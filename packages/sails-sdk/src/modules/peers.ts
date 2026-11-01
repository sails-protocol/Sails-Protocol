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
import type { PeerStatus } from '../types'

const STATIC_TOPICS = ['marketplace', 'btc', 'lnBtc', 'liquidBtc', 'usdtErc20', 'usdtLiquid'] as const
export type StaticTopic = (typeof STATIC_TOPICS)[number]

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
   * ticket. The caller owns the socket and its message protocol. Every
   * reconnect must call this method again; a consumed ticket cannot be reused.
   * This does not provide Pears topic discovery or DHT broadcast semantics.
   */
  async connectRelay(): Promise<WebSocket> {
    const { ticket } = await this.transport.post<{ ticket: string; expiresIn: number }>(
      '/v1/identity/ws-ticket', {}, true,
    )
    return this.transport.openWebSocket('/ws/relay', { ticket })
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
