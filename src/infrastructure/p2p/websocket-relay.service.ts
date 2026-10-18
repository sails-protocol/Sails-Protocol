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

  // Called by app.ts's `/ws/relay` route once the client's WebSocket
  // upgrade completes — this is the real "connection", not start() below.
  registerSocket(participantId: string, socket: RelaySocket): void {
    this.sockets.set(participantId, socket)
  }

  unregisterSocket(participantId: string, socket?: RelaySocket): void {
    // A stale close event must not remove a newer socket registered for
    // the same participant (reconnect/overlapping connections).
    if (socket && this.sockets.get(participantId) !== socket) return
    this.sockets.delete(participantId)
  }

  // Registers intent to use this provider; does not itself open a
  // connection (see class doc). Returns a synthetic PeerHandle — this
  // relay has no DHT-level peerId, participantId is the only address.
  async start(participantId: string): Promise<PeerHandle> {
    return { peerId: participantId }
  }

  async stop(participantId: string): Promise<void> {
    const socket = this.sockets.get(participantId)
    if (socket && socket.readyState === OPEN) socket.close()
    this.sockets.delete(participantId)
    this.messageHandlers.delete(participantId)
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
    // Blind forward — payload is whatever the caller already encrypted
    // above this layer. Never parsed, never logged.
    socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
    return true
  }

  onMessage(participantId: string, handler: (peerId: string, payload: unknown) => void): void {
    this.messageHandlers.set(participantId, handler)
  }

  // Called by app.ts's `/ws/relay` route on each incoming frame — routes
  // it to whichever onMessage() handler this participant registered.
  dispatchIncoming(participantId: string, rawPayload: unknown): void {
    this.messageHandlers.get(participantId)?.(participantId, rawPayload)
  }

  isConnected(participantId: string): boolean {
    return this.sockets.get(participantId)?.readyState === OPEN
  }
}

export const webSocketRelayTransportProvider = new WebSocketRelayTransportProvider()
