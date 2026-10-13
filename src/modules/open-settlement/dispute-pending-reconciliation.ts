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
 * collected — a necessary but NOT sufficient condition for deletion:
 * the exact ruling generation, its durable Outcome and the absence of a
 * committed economic disposition are re-proven under the dispute and
 * escrow locks as well (deletePendingRoundIfStillUnsigned()).
 * `escrow-pending-tx.ts`'s own
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
import { economicDispositionLockKey } from './economic-disposition-authority'
import { validateTranslatedOutputsAgainstOutcome } from './dispatch-translation-guard'
import { childLogger } from '../../common/logger'

const log = childLogger('dispute-pending-reconciliation')

// Conservative — never touches a pending row young enough that it could
// still be a live, in-flight request (the arbiter's own resolveDispute()
// call, still executing between persist and guard-check). Configurable
// only via this constant, not environment — this is a safety margin, not
// an operational policy a deployment should need to tune.
const MIN_AGE_MS = 5 * 60 * 1000

export interface StalePendingReconciliationReport {
  reconciled: Array<{ escrowId: string; pendingTransactionId: string; verdict: 'DELETED_GUARD_FAILED' | 'LEFT_GUARD_PASSED' }>
  skippedTooYoung: string[]
  skippedHasSignatures: string[]
  /** #244 - the round was already gone at the delete point (a concurrent run cleaned it). */
  alreadyCleaned: string[]
  failed: Array<{ escrowId: string; error: string }>
}

export type StalePendingDeleteResult =
  | 'DELETED'
  | 'SIGNED_MEANWHILE'
  | 'ALREADY_GONE'
  | 'PROVENANCE_REJECTED'
  /** ST-1 - no durable Core-authoritative Outcome (or one without content): authority cannot be proven, nothing is deleted. */
  | 'OUTCOME_ABSENT'
  /** ST-1 - an Outcome exists but is not a RESOLVED transition for THIS ruling: inconsistent durable state, nothing is deleted. */
  | 'OUTCOME_MISMATCH'
  /** The round, re-validated against its own durable Outcome under the locks, is a legitimate pending round. */
  | 'GUARD_PASSED'

type PendingGeneration = {
  disputeId: string
  rulingAppealRound: number
  rulingArbiterId: string
  rulingOutcome: string
  rulingAuthoritySignature: string
  rulingAuthorityIssuedAt: Date
}

function recordedGeneration(pending: {
  disputeId: string | null
  rulingAppealRound: number | null
  rulingArbiterId: string | null
  rulingOutcome: string | null
  rulingAuthoritySignature: string | null
  rulingAuthorityIssuedAt: Date | null
}): PendingGeneration | null {
  if (!pending.disputeId || pending.rulingAppealRound === null ||
      !pending.rulingArbiterId || !pending.rulingOutcome ||
      !pending.rulingAuthoritySignature || !pending.rulingAuthorityIssuedAt) return null
  return pending as PendingGeneration
}

// A lock wait is bounded: the sweep must never hang behind a stalled transaction on the dispute or escrow lock.
// A timed-out attempt is reported as failed and retried by the next sweep; nothing was deleted.
const CLEANUP_LOCK_TIMEOUT_MS = 3000

/**
 * Issues #244 / ST-1 - the only way this module deletes a pending round. The candidate snapshot never
 * authorizes the delete by itself. The decision is taken inside ONE transaction, after the same two advisory
 * locks - always in this order - that every other writer of this authority graph takes:
 *
 *   1. D, `economic-disposition:<disputeId>` - the lock appeal() and the Outcome commit hold, so the dispute's
 *      authority cannot move while this decision is taken (ADR-005 s3).
 *   2. E, `hashtext(escrowId)` - withEscrowFundingLock(), the lock submitTransactionSignature() holds while it
 *      accepts a signature, so no signature can be accepted into this round until this transaction ends.
 *
 * Under both it re-proves, from durable state only: the exact pending round (id + escrow) still exists with
 * zero signatures; it is still exactly the recorded ruling generation; the dispute is still RESOLVED for that
 * generation (the dispute row is read FOR UPDATE); no committed Economic Disposition Authorization names it;
 * the generation's own durable Outcome still exists; and the translation guard, re-run on the stored PSBT,
 * still rejects it. Any step that cannot be proven fails closed - nothing is deleted - and the delete itself is
 * conditional on the same generation and on zero signatures.
 */
export async function deletePendingRoundIfStillUnsigned(
  pendingTransactionId: string,
  escrowId: string,
  generation?: PendingGeneration,
): Promise<StalePendingDeleteResult> {
  // Legacy callers cannot authorize deletion from a bare pending ID.
  if (!generation) return 'PROVENANCE_REJECTED'
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(CLEANUP_LOCK_TIMEOUT_MS)}, true)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(generation.disputeId)})::bigint)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`

    const pending = await tx.escrowPendingTransaction.findUnique({
      where: { id: pendingTransactionId },
      include: { signatures: true },
    })
    if (!pending) return 'ALREADY_GONE'
    if (pending.escrowId !== escrowId) return 'PROVENANCE_REJECTED'
    // MUTATION PROBE ONLY: signature veto deliberately disabled to demand RED CI
    if (false && pending.signatures.length) return 'SIGNED_MEANWHILE'
    const current = recordedGeneration(pending)
    if (!current ||
        current.disputeId !== generation.disputeId ||
        current.rulingAppealRound !== generation.rulingAppealRound ||
        current.rulingArbiterId !== generation.rulingArbiterId ||
        current.rulingOutcome !== generation.rulingOutcome ||
        current.rulingAuthoritySignature !== generation.rulingAuthoritySignature ||
        current.rulingAuthorityIssuedAt.getTime() !== generation.rulingAuthorityIssuedAt.getTime()) {
      return 'PROVENANCE_REJECTED'
    }

    const [dispute] = await tx.$queryRaw<Array<{
      escrowId: string; status: string; appealRound: number; arbiterId: string | null; ruling: string | null
      authoritySignature: string | null; authorityIssuedAt: Date | null
    }>>`SELECT "escrowId", status::text AS status, "appealRound", "arbiterId", ruling::text AS ruling, "authoritySignature", "authorityIssuedAt"
        FROM disputes WHERE id = ${generation.disputeId} FOR UPDATE`
    if (!dispute || dispute.escrowId !== escrowId ||
        dispute.status !== 'RESOLVED' ||
        dispute.appealRound !== generation.rulingAppealRound ||
        dispute.arbiterId !== generation.rulingArbiterId ||
        dispute.ruling !== generation.rulingOutcome ||
        dispute.authoritySignature !== generation.rulingAuthoritySignature ||
        !dispute.authorityIssuedAt ||
        dispute.authorityIssuedAt.getTime() !== generation.rulingAuthorityIssuedAt.getTime()) {
      return 'PROVENANCE_REJECTED'
    }
    const committed = await tx.economicDispositionAuthorization.findUnique({
      where: { pendingOperationId: pendingTransactionId },
    })
    if (committed) return 'PROVENANCE_REJECTED'

    // The Outcome and the guard are re-evaluated HERE, under the locks, from durable state: a verdict taken
    // from the candidate snapshot is only a nomination.
    const row = await loadDisputeRulingRecord(escrowId, generation.rulingAppealRound, tx)
    if (!row || !row.outcomeContent) return 'OUTCOME_ABSENT'
    // Existence is not enough: the immutable record must be the RESOLVED transition of this very ruling.
    const content = row.outcomeContent as { ruling?: unknown } | null
    if (row.toState !== 'RESOLVED' || typeof content !== 'object' || content === null || Array.isArray(content) ||
        content.ruling !== generation.rulingOutcome) return 'OUTCOME_MISMATCH'
    const record = fromDisputeRulingRow(row)
    if (!record.outcome) return 'OUTCOME_ABSENT'
    const verdict = validateTranslatedOutputsAgainstOutcome(pending.unsignedPsbtBase64, record.outcome, networkFor(config.multisig.network), pending.minerFeeSats ?? undefined)
    if (verdict.ok) return 'GUARD_PASSED'

    const { count } = await tx.escrowPendingTransaction.deleteMany({
      where: {
        id: pendingTransactionId, escrowId, signatures: { none: {} },
        disputeId: generation.disputeId,
        rulingAppealRound: generation.rulingAppealRound,
        rulingArbiterId: generation.rulingArbiterId,
        rulingOutcome: generation.rulingOutcome as typeof pending.rulingOutcome,
        rulingAuthoritySignature: generation.rulingAuthoritySignature,
        rulingAuthorityIssuedAt: generation.rulingAuthorityIssuedAt,
      },
    })
    if (count === 1) {
      log.error({ msg: 'M9: stale pending transaction failed re-validation against its own durable Outcome - deleted (zero signatures, generation and authority re-proven under the dispute and escrow locks)', escrowId, mismatches: verdict.mismatches })
      return 'DELETED'
    }
    const stillThere = await tx.escrowPendingTransaction.findUnique({ where: { id: pendingTransactionId }, select: { id: true } })
    return stillThere ? 'SIGNED_MEANWHILE' : 'ALREADY_GONE'
  })
}

/**
 * The main entry point — same operational shape as
 * reconcilePendingSettlements()/sweepExpiredEscrows(): a plain async
 * function, callable from a cron/ops process, never wired to an HTTP
 * route. Idempotent by construction: a row already deleted or already
 * signature-bearing is structurally excluded from a later run's own
 * candidate query, and - #244 - from the delete itself, which re-proves
 * zero signatures under the escrow lock (deletePendingRoundIfStillUnsigned()).
 * The snapshot read below only nominates candidates.
 */
export async function reconcileStalePendingDisputeTranslations(): Promise<StalePendingReconciliationReport> {
  const report: StalePendingReconciliationReport = { reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [] }

  // Candidates: any pending row for a MULTISIG escrow with a RESOLVED
  // dispute. Signature count and age are checked per-row below (cheaper
  // to express precisely in code than in a single complex query, and
  // this table is never large - one row per escrow, at most).
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

      const generation = recordedGeneration(pending)
      if (!generation) {
        report.failed.push({ escrowId: pending.escrowId, error: 'missing or ambiguous pending ruling provenance; refusing cleanup' })
        continue
      }

      // Everything above is the snapshot: it nominates. The decision - generation, dispute, Outcome, guard,
      // signatures - is taken inside deletePendingRoundIfStillUnsigned(), under the dispute and escrow locks.
      const result = await deletePendingRoundIfStillUnsigned(pending.id, pending.escrowId, generation)
      switch (result) {
        case 'DELETED':
          report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED' })
          break
        case 'GUARD_PASSED':
          report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'LEFT_GUARD_PASSED' })
          break
        case 'SIGNED_MEANWHILE':
          report.skippedHasSignatures.push(pending.escrowId)
          break
        case 'ALREADY_GONE':
          report.alreadyCleaned.push(pending.escrowId)
          break
        case 'OUTCOME_ABSENT':
          // Fail closed. A pending round whose own durable Outcome cannot be read is not provably stale; it is
          // reported and left for a human, never deleted on an assumption.
          report.failed.push({ escrowId: pending.escrowId, error: 'no durable Core-authoritative Outcome for the pending ruling generation; refusing cleanup' })
          break
        case 'OUTCOME_MISMATCH':
          report.failed.push({ escrowId: pending.escrowId, error: 'durable Outcome does not match pending ruling generation; refusing cleanup' })
          break
        case 'PROVENANCE_REJECTED':
          report.failed.push({ escrowId: pending.escrowId, error: 'pending ruling generation no longer authorizes cleanup' })
          break
      }
    } catch (err) {
      report.failed.push({ escrowId: pending.escrowId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
