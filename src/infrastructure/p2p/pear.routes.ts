/**
 * P2P Transport routes — API_REFERENCE.md section 7. Infrastructure
 * layer (not a module) — these wrap `pearNodeRegistry` only, per that
 * doc's implementation note: never instantiate `PearNode` directly.
 *
 * Every route requires auth — a caller can only start/stop/broadcast on
 * their own node (`req.participantId` from the session, never a bare
 * `userId` in the body).
 *
 * POST /v1/peers/join-trade moved to modules/open-p2p/trade.routes.ts
 * (Missão 06.10, same URL — see that file's header comment and RFC-002's
 * dated amendment for the full reasoning). It needed a Trade-domain
 * authorization decision (is this actor a party to this trade?) that
 * this file structurally cannot make without infrastructure/ importing
 * modules/ — a dependency direction that's never existed and stays
 * rejected. Every route still here (start/stop/status/join-topic/
 * broadcast-offer) has no such decision to make: they act only on the
 * caller's own node/identity, never on another domain's entity.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pearNodeRegistry } from './pear.service'
import { fallbackTransportProvider } from './transport-provider'
import { requireAuth } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { docsOnlySchema } from '../../common/openapi'

const joinTopicSchema = z.object({
  topic: z.enum(['marketplace', 'btc', 'lnBtc', 'liquidBtc', 'usdtErc20', 'usdtLiquid']),
})

const broadcastOfferSchema = z.object({
  offerId: z.string().min(1),
  asset: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  priceUsd: z.string().min(1),
})

export async function peerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/peers/start', {
    preHandler: requireAuth,
    schema: { tags: ['peers'] },
  }, async (request, reply) => {
    const participantId = (request as AuthenticatedRequest).participantId
    // Pears first, WebSocket relay (`/ws/relay`) only if Pears doesn't
    // connect within the timeout — see transport-provider.ts's
    // FallbackTransportProvider. `transport` tells the caller which one
    // actually won, so a client can show a degraded-connectivity state:
    // a participant on 'websocket-relay' can still start()/sendToPeer(),
    // but /v1/peers/join-trade and /v1/peers/broadcast-offer below still
    // require a real PearNode and will 409 for them — a relay has no DHT
    // topic to join.
    //
    // Key-custody fix (2026-08-09) — this route no longer accepts a
    // caller-supplied secret key in the body. PearNode.start() generates
    // its own ephemeral per-session Ed25519 identity now (that file's
    // own doc comment has the full reasoning); a request body here was
    // the one point this key ever transited the network, and it's gone.
    const { peerId } = await fallbackTransportProvider.start(participantId)
    const transport = fallbackTransportProvider.activeTransportName(participantId)
    // Explicitly expose degraded capabilities; relay readiness is not DHT discovery.
    const capabilities = transport === 'websocket-relay'
      ? { directRelay: true, topicDiscovery: false, topicBroadcast: false }
      : { directRelay: false, topicDiscovery: true, topicBroadcast: true }
    return reply.code(200).send({ success: true, data: { peerId, transport, capabilities } })
  })

  app.post('/v1/peers/stop', {
    preHandler: requireAuth,
    schema: { tags: ['peers'] },
  }, async (request, reply) => {
    const participantId = (request as AuthenticatedRequest).participantId
    await fallbackTransportProvider.stop(participantId)
    return reply.code(200).send({ success: true })
  })

  app.get('/v1/peers/status', {
    preHandler: requireAuth,
    schema: { tags: ['peers'] },
  }, async (request, reply) => {
    const participantId = (request as AuthenticatedRequest).participantId
    const status = pearNodeRegistry.getStatus(participantId)
    return reply.code(200).send({ success: true, data: status })
  })

  app.post('/v1/peers/join-topic', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['peers'], body: joinTopicSchema }),
  }, async (request, reply) => {
    const body = joinTopicSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const node = pearNodeRegistry.get(participantId)
    // PRODUCTION_READINESS_FIXES.md P1 item 17, closed 2026-08-08 — 409
    // is the right status here (a real precondition: caller hasn't
    // started a node yet, not "this route doesn't exist"), but the
    // error CODE said 'NOT_FOUND', mismatched with its own HTTP status.
    // Same fix applied to the two other "no active node" checks below.
    if (!node) {
      return reply.code(409).send({ success: false, error: 'CONFLICT', message: 'No active node — call POST /v1/peers/start first', details: [] })
    }
    await node.joinTopic(body.topic)
    return reply.code(200).send({ success: true })
  })

  app.post('/v1/peers/broadcast-offer', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['peers'], body: broadcastOfferSchema }),
  }, async (request, reply) => {
    const body = broadcastOfferSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const node = pearNodeRegistry.get(participantId)
    if (!node) {
      return reply.code(409).send({ success: false, error: 'CONFLICT', message: 'No active node — call POST /v1/peers/start first', details: [] })
    }
    const sent = node.broadcast({ kind: 'offer_announce', ...body })
    return reply.code(200).send({ success: true, data: { deliveredTo: sent } })
  })
}
