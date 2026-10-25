/**
 * Redis Pub/Sub delivery transport, isolated from production route wiring.
 * Publication only proves Redis accepted a message, not delivery. ACKs are
 * correlated by the origin registry. Channel names must be trusted config.
 */
import type Redis from 'ioredis'
import { acceptRelayDeliveryAtDestination } from './relay-delivery-destination'
import { RelayDeliveryOrigin } from './relay-delivery-origin'
import type { RelayDeliveryCommand } from './relay-delivery-command'
import type { WebSocketRelayTransportProvider } from './websocket-relay.service'

const MAX_WIRE_BYTES = 1024 * 1024
const MAX_INBOUND_COMMANDS = 256
const CHANNEL_RE = /^sails:relay:delivery:[a-zA-Z0-9_-]{1,80}$/

function parseWire(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_WIRE_BYTES) return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

/**
 * Explicitly scoped transport; requires dedicated subscriber connections.
 * The owner channel is configured by the caller; no presence-based routing
 * or authentication is claimed by this module.
 */
export class RedisRelayDeliveryTransport {
  private started = false
  private inFlightCommands = 0
  private starting: Promise<void> | null = null
  private closing = false
  private closePromise: Promise<void> | null = null
  private readonly origin: RelayDeliveryOrigin
  private readonly onMessage: (channel: string, message: string) => void
  private readonly onSubscriberClose: () => void
  private readonly onPublisherClose: () => void

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly localChannel: string,
    private readonly destinationProvider: WebSocketRelayTransportProvider,
  ) {
    if (!CHANNEL_RE.test(localChannel)) throw new Error('invalid relay channel')
    this.origin = new RelayDeliveryOrigin(async (command, destinationChannel) => {
      if (!destinationChannel) throw new Error('destination channel not configured')
      const receivers = await this.publisher.publish(destinationChannel, JSON.stringify({
        ...command,
        replyChannel: this.localChannel,
      }))
      if (receivers < 1) throw new Error('no relay destination subscriber')
    })
    // Redis emits messages without awaiting listeners. A rejected async handler
    // must not escape as an unhandled rejection or fabricate a positive ACK.
    // A Redis reconnect must not silently restore delivery without re-establishing
    // the authenticated channel and routing contract. Fail closed permanently.
    this.onSubscriberClose = () => {
      this.closing = true
      this.started = false
      this.origin.close()
      this.subscriber.off('message', this.onMessage)
      this.subscriber.off('close', this.onSubscriberClose)
      this.publisher.off('close', this.onPublisherClose)
    }
    // The publishing connection is an independent failure boundary: do not
    // continue accepting delivery requests after it drops.
    this.onPublisherClose = () => {
      this.closing = true
      this.started = false
      this.origin.close()
      this.publisher.off('close', this.onPublisherClose)
      this.subscriber.off('message', this.onMessage)
      this.subscriber.off('close', this.onSubscriberClose)
    }
    this.onMessage = (channel, message) => {
      void this.handleMessage(channel, message).catch(() => undefined)
    }
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error('relay transport is closed')
    if (this.started) return
    if (this.starting) return this.starting
    this.starting = this.subscribeOnce()
    try { await this.starting } finally { this.starting = null }
  }

  private async subscribeOnce(): Promise<void> {
    this.publisher.on('close', this.onPublisherClose)
    this.subscriber.on('close', this.onSubscriberClose)
    this.subscriber.on('message', this.onMessage)
    try {
      await this.subscriber.subscribe(this.localChannel)
      if (this.closing) {
        this.subscriber.off('message', this.onMessage)
        // close() owns the unsubscribe and must surface failures to its caller.
        // Do not attempt it here as well: duplicate unsubscribe calls can race.
        return
      }
      this.started = true
    } catch (error) {
      this.started = false
      this.closing = true
      this.origin.close()
      this.subscriber.off('message', this.onMessage)
      this.subscriber.off('close', this.onSubscriberClose)
      this.publisher.off('close', this.onPublisherClose)
      // A rejected subscribe may have partially succeeded server-side.
      // If close() is already running, it owns unsubscribe. Otherwise attempt
      // best-effort cleanup here while preserving the original subscribe error.
      if (!this.closePromise) {
        try { await this.subscriber.unsubscribe(this.localChannel) } catch { /* retain original failure */ }
      }
      throw error
    }
  }

  async deliver(destinationChannel: string, input: Omit<RelayDeliveryCommand, 'requestId'>): Promise<boolean> {
    if (!this.started || !CHANNEL_RE.test(destinationChannel)) return false
    return this.origin.deliver(input, destinationChannel)
  }

  private async handleMessage(channel: string, message: string): Promise<void> {
    if (!this.started || channel !== this.localChannel) return
    const wire = parseWire(message)
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return
    const record = wire as Record<string, unknown>
    if ('replyChannel' in record) {
      if (typeof record.replyChannel !== 'string' || !CHANNEL_RE.test(record.replyChannel)) return
      if (this.inFlightCommands >= MAX_INBOUND_COMMANDS) return
      this.inFlightCommands++
      try {
        const { replyChannel, ...command } = record
        const ack = await acceptRelayDeliveryAtDestination(this.destinationProvider, command)
        if (!ack || !this.started) return
        try { await this.publisher.publish(replyChannel, JSON.stringify(ack)) } catch { /* origin times out */ }
      } finally {
        this.inFlightCommands--
      }
    } else {
      this.origin.acknowledge(record)
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    // Mark closed synchronously so concurrent callers cannot initiate work.
    this.closing = true
    this.started = false
    this.origin.close()
    this.subscriber.off('message', this.onMessage)
    this.subscriber.off('close', this.onSubscriberClose)
    this.publisher.off('close', this.onPublisherClose)
    this.closePromise = (async () => {
      if (this.starting) {
        try { await this.starting } catch { /* subscription failed; no active channel */ }
      }
      await this.subscriber.unsubscribe(this.localChannel)
    })()
    return this.closePromise
  }
}
