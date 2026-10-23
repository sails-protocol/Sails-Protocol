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
 * for the full rationale. The in-repo SDK exposes
 * `SailsClient.peers.connectRelay()`: it requests a short-lived ticket via
 * authenticated HTTP, then opens `/ws/relay?ticket=...` (never a raw session
 * token). `tests/relayLiveWebSocket.test.ts` exercises SDK-to-live-socket
 * wiring with mocked ticket HTTP and ticket resolver boundaries; this is
 * not an end-to-end proof of the production authentication service.
 *
 * Live delivery evidence: `tests/relayProviderLiveDelivery.test.ts` uses the
 * actual relay provider with two real TCP WebSocket clients, checking opaque
 * sender-to-recipient delivery and disconnect isolation. The test mocks
 * authentication resolution and Redis budget decisions; it does not prove
 * production ticket issuance or cross-instance delivery.
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
import { randomUUID } from 'node:crypto'
import { resolveParticipantFromTicket } from '../../common/middleware/ws-auth'
import { webSocketRelayTransportProvider } from './websocket-relay.service'
import { consumeSharedRelayBudget } from './relay-shared-budget'
import { RELAY_FRAME_MAX_BYTES } from './relay-ingress-budget'
import { claimRelayPresence, renewRelayPresence, releaseRelayPresence, RELAY_PRESENCE_TTL_MS } from './relay-presence'

export async function relayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/relay', { websocket: true }, async (socket, request) => {
    // @fastify/websocket requires a synchronous message listener: an async
    // ticket lookup must not leave incoming frames unobserved. Pre-auth
    // traffic is rejected rather than buffered or forwarded.
    let preAuthFrameReceived = false
    const rejectPreAuthFrame = () => {
      preAuthFrameReceived = true
      socket.close(1008, 'Relay authentication pending')
    }
    socket.on('message', rejectPreAuthFrame)
    const query = request.query as { ticket?: string }
    // Reject absent tickets without allocating an asynchronous Redis lookup.
    if (typeof query.ticket !== 'string' || query.ticket.length === 0) {
      socket.off('message', rejectPreAuthFrame)
      socket.close(1008, 'Relay ticket required')
      return
    }
    let participantId: string | null
    const AUTH_TIMEOUT_MS = 5000
    let authTimer: ReturnType<typeof setTimeout> | undefined
    try {
      participantId = await Promise.race([
        resolveParticipantFromTicket(query.ticket),
        new Promise<never>((_resolve, reject) => {
          authTimer = setTimeout(() => reject(new Error('Relay authentication timed out')), AUTH_TIMEOUT_MS)
        }),
      ])
    } catch {
      socket.off('message', rejectPreAuthFrame)
      socket.close(1011, 'Relay authentication unavailable')
      return
    } finally {
      if (authTimer) clearTimeout(authTimer)
    }
    socket.off('message', rejectPreAuthFrame)
    if (preAuthFrameReceived || socket.readyState !== 1) return
    if (!participantId) {
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Missing, invalid, or already-used ticket query param — call POST /v1/identity/ws-ticket first' } }))
      socket.close()
      return
    }

    // Presence is a short-lived routing hint, not proof of delivery.
    // A stalled Redis call must not leave an authenticated socket hanging.
    const leaseToken = randomUUID()
    const PRESENCE_CLAIM_TIMEOUT_MS = 5000
    let claimTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        claimRelayPresence(participantId, leaseToken),
        new Promise<never>((_resolve, reject) => {
          claimTimer = setTimeout(() => reject(new Error('Relay presence claim timed out')), PRESENCE_CLAIM_TIMEOUT_MS)
        }),
      ])
    } catch {
      socket.close(1011, 'Relay presence unavailable')
      return
    } finally {
      if (claimTimer) clearTimeout(claimTimer)
    }
    if (preAuthFrameReceived || socket.readyState !== 1) {
      void releaseRelayPresence(participantId, leaseToken).catch(() => undefined)
      return
    }
    webSocketRelayTransportProvider.registerSocket(participantId, socket, leaseToken)
    let renewing = false
    // A renewal can hang without rejecting. Never keep a socket open after
    // its last confirmed lease may have expired.
    let leaseExpiresAt = Date.now() + RELAY_PRESENCE_TTL_MS
    const leaseTimer = setInterval(() => {
      if (!webSocketRelayTransportProvider.ownsSocket(participantId, socket) || socket.readyState !== 1) {
        clearInterval(leaseTimer)
        return
      }
      if (Date.now() >= leaseExpiresAt) {
        socket.close(1011, 'Relay presence lease expired')
        clearInterval(leaseTimer)
        return
      }
      // A stalled Redis request must not accumulate concurrent renewals.
      if (renewing) return
      renewing = true
      const startedAt = Date.now()
      void renewRelayPresence(participantId, leaseToken).then(renewed => {
        // A late Redis success cannot revive an expired or replaced socket.
        if (!webSocketRelayTransportProvider.ownsSocket(participantId, socket) || socket.readyState !== 1) return
        if (Date.now() >= leaseExpiresAt) {
          socket.close(1011, 'Relay presence lease expired')
          return
        }
        if (!renewed) {
          socket.close(1011, 'Relay presence ownership lost')
        } else {
          // Conservatively count from request start, not response time.
          // A delayed success cannot extend the socket beyond that deadline.
          const renewedUntil = startedAt + RELAY_PRESENCE_TTL_MS
          if (Date.now() >= renewedUntil) {
            socket.close(1011, 'Relay presence lease expired')
            return
          }
          leaseExpiresAt = renewedUntil
        }
      }).catch(() => {
        if (socket.readyState === 1) socket.close(1011, 'Relay presence unavailable')
      }).finally(() => {
        renewing = false
      })
    }, Math.floor(RELAY_PRESENCE_TTL_MS / 3))

    // Serialize asynchronous Redis decisions to preserve ingress dispatch order.
    // Once the socket is closed/exhausted, queued frames must never dispatch.
    let pending = Promise.resolve()
    let stopped = false
    let queuedBytes = 0
    let queuedFrames = 0
    const MAX_PENDING_BYTES = 256 * 1024
    const MAX_PENDING_FRAMES = 60
    socket.on('message', (raw: Buffer) => {
      if (stopped || !webSocketRelayTransportProvider.ownsSocket(participantId, socket)) return
      if (raw.byteLength > RELAY_FRAME_MAX_BYTES) {
        stopped = true
        socket.close(1009, 'Relay frame exceeds maximum size')
        return
      }
      // Capture raw data synchronously: the callback must not retain mutable
      // WebSocket-owned buffers across the Redis await.
      if (queuedFrames >= MAX_PENDING_FRAMES || raw.byteLength > MAX_PENDING_BYTES - queuedBytes) {
        stopped = true
        socket.close(1008, 'Relay pending byte budget exceeded')
        return
      }
      const frame = Buffer.from(raw)
      queuedBytes += frame.byteLength
      queuedFrames++
      pending = pending.then(async () => {
        if (stopped || !webSocketRelayTransportProvider.ownsSocket(participantId, socket)) return
        // Blind forward: enforce raw byte budgets without parsing payload.
        if (!await consumeSharedRelayBudget(participantId, frame.byteLength)) {
          stopped = true
          socket.close(1008, 'Relay resource budget exceeded')
          return
        }
        if (!stopped && socket.readyState === 1 && webSocketRelayTransportProvider.ownsSocket(participantId, socket)) {
          webSocketRelayTransportProvider.dispatchIncoming(participantId, frame.toString())
        }
      }).catch(() => {
        // Unexpected asynchronous failures are also fail closed.
        stopped = true
        socket.close(1011, 'Relay unavailable')
      }).finally(() => {
        queuedBytes -= frame.byteLength
        queuedFrames--
      })
    })

    socket.on('close', () => {
      clearInterval(leaseTimer)
      void releaseRelayPresence(participantId, leaseToken).catch(() => undefined)
      stopped = true
      webSocketRelayTransportProvider.unregisterSocket(participantId, socket)
    })
  })
}
