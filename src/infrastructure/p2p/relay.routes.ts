/**
 * WebSocket relay route — `/ws/relay`. Gives `WebSocketRelayTransportProvider`
 * (websocket-relay.service.ts) a real socket to register against.
 *
 * Until this file existed, `WebSocketRelayTransportProvider` and
 * `FallbackTransportProvider` (transport-provider.ts) were real and
 * unit-tested in isolation (transportFallback.test.ts, with fake
 * TransportProvider/socket doubles) but had no live wiring — a class
 * comment in websocket-relay.service.ts referenced "app.ts's `/ws/relay`
 * route" that did not exist anywhere in this codebase. A fallback to a
 * relay that no client can ever reach is not a fallback; this is the
 * missing piece that makes it real.
 *
 * Auth follows chat.routes.ts's exact pattern (`?ticket=` query param, a
 * short-lived single-use value minted by POST /v1/identity/ws-ticket and
 * burned on first resolution — not `requireAuth`'s Authorization-header
 * check, because a WebSocket upgrade request from a browser client can't
 * set arbitrary headers, the same constraint that route already
 * documents). Migrated off a raw `?token=` session token, 2026-08-15
 * security review P1 — see ws-auth.ts's resolveParticipantFromTicket()
 * for the full rationale. Note this route currently has no in-repo SDK
 * client (grep confirms `packages/sails-sdk` never constructs a
 * `/ws/relay` URL) — any external client connecting here needs the same
 * paired update: fetch a ticket via the authenticated HTTP endpoint
 * first, then open the socket with `?ticket=`, not `?token=`.
 *
 * Scope, stated plainly: this makes `start()`/`sendToPeer()` degrade
 * gracefully when Pears/HyperDHT hole-punching doesn't complete in time
 * (restrictive NAT, corporate firewall — transportFallback.test.ts's
 * timeout/reject cases). It does NOT give the relay a DHT-topic
 * equivalent — `/v1/peers/join-trade` and `/v1/peers/broadcast-offer`
 * still require a real PearNode and will 409 for a participant who fell
 * back to the relay. That is a structural limit of a point-to-point
 * relay, not an oversight (see transport-provider.ts's `FallbackTransportProvider`
 * class comment).
 */
import type { FastifyInstance } from 'fastify'
import { resolveParticipantFromTicket } from '../../common/middleware/ws-auth'
import { webSocketRelayTransportProvider } from './websocket-relay.service'
import { consumeSharedRelayBudget } from './relay-shared-budget'

export async function relayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/relay', { websocket: true }, async (socket, request) => {
    const query = request.query as { ticket?: string }
    const participantId = await resolveParticipantFromTicket(query.ticket)
    if (!participantId) {
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Missing, invalid, or already-used ticket query param — call POST /v1/identity/ws-ticket first' } }))
      socket.close()
      return
    }

    webSocketRelayTransportProvider.registerSocket(participantId, socket)

    socket.on('message', async (raw: Buffer) => {
      // Blind forward, same rule sendToPeer() follows (CISO Privacy Rule,
      // "Blind Relay") — this route never parses the frame, it only hands
      // the raw bytes to whichever onMessage() handler the participant
      // registered via the TransportProvider interface.
      // Count actual received bytes before decoding; no relay payload inspection.
      if (!await consumeSharedRelayBudget(participantId, raw.byteLength)) {
        socket.close(1008, 'Relay resource budget exceeded')
        return
      }
      webSocketRelayTransportProvider.dispatchIncoming(participantId, raw.toString())
    })

    socket.on('close', () => {
      webSocketRelayTransportProvider.unregisterSocket(participantId)
    })
  })
}
