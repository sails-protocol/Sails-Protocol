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
import { blocksRulingDispatch } from './pending-round-supersession'

const TERMINAL_ESCROW_STATUSES = ['COMPLETED', 'REFUNDED', 'SPLIT'] as const

/**
 * `DurableDispatchRecordCheck`-shaped (dispatch-gate-adapter.ts, M8) —
 * a real, durable lookup, never a caller-suppliable boolean. Scoped to
 * the escrow the record's own `interaction` names, exactly like every
 * other dispatch-gate check in this program.
 */
async function checkDisputeRulingAlreadyDispatched(escrowId: string): Promise<boolean> {
  const [pending, escrow] = await Promise.all([
    prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, include: { signatures: { select: { participantId: true } } } }),
    prisma.escrow.findUnique({ where: { id: escrowId }, select: { status: true } }),
  ])
  // #239 - a dead cooperative round is not a dispatch (blocksRulingDispatch()); the ruling's own dispatch
  // then supersedes it, or - for a potentially exposed legacy round - refuses for manual review (#239D).
  if (pending && blocksRulingDispatch(pending)) return true
  if (escrow && (TERMINAL_ESCROW_STATUSES as readonly string[]).includes(escrow.status)) return true
  return false
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
