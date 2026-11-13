/**
 * dispute-dispatch.ts — Sails Core Implementation Program M8-R (Live
 * Dispatch Retry). Wires M8's existing dispatch-eligibility primitive
 * (`packages/sails-core/src/dispatch-gate.ts`) to the durable record
 * `dispute-outcome.ts` commits, for the ONE live slice this mission
 * migrates: Mission13 MULTISIG disputed settlement. No other rail — see
 * `dispute.service.ts`'s own branch for why LIGHTNING_HODL/SAFE_GUARD_EVM
 * disputes remain on their pre-existing, unchanged path.
 *
 * "ALREADY DISPATCHED" (mission §16/§23-24): derived exclusively from
 * durable state this Runtime already maintains for exactly this
 * purpose — `EscrowPendingTransaction`'s own `@@unique` on `escrowId`
 * (an escrow can have at most one pending signature-collection
 * transaction at a time, already enforced with a real P2002 guard in
 * `escrow-pending-tx.ts`'s `initiateSignatureCollectionCore()`) plus the
 * escrow's own terminal status. No new "dispatch intent" table is
 * introduced — the existing one already IS that durable record for this
 * slice, and inventing a parallel one would create two competing sources
 * of the same fact.
 */
import { prisma } from '../../common/database'
import { evaluateLiveDispatchEligibility } from './dispatch-gate-adapter'
import { loadDisputeRulingRecord, fromDisputeRulingRow, DISPUTE_RULING_RULESET } from './dispute-outcome'
import { ArbitrationOutcomeContent, BeneficiaryDestination } from './economic-outcome'
import type { DispatchGateVerdict, TransitionRecord } from '@sails/core'
import { EscrowError } from '../../common/errors'
import type { Prisma } from '@prisma/client'

const TERMINAL_ESCROW_STATUSES = ['COMPLETED', 'REFUNDED', 'SPLIT'] as const

/**
 * `DurableDispatchRecordCheck`-shaped (dispatch-gate-adapter.ts, M8) —
 * a real, durable lookup, never a caller-suppliable boolean. Scoped to
 * the escrow the record's own `interaction` names, exactly like every
 * other dispatch-gate check in this program.
 */
async function checkDisputeRulingAlreadyDispatched(escrowId: string): Promise<boolean> {
  const [pending, escrow] = await Promise.all([
    prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, include: { signatures: true } }),
    prisma.escrow.findUnique({ where: { id: escrowId }, select: { status: true, type: true } }),
  ])
  // Issue #239 - a cooperative MULTISIG round that is not fully signed is not this ruling's dispatch: the ruling
  // supersedes it (initiateSignatureCollectionCore() re-checks everything under the escrow lock).
  if (pending && !(escrow?.type === 'MULTISIG' && isSupersedableCooperativeRound(pending))) return true
  if (escrow && (TERMINAL_ESCROW_STATUSES as readonly string[]).includes(escrow.status)) return true
  return false
}

/** Pre-check only (no lock): the authoritative decision is re-taken under the escrow lock. */
export function isSupersedableCooperativeRound(round: { disputeId: string | null; requiredSigners: string[]; signatures: Array<{ participantId: string }> }): boolean {
  const signed = new Set(round.signatures.map((s) => s.participantId))
  return round.disputeId === null && !round.requiredSigners.every((id) => signed.has(id))
}

/**
 * Issue #239 (A-1) - the ONLY authority that lets a ruling's dispatch replace a cooperative round. Issued only by
 * dispute.service.ts's applyRulingCoreAuthoritative() after its ruling committed, and by C4 recovery
 * (dispute-dispatch-recovery.ts). Never derivable from a request: the core accepts only an instance this module
 * issued (the WeakSet below), and re-validates it against the database under the escrow lock.
 */
export interface RulingSupersessionGrant {
  readonly disputeId: string
  readonly appealRound: number
  readonly arbiterId: string
  readonly ruling: string
  readonly authoritySignature: string | null
  readonly authorityIssuedAt: Date | null
}
const issuedGrants = new WeakSet<object>()

export function issueRulingSupersessionGrant(dispute: {
  id: string; appealRound: number; arbiterId: string | null; ruling: string | null
  authoritySignature: string | null; authorityIssuedAt: Date | null; status: string
}): RulingSupersessionGrant {
  if (dispute.status !== 'RESOLVED' || !dispute.arbiterId || !dispute.ruling) {
    throw new EscrowError(`Dispute ${dispute.id} has no committed ruling to supersede a cooperative round with`)
  }
  const grant: RulingSupersessionGrant = Object.freeze({
    disputeId: dispute.id, appealRound: dispute.appealRound, arbiterId: dispute.arbiterId, ruling: dispute.ruling,
    authoritySignature: dispute.authoritySignature, authorityIssuedAt: dispute.authorityIssuedAt,
  })
  issuedGrants.add(grant)
  return grant
}

export const RULING_KIND: Record<string, string> = { RELEASE: 'release', REFUND: 'refund', SPLIT: 'split' }

/** Under the escrow lock: the grant is one this module issued and still matches the committed ruling. */
export async function revalidateRulingSupersessionGrant(
  tx: Prisma.TransactionClient, grant: unknown, escrowId: string, kind: string
): Promise<RulingSupersessionGrant> {
  if (typeof grant !== 'object' || grant === null || !issuedGrants.has(grant)) {
    throw new EscrowError('Ruling supersession grant was not issued by the ruling dispatch path')
  }
  const g = grant as RulingSupersessionGrant
  const [dispute, escrow] = await Promise.all([
    tx.dispute.findUnique({ where: { id: g.disputeId } }),
    tx.escrow.findUnique({ where: { id: escrowId }, select: { status: true, type: true } }),
  ])
  const same = dispute && dispute.escrowId === escrowId && dispute.status === 'RESOLVED'
    && dispute.appealRound === g.appealRound && dispute.arbiterId === g.arbiterId && dispute.ruling === g.ruling
    && dispute.authoritySignature === g.authoritySignature
    && (dispute.authorityIssuedAt?.getTime() ?? null) === (g.authorityIssuedAt?.getTime() ?? null)
  if (!same) throw new EscrowError(`Ruling supersession grant for dispute ${g.disputeId} no longer matches the committed ruling`)
  if (RULING_KIND[g.ruling] !== kind) throw new EscrowError(`Ruling ${g.ruling} does not authorize a ${kind} round`)
  if (escrow?.status !== 'DISPUTED' || escrow.type !== 'MULTISIG') throw new EscrowError(`Escrow ${escrowId} is not a DISPUTED MULTISIG escrow`)
  const record = await loadDisputeRulingRecord(escrowId, g.appealRound)
  if (!record?.outcomeContent) throw new EscrowError(`No durable authoritative record for escrow ${escrowId} appeal round ${g.appealRound}`)
  return g
}

export type DisputeDispatchResult =
  | { readonly eligible: true; readonly record: TransitionRecord<{ readonly escrowId: string }, ArbitrationOutcomeContent, readonly BeneficiaryDestination[]> }
  | { readonly eligible: false; readonly reason: string }

/**
 * Loads the durably-committed record FROM THE DATABASE (never the
 * in-memory object `dispute-outcome.ts`'s commit function just returned
 * in the same call stack) and evaluates M8's dispatch-eligibility
 * primitive against it. This is what proves persistence — not transient
 * request memory — is what actually governs dispatch (mission §16, P22).
 */
export async function evaluateDisputeDispatchEligibility(escrowId: string, appealRound: number): Promise<DisputeDispatchResult> {
  const row = await loadDisputeRulingRecord(escrowId, appealRound)
  if (!row) {
    return { eligible: false, reason: `no durable authoritative record exists for escrow ${escrowId} appeal round ${appealRound}` }
  }
  const record = fromDisputeRulingRow(row)

  const verdict: DispatchGateVerdict = await evaluateLiveDispatchEligibility(
    record,
    /* requiresAttribution */ true,
    /* requiresOutcome */ true,
    checkDisputeRulingAlreadyDispatched,
  )
  if (verdict.kind !== 'ELIGIBLE') {
    return { eligible: false, reason: verdict.reason }
  }
  return { eligible: true, record }
}

/** Thin, fail-loud wrapper — `dispute.service.ts` calls this instead of inspecting the verdict union itself, matching this module's own single point of enforcement. */
export async function assertDisputeDispatchEligible(escrowId: string, appealRound: number): Promise<TransitionRecord<{ readonly escrowId: string }, ArbitrationOutcomeContent, readonly BeneficiaryDestination[]>> {
  const result = await evaluateDisputeDispatchEligibility(escrowId, appealRound)
  if (!result.eligible) {
    throw new EscrowError(`Dispatch eligibility check failed for escrow ${escrowId}: ${result.reason}`)
  }
  return result.record
}

export { DISPUTE_RULING_RULESET }
