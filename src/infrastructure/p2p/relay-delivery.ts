/**
 * #307 Phase B — participant-to-participant delivery over the WebSocket relay.
 *
 * Until this module the relay authenticated and budgeted client frames, then
 * dispatched them to no handler: nothing in production delivered anything.
 * This is the router: a strict, versioned envelope; sender identity taken
 * only from the authenticated socket; recipient authorized against the real
 * Trade row; delivery to the recipient's socket on this or another server
 * instance; an acknowledgement that means "written to the recipient's socket",
 * never "read".
 *
 * Contract v1 (client → relay), exactly these keys:
 *   {"v":1,"type":"SEND","id":"<16-64 base64url>","to":"<participantId>","trade":"<tradeId>","body":"<string>"}
 * Relay → recipient:  {"type":"MESSAGE","v":1,"id","from","trade","body"}
 * Relay → sender:     {"type":"SENT","id"} | {"type":"UNDELIVERED","id"}
 *                     | {"type":"REJECTED","id","reason":"MALFORMED"|"DUPLICATE"}
 *
 * - `from` is never accepted from the client (an extra key is MALFORMED).
 * - Not authorized and not connected both answer UNDELIVERED, identically, so
 *   a sender cannot learn whether a non-counterparty exists or is online.
 * - Authorization: sender and recipient are the trade's buyer and seller and
 *   the trade is PENDING or ACTIVE (`findActiveTradeIdsBetween`'s existing
 *   rule). Whether DISPUTED/COMPLETED/CANCELLED trades may message is an open
 *   CTO decision; until then they are refused, never granted.
 * - `body` is opaque and is never logged or parsed. Nothing is stored for
 *   offline recipients. This module does NOT provide end-to-end encryption.
 * - Every Redis or database failure throws; relay.routes.ts closes the
 *   socket 1011 (fail closed). No step degrades to "pretend it worked".
 */
import { randomUUID } from 'crypto'
import type Redis from 'ioredis'

export const RELAY_ENVELOPE_VERSION = 1
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const REF_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const ENVELOPE_KEYS = ['body', 'id', 'to', 'trade', 'type', 'v']
const AUTHORIZED_TRADE_STATUSES = new Set(['PENDING', 'ACTIVE'])
// A message id may be delivered once per sender within this window; a resend
// with the same id after an UNDELIVERED is allowed (the claim is released).
const MESSAGE_ID_TTL_SECONDS = 600
const REMOTE_ACK_TIMEOUT_MS = 3000
const MAX_PENDING_REMOTE = 10_000

export interface RelayEnvelope { id: string; to: string; trade: string; body: string }

export interface RelaySocketHost {
  isConnected(participantId: string): boolean
  sendToPeer(fromParticipantId: string, targetParticipantId: string, payload: unknown): Promise<boolean>
}

export interface TradeParties { buyerId: string; sellerId: string; status: string }

export interface RelayRouterDeps {
  redis: Redis
  host: RelaySocketHost
  findTrade(tradeId: string): Promise<TradeParties | null>
  instanceId?: string
}

/** Strict parse; null means MALFORMED. Never throws on client input. */
export function parseRelayEnvelope(raw: string): RelayEnvelope | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const frame = value as Record<string, unknown>
  const keys = Object.keys(frame).sort()
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) return null
  if (frame.v !== RELAY_ENVELOPE_VERSION || frame.type !== 'SEND') return null
  const { id, to, trade, body } = frame
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null
  if (typeof to !== 'string' || !REF_PATTERN.test(to)) return null
  if (typeof trade !== 'string' || !REF_PATTERN.test(trade)) return null
  if (typeof body !== 'string' || body.length === 0) return null
  return { id, to, trade, body }
}

/** Both ends must be the trade's two parties, on a trade still in progress. */
export function isAuthorizedPair(trade: TradeParties | null, from: string, to: string): boolean {
  if (!trade || from === to || !AUTHORIZED_TRADE_STATUSES.has(trade.status)) return false
  const parties = [trade.buyerId, trade.sellerId]
  return parties.includes(from) && parties.includes(to)
}

const ownerKey = (participantId: string) => 'relay:owner:' + participantId
const channelOf = (instanceId: string) => 'relay:instance:' + instanceId

// Delete only if this instance still owns the key: a reconnect elsewhere
// must not be unregistered by this instance's late close.
const RELEASE_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

type RemoteFrame =
  | { kind: 'deliver'; reqId: string; replyTo: string; to: string; payload: string }
  | { kind: 'ack'; reqId: string; ok: boolean }

export class RelayRouter {
  readonly instanceId: string
  private readonly redis: Redis
  private readonly host: RelaySocketHost
  private readonly findTrade: RelayRouterDeps['findTrade']
  private subscriber: Redis | null = null
  private subscribing: Promise<Redis> | null = null
  private readonly pendingAcks = new Map<string, (ok: boolean) => void>()

  constructor(deps: RelayRouterDeps) {
    this.redis = deps.redis
    this.host = deps.host
    this.findTrade = deps.findTrade
    this.instanceId = deps.instanceId ?? randomUUID()
  }

  // Lazy: an instance subscribes when its first participant registers, so
  // building the app touches no Redis. A failed attempt is retried next time.
  private subscribed(): Promise<Redis> {
    if (!this.subscribing) {
      const subscriber = this.redis.duplicate()
      subscriber.on('message', (_channel: string, message: string) => this.onRemote(message))
      this.subscribing = subscriber.subscribe(channelOf(this.instanceId)).then(
        () => (this.subscriber = subscriber),
        error => {
          this.subscribing = null
          subscriber.disconnect()
          throw error
        },
      )
    }
    return this.subscribing
  }

  async stop(): Promise<void> {
    for (const resolve of this.pendingAcks.values()) resolve(false)
    this.pendingAcks.clear()
    const subscriber = await this.subscribing?.catch(() => null)
    this.subscribing = null
    this.subscriber = null
    await subscriber?.quit().catch(() => undefined)
  }

  /** Called before READY: other instances can reach this participant once READY is sent. */
  async claim(participantId: string): Promise<void> {
    await this.subscribed()
    await this.redis.set(ownerKey(participantId), this.instanceId)
  }

  async release(participantId: string): Promise<void> {
    await this.redis.eval(RELEASE_OWNER_SCRIPT, 1, ownerKey(participantId), this.instanceId)
  }

  /** One authenticated, budget-admitted frame from `from`. Throws only on infrastructure failure. */
  async route(from: string, raw: string): Promise<void> {
    const envelope = parseRelayEnvelope(raw)
    if (!envelope) {
      await this.reply(from, { type: 'REJECTED', id: null, reason: 'MALFORMED' })
      return
    }
    const { id, to, trade, body } = envelope
    if (!isAuthorizedPair(await this.findTrade(trade), from, to)) {
      await this.reply(from, { type: 'UNDELIVERED', id })
      return
    }
    const claimKey = `relay:msg:${from}:${id}`
    if (await this.redis.set(claimKey, '1', 'EX', MESSAGE_ID_TTL_SECONDS, 'NX') === null) {
      await this.reply(from, { type: 'REJECTED', id, reason: 'DUPLICATE' })
      return
    }
    const message = JSON.stringify({ type: 'MESSAGE', v: RELAY_ENVELOPE_VERSION, id, from, trade, body })
    const delivered = await this.deliver(from, to, message)
    if (!delivered) await this.redis.del(claimKey)
    await this.reply(from, { type: delivered ? 'SENT' : 'UNDELIVERED', id })
  }

  private async reply(to: string, frame: Record<string, unknown>): Promise<void> {
    await this.host.sendToPeer('relay', to, JSON.stringify(frame))
  }

  private async deliver(from: string, to: string, message: string): Promise<boolean> {
    if (this.host.isConnected(to)) return this.host.sendToPeer(from, to, message)
    const owner = await this.redis.get(ownerKey(to))
    if (!owner || owner === this.instanceId || !this.subscriber) return false
    if (this.pendingAcks.size >= MAX_PENDING_REMOTE) return false
    const reqId = randomUUID()
    const ack = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId)
        resolve(false)
      }, REMOTE_ACK_TIMEOUT_MS)
      this.pendingAcks.set(reqId, ok => {
        clearTimeout(timer)
        this.pendingAcks.delete(reqId)
        resolve(ok)
      })
    })
    const frame: RemoteFrame = { kind: 'deliver', reqId, replyTo: this.instanceId, to, payload: message }
    const receivers = await this.redis.publish(channelOf(owner), JSON.stringify(frame)).catch(error => {
      this.pendingAcks.get(reqId)?.(false)
      throw error
    })
    if (receivers === 0) {
      // Stale owner key (instance gone): nobody can deliver.
      this.pendingAcks.get(reqId)?.(false)
    }
    return ack
  }

  private onRemote(message: string): void {
    let frame: RemoteFrame
    try {
      frame = JSON.parse(message) as RemoteFrame
    } catch {
      return
    }
    if (frame.kind === 'ack') {
      this.pendingAcks.get(frame.reqId)?.(frame.ok === true)
      return
    }
    if (frame.kind !== 'deliver') return
    const send = this.host.isConnected(frame.to)
      ? this.host.sendToPeer('relay', frame.to, frame.payload)
      : Promise.resolve(false)
    void send
      .then(ok => ok, () => false)
      .then(ok => this.redis.publish(channelOf(frame.replyTo), JSON.stringify({ kind: 'ack', reqId: frame.reqId, ok })))
      .catch(() => undefined)
  }
}
