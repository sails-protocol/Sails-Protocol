/**
 * @satsails/p2p-trading-sdk — P2P Transport module (Pears/HyperDHT — verified against
 * src/infrastructure/p2p/pear.routes.ts directly).
 *
 * Not part of SDK_GUIDE.md's original `SailsClient` interface (that
 * document predates the route-restoration pass that made these real,
 * `API_REFERENCE.md` section 7's own routes) — added here because a
 * wallet integrating this SDK needs a way to actually start its own
 * HyperDHT node to participate in P2P discovery/negotiation at all
 * (PROJECT_CONTEXT.md's developer diagram: "the one thing a wallet
 * imports to get every module below it"). Flagged for SDK_GUIDE.md to
 * formally adopt, not silently added as if it had always been there.
 */
import type { SailsTransport } from '../transport'
import { SailsTransportError } from '../errors'
import type { PeerStatus } from '../types'

const STATIC_TOPICS = ['marketplace', 'btc', 'lnBtc', 'liquidBtc', 'usdtErc20', 'usdtLiquid'] as const
export type StaticTopic = (typeof STATIC_TOPICS)[number]

// Exact bytes src/infrastructure/p2p/relay.routes.ts sends; anything else as
// the first frame is a failed handshake, never a partial match.
const RELAY_READY_FRAME = JSON.stringify({ type: 'READY' })
const RELAY_READY_TIMEOUT_MS = 10_000

function relayRejection(data: unknown): string {
  if (typeof data === 'string') {
    try {
      const frame = JSON.parse(data) as { type?: unknown; payload?: { message?: unknown } }
      if (frame.type === 'ERROR' && typeof frame.payload?.message === 'string') {
        return `Relay rejected the connection: ${frame.payload.message}`
      }
    } catch {
      // Not JSON: reported as unexpected below.
    }
  }
  return 'Relay sent an unexpected first frame instead of READY'
}

export class SailsPeersModule {
  constructor(private readonly transport: SailsTransport) {}

  /**
   * Requires an active session. Starts the caller's own server-hosted P2P
   * node (Pears/HyperDHT, falling back to a WebSocket relay if Pears
   * doesn't connect in time — see the real route's own doc comment).
   *
   * Key-custody fix, 2026-08-09 (docs/TODO.md's own "as chaves privadas
   * do usuário podem ser consultadas?" item): this used to take a caller-
   * generated secret key and send it in the request body — the server
   * now generates its own ephemeral per-session identity instead, so
   * that key material never has to transit the network at all. No
   * argument to pass anymore; kept as a 0-arg method rather than
   * silently accepting and ignoring a value a caller might still think
   * matters.
   */
  async start(): Promise<{ peerId: string }> {
    return this.transport.post<{ peerId: string }>('/v1/peers/start', undefined, true)
  }

  /**
   * Open the server's blind WebSocket relay with a freshly minted, single-use
   * ticket. Resolves only after the server's READY frame: the ticket was
   * consumed and the socket registered, so the caller may send at once
   * (`open` alone is not authentication; a frame sent before READY makes the
   * server close the socket). READY is consumed here and never reaches the
   * caller's listeners. Rejects, and closes the socket, on an ERROR or any
   * other first frame, on close or error before READY, on `timeoutMs`
   * (default 10 s) or when `signal` aborts.
   *
   * The caller owns the socket and its message protocol afterwards. Every
   * reconnect must call this method again; a consumed ticket cannot be reused.
   * This does not provide Pears topic discovery or DHT broadcast semantics.
   */
  async connectRelay(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WebSocket> {
    const { timeoutMs = RELAY_READY_TIMEOUT_MS, signal } = options
    if (signal?.aborted) throw new SailsTransportError('Relay connection aborted')
    const { ticket } = await this.transport.post<{ ticket: string; expiresIn: number }>(
      '/v1/identity/ws-ticket', {}, true,
    )
    if (signal?.aborted) throw new SailsTransportError('Relay connection aborted')
    const socket = this.transport.openWebSocket('/ws/relay', { ticket })

    return new Promise<WebSocket>((resolve, reject) => {
      const settle = (error?: SailsTransportError) => {
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
        if (!error) return resolve(socket)
        // Closing a still-CONNECTING socket fires `error` (Node's `ws` throws an
        // unhandled one if nothing listens); this socket is discarded anyway.
        if (socket.readyState === 0) socket.addEventListener('error', () => undefined)
        try {
          socket.close()
        } catch {
          // Already closing or never connected; the rejection is what matters.
        }
        reject(error)
      }
      const onMessage = (event: MessageEvent) => settle(
        event.data === RELAY_READY_FRAME ? undefined : new SailsTransportError(relayRejection(event.data)),
      )
      const onClose = (event: CloseEvent) => settle(new SailsTransportError(
        `Relay closed before READY (${event.code}${event.reason ? ` ${event.reason}` : ''})`,
      ))
      const onError = () => settle(new SailsTransportError('Relay connection failed before READY'))
      const onAbort = () => settle(new SailsTransportError('Relay connection aborted'))
      const timer = setTimeout(
        () => settle(new SailsTransportError(`Relay READY not received within ${timeoutMs}ms`)), timeoutMs,
      )
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
      signal?.addEventListener('abort', onAbort)
    })
  }

  /** Requires an active session. */
  async stop(): Promise<void> {
    await this.transport.post('/v1/peers/stop', undefined, true)
  }

  /** Requires an active session. */
  async status(): Promise<PeerStatus> {
    return this.transport.get<PeerStatus>('/v1/peers/status', undefined, true)
  }

  /** Requires an active session and an active node (call start() first). */
  async joinTopic(topic: StaticTopic): Promise<void> {
    await this.transport.post('/v1/peers/join-topic', { topic }, true)
  }

  /** Requires an active session and an active node. */
  async joinTrade(tradeId: string): Promise<void> {
    await this.transport.post('/v1/peers/join-trade', { tradeId }, true)
  }

  /** Requires an active session and an active node. */
  async broadcastOffer(input: { offerId: string; asset: string; side: 'BUY' | 'SELL'; priceUsd: string }): Promise<{ deliveredTo: number }> {
    return this.transport.post<{ deliveredTo: number }>('/v1/peers/broadcast-offer', input, true)
  }
}
