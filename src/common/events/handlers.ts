import { prisma } from '../database'
import { applyEventProjectionOnce, TRANSITION_PROJECTED_KEY, type ProjectionTx } from './event-projection'
import { tradeRepository } from '../../modules/open-p2p/trade-repository'
import type { Prisma } from '@prisma/client'
import { eventBus } from './event-bus'
import { reconciliationService } from '../../modules/open-p2p/reconciliation.service'
import { reputationService } from '../../modules/open-reputation/reputation.service'
import { vouchService } from '../../modules/open-reputation/vouch.service'
import { broadcastToTrade } from '../../modules/open-p2p/chat-room-registry'
import { executeSettlement } from '../../modules/open-settlement/settlement-orchestrator'
import { wdkSettlementProvider, buyerIndexFor } from '../../modules/open-settlement/wdk-settlement.provider'
import { intentEngine } from '../../core/intent-engine'
import { config } from '../../config'
import { escrowsCreatedTotal, escrowsReleasedTotal, escrowsRefundedTotal, disputesOpenedTotal, qvacDetectionFailuresTotal } from '../metrics'
import { childLogger } from '../logger'

const log = childLogger('handlers')

// RFC-018 — 'system:trade-lifecycle' for every Intent transition this
// dispatcher drives on a trade's behalf, matching the existing
// 'system:expiry-check' sentinel convention (core/intent-engine.ts's
// own expiry transitions) for system-triggered, non-participant events.
const INTENT_LIFECYCLE_TRIGGER = 'system:trade-lifecycle'

/**
 * Sails Protocol — Coordination Protocol (Event Handlers)
 *
 * This file is the ONLY place where cross-module reactions happen.
 * No module ever imports another module's service directly — they only
 * emit events (see event-bus.ts) and this dispatcher reacts to them.
 *
 * Ownership map (who reacts to what, and why):
 *   - settlement.escrow.created   → OpenP2P reacts (Trade.escrowId = escrow.id
 *                                   — the FK escrow.service.ts's own module-
 *                                   boundary rule forbids it from writing itself)
 *   - settlement.escrow.locked    → OpenP2P reacts (Trade.status = ACTIVE)
 *   - settlement.escrow.released  → OpenP2P reacts (Trade.status = COMPLETED)
 *                                   OpenReputation reacts (increment stats,
 *                                   recordOutcome() — dispute-aware, see below;
 *                                   RFC-021 D7 — burns the losing seller's
 *                                   active vouch, if any, on a dispute loss)
 *   - settlement.escrow.disputed  → OpenP2P reacts (Trade.status = DISPUTED)
 *                                   OpenReputation reacts (disputeCount += 1 for
 *                                   both sides — Issue #253, moved inline here
 *                                   from a separate openp2p.trade.disputed
 *                                   consumer so it shares this transition's own
 *                                   PASS 3 recovery, see recordDisputeCount())
 *   - settlement.escrow.refunded  → OpenP2P reacts (Trade.status = CANCELLED)
 *                                   OpenReputation reacts (recordOutcome() —
 *                                   dispute-aware, see below; RFC-021 D7 —
 *                                   same vouch-burn reaction, for the buyer)
 *   - settlement.escrow.split     → OpenP2P reacts (Trade.status = COMPLETED
 *                                   — RFC-021 D9, only ever a dispute
 *                                   outcome, no happy-path equivalent)
 *                                   OpenReputation reacts (recordOutcome()
 *                                   NEUTRAL for both — no vouch burned,
 *                                   see that handler's own comment)
 *   - peer.connected              → OpenP2P reacts (RFC-011: reconcile every
 *                                   active trade shared with the peer that
 *                                   just (re)connected against Postgres, the
 *                                   authoritative source a dropped P2P
 *                                   message never actually lost data from)
 *   - openp2p.message.sent        → OpenP2P reacts (pushes NEW_MESSAGE to
 *                                   every WS-connected chat-room member for
 *                                   that trade — chat-unification pass, see
 *                                   chat-room-registry.ts's doc comment.
 *                                   Both chat.routes.ts's WS route and
 *                                   negotiation.service.ts's HumanChatChannel
 *                                   emit this same event after persisting a
 *                                   Message, so this is the one place either
 *                                   transport's messages reach WS clients)
 *   - openp2p.message.sent        → OpenAgents reacts, ONLY when
 *                                   config.features.socialEngineeringDetection
 *                                   is true (default false — real QVAC call
 *                                   per message, not free): SocialEngineering
 *                                   Agent.evaluate() (RFC-007 D7, real as of
 *                                   RFC-017) scores the message for
 *                                   off_channel_migration/payment_instruction_
 *                                   change; a non-null signal is re-emitted as
 *                                   agents.social_engineering.risk_detected,
 *                                   which chat.routes.ts broadcasts as a
 *                                   RISK_WARNING to the trade's WS room —
 *                                   detection only, never an automatic action.
 *   - openp2p.trade.created        → OpenSettlement reacts, ONLY when
 *                                   config.features.autoSettleOnMatch is
 *                                   true (default false — see config's own
 *                                   comment): calls settlement-orchestrator.ts's
 *                                   executeSettlement(), the real end-to-end
 *                                   escrow-lock -> emulated-PIX-receipt ->
 *                                   signed-WDK-release sequence. This is
 *                                   "the P2P engine giving Match" in this
 *                                   codebase's actually-built code — the
 *                                   Intent Engine's own MATCHED state has
 *                                   no real matching engine wired to it yet.
 *
 * RFC-007 D8/D9's Outcome Engine, applied at the settlement.escrow.released/
 * refunded handlers below: the same fund movement (release or refund) means
 * something different depending on how the trade got there. A plain happy-
 * path completion/cancellation is Positive/Neutral for both parties; a
 * dispute RELEASE/REFUND ruling means one party won and the other lost —
 * checked here via a resolved Dispute row for the trade, since the escrow
 * event payload itself doesn't carry that context.
 *
 * NOTE: In this reference implementation, OpenP2P's Trade-status writes
 * below still happen directly in this dispatcher rather than through a
 * `tradeService.markActive()`-style call — trade.service.ts (added in the
 * route-restoration pass) owns Trade *creation*, not yet these reactive
 * status transitions. Moving them there is a clean, low-risk follow-up,
 * not done in this pass to keep the diff scoped to what OpenReputation
 * actually needed.
 */

// ─── Shared helpers ─────────────────────────────────────────────────────────────
// Extracted from the inline blocks below (escrow.released/refunded both ran
// the same 2x user.update for totalTrades/totalVolumeBtc; both ran the same
// `if (resolved) X else Y` dispute-aware branch; both ran the same final
// intent transition walk). One source of truth keeps each behavior consistent
// and lets the "did this settlement come from a dispute?" rule evolve in one
// place — the same Outcome Engine concept RFC-007 D8/D9 introduces for the
// reputation side.

/** Increments totalTrades + totalVolumeBtc for both sides — used by every
 *  trade-completion path (release, split, and any future non-disputed
 *  settlement). trade.amount is already a Prisma.Decimal.
 *
 *  Deliberately sequential (await + await, not Promise.all) — the existing
 *  test suite in tests/reputationOutcome.test.ts asserts on call order via
 *  `mockUserUpdate.mock.calls.filter(...)`, and matching the original
 *  implementation's call sequence keeps that contract visible. With one
 *  real DB query per side this isn't a hot enough path to need parallelism. */
async function recordTradeCompletion(tx: ProjectionTx, buyerId: string, sellerId: string, amount: Prisma.Decimal): Promise<void> {
  await tx.user.update({
    where: { id: buyerId },
    data: { totalTrades: { increment: 1 }, totalVolumeBtc: { increment: amount } },
  })
  await tx.user.update({
    where: { id: sellerId },
    data: { totalTrades: { increment: 1 }, totalVolumeBtc: { increment: amount } },
  })
}

/** Issue #253 - increments disputeCount for both sides, exactly once per (durable eventId, tradeId) — the
 *  same atomic claim+effect shape as recordTradeCompletion() above. Previously this ran from a SEPARATE,
 *  non-durable `eventBus.on('openp2p.trade.disputed', ...)` handler with no idempotency claim of its own:
 *  a crash between the two increments (or any failure after the notification event was durably published)
 *  silently lost the effect forever, since nothing ever re-drove that derived notification event. Moved
 *  inline to the settlement.escrow.disputed onDurable() handler itself so it is covered by the SAME PASS 3
 *  recovery (reconcileIncompleteProjections()) that already re-drives every other projection of that
 *  transition when markTransitionProjected() was never reached. Sequential, matching
 *  recordTradeCompletion()'s own call-order convention. */
async function recordDisputeCount(tx: ProjectionTx, buyerId: string, sellerId: string): Promise<void> {
  await tx.user.update({
    where: { id: buyerId },
    data: { disputeCount: { increment: 1 } },
  })
  await tx.user.update({
    where: { id: sellerId },
    data: { disputeCount: { increment: 1 } },
  })
}

/** Walks a successful Intent through SETTLING → FULFILLED in one place.
 *  Idempotent against both legs — a re-delivered durable event hits a
 *  state-machine guard inside intent-engine.ts and no-ops, so this
 *  helper is safe to call from every completion path without a
 *  per-handler try/catch dance. */
async function fulfillIntent(intentId: string, escrowId: string, outcome: 'RELEASED' | 'SPLIT'): Promise<void> {
  // Each step tolerates only "already there/past it": a crash between the two steps must leave a retry able
  // to finish FULFILLED (previously an already-SETTLING intent aborted the whole helper).
  await ensureIntentCommitted(intentId, escrowId)
  await advanceIntent(intentId, 'SETTLING', 'intent.settling', { intentId, settlementId: escrowId })
  await advanceIntent(intentId, 'FULFILLED', 'intent.fulfilled', { intentId, settlementId: escrowId, outcome })
}

/**
 * A released/refunded/split escrow proves the funds were locked, so the Intent is at least COMMITTED even if
 * the (independent) 'locked' event has not been projected yet. Catching up here keeps the Intent progression
 * monotonic and lets the settlement event complete instead of failing until 'locked' happens to arrive.
 */
async function ensureIntentCommitted(intentId: string, escrowId: string): Promise<void> {
  await advanceIntent(intentId, 'COMMITTED', 'intent.committed', { intentId, settlementId: escrowId, terms: null })
}

/** RFC-021 D4, Phase 3 — split the cost-to-fabricate-reputation floor
 *  between both parties whenever the protocol fee was actually charged.
 *  No-op when feeCharged is null/0 (the bootstrap-phase default).
 *
 *  Sequential, not Promise.all, for the same call-order contract
 *  recordTradeCompletion()'s own comment explains. */
async function accrueFeeFloor(tx: ProjectionTx, buyerId: string, sellerId: string, feeCharged: Prisma.Decimal | null | undefined): Promise<void> {
  if (!feeCharged) return
  await tx.user.update({
    where: { id: buyerId },
    data: { cumulativeFeesObserved: { increment: feeCharged } },
  })
  await tx.user.update({
    where: { id: sellerId },
    data: { cumulativeFeesObserved: { increment: feeCharged } },
  })
}

/** Outcome Engine for the released path (RFC-007 D8): a RELEASE ruling means
 *  the buyer won and the seller lost; a plain release (no dispute) means
 *  both parties completed cleanly. RFC-021 D7 — the losing seller's active
 *  vouches (if any) get burned via vouchService, applying the same
 *  "skin-in-the-game" reasoning D3 uses for arbiters to peer vouches. */
async function applyReleaseOutcomes(eventId: string, tradeId: string, buyerId: string, sellerId: string): Promise<void> {
  const resolvedRelease = await prisma.dispute.findFirst({
    where: { tradeId, status: 'RESOLVED', ruling: 'RELEASE' },
  })
  if (resolvedRelease) {
    await reputationService.recordOutcomeOnce(eventId, tradeId, buyerId, 'POSITIVE')
    await reputationService.recordOutcomeOnce(eventId, tradeId, sellerId, 'NEGATIVE')
    await vouchService.burnVouchesForOnce(eventId, sellerId)
  } else {
    await reputationService.recordOutcomeOnce(eventId, tradeId, buyerId, 'POSITIVE')
    await reputationService.recordOutcomeOnce(eventId, tradeId, sellerId, 'POSITIVE')
  }
}

/** Outcome Engine for the refunded path (RFC-007 D9): a REFUND ruling means
 *  the seller won and the buyer lost; a plain refund with no dispute ever
 *  raised is a mutual cancellation — always Neutral, never Negative, for
 *  either party. RFC-021 D7 — same vouch-burn reasoning as released, for
 *  the buyer instead of the seller.
 *
 *  Returns the resolved Dispute row (or null) so the caller can branch on
 *  "did this come from a dispute ruling?" for the Intent FAILED transition's
 *  `reason` field — same as the original inline implementation did. */
async function applyRefundOutcomes(eventId: string, tradeId: string, buyerId: string, sellerId: string): Promise<{ id: string } | null> {
  const resolvedRefund = await prisma.dispute.findFirst({
    where: { tradeId, status: 'RESOLVED', ruling: 'REFUND' },
  })
  if (resolvedRefund) {
    await reputationService.recordOutcomeOnce(eventId, tradeId, sellerId, 'POSITIVE')
    await reputationService.recordOutcomeOnce(eventId, tradeId, buyerId, 'NEGATIVE')
    await vouchService.burnVouchesForOnce(eventId, buyerId)
  } else {
    await reputationService.recordOutcomeOnce(eventId, tradeId, buyerId, 'NEUTRAL')
    await reputationService.recordOutcomeOnce(eventId, tradeId, sellerId, 'NEUTRAL')
  }
  return resolvedRefund
}

// ─── Issue #294/#298 - projection identity helpers ───────────────────────────────────────────
// Escrow is authoritative; Trade is a projection. Every downstream effect below is applied at most
// once per (durable eventId, projectionKey, subject) via applyEventProjectionOnce(), and a stale or
// duplicate delivery can neither regress economic state nor double-count an additive effect.

/** Trade status projection: derived from the PERSISTED Escrow state (monotonic), never from the event payload. */
async function projectTrade(event: { eventId: string }, tradeId: string, escrowId: string): Promise<boolean> {
  return applyEventProjectionOnce(event.eventId, 'trade.status', tradeId, async (tx) => {
    const r = await tradeRepository.projectEscrowStatus(tradeId, escrowId, { tx })
    // An unresolvable (trade, escrow) pair is not "nothing to project": throwing rolls the claim back so the
    // event is neither consumed nor marked projected while its projection was never applied.
    if (!r.applied && (r.reason === 'ESCROW_NOT_FOUND' || r.reason === 'TRADE_MISMATCH')) {
      throw new Error(`Trade projection impossible (${r.reason}) for trade ${tradeId} / escrow ${escrowId}`)
    }
  })
}

/** Records that ALL projections of this escrow transition completed (recovery reads this). */
async function markTransitionProjected(event: { eventId: string; payload: { transitionId?: string } }): Promise<void> {
  const transitionId = event.payload.transitionId
  if (!transitionId) return
  await applyEventProjectionOnce(event.eventId, TRANSITION_PROJECTED_KEY, transitionId, async () => {})
}

// States at which an Intent transition to the key is already applied / superseded (nothing left to do).
// An Intent still EARLIER than the target is NOT tolerated: the transition is not applied yet, so the event
// must fail and be redelivered rather than be recorded as projected.
const INTENT_AT_OR_PAST: Record<string, string[]> = {
  COMMITTED: ['COMMITTED', 'SETTLING', 'FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SETTLING: ['SETTLING', 'FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  FULFILLED: ['FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  FAILED: ['FAILED', 'FULFILLED', 'CANCELLED', 'EXPIRED'],
}

async function advanceIntent(intentId: string, target: keyof typeof INTENT_AT_OR_PAST, eventName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await intentEngine.transition(intentId, target as never, INTENT_LIFECYCLE_TRIGGER, eventName as never, payload as never)
  } catch (err) {
    const m = err instanceof Error ? /Invalid Intent transition: (\w+) → (\w+)/.exec(err.message) : null
    if (m && m[2] === target && INTENT_AT_OR_PAST[target].includes(m[1])) return
    throw err
  }
}

/**
 * A notification emitted once per (event, key). The emit runs INSIDE the claim transaction: if it fails the
 * claim rolls back and the redelivery emits again (at-least-once), instead of consuming the claim and losing
 * the notification (at-most-once, the previous claim-first order).
 */
async function emitOnce(event: { eventId: string }, key: string, subjectId: string, emit: () => Promise<void>): Promise<void> {
  await applyEventProjectionOnce(event.eventId, key, subjectId, async () => { await emit() })
}

export function registerEventHandlers(): void {
  // ── Sails OpenP2P reacts to settlement state changes ────────────────────────

  // Gap found while investigating a CTO-role follow-up ("disputa durante
  // negociação" — RFC-018 failure-scenario coverage): escrow.service.ts's
  // createEscrow() emits settlement.escrow.created but, per this file's own
  // module-boundary rule (OpenSettlement may read Trade, never write it),
  // never sets Trade.escrowId itself — and nothing else did either. That
  // left Trade.escrowId permanently null in the real (non-mocked) flow,
  // which meant dispute.service.ts's raiseDispute() guard
  // (`if (!trade.escrowId) throw ...`) rejected every dispute unconditionally,
  // for a trade in any status. Not merely "disputes during negotiation are
  // blocked" — disputes were blocked, period. This handler is the missing
  // reaction, matching the same pattern as settlement.escrow.locked below.
  eventBus.on('settlement.escrow.created', async (payload) => {
    await prisma.trade.update({
      where: { id: payload.tradeId },
      data: { escrowId: payload.escrowId },
    })
    escrowsCreatedTotal.inc()
  })

  // CTO_DUE_DILIGENCE_REPORT.md B-OPS-01 — the business-counter half of
  // metrics.ts's own comment: a real dispute count over time, independent
  // of whatever HTTP route happened to trigger it.
  eventBus.on('dispute.opened', async () => {
    disputesOpenedTotal.inc()
  })

  eventBus.onDurable('settlement.escrow.locked', async (event) => {
    const payload = event.payload
    await projectTrade(event, payload.tradeId, payload.escrowId)
    const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })

    if (trade?.intentId) {
      await advanceIntent(trade.intentId, 'COMMITTED', 'intent.committed', { intentId: trade.intentId, settlementId: payload.escrowId, terms: null })
    }
    await markTransitionProjected(event)
  })

  eventBus.onDurable('settlement.escrow.released', async (event) => {
    const payload = event.payload
    const eventId = event.eventId
    if (await projectTrade(event, payload.tradeId, payload.escrowId)) escrowsReleasedTotal.inc()
    const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })
    if (!trade) return

    await applyEventProjectionOnce(eventId, 'trade.completion-counters', payload.tradeId, (tx) =>
      recordTradeCompletion(tx, trade.buyerId, trade.sellerId, trade.amount)
    )
    await applyEventProjectionOnce(eventId, 'fee-floor', payload.tradeId, async (tx) => {
      const releasedEscrow = await tx.escrow.findUnique({ where: { id: payload.escrowId } })
      await accrueFeeFloor(tx, trade.buyerId, trade.sellerId, releasedEscrow?.feeCharged)
    })

    await emitOnce(event, 'trade.completed-notification', payload.tradeId, () =>
      eventBus.emit('openp2p.trade.completed', {
        tradeId: payload.tradeId,
        from: 'ACTIVE',
        to: 'COMPLETED',
        triggeredBy: payload.triggeredBy,
      }, payload.tradeId)   // correlationId (RFC-010)
    )

    await applyReleaseOutcomes(eventId, payload.tradeId, trade.buyerId, trade.sellerId)

    if (trade.intentId) {
      await fulfillIntent(trade.intentId, payload.escrowId, 'RELEASED')
    }
    await markTransitionProjected(event)
  })

  eventBus.onDurable('settlement.escrow.disputed', async (event) => {
    const payload = event.payload
    await projectTrade(event, payload.tradeId, payload.escrowId)
    const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })

    if (trade) {
      // Issue #253 - atomic claim+effect, recovered by PASS 3 (reconcileIncompleteProjections()) alongside
      // every other projection of this same transition — see recordDisputeCount()'s own comment for why
      // this moved off the old openp2p.trade.disputed consumer.
      await applyEventProjectionOnce(event.eventId, 'dispute.count', payload.tradeId, (tx) =>
        recordDisputeCount(tx, trade.buyerId, trade.sellerId)
      )
    }

    await emitOnce(event, 'trade.disputed-notification', payload.tradeId, () =>
      eventBus.emit('openp2p.trade.disputed', {
        tradeId: payload.tradeId,
        from: 'ACTIVE',
        to: 'DISPUTED',
        triggeredBy: payload.triggeredBy,
      }, payload.tradeId)   // correlationId (RFC-010)
    )
    await markTransitionProjected(event)
  })

  eventBus.onDurable('settlement.escrow.refunded', async (event) => {
    const payload = event.payload
    if (await projectTrade(event, payload.tradeId, payload.escrowId)) escrowsRefundedTotal.inc()
    const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })
    if (!trade) return

    const resolvedRefund = await applyRefundOutcomes(event.eventId, payload.tradeId, trade.buyerId, trade.sellerId)

    if (trade.intentId) {
      await ensureIntentCommitted(trade.intentId, payload.escrowId)
      await advanceIntent(trade.intentId, 'FAILED', 'intent.failed', { intentId: trade.intentId, reason: resolvedRefund ? 'Escrow refunded per dispute ruling' : 'Escrow refunded' })
    }
    await markTransitionProjected(event)
  })

  eventBus.onDurable('settlement.escrow.split', async (event) => {
    const payload = event.payload
    await projectTrade(event, payload.tradeId, payload.escrowId)
    const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })
    if (!trade) return

    await applyEventProjectionOnce(event.eventId, 'trade.completion-counters', payload.tradeId, (tx) =>
      recordTradeCompletion(tx, trade.buyerId, trade.sellerId, trade.amount)
    )

    await reputationService.recordOutcomeOnce(event.eventId, payload.tradeId, trade.buyerId, 'NEUTRAL')
    await reputationService.recordOutcomeOnce(event.eventId, payload.tradeId, trade.sellerId, 'NEUTRAL')

    await emitOnce(event, 'trade.completed-notification', payload.tradeId, () =>
      eventBus.emit('openp2p.trade.completed', {
        tradeId: payload.tradeId,
        from: 'DISPUTED',
        to: 'COMPLETED',
        triggeredBy: payload.triggeredBy,
      }, payload.tradeId)
    )

    if (trade.intentId) {
      await fulfillIntent(trade.intentId, payload.escrowId, 'SPLIT')
    }
    await markTransitionProjected(event)
  })

  // ── Sails OpenSettlement: QVAC-assisted dispute auto-resolution (RFC-021 D8) ──
  // Off by default (config.settlement.qvacAutoResolutionEnabled) — a real
  // QVAC call per evidence submission is real latency and real
  // model-inference cost, same reasoning socialEngineeringDetection's own
  // handler above already established. Uses onDurable() for the same
  // reason that handler does: this must survive a process restart between
  // evidence being submitted and QVAC finishing its analysis, not be lost
  // if it raced a redeploy. qvac-agent.provider.ts and dispute.service.ts
  // are both required lazily, after the flag check — the QVAC one
  // transitively imports the real @qvac/sdk (ESM-only), the same "don't
  // make every test mock this" reasoning the social-engineering handler's
  // own comment explains.
  //
  // Deliberately payment-method-agnostic (project owner, 2026-08-02): the
  // trade's own real PaymentMethod is passed through as-is, never assumed
  // to be any specific rail.
  eventBus.onDurable('dispute.evidence_submitted', async (event) => {
    if (!config.settlement.qvacAutoResolutionEnabled) return

    try {
      const payload = event.payload as { disputeId: string; tradeId: string }
      const dispute = await prisma.dispute.findUnique({ where: { id: payload.disputeId } })
      if (!dispute || dispute.status === 'RESOLVED' || dispute.status === 'AUTO_PROPOSED' || dispute.status === 'APPEALED') return

      // paymentMethod lives on Offer, not Trade — Trade only copies
      // asset/amount at creation time (this model's own field list).
      const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId }, include: { offer: true } })
      if (!trade) return

      const evidence = Array.isArray(dispute.evidence) ? (dispute.evidence as unknown as Array<{ type: string; note?: string; submittedBy: string }>) : []
      if (evidence.length === 0) return // nothing for QVAC to assess yet

      const { qvacAgentProvider } = require('../../modules/open-agents/qvac-agent.provider') // eslint-disable-line @typescript-eslint/no-var-requires
      const assessment = await qvacAgentProvider.assessDisputeEvidence({
        paymentMethod: trade.offer.paymentMethod,
        asset: trade.asset,
        amount: trade.amount.toString(),
        reason: dispute.reason,
        evidence: evidence.map((e) => ({
          type: e.type,
          note: e.note,
          submittedBy: e.submittedBy === trade.buyerId ? 'buyer' as const : 'seller' as const,
        })),
      })

      if (
        assessment.recommendation === 'INCONCLUSIVE' ||
        assessment.confidence < config.settlement.qvacAutoResolutionConfidenceThreshold
      ) {
        return // falls straight through to the already-assigned human arbiter, unchanged
      }

      const { getDisputeService } = require('../../modules/open-settlement/dispute.service') // eslint-disable-line @typescript-eslint/no-var-requires
      await getDisputeService().proposeAutoResolution(
        payload.disputeId,
        assessment.recommendation,
        assessment.confidence,
        assessment.reasoning
      )
    } catch (err) {
      log.error({ msg: 'qvacAutoResolution failed', eventId: event.eventId, err: err instanceof Error ? err.message : err })
    }
  })

  // ── Sails OpenP2P reacts to a peer reconnecting (RFC-011) ──────────────────
  eventBus.on('peer.connected', async (payload) => {
    // Only a real two-party handshake (pear.service.ts's handleNewConnection)
    // carries localUserId — the self-node-start peer.connected has no
    // counterparty to reconcile against.
    if (!payload.localUserId) return

    const results = await reconciliationService.reconcilePeerPair(payload.localUserId, payload.userId)
    for (const result of results) {
      await eventBus.emit('negotiation.reconciled', {
        tradeId: result.tradeId,
        currentTradeStatus: result.currentTradeStatus,
        currentEscrowStatus: result.currentEscrowStatus,
        missedMessageCount: result.missedMessages.length,
      }, result.tradeId)   // correlationId (RFC-010)
    }
  })

  // ── Sails OpenP2P: chat transport unification ──────────────────────────────
  // The single place NEW_MESSAGE reaches WS-connected clients, regardless of
  // whether the message was sent via chat.routes.ts's WS route or via
  // negotiation.service.ts's HumanChatChannel over Pears — both emit this
  // same event after persisting to Message. See chat-room-registry.ts's doc
  // comment for what this does NOT cover (WS-origin messages aren't relayed
  // onto Pears — that direction stays HumanChatChannel-only).
  eventBus.on('openp2p.message.sent', (payload) => {
    broadcastToTrade(payload.tradeId, { type: 'NEW_MESSAGE', payload })
  })

  // ── Sails OpenAgents: Social Engineering Agent (RFC-007 D7 / RFC-017) ──────
  // Off by default (config.features.socialEngineeringDetection) — a real
  // QVAC call per chat message is real latency and real model-inference
  // cost, not something every deployment should pay for unconditionally.
  // Uses onDurable() (not on()) because evaluate() needs the message's
  // real eventId/publishedAt to build a TimelineEntry, per D7's own
  // interface — never awaited into whatever triggered the message send,
  // same "a detection failure must not break the thing it's watching"
  // philosophy as autoSettleOnMatch's handler below.
  //
  // social-engineering-agent.ts is required lazily, after the flag check,
  // not imported at the top of this file — it transitively imports the
  // real @qvac/sdk (ESM-only), which every test that imports app.ts would
  // otherwise need to mock (tests/walletAgents.test.ts's own jest.mock
  // is why that pattern exists at all). This way @qvac/sdk is only ever
  // touched when the feature is actually turned on.
  eventBus.onDurable('openp2p.message.sent', async (event) => {
    if (!config.features.socialEngineeringDetection) return

    try {
      const { socialEngineeringAgent } = require('../../modules/open-agents/social-engineering-agent') // eslint-disable-line @typescript-eslint/no-var-requires
      const signal = await socialEngineeringAgent.evaluate({
        eventId: event.eventId,
        eventType: event.eventName,
        occurredAt: event.publishedAt,
        payload: event.payload,
      })
      if (!signal) return

      await eventBus.emit('agents.social_engineering.risk_detected', {
        tradeId: signal.correlationId,
        pattern: signal.pattern,
        riskScore: signal.riskScore,
        reasoning: signal.reasoning,
        sourceEventId: signal.sourceEventId,
        detectedAt: signal.detectedAt,
      }, signal.correlationId)   // correlationId (RFC-010) = tradeId
    } catch (err) {
      qvacDetectionFailuresTotal.inc({ path: 'social_engineering' })
      log.error({ msg: 'socialEngineeringDetection failed', eventId: event.eventId, err: err instanceof Error ? err.message : err })
    }
  })

  // ── Sails OpenSettlement reacts to a Match (openp2p.trade.created) ────────
  // Off by default (config.features.autoSettleOnMatch) — this event fires
  // for every real trade in this codebase, not only agent-driven demo
  // trades, so unconditional auto-release would silently bypass the
  // negotiation/dispute-window design (Escrow.timelockHours). Deliberately
  // not awaited into the emit() call site in trade.service.ts — a
  // settlement failure here must not make Trade creation itself fail.
  eventBus.on('openp2p.trade.created', async (payload) => {
    if (!config.features.autoSettleOnMatch) return

    try {
      const buyerAddress = await wdkSettlementProvider.getAccountAddress(buyerIndexFor(payload.buyerId))
      await executeSettlement({ tradeId: payload.tradeId, buyerReceivingAddress: buyerAddress })
    } catch (err) {
      log.error({ msg: 'autoSettleOnMatch failed', tradeId: payload.tradeId, err: err instanceof Error ? err.message : err })
    }
  })
}
