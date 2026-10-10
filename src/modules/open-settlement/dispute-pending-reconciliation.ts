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
 * collected — the durable, checkable fact that makes deletion
 * unconditionally safe: `escrow-pending-tx.ts`'s own
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
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from './discretionary-authority'
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

export type StalePendingDeleteResult = 'DELETED' | 'SIGNED_MEANWHILE' | 'ALREADY_GONE'

/**
 * Issue #244 - the only way this module deletes a pending round. The candidate snapshot (zero
 * signatures when it was read) never authorizes the delete by itself: under the escrow-scoped advisory
 * lock (the same key as withEscrowFundingLock(), escrow-lifecycle.ts, which submitTransactionSignature()
 * holds while it accepts a signature), the delete re-proves - in one statement - that this exact round
 * (id + escrow) still exists and still has zero durable signatures. A signature accepted before the lock
 * makes it match 0 rows; a signer arriving after finds the round gone and fails closed.
 */
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

export async function deletePendingRoundIfStillUnsigned(
  pendingTransactionId: string,
  escrowId: string,
  generation?: PendingGeneration,
): Promise<StalePendingDeleteResult | 'PROVENANCE_REJECTED'> {
  // Legacy callers cannot authorize deletion from a bare pending ID.
  if (!generation) return 'PROVENANCE_REJECTED'
  return prisma.$transaction(async (tx) => {
    // Economic disposition first, escrow signer lock second: D -> E.
    // Hold both through generation, Outcome, authorization and conditional delete.
    const dispositionKey = economicDispositionLockKey(escrowId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispositionKey})::bigint)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
    // Re-read the operation AND live dispute under the same lock used by signers.
    const pending = await tx.escrowPendingTransaction.findUnique({
      where: { id: pendingTransactionId },
      include: { signatures: true },
    })
    if (!pending) return 'ALREADY_GONE'
    if (pending.escrowId !== escrowId) return 'PROVENANCE_REJECTED'
    if (pending.signatures.length) return 'SIGNED_MEANWHILE'
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
    const dispute = await tx.dispute.findUnique({ where: { id: generation.disputeId } })
    if (!dispute || dispute.escrowId !== escrowId ||
        dispute.status !== 'RESOLVED' ||
        dispute.appealRound !== generation.rulingAppealRound ||
        dispute.arbiterId !== generation.rulingArbiterId ||
        dispute.ruling !== generation.rulingOutcome ||
        dispute.authoritySignature !== generation.rulingAuthoritySignature) {
      return 'PROVENANCE_REJECTED'
    }
    const durableOutcome = await tx.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: {
        interactionId: escrowId,
        transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE,
        appealRound: generation.rulingAppealRound,
      } },
    })
    if (!durableOutcome?.outcomeContent) return 'PROVENANCE_REJECTED'
    const committed = await tx.economicDispositionAuthorization.findUnique({
      where: { pendingOperationId: pendingTransactionId },
    })
    if (committed) return 'PROVENANCE_REJECTED'
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
    if (count === 1) return 'DELETED'
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

  // #244 - a delete the snapshot below decided on is reported by what the lock-protected re-check found.
  const deleteUnlessSigned = async (pending: { id: string; escrowId: string } & Parameters<typeof recordedGeneration>[0], verdict: 'DELETED_GUARD_FAILED'): Promise<boolean> => {
    const generation = recordedGeneration(pending)
    if (!generation) {
      report.failed.push({ escrowId: pending.escrowId, error: 'missing or ambiguous pending ruling provenance; refusing cleanup' })
      return false
    }
    const outcome = await deletePendingRoundIfStillUnsigned(pending.id, pending.escrowId, generation)
    if (outcome === 'DELETED') {
      report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict })
      return true
    }
    if (outcome === 'PROVENANCE_REJECTED') report.failed.push({ escrowId: pending.escrowId, error: 'pending ruling generation no longer authorizes cleanup' })
    else if (outcome === 'SIGNED_MEANWHILE') report.skippedHasSignatures.push(pending.escrowId)
    else report.alreadyCleaned.push(pending.escrowId)
    return false
  }

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

      const generation = recordedGeneration(pending)
      if (!generation) {
        report.failed.push({ escrowId: pending.escrowId, error: 'missing or ambiguous pending ruling provenance; refusing cleanup' })
        continue
      }
      const dispute = await prisma.dispute.findFirst({
        where: { id: generation.disputeId, escrowId: pending.escrowId, status: 'RESOLVED',
          appealRound: generation.rulingAppealRound, arbiterId: generation.rulingArbiterId,
          ruling: generation.rulingOutcome as typeof pending.rulingOutcome,
          authoritySignature: generation.rulingAuthoritySignature },
      })
      if (!dispute) {
        // Structurally shouldn't happen (the candidate query itself
        // requires one) — a genuine anomaly if it does. Fail closed,
        // never delete on an assumption.
        report.failed.push({ escrowId: pending.escrowId, error: 'candidate query matched but no RESOLVED dispute found on re-check' })
        continue
      }

      const row = await loadDisputeRulingRecord(pending.escrowId, generation.rulingAppealRound)
      if (!row || !row.outcomeContent) {
        // No immutable Outcome means no deletion authority, regardless of signatures.
        report.failed.push({ escrowId: pending.escrowId, error: 'missing durable Core-authoritative Outcome; refusing cleanup' })
        log.error({ msg: 'M9: missing durable Outcome; pending preserved for investigation', escrowId: pending.escrowId })
        continue
      }

      const record = fromDisputeRulingRow(row)
      if (!record.outcome) {
        report.failed.push({ escrowId: pending.escrowId, error: 'durable record has no Outcome despite outcomeContent being present' })
        continue
      }

      const network = networkFor(config.multisig.network)
      const result = validateTranslatedOutputsAgainstOutcome(pending.unsignedPsbtBase64, record.outcome, network)

      if (result.ok) {
        report.reconciled.push({ escrowId: pending.escrowId, pendingTransactionId: pending.id, verdict: 'LEFT_GUARD_PASSED' })
      } else {
        if (await deleteUnlessSigned(pending, 'DELETED_GUARD_FAILED')) {
          log.error({ msg: 'M9: stale pending transaction failed re-validation against its own durable Outcome — deleted (zero signatures, no fund-movement risk)', escrowId: pending.escrowId, mismatches: result.mismatches })
        }
      }
    } catch (err) {
      report.failed.push({ escrowId: pending.escrowId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
