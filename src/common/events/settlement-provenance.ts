import { prisma } from '../database'
import { NotFoundError, ValidationError } from '../errors'
import { childLogger } from '../logger'
import { eventBus } from './event-bus'
import {
  applyEventProjectionOnce,
  SETTLEMENT_PROVENANCE_DECISION_KEY,
  SETTLEMENT_PROVENANCE_HELD_KEY,
  SETTLEMENT_PROVENANCE_RESOLVED_KEY,
  TRANSITION_DISPOSITION_AUTHORIZATION_KEY,
  TRANSITION_DISPUTE_PROVENANCE_KEY,
} from './event-projection'
import { reputationService } from '../../modules/open-reputation/reputation.service'
import { vouchService } from '../../modules/open-reputation/vouch.service'
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from '../../modules/open-settlement/discretionary-authority'
import { computeEscrowEventHash } from '../../modules/open-settlement/escrow-lifecycle'

const log = childLogger('settlement-provenance')

export type SettlementKind = 'RELEASE' | 'REFUND'
export type SettlementProvenance = 'DISPUTED' | 'COOPERATIVE' | 'UNPROVEN'

/**
 * Issue #254 / #341 - was this settlement caused by a dispute ruling? Never read from Dispute.status/ruling:
 * appeal() can reopen a RESOLVED dispute at any time, including while this event's projection is delayed, and
 * the same event would then mean something else. Only durable facts count:
 *
 *   DISPUTED    - evidence bound to this transition and mutually consistent: the event's own disputeId, the
 *                 copy its transition claim recorded, and the ADR-005 authorization the claim bound
 *                 ('transition.disposition-authorization', verified by the producer against its pending
 *                 operation); or MULTISIG's semantic_transition_records (committed before dispatch, a reverted
 *                 ruling deletes its row). Corrected 2026-11-05 (Issue #341, CTO 22 D1-D4): an authorization was
 *                 previously accepted by escrowId alone; that is now only a veto against COOPERATIVE, never a
 *                 proof, and a recovered publication without payload.disputeId is proven by its bound markers.
 *   COOPERATIVE - positive proof, never the mere absence of a Dispute row (a row can be deleted): the escrow's
 *                 hash-chained transitions link from genesis to this settlement and none enters or leaves
 *                 DISPUTED. Opening a dispute writes that transition before any ruling can settle, and deleting
 *                 it breaks the link of every later transition. No Dispute row may exist either.
 *   UNPROVEN    - anything else: a Dispute nothing above binds to this settlement, contradictory or cross-escrow
 *                 evidence, an authorization of this escrow not bound to the transition, a legacy unhashed or
 *                 broken chain, a deleted dispute, or a recovered direct-call settlement. Fails closed: not
 *                 classified by assumption. Only the reputation outcomes are held; the settlement and its
 *                 funds are never touched by this classification.
 */
export async function classifySettlementProvenance(effectId: string, escrowId: string, eventDisputeId: string | undefined): Promise<SettlementProvenance> {
  const unproven = (reason: string): SettlementProvenance => {
    log.warn({ msg: 'Settlement provenance is contradictory or unanchored: classified UNPROVEN', escrowId, effectId, reason })
    return 'UNPROVEN'
  }

  // Issue #341 (CTO 22 D1-D4) - evidence bound to THIS transition (effectId): the event's disputeId and the markers
  // written with its claim. Each must agree with the others and with the durable rows it names.
  const markers = await prisma.eventProjectionClaim.findMany({
    where: { eventId: effectId, projectionKey: { in: [TRANSITION_DISPUTE_PROVENANCE_KEY, TRANSITION_DISPOSITION_AUTHORIZATION_KEY] } },
    select: { projectionKey: true, subjectId: true },
  })
  const authorizationIds = markers.filter((m) => m.projectionKey === TRANSITION_DISPOSITION_AUTHORIZATION_KEY).map((m) => m.subjectId)
  const disputeIds = new Set(markers.filter((m) => m.projectionKey === TRANSITION_DISPUTE_PROVENANCE_KEY).map((m) => m.subjectId))
  if (eventDisputeId) disputeIds.add(eventDisputeId)

  if (authorizationIds.length > 1) return unproven('more than one disposition authorization bound to the transition')
  if (disputeIds.size > 1) return unproven('the transition names more than one dispute')
  const [disputeId] = disputeIds

  if (authorizationIds.length === 1) {
    const authorization = await prisma.economicDispositionAuthorization.findUnique({ where: { id: authorizationIds[0] } })
    if (!authorization) return unproven('bound disposition authorization not found')
    if (authorization.escrowId !== escrowId) return unproven('bound disposition authorization belongs to another escrow')
    if (!disputeId) return unproven('disposition authorization bound without its dispute')
    if (authorization.disputeId !== disputeId) return unproven('bound disposition authorization names another dispute')
    return 'DISPUTED'
  }

  if (disputeId) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, select: { escrowId: true } })
    if (dispute && dispute.escrowId !== escrowId) return unproven('the named dispute belongs to another escrow')
    // A disputeId alone never outweighs a durable authorization of this escrow for a different dispute.
    const other = await prisma.economicDispositionAuthorization.findFirst({ where: { escrowId, disputeId: { not: disputeId } }, select: { id: true } })
    if (other) return unproven('an authorization of this escrow names another dispute')
    return 'DISPUTED'
  }

  const coreRecord = await prisma.semanticTransitionRecord.findFirst({
    where: { interactionId: escrowId, transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE },
    select: { id: true },
  })
  if (coreRecord) return 'DISPUTED'

  // D2: an authorization of this escrow not bound to this transition proves nothing positive. It still vetoes
  // COOPERATIVE: the escrow had a disputed operation, so absence of a marker is never read as cooperative.
  if (await hasDispositionAuthorization(escrowId)) return 'UNPROVEN'

  const dispute = await prisma.dispute.findFirst({ where: { escrowId }, select: { id: true } })
  if (dispute) return 'UNPROVEN'
  return (await provesUndisputedChain(effectId, escrowId)) ? 'COOPERATIVE' : 'UNPROVEN'
}

async function hasDispositionAuthorization(escrowId: string): Promise<boolean> {
  return (await prisma.economicDispositionAuthorization.findFirst({ where: { escrowId }, select: { id: true } })) !== null
}

/** Walks the transition chain by its links, not by timestamps (two rows can share a createdAt), and requires every
 *  row to be on it: an unhashed, mutated, branched or orphaned row makes the history unprovable. */
async function provesUndisputedChain(effectId: string, escrowId: string): Promise<boolean> {
  const rows = await prisma.escrowEvent.findMany({ where: { escrowId } })
  const byPrev = new Map<string, typeof rows[number]>()
  for (const r of rows) {
    if (!r.entryHash || !r.prevHash || byPrev.has(r.prevHash)) return false
    if (r.entryHash !== computeEscrowEventHash(r.fromStatus, r.toStatus, r.triggeredBy, r.prevHash)) return false
    byPrev.set(r.prevHash, r)
  }
  let link = 'genesis', walked = 0, found = false
  for (let r = byPrev.get(link); r; r = byPrev.get(link)) {
    if (r.fromStatus === 'DISPUTED' || r.toStatus === 'DISPUTED') return false
    if (r.id === effectId) found = true
    link = r.entryHash!
    walked++
  }
  return found && walked === rows.length
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
  // Issue #341 (CTO 22 D2) - a disposition authorization on this escrow is a veto, not a proof: it cannot classify
  // the settlement DISPUTED by itself, but a human cannot declare it COOPERATIVE either.
  if (decision === 'COOPERATIVE' && (await hasDispositionAuthorization(escrowId))) {
    throw new ValidationError(`Settlement ${effectId}: the decision COOPERATIVE contradicts durable evidence (an economic disposition authorization exists for escrow ${escrowId})`)
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
