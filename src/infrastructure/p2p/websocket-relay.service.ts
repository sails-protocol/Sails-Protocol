/**
 * WebSocketRelayTransportProvider — secondary TransportProvider
 * 03-implementation_plan.md section 3; CISO Privacy Rule ("Blind Relay").
 *
 * Activates only when PearsTransportProvider doesn't connect within the
 * fallback timeout (see FallbackTransportProvider, transport-provider.ts).
 * This class never inspects, decrypts, or logs payload contents — it
 * forwards whatever bytes it's given, verbatim, to the target
 * participant's registered socket (PRINCIPLES.md principle 8, Privacy
 * Preserving; SECURITY_MODEL.md "Privacy by Design"). If a future caller
 * needs to *read* a payload here to make a routing decision, that is
 * exactly the violation this rule exists to prevent.
 *
 * Accuracy note (found while wiring `PearsTransportProvider.sendIntentToPeer`,
 * transport-provider.ts): this class previously claimed app-layer
 * "Secretstream/E2E encryption already happens above this layer" as a
 * blanket statement. That's now true specifically for Intent payloads sent
 * via `sendIntentToPeer` (real libsodium sealed-box encryption,
 * `payload-crypto.ts`) — it was never true for chat/negotiation messages
 * (`chat.routes.ts`, `negotiation.service.ts`'s `HumanChatChannel`), which
 * still send plain JSON. Both cases DO get Hyperswarm's own Noise-handshake
 * transport encryption when routed via Pears (real, inherent to
 * `hyperswarm`/`hyperdht`, not this class's concern) — but this relay has
 * no such transport-level encryption of its own, so an unencrypted
 * chat/negotiation payload really is only as private as this WebSocket
 * connection (TLS in front of it, in a real deployment). Not fixed here —
 * flagged, same as every other gap found this way in this codebase.
 *
 * Connection registration is asymmetric from PearsTransportProvider by
 * necessity: HyperDHT connections are peer-initiated (PearNode.start()
 * actively bootstraps a DHT node); WebSocket connections are
 * client-initiated (a participant's client connects to this server's `/ws`
 * upgrade endpoint). `start()` below registers readiness; `registerSocket()`
 * is what a Fastify WS route handler calls once the actual connection
 * lands — see relay.routes.ts's `/ws/relay` route (registered in app.ts).
 */
import type { TransportProvider, PeerHandle } from './transport-provider'

export interface RelayRouterHooks {
  claim(participantId: string): Promise<void>
  release(participantId: string): Promise<void>
  route(fromParticipantId: string, raw: string): Promise<void>
}

export interface RelaySocket {
  send(data: string): void
  close(): void
  readyState: number
}

const OPEN = 1 // WebSocket.OPEN — avoids importing the `ws` package just for this constant

export class WebSocketRelayTransportProvider implements TransportProvider {
  name = 'websocket-relay'
  private sockets = new Map<string, RelaySocket>()
  private messageHandlers = new Map<string, (peerId: string, payload: unknown) => void>()
  // #307 Phase B: participant-to-participant delivery (relay-delivery.ts).
  // Installed by app.ts only; without it the provider keeps its blind,
  // handler-only behaviour.
  private router: RelayRouterHooks | null = null

  useRouter(router: RelayRouterHooks | null): void {
    this.router = router
  }

  /** Must resolve before READY: makes this participant reachable from every instance. */
  async prepareRegistration(participantId: string): Promise<void> {
    await this.router?.claim(participantId)
  }

  /** The socket closed between prepareRegistration() and registration. */
  abandonRegistration(participantId: string): void {
    if (this.sockets.has(participantId)) return
    void this.router?.release(participantId).catch(() => undefined)
  }

  // Called by app.ts's `/ws/relay` route once the client's WebSocket
  // upgrade completes — this is the real "connection", not start() below.
  registerSocket(participantId: string, socket: RelaySocket): void {
    const previous = this.sockets.get(participantId)
    if (previous === socket) return
    // Transfer ownership before closing: a stale close callback must not
    // unregister the replacement socket.
    this.sockets.set(participantId, socket)
    if (previous && previous.readyState === OPEN) {
      try {
        previous.close()
      } catch {
        // A broken old transport must not abort registration of the new
        // authenticated socket. Ownership has already been transferred.
      }
    }
  }

  ownsSocket(participantId: string, socket: RelaySocket): boolean {
    return this.sockets.get(participantId) === socket
  }

  unregisterSocket(participantId: string, socket?: RelaySocket): void {
    // A stale close event must not remove a newer socket registered for
    // the same participant (reconnect/overlapping connections).
    if (socket && this.sockets.get(participantId) !== socket) return
    this.sockets.delete(participantId)
    // Best effort: a stale owner key only yields UNDELIVERED, never a misdelivery.
    void this.router?.release(participantId).catch(() => undefined)
  }

  // Registers intent to use this provider; does not itself open a
  // connection (see class doc). Returns a synthetic PeerHandle — this
  // relay has no DHT-level peerId, participantId is the only address.
  async start(participantId: string): Promise<PeerHandle> {
    return { peerId: participantId }
  }

  async stop(participantId: string): Promise<void> {
    const socket = this.sockets.get(participantId)
    // Revoke ownership before invoking close(): a synchronous close callback
    // must not remove a replacement registered during shutdown.
    this.sockets.delete(participantId)
    this.messageHandlers.delete(participantId)
    if (socket && socket.readyState === OPEN) {
      try {
        socket.close()
      } catch {
        // A broken socket is already unregistered; shutdown remains idempotent.
      }
    }
  }

  // No topic concept over a point-to-point relay — a no-op, not an error,
  // consistent with RFC-002's "never assumes continuous connectivity /
  // never assumes symmetric capability across TransportProvider
  // implementations" reasoning.
  async joinTopic(_participantId: string, _topic: string): Promise<void> {
    return
  }

  async broadcast(participantId: string, payload: unknown): Promise<number> {
    // Only meaningful target here is whichever socket is registered for
    // this participant's known counterparty — a relay has no topic-wide
    // fanout. Delegates to sendToPeer's semantics for the one connection
    // it actually has; callers needing real broadcast should use Pears.
    void participantId
    void payload
    return 0
  }

  async sendToPeer(_participantId: string, targetParticipantId: string, payload: unknown): Promise<boolean> {
    const socket = this.sockets.get(targetParticipantId)
    if (!socket || socket.readyState !== OPEN) return false
    // Blind forward: payload confidentiality depends on the caller. Intent
    // payloads have application-layer encryption, but chat/negotiation may
    // still be plaintext (see module security note). Never parse or log.
    try {
      socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
      return true
    } catch {
      // A socket can fail after readyState was checked; report failed delivery.
      // Do not evict here: a concurrent reconnect may already own the slot.
      return false
    }
  }

  onMessage(participantId: string, handler: (peerId: string, payload: unknown) => void): void {
    this.messageHandlers.set(participantId, handler)
  }

  // Called by app.ts's `/ws/relay` route on each incoming frame — routes
  // it to whichever onMessage() handler this participant registered.
  dispatchIncoming(participantId: string, rawPayload: unknown): Promise<void> | void {
    this.messageHandlers.get(participantId)?.(participantId, rawPayload)
    if (this.router && typeof rawPayload === 'string') return this.router.route(participantId, rawPayload)
  }

  isConnected(participantId: string): boolean {
    return this.sockets.get(participantId)?.readyState === OPEN
  }
}

export const webSocketRelayTransportProvider = new WebSocketRelayTransportProvider()
