import { prisma } from '../database'
import { NotFoundError, ValidationError } from '../errors'
import { childLogger } from '../logger'
import { eventBus } from './event-bus'
import {
  applyEventProjectionOnce,
  SETTLEMENT_PROVENANCE_DECISION_KEY,
  SETTLEMENT_PROVENANCE_HELD_KEY,
  SETTLEMENT_PROVENANCE_RESOLVED_KEY,
  TRANSITION_DISPUTE_PROVENANCE_KEY,
} from './event-projection'
import { reputationService } from '../../modules/open-reputation/reputation.service'
import { vouchService } from '../../modules/open-reputation/vouch.service'
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from '../../modules/open-settlement/discretionary-authority'

const log = childLogger('settlement-provenance')

export type SettlementKind = 'RELEASE' | 'REFUND'
export type SettlementProvenance = 'DISPUTED' | 'COOPERATIVE' | 'UNPROVEN'

/**
 * Issue #254 / #341 - was this settlement caused by a dispute ruling? Never read from Dispute.status/ruling:
 * appeal() can reopen a RESOLVED dispute at any time, including while this event's projection is delayed, and
 * the same event would then mean something else. Only durable facts count:
 *
 *   DISPUTED    - the event's own disputeId or the copy its transition claim recorded, MULTISIG's semantic_transition_records (committed before dispatch,
 *                 a reverted ruling deletes its row), or the ADR-005 authorization (committed before the
 *                 provider side effect and kept after the pending row is deleted, so it survives a recovered
 *                 publication, which has no payload.disputeId). That same gate refuses a cooperative operation
 *                 on a disputed escrow, so the row can only belong to a disputed settlement.
 *   COOPERATIVE - the escrow never had a Dispute, the same proof the ADR-005 gate accepts.
 *   UNPROVEN    - a Dispute exists and nothing above binds this settlement to it. Fails closed: a legacy event
 *                 or a recovered direct-call settlement is not classified by assumption.
 */
export async function classifySettlementProvenance(effectId: string, escrowId: string, eventDisputeId: string | undefined): Promise<SettlementProvenance> {
  if (eventDisputeId) return 'DISPUTED'

  const claimed = await prisma.eventProjectionClaim.findFirst({
    where: { eventId: effectId, projectionKey: TRANSITION_DISPUTE_PROVENANCE_KEY },
    select: { id: true },
  })
  if (claimed) return 'DISPUTED'

  const coreRecord = await prisma.semanticTransitionRecord.findFirst({
    where: { interactionId: escrowId, transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE },
    select: { id: true },
  })
  if (coreRecord) return 'DISPUTED'

  const authorization = await prisma.economicDispositionAuthorization.findFirst({
    where: { escrowId },
    select: { id: true },
  })
  if (authorization) return 'DISPUTED'

  const dispute = await prisma.dispute.findFirst({ where: { escrowId }, select: { id: true } })
  return dispute ? 'UNPROVEN' : 'COOPERATIVE'
}

/** Outcome Engine (RFC-007 D8/D9): a ruling makes one party win and one lose, and RFC-021 D7 burns the loser's
 *  active vouches. With no dispute a release completed cleanly (both Positive) and a refund was a mutual
 *  cancellation (both Neutral). Every write is claimed per effectId, so a repeat applies nothing. */
async function applySettlementOutcomes(effectId: string, kind: SettlementKind, tradeId: string, buyerId: string, sellerId: string, disputed: boolean): Promise<void> {
  if (disputed) {
    const [winner, loser] = kind === 'RELEASE' ? [buyerId, sellerId] : [sellerId, buyerId]
    await reputationService.recordOutcomeOnce(effectId, tradeId, winner, 'POSITIVE')
    await reputationService.recordOutcomeOnce(effectId, tradeId, loser, 'NEGATIVE')
    await vouchService.burnVouchesForOnce(effectId, loser)
    return
  }
  const outcome = kind === 'RELEASE' ? 'POSITIVE' : 'NEUTRAL'
  await reputationService.recordOutcomeOnce(effectId, tradeId, buyerId, outcome)
  await reputationService.recordOutcomeOnce(effectId, tradeId, sellerId, outcome)
}

/**
 * Projects the outcomes of one settlement, or holds them when its provenance is unproven. Holding lets the rest
 * of the settlement project and the transition complete: throwing instead would redrive it forever for a fact
 * no retry can produce. The case stays listed by listHeldSettlementProvenance() until a human decides it.
 * Returns whether the settlement is proven disputed.
 */
export async function projectSettlementOutcomes(effectId: string, kind: SettlementKind, tradeId: string, buyerId: string, sellerId: string, escrowId: string, eventDisputeId: string | undefined): Promise<boolean> {
  const provenance = await classifySettlementProvenance(effectId, escrowId, eventDisputeId)
  if (provenance === 'UNPROVEN') {
    const held = await applyEventProjectionOnce(effectId, SETTLEMENT_PROVENANCE_HELD_KEY, escrowId, async () => {})
    if (held) log.error({ msg: 'Settlement has a Dispute but no immutable provenance: reputation outcomes held for review', escrowId, effectId })
    return false
  }
  await applySettlementOutcomes(effectId, kind, tradeId, buyerId, sellerId, provenance === 'DISPUTED')
  return provenance === 'DISPUTED'
}

export interface HeldSettlementDecision {
  effectId: string
  decision: Exclude<SettlementProvenance, 'UNPROVEN'>
  decidedBy: string
  evidence: string
}

/**
 * The only way out of a hold: a human decision, made once, published durably with its evidence, then applied
 * through the same claimed effects. The decision commits first, so a crash leaves it recorded and a repeat call
 * with the same decision finishes the work, while a different decision is refused.
 */
export async function resolveHeldSettlementProvenance({ effectId, decision, decidedBy, evidence }: HeldSettlementDecision): Promise<void> {
  if (!decidedBy.trim() || !evidence.trim()) throw new ValidationError('A held settlement decision requires decidedBy and evidence')

  const held = await prisma.eventProjectionClaim.findFirst({ where: { eventId: effectId, projectionKey: SETTLEMENT_PROVENANCE_HELD_KEY } })
  if (!held) throw new NotFoundError('Held settlement', effectId)
  const escrowId = held.subjectId

  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } })
  const kind: SettlementKind | null = escrow?.status === 'COMPLETED' ? 'RELEASE' : escrow?.status === 'REFUNDED' ? 'REFUND' : null
  if (!escrow || !kind) throw new ValidationError(`Escrow ${escrowId} is not settled as a release or refund`)
  const trade = await prisma.trade.findUnique({ where: { id: escrow.tradeId } })
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)

  const proven = await classifySettlementProvenance(effectId, escrowId, undefined)
  if (proven !== 'UNPROVEN' && proven !== decision) {
    throw new ValidationError(`Settlement ${effectId} is proven ${proven}: the decision ${decision} contradicts durable evidence`)
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'settlement-provenance:' + effectId})::bigint)`
    const existing = await tx.eventProjectionClaim.findFirst({ where: { eventId: effectId, projectionKey: SETTLEMENT_PROVENANCE_DECISION_KEY } })
    if (existing) {
      if (existing.subjectId !== decision) throw new ValidationError(`Settlement ${effectId} was already decided ${existing.subjectId}`)
      return
    }
    await tx.eventProjectionClaim.create({ data: { eventId: effectId, projectionKey: SETTLEMENT_PROVENANCE_DECISION_KEY, subjectId: decision } })
    await eventBus.emit('settlement.provenance.resolved', { escrowId, transitionId: effectId, decision, decidedBy, evidence }, escrow.tradeId)
  })

  await applySettlementOutcomes(effectId, kind, trade.id, trade.buyerId, trade.sellerId, decision === 'DISPUTED')
  await applyEventProjectionOnce(effectId, SETTLEMENT_PROVENANCE_RESOLVED_KEY, escrowId, async () => {})
}
