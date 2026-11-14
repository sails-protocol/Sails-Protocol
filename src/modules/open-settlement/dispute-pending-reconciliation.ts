/**
 * dispute-pending-reconciliation.ts — Sails Core Implementation Program
 * M9 (Recovery, Execution Uncertainty & Semantic Reconciliation).
 *
 * Closes the ONE concrete, disclosed residual M8-R and M8.6 both carried
 * forward without solving: "crash between unsigned PSBT persistence and
 * translation-guard cleanup may leave a stale pending row" (M8-R's own
 * finding, mission M9 §40's explicit instruction to revisit it).
 *
 * SCOPE — narrowly the M8-R Core-authoritative MULTISIG dispute-ruling
 * slice only, matching this whole program's own discipline: a pending
 * transaction this module ever touches must (a) belong to a MULTISIG
 * escrow, (b) belong to an escrow with a RESOLVED Dispute (the durable
 * signal that `applyRulingCoreAuthoritative()`'s own commit path, not
 * some other flow, is what created it), and (c) have ZERO signatures
 * collected — the durable, checkable fact that makes deletion safe,
 * provided it still holds at the delete itself (Issue #244, corrected
 * 2026-11-09: it is re-checked there, under the escrow lock — see
 * deleteIfStillUnsigned()): `escrow-pending-tx.ts`'s own
 * `submitTransactionSignature()` is the ONLY code path that can ever
 * move funds for a signature-collection escrow, and it structurally
 * cannot have run yet if no required signer has submitted anything.
 *
 * WHY RE-RUNNING THE GUARD IS SAFE AND CONCLUSIVE (never a guess): the
 * translation guard (`dispatch-translation-guard.ts`,
 * `assertTranslationMatchesOutcome()`) is a PURE, deterministic function
 * of two IMMUTABLE inputs — the stored `unsignedPsbtBase64` bytes (never
 * mutated once persisted) and the durable, historical Outcome
 * (`SemanticTransitionRecord`, also immutable once committed, per this
 * program's own Rule 3: "a committed Record is never edited"). Whatever
 * verdict the guard would have produced at persist time, it produces
 * again now — there is no "staleness" in the sense of the ANSWER
 * changing, only in the sense of the CLEANUP never having run. A
 * surviving pending row is therefore in exactly one of two states,
 * distinguishable by re-running the SAME check:
 *   1. The guard was never reached (crash before it ran) — re-running it
 *      now gives the definitive, first-ever verdict.
 *   2. The guard ran, FAILED, and its own cleanup delete crashed before
 *      completing — re-running it now deterministically fails again,
 *      confirming deletion is (still) correct.
 * A row whose guard verdict is a PASS is not stale at all — it is a
 * legitimate pending transaction genuinely still awaiting signature
 * collection (mission §27's own "prepared but never executed... may
 * resume automatically" — sufficient evidence exists here precisely
 * because the deterministic re-check IS that evidence).
 */
import { prisma } from '../../common/database'
import { config } from '../../config'
import { networkFor } from './multisig.provider'
import { loadDisputeRulingRecord, fromDisputeRulingRow } from './dispute-outcome'
import { validateTranslatedOutputsAgainstOutcome } from './dispatch-translation-guard'
import { withEscrowFundingLock } from './escrow-lifecycle'
import { childLogger } from '../../common/logger'

const log = childLogger('dispute-pending-reconciliation')

// Issue #244 - the zero-signature snapshot read by the sweep never authorizes the delete by itself. Under the escrow
// lock submitTransactionSignature() signs under, the delete removes this exact round only if it still has no signature.
// GONE: another run (or the round's own finalization) already removed it.
async function deleteIfStillUnsigned(pending: { id: string; escrowId: string }): Promise<'DELETED' | 'HAS_SIGNATURES' | 'GONE'> {
  return withEscrowFundingLock(pending.escrowId, async (tx) => {
    const { count } = await tx.escrowPendingTransaction.deleteMany({ where: { id: pending.id, escrowId: pending.escrowId, signatures: { none: {} } } })
    if (count === 1) return 'DELETED'
    return (await tx.escrowPendingTransaction.count({ where: { id: pending.id } })) ? 'HAS_SIGNATURES' : 'GONE'
  })
}

// Conservative — never touches a pending row young enough that it could
// still be a live, in-flight request (the arbiter's own resolveDispute()
// call, still executing between persist and guard-check). Configurable
// only via this constant, not environment — this is a safety margin, not
// an operational policy a deployment should need to tune.
const MIN_AGE_MS = 5 * 60 * 1000

export interface StalePendingReconciliationReport {
  reconciled: Array<{ escrowId: string; pendingTransactionId: string; verdict: 'DELETED_GUARD_FAILED' | 'LEFT_GUARD_PASSED' | 'DELETED_NO_OUTCOME' }>
  skippedTooYoung: string[]
  skippedHasSignatures: string[]
  failed: Array<{ escrowId: string; error: string }>
}

/**
 * The main entry point — same operational shape as
 * reconcilePendingSettlements()/sweepExpiredEscrows(): a plain async
 * function, callable from a cron/ops process, never wired to an HTTP
 * route. Idempotent by construction: a row already deleted or already
 * signature-bearing is structurally excluded from a later run's own
 * candidate query.
 */
export async function reconcileStalePendingDisputeTranslations(): Promise<StalePendingReconciliationReport> {
  const report: StalePendingReconciliationReport = { reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], failed: [] }

  // Candidates: any pending row for a MULTISIG escrow with a RESOLVED
  // dispute. Signature count and age are checked per-row below (cheaper
  // to express precisely in code than in a single complex query, and
  // this table is never large — one row per escrow, at most).
  const candidates = await prisma.escrowPendingTransaction.findMany({
    where: { escrow: { type: 'MULTISIG', disputes: { some: { status: 'RESOLVED' } } } },
    include: { signatures: true, escrow: true },
  })

  for (const pending of candidates) {
    try {
      if (pending.signatures.length > 0) {
        report.skippedHasSignatures.push(pending.escrowId)
        continue
      }
      const ageMs = Date.now() - pending.createdAt.getTime()
      if (ageMs < MIN_AGE_MS) {
        report.skippedTooYoung.push(pending.escrowId)
        continue
      }

      const dispute = await prisma.dispute.findFirst({
        where: { escrowId: pending.escrowId, status: 'RESOLVED' },
        orderBy: { appealRound: 'desc' },
      })
      if (!dispute) {
        // Structurally shouldn't happen (the candidate query itself
        // requires one) — a genuine anomaly if it does. Fail closed,
        // never delete on an assumption.
        report.failed.push({ escrowId: pending.escrowId, error: 'candidate query matched but no RESOLVED dispute found on re-check' })
        continue
      }

      const row = await loadDisputeRulingRecord(pending.escrowId, dispute.appealRound)
      if (!row || !row.outcomeContent) {
        // A RESOLVED dispute with no durable Core-authoritative Outcome
        // at all — this pending row cannot possibly have been created by
        // applyRulingCoreAuthoritative() (which never persists one
        // without first committing the Outcome in the SAME transaction).
        // Something outside this module's own model created it; deletion
        // is still safe (zero signatures, zero fund-movement risk) but
        // reported distinctly for visibility, never silently folded into
        // the ordinary "guard failed" case.
        const outcome = await deleteIfStillUnsigned(pending)
        if (outcome === 'HAS_SIGNATURES') report.skippedHasSignatures.push(pending.escrowId)
        if (outcome !== 'DELETED') continue
        report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_NO_OUTCOME' })
        log.error({ msg: 'M9: stale pending transaction with no durable Core-authoritative Outcome — deleted (zero signatures, no fund-movement risk)', escrowId: pending.escrowId })
        continue
      }

      const record = fromDisputeRulingRow(row)
      if (!record.outcome) {
        report.failed.push({ escrowId: pending.escrowId, error: 'durable record has no Outcome despite outcomeContent being present' })
        continue
      }

      const network = networkFor(config.multisig.network)
      // Same call as the live paths (dispute.service.ts, dispute-dispatch-recovery.ts): the declared miner fee stored with the round is
      // checked against the fee its own PSBT implies. A null fee (legacy / non-policy-aware round) keeps skipping that one check.
      const result = validateTranslatedOutputsAgainstOutcome(pending.unsignedPsbtBase64, record.outcome, network, pending.minerFeeSats ?? undefined)

      if (result.ok) {
        report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'LEFT_GUARD_PASSED' })
      } else {
        const outcome = await deleteIfStillUnsigned(pending)
        if (outcome === 'HAS_SIGNATURES') report.skippedHasSignatures.push(pending.escrowId)
        if (outcome !== 'DELETED') continue
        report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED' })
        log.error({ msg: 'M9: stale pending transaction failed re-validation against its own durable Outcome — deleted (zero signatures, no fund-movement risk)', escrowId: pending.escrowId, mismatches: result.mismatches })
      }
    } catch (err) {
      report.failed.push({ escrowId: pending.escrowId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
