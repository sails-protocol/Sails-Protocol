/**
 * Sails OpenP2P chat routes — API_REFERENCE.md section 5 (WebSocket
 * protocol) + the message-history GET route.
 *
 * Unified with negotiation.service.ts's HumanChatChannel (the Pears
 * transport) as of the chat-unification pass: this route no longer
 * broadcasts NEW_MESSAGE itself after a SEND_MESSAGE — it only persists
 * the Message and emits openp2p.message.sent, same as HumanChatChannel
 * already did. common/events/handlers.ts's single reaction to that event
 * is what pushes NEW_MESSAGE to every WS-connected room member, so a
 * message sent via Pears (HumanChatChannel) now reaches WS clients
 * watching that trade too.
 *
 * WS -> Pears relay (added this pass, best-effort, not full symmetry —
 * documented, not silently claimed as complete): `sendToPeer()` only
 * exists on the *sending* identity's own PearNode — there is no way to
 * transmit "over Pears" on behalf of a participant who never called
 * `POST /v1/peers/start`, the same way you can't send an email as
 * someone whose mail server you don't control. So relaying here is only
 * possible, and only attempted, when the WS-connected sender *also*
 * happens to have an active PearNode (mirrors exactly what
 * `HumanChatChannel.sendEvent()` already does). If they don't, there is
 * genuinely nothing to relay — not a bug, a structural limit of
 * peer-to-peer transports.
 *
 * A deeper, separate gap found while investigating this and fixed in a
 * later pass: incoming Pears messages had no consumer at all —
 * `HumanChatChannel.onEvent()` was defined but never called anywhere.
 * JOIN_TRADE below now wires one via `wireInboundNegotiationChannel()`
 * (negotiation.service.ts), which also closed a second issue found
 * alongside it: the handler had no check that an inbound event's claimed
 * sender matched the connection's actual handshake-verified identity.
 * The wiring and its same-process dedup guard are covered by
 * `tests/negotiationInboundChannel.test.ts` against a mocked PearNode —
 * a live two-node Pears/HyperDHT setup is still needed to verify the
 * real wire round trip end-to-end (the same limitation
 * `PearsTransportProvider`'s own tests already decline to fake); see
 * `BACKLOG.md` P0's Transport Provider row and `TODO.md` §1.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../common/database'
import { eventBus } from '../../common/events/event-bus'
import { requireAuth } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { resolveParticipantFromTicket } from '../../common/middleware/ws-auth'
import { joinRoom, leaveRoom, broadcastToTrade, type RoomMember } from './chat-room-registry'
import { checkWsMessageRateLimit } from './ws-message-rate-limiter'
import { recordSuspiciousActivity } from '../../common/security/suspicious-activity'
import { pearNodeRegistry } from '../../infrastructure/p2p/pear.service'
import { wireInboundNegotiationChannel } from './negotiation.service'
import { tradeService } from './trade.service'
import { docsOnlySchema } from '../../common/openapi'

// Auto-push escrow/trade status changes to whoever's currently watching
// that trade's room — API_REFERENCE.md's TRADE_STATUS_UPDATE/
// ESCROW_STATUS_UPDATE server messages. Registered once at module load,
// not per-connection. (NEW_MESSAGE's equivalent registration lives in
// common/events/handlers.ts now, alongside the rest of the Outcome
// Engine / cross-module reactions, not here — see this file's own doc
// comment above for why.)
eventBus.on('openp2p.trade.status_changed', (payload) => {
  broadcastToTrade(payload.tradeId, { type: 'TRADE_STATUS_UPDATE', payload })
})
eventBus.on('settlement.escrow.locked', (payload) => broadcastToTrade(payload.tradeId, { type: 'ESCROW_STATUS_UPDATE', payload }))
eventBus.on('settlement.escrow.payment_pending', (payload) => broadcastToTrade(payload.tradeId, { type: 'ESCROW_STATUS_UPDATE', payload }))
eventBus.on('settlement.escrow.released', (payload) => broadcastToTrade(payload.tradeId, { type: 'ESCROW_STATUS_UPDATE', payload }))
eventBus.on('settlement.escrow.disputed', (payload) => broadcastToTrade(payload.tradeId, { type: 'ESCROW_STATUS_UPDATE', payload }))
eventBus.on('settlement.escrow.refunded', (payload) => broadcastToTrade(payload.tradeId, { type: 'ESCROW_STATUS_UPDATE', payload }))
// RFC-017 — SocialEngineeringAgent's detection (common/events/handlers.ts,
// off by default behind config.features.socialEngineeringDetection)
// reaches WS clients the same way every other server-pushed status
// update in this file does. Detection only: this pushes a signal for a
// human to see, it never blocks or alters the trade itself.
eventBus.on('agents.social_engineering.risk_detected', (payload) => broadcastToTrade(payload.tradeId, { type: 'RISK_WARNING', payload }))

const joinTradeSchema = z.object({ tradeId: z.string().min(1) })
const sendMessageSchema = z.object({
  tradeId: z.string().min(1),
  content: z.string().min(1).max(10000),
  msgType: z.enum(['TEXT', 'IMAGE', 'FILE']).default('TEXT'),
})

const tradeIdParamsSchema = z.object({ tradeId: z.string().min(1) })
const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const MAX_QUEUED_MESSAGES_PER_SOCKET = 32

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/openp2p/chat', { websocket: true }, async (socket, request) => {
    const query = request.query as { ticket?: string }

    // Missão 08B Fase 12 root cause — this listener must be attached
    // SYNCHRONOUSLY, before the `await resolveParticipantFromTicket()`
    // below, not after. The underlying `ws` connection starts emitting
    // 'message' events for incoming frames the instant the WS upgrade
    // completes — it does not buffer them for a listener registered
    // later. A client's `WebSocketChannel` sends `JOIN_TRADE` the moment
    // its own socket reports 'open' (openp2p.ts), which can — and, per
    // this mission's real 2-process restart acceptance test, reliably
    // does on a just-restarted (cold) instance — arrive before this
    // async handler resumes past its first `await`. Previously,
    // `socket.on('message', ...)` was registered only after that await,
    // so a `JOIN_TRADE` arriving in that window was silently dropped:
    // the socket stayed open, the room was never joined, and every
    // later cross-instance-relayed message for that trade found nobody
    // to broadcast to (chat-room-registry.ts's `rooms` empty for that
    // tradeId) — reproducible via generation-tagged client/server
    // instrumentation, not assumed. Fix: attach the listener first,
    // queue any frame that arrives before ticket resolution finishes,
    // then drain the queue in order once `participantId` is known.
    const pendingRaw: Buffer[] = []
    let handleMessage: ((raw: Buffer) => Promise<void>) | null = null
    let processing = false
    let closed = false
    let participantId: string | null = null
    const joined = new Set<string>()

    const cleanup = () => {
      closed = true
      pendingRaw.length = 0
      for (const tradeId of joined) {
        leaveRoom(tradeId, socket)
        broadcastToTrade(tradeId, { type: 'USER_OFFLINE', payload: { tradeId, participantId } })
      }
      joined.clear()
    }
    socket.on('close', cleanup)

    const drain = async () => {
      if (processing || closed || !handleMessage) return
      processing = true
      try {
        while (pendingRaw.length > 0 && !closed) {
          const raw = pendingRaw.shift()!
          await handleMessage(raw)
        }
      } finally {
        processing = false
        if (pendingRaw.length > 0 && !closed) void drain()
      }
    }

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (closed) return
      if (isBinary) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Binary messages are not supported' } }))
        socket.close()
        return
      }
      if (!handleMessage && pendingRaw.length >= 1) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Too many messages before authentication' } }))
        socket.close()
        return
      }
      if (pendingRaw.length >= MAX_QUEUED_MESSAGES_PER_SOCKET) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Too many messages in flight' } }))
        socket.close()
        return
      }
      pendingRaw.push(raw)
      void drain()
    })

    const resolvedParticipantId = await resolveParticipantFromTicket(query.ticket)
    if (!resolvedParticipantId) {
      pendingRaw.length = 0
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Missing, invalid, or already-used ticket query param — call POST /v1/identity/ws-ticket first' } }))
      socket.close()
      return
    }
    participantId = resolvedParticipantId

    handleMessage = async (raw: Buffer) => {
      let msg: { type: string; payload?: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Malformed JSON' } }))
        return
      }

      try {
        if (msg.type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG', payload: {} }))
          return
        }

        if (msg.type === 'JOIN_TRADE') {
          const { tradeId } = joinTradeSchema.parse(msg.payload)
          const trade = await tradeService.assertParticipant(tradeId, participantId)

          const member: RoomMember = { socket, participantId }
          joinRoom(tradeId, member)
          joined.add(tradeId)
          broadcastToTrade(tradeId, { type: 'USER_ONLINE', payload: { tradeId, participantId } }, socket)

          // Consume negotiation events arriving over this participant's
          // own Pears/HyperDHT connection for this trade — see this
          // file's header comment for the gap this closes. No-ops if the
          // participant never called POST /v1/peers/start (no local
          // PearNode to attach to).
          const counterpartyId = participantId === trade.buyerId ? trade.sellerId : trade.buyerId
          wireInboundNegotiationChannel(participantId, counterpartyId, tradeId)
          return
        }

        if (msg.type === 'LEAVE_TRADE') {
          const { tradeId } = joinTradeSchema.parse(msg.payload)
          leaveRoom(tradeId, socket)
          joined.delete(tradeId)
          broadcastToTrade(tradeId, { type: 'USER_OFFLINE', payload: { tradeId, participantId } })
          return
        }

        if (msg.type === 'SEND_MESSAGE') {
          // 2026-08-15 security review: @fastify/rate-limit (app.ts) never
          // sees this — it's a `message` frame on an already-open socket,
          // not a new HTTP request. See ws-message-rate-limiter.ts.
          if (!checkWsMessageRateLimit(participantId)) {
            recordSuspiciousActivity('RATE_LIMITED', participantId, request.log)
            socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Rate limit exceeded — slow down' } }))
            return
          }

          const body = sendMessageSchema.parse(msg.payload)
          const trade = await tradeService.assertParticipant(body.tradeId, participantId)

          const message = await prisma.message.create({
            data: {
              tradeId: body.tradeId,
              senderId: participantId,
              content: body.content,
              msgType: body.msgType,
            },
          })

          // No direct broadcastToTrade() call here anymore — handlers.ts's
          // reaction to this same event is now the single place NEW_MESSAGE
          // gets pushed, so a message sent via this route and one sent via
          // HumanChatChannel/Pears both reach WS room members the same way.
          await eventBus.emit('openp2p.message.sent', {
            messageId: message.id,
            tradeId: body.tradeId,
            senderId: participantId,
            content: body.content,
            msgType: body.msgType,
            timestamp: message.createdAt.toISOString(),
          }, body.tradeId)

          // Best-effort WS -> Pears relay — see this file's own doc comment
          // for why this only fires when the sender has an active PearNode,
          // and why that's the actual boundary of what's possible here, not
          // an arbitrary restriction. Never awaited into the response —
          // Pears delivery is fire-and-forget everywhere else in this
          // codebase (RFC-002's "never assumes continuous connectivity"),
          // and a WS client shouldn't wait on it either.
          const senderNode = pearNodeRegistry.get(participantId)
          if (senderNode) {
            const recipientId = participantId === trade.buyerId ? trade.sellerId : trade.buyerId
            senderNode.sendToPeer(recipientId, {
              kind: 'negotiation_event',
              tradeId: body.tradeId,
              event: { type: 'MESSAGE_EXCHANGED', by: participantId, content: body.content, at: message.createdAt.toISOString() },
            })
          }
          return
        }

        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: `Unknown message type: ${msg.type}` } }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error'
        // Missão 07.6 release-readiness audit — this catch previously only
        // told the client something failed; an operator had no server-side
        // trace at all for a failed JOIN_TRADE/SEND_MESSAGE/LEAVE_TRADE
        // (a ForbiddenError from assertParticipant, a Prisma failure, an
        // event-bus publish failure). Every other failure path in this
        // codebase logs; this one silently didn't.
        request.log.error({ participantId, msgType: msg.type, err: message }, 'chat WS message handler failed')
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message } }))
      }
    }

    void drain()
  })

  // requireAuth + participant check — found while writing tests for this
  // route: it had no auth at all, while the WS side (JOIN_TRADE/
  // SEND_MESSAGE above) already restricts a trade's room to its two
  // parties. Leaving this REST read open would have made negotiation
  // content readable by anyone who guessed a tradeId.
  app.get('/v1/openp2p/chat/:tradeId/messages', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-p2p'], params: tradeIdParamsSchema, querystring: paginationQuerySchema }),
  }, async (request, reply) => {
    const { tradeId } = tradeIdParamsSchema.parse(request.params)
    const { limit, offset } = paginationQuerySchema.parse(request.query)
    const participantId = (request as AuthenticatedRequest).participantId
    await tradeService.assertParticipant(tradeId, participantId)
    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where: { tradeId },
        orderBy: { createdAt: 'asc' },
        take: limit ?? 50,
        skip: offset ?? 0,
      }),
      prisma.message.count({ where: { tradeId } }),
    ])
    return reply.code(200).send({
      success: true,
      data: {
        items,
        total,
        hasMore: (offset ?? 0) + items.length < total,
        nextOffset: (offset ?? 0) + items.length < total ? (offset ?? 0) + items.length : null,
      },
    })
  })
}
