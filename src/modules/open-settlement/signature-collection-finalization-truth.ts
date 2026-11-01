/**
 * signature-collection-finalization-truth.ts — Issue #240 (Signature-Collection Provider UNKNOWN /
 * Restart Convergence).
 *
 * Durable pre/post-submission evidence for the LIGHTNING_HODL/SAFE_GUARD_EVM finalize boundary
 * (`RestArkProvider.submitTx()`+`finalizeTx()` / the ERC-4337 bundler's `eth_sendUserOperation`).
 *
 * Why this exists, and why it is NOT WdkTransferAttempt reused: MULTISIG needs no equivalent
 * (Bitcoin broadcast is idempotent by construction — the same signed transaction always produces
 * the same txid, so a second broadcast of it is harmless). WDK_USDT_EVM already has its own durable
 * table (`WdkTransferAttempt`), deliberately WDK-specific per that file's own header comment — a
 * self-initiated direct-call transfer with its own receipt-query primitive, a genuinely different
 * shape from "combine client-collected signatures and submit once." LIGHTNING_HODL/SAFE_GUARD_EVM
 * are a third shape: neither Ark's submission protocol nor an ERC-4337 bundler's resubmission
 * behavior is proven idempotent anywhere in this codebase, and neither provider exposes a verified,
 * live-tested external query this codebase can safely call during recovery — see each provider's
 * own `finalizeRelease()`/`finalizeRefund()` header comment for why. This file therefore answers
 * exactly one question, safely: "did Sails already attempt this exact finalize once?"
 *
 * Property preserved (same corrected lesson `wdk-execution-truth.ts`'s own header documents): the
 * durable row is written SUBMISSION_UNKNOWN in the SAME call that decides to proceed — no separate,
 * later pre-commit step, no `await` gap between "decided to attempt" and "durably recorded as
 * attempted" — so a crash at any point from here onward, including mid-call after a real submission
 * may already have gone out, can never look like "never attempted."
 *
 * `SUBMITTED` vs `CONFIRMED` is a real distinction only for SAFE_GUARD_EVM: `eth_sendUserOperation`
 * returns the bundler-ACCEPTED userOpHash, not on-chain finality (safe-guard-evm.provider.ts's own
 * `broadcast()` comment). LIGHTNING_HODL's `finalizeTx()` has no further async confirmation step in
 * this codebase, so a successful return is recorded CONFIRMED directly — the same standard this
 * codebase already applies everywhere else (a finalize call returning without throwing is already
 * treated as done the instant it returns; see escrow-pending-tx.ts's own submitTransactionSignature()
 * two-error-boundary comment).
 *
 * No external query is implemented here for either provider (Issue #240's own explicit finding: this
 * would require live-verified provider behavior neither this codebase nor this environment has —
 * "Do not invent provider behavior," "Do not claim production eligibility from mocks"). A SUBMITTED
 * or SUBMISSION_UNKNOWN row therefore never automatically resolves — it stays a durable, honest,
 * inspectable manual-review state, exactly the "IMPLEMENTED but NOT PRODUCTION-ELIGIBLE for automated
 * restart convergence" outcome Issue #240 explicitly accepts as correct over a fabricated one.
 */
import { prisma } from '../../common/database'
import { EscrowError } from '../../common/errors'

export type EnsureFinalizationResult =
  | { action: 'RESUME_CONFIRMED'; txHash: string }
  | { action: 'PROCEED' }

/**
 * Called BEFORE every real finalize (submit) attempt, with no other `await` in between it and the
 * actual external call. Either durably records a fresh attempt (PROCEED — safe to call the provider
 * now) or determines from an existing row that this exact call can safely resume (CONFIRMED — return
 * the known txHash, never re-submit) or must be blocked (SUBMITTED/SUBMISSION_UNKNOWN — the prior
 * outcome is unresolved and no automated reconciliation exists; a human must resolve it before this
 * exact pending operation can be retried).
 */
export async function ensureFinalizationAttempt(escrowId: string, pendingTxId: string, kind: string): Promise<EnsureFinalizationResult> {
  const existing = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId } })

  if (!existing) {
    await prisma.signatureCollectionFinalizationAttempt.create({
      data: { escrowId, pendingTxId, kind, status: 'SUBMISSION_UNKNOWN' },
    })
    return { action: 'PROCEED' }
  }

  // Integrity guard, not a strict idempotency key — EscrowPendingTransaction.escrowId is itself
  // @unique (at most one live signature-collection round per escrow) and this table's own escrowId
  // is @unique too, so a row bound to a DIFFERENT pendingTxId than the one being finalized right now
  // indicates a real anomaly (a stale row that outlived its own pending operation, since convergence
  // is supposed to delete the pending row - see applyDownstreamCompletionEffects()'s own comment) —
  // loud failure, not a silent reuse of mismatched state.
  if (existing.pendingTxId !== pendingTxId) {
    throw new EscrowError(
      `SignatureCollectionFinalizationAttempt ${existing.id} for escrow ${escrowId} is bound to pending operation ${existing.pendingTxId}, ` +
      `which is not the current one (${pendingTxId}) — refusing to reuse or overwrite it. Manual review required.`
    )
  }

  if (existing.status === 'CONFIRMED') {
    if (!existing.txHash) {
      throw new EscrowError(`SignatureCollectionFinalizationAttempt ${existing.id} is CONFIRMED but has no persisted txHash — data integrity violation, refusing to resume.`)
    }
    return { action: 'RESUME_CONFIRMED', txHash: existing.txHash }
  }

  // SUBMITTED or SUBMISSION_UNKNOWN — see this file's own header comment: no automated external
  // reconciliation exists for either provider today, so the prior attempt's real-world outcome is
  // genuinely unknown. Never resubmit; never guess.
  throw new EscrowError(
    `Escrow ${escrowId}'s prior ${kind} finalization attempt (${existing.id}) has an unresolved outcome (${existing.status}) — ` +
    'no automated external reconciliation exists for this provider (Issue #240); it must not be retried automatically. Manual review required.'
  )
}

/** Written the instant the external call returns without throwing — see this file's own header comment on why SUBMITTED vs CONFIRMED differs by provider. */
export async function recordFinalizationOutcome(escrowId: string, status: 'SUBMITTED' | 'CONFIRMED', txHash: string): Promise<void> {
  await prisma.signatureCollectionFinalizationAttempt.update({ where: { escrowId }, data: { status, txHash } })
}
