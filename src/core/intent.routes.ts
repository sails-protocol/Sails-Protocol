/**
 * Intent API routes — 03-implementation_plan.md section 4.
 *
 * Deliberately thin: request-shape validation via zod (already wired into
 * app.ts's error handler — a ZodError here becomes a 400 VALIDATION_ERROR
 * automatically), everything else delegates to core/intent-engine.ts. This
 * route must never re-implement the Byzantine/Economic rules — those live
 * once, in the Core, so every future entry point (SDK, a second HTTP
 * route, an agent calling the engine directly) gets them for free.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { intentEngine } from '../core/intent-engine'
import { intentRepository } from '../core/intent-repository'
import { evaluateIntentPolicy } from '../core/policy-engine'
import { CAPABILITY_IMPLEMENTATIONS } from '../core/capability-registry'
import { liquidityRouter } from '../modules/open-liquidity/liquidity.service'
import { requireAuth } from '../common/middleware/auth'
import type { AuthenticatedRequest } from '../common/middleware/auth'
import { config } from '../config'
import { NotFoundError, ForbiddenError, ValidationError } from '../common/errors'
import { docsOnlySchema } from '../common/openapi'
import type { IntentType, IntentStatus, TradeIntentPayload } from '../common/types/intent'
import type { AssetType } from '../common/types'
import { assertRailOpen } from '../common/day0-closed-rails'

// Fase 1 Red Team finding: asset/currency/fiatMethod were open
// z.string(), letting adversarial free text ride all the way into
// QvacAgentProvider.assessIntentRisk()'s prompt unsanitized
// (tests/qvac-prompt-injection.test.ts confirmed this live, against the
// real model — a fiatMethod containing a fake "SYSTEM OVERRIDE"
// instruction flipped a high-risk/reject assessment to low-risk/proceed
// on an identical trade; a live re-check found `asset` exploitable the
// identical way). Restricted to the same real enums
// common/types/index.ts's AssetType/FiatCurrency/PaymentMethod already
// declare — closes the vector at the API boundary, not just at the
// prompt layer (see qvac-agent.provider.ts's RISK_SYSTEM_PROMPT for the
// defense-in-depth layer on top of this). `asset` costs nothing to
// restrict: Offer.asset/Trade.asset/Escrow.asset are already constrained
// to this same AssetType at the Prisma level, so an Intent using
// anything outside it would fail downstream anyway.
const tradeIntentPayloadSchema = z.object({
  asset: z.enum(['BTC', 'USDT_ERC20', 'USDT_TRC20', 'USDT_LIQUID', 'USDT_LIGHTNING', 'LN_BTC', 'LIQUID_BTC', 'SPARK', 'STACKS', 'RSK_BTC']),
  side: z.enum(['BUY', 'SELL']),
  maxValue: z.string().optional(),
  minValue: z.string().optional(),
  currency: z.enum(['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'NGN', 'INR']).optional(),
  fiatMethod: z.enum(['PIX', 'TED', 'BANK_TRANSFER', 'CRYPTO_DIRECT', 'LIGHTNING_DIRECT', 'CASH', 'OTHER']).optional(),
  network: z.string().optional(),
  slippageTolerance: z.number().optional(),
  // RFC-013 — zod's default z.object() strips unrecognized keys rather
  // than rejecting them, so these need to be listed explicitly here or
  // they'd be silently dropped before ever reaching intent-engine.ts's
  // own bounds check, for every caller of this route (including
  // @satsails/p2p-trading-sdk's createIntent()).
  minReputationScore: z.number().optional(), // UX-048; bounds and the alias rule are checked in intent-handler.ts
  minReputationRating: z.number().optional(), // deprecated alias of minReputationScore
  // RFC-023 — same "must be listed explicitly or zod silently strips it"
  // reasoning as minReputationRating above. Decimal strings (RFC-009),
  // not z.number(), same convention as maxValue/minValue.
  maxPriceUsd: z.string().optional(),
  minPriceUsd: z.string().optional(),
})

const createIntentSchema = z.object({
  type: z.literal('TradeIntent'), // only IntentType with a registered handler today (§2.3)
  payload: tradeIntentPayloadSchema,
  agentId: z.string().optional(),
})

// RFC-023 — `amount` is inherently per-request (createTrade()'s own
// signature takes it the same way), not a fixed point value the Intent's
// own minValue/maxValue *range* could supply on its own.
const proposeIntentSchema = z.object({
  amount: z.string(), // decimal string — RFC-009
})

export async function intentRoutes(app: FastifyInstance): Promise<void> {
  // Gap-audit fix: this route previously took `participantId` directly
  // from the request body with no auth at all — the exact RT-002
  // vulnerability auth.ts's own doc comment warns against
  // ("a route that reads req.body.userId directly instead of
  // req.participantId set by this middleware is exactly the RT-002
  // vulnerability again"), reintroduced here specifically. Anyone could
  // previously create a TradeIntent attributed to any participantId with
  // no proof they controlled that identity. participantId is now derived
  // from the authenticated session only, never trusted from the body —
  // same pattern every other mutating route in this codebase already
  // uses (liquidity.routes.ts, trade.routes.ts, settlement.routes.ts).
  // PRODUCTION_READINESS_FIXES.md P0, closed 2026-08-08 — every other
  // module registers its routes under /v1/..., never /api/v1/...; this
  // was the one inconsistent prefix in the whole API surface.
  app.post('/v1/intents', {
    preHandler: requireAuth,
    schema: {
      tags: ['intent'],
      body: {
        type: 'object',
        required: ['type', 'payload'],
        properties: {
          type: { type: 'string' },
          payload: { type: 'object' },
          agentId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = createIntentSchema.parse(request.body)
    assertRailOpen({ asset: body.payload.asset }) // Despacho 064: no LN_BTC intent is born
    const participantId = (request as AuthenticatedRequest).participantId
    const intent = await intentEngine.create<TradeIntentPayload>(
      body.type as IntentType,
      body.payload,
      participantId,
      body.agentId
    )
    return reply.code(201).send({ success: true, data: intent })
  })

  // Gap-audit fix: same RT-002-class issue as above, plus no ownership
  // check at all — any caller could cancel any Intent by id.
  // intentEngine.cancel() now requires cancelledBy and verifies it
  // against the Intent's own participantId.
  app.delete('/v1/intents/:id', {
    preHandler: requireAuth,
    schema: { tags: ['intent'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    await intentEngine.cancel(id, participantId)
    return reply.code(200).send({ success: true })
  })

  // RFC-023 (rfcs/RFC-023-qvac-negotiated-trade-proposal.md) — the backend
  // half of making packages/sails-ui's "AI Negotiator" real. Given a
  // persisted TradeIntent's own declared price/reputation limits, finds a
  // real matching Offer (liquidityRouter.proposeForIntent()) and returns
  // it for the human to approve — this route never creates a Trade
  // itself. Approval is the EXISTING, unmodified POST /v1/openp2p/trades
  // flow (trade.service.ts createTrade()), called by the client with the
  // returned offerId — this route never calls it, and open-settlement is
  // never imported by this file. That boundary is intentional: the CTO's
  // explicit instruction was QVAC gets discovery/negotiation authority,
  // never settlement authority — those are two separably-gated
  // capabilities, not one.
  app.post('/v1/intents/:id/propose', {
    preHandler: requireAuth,
    ...docsOnlySchema({
      tags: ['intent'],
      params: z.object({ id: z.string().min(1) }),
      body: proposeIntentSchema,
    }),
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const { amount } = proposeIntentSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId

    const record = await intentRepository.findById(id)
    if (!record) throw new NotFoundError('Intent', id)

    const status = record.status as IntentStatus
    const payload = record.payload as unknown as TradeIntentPayload
    const amountNum = Number(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new ValidationError(`amount must be a positive decimal string, got "${amount}"`)
    }

    // Missão 03 — ownership/expiry/status/capability/amount-bounds, all
    // through the one named Policy decision (core/policy-engine.ts). The
    // price/reputation limits this route reads come from the *persisted*
    // Intent row, never re-trusted from the request body — the whole
    // reason this lives under /v1/intents/:id rather than an
    // unauthenticated /v1/liquidity/ route that would accept them as raw
    // params instead. Capability scope reuses 'intent.discovering' — the
    // real event this action can produce (see the transition below) —
    // rather than inventing a separate scope vocabulary, same convention
    // intent-engine.ts's own 'intent.created' check already set.
    const decision = await evaluateIntentPolicy({
      action: 'intent.propose',
      intent: { id: record.id, participantId: record.participantId, status, expiresAt: record.expiresAt },
      requestedBy: participantId,
      allowedStatuses: ['COORDINATED', 'DISCOVERING'],
      requireCapability: config.features.enforceCapabilities,
      capabilityName: CAPABILITY_IMPLEMENTATIONS.openp2p,
      capabilityScope: 'intent.discovering',
      requestedAmount: { amount, minValue: payload.minValue, maxValue: payload.maxValue },
    })
    if (decision.effect === 'DENY') {
      if (decision.denialCategory === 'forbidden') throw new ForbiddenError(decision.reason)
      throw new ValidationError(decision.reason)
    }

    const { match, counterProposal } = await liquidityRouter.proposeForIntent(
      payload.asset as AssetType, payload.side, amount,
      { priceMin: payload.minPriceUsd, priceMax: payload.maxPriceUsd, minReputation: payload.minReputationRating, minReputationScore: payload.minReputationScore }
    )

    // COORDINATED's only forward transition is DISCOVERING
    // (state-machine.ts) — a freshly-created Intent is already sitting
    // there by the time it could ever reach this route
    // (intentEngine.create() drives it there synchronously before
    // returning). Skipped on a retried call (already DISCOVERING) —
    // transitioning DISCOVERING -> DISCOVERING isn't valid and would
    // throw. Deliberately NOT transitioning further (MATCHED/NEGOTIATING
    // mean "a real Trade now exists" elsewhere in this codebase, per
    // trade.service.ts's own comment on its identical-looking three-step
    // transition) — this buyer-side Intent tops out at DISCOVERING and
    // later expires via its own expiresAt; fully unifying it with the
    // *offer's own* separate Intent (the one createTrade() itself walks
    // forward once approved) would mean touching createTrade(),
    // explicitly out of scope for this RFC.
    if (status === 'COORDINATED') {
      const note = match
        ? `QVAC proposal: matched offer ${match.id} @ ${match.priceUsd}`
        : counterProposal
          ? `QVAC counter-proposal: suggested ${counterProposal.suggestedPriceUsd} vs listed ${counterProposal.listedPriceUsd} (ref offer ${counterProposal.referenceOfferId})`
          : 'QVAC proposal: no match found within declared limits'
      await intentEngine.transition(id, 'DISCOVERING', participantId, 'intent.discovering', { intentId: id }, note)
    }

    return reply.code(200).send({
      success: true,
      data: {
        proposal: match ? {
          offerId: match.id,
          priceUsd: match.priceUsd,
          amount,
          traderReputation: match.traderReputation ?? null,
          paymentMethods: match.paymentMethods,
        } : null,
        // Missão 02 Fase 4 — additive field, present alongside `proposal`
        // (never both non-null at once). Informational only: `referenceOfferId`
        // is not accepted by any trade-creation or settlement call — see
        // liquidity.service.ts's CounterProposal doc comment.
        counterProposal,
      },
    })
  })
}
