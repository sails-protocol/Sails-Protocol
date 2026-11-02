/**
 * wdk-execution-truth.ts — Bounded Remediation (WDK Fund-Moving Safety,
 * 2026-09-08), closing the retry-safety gaps
 * docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md (#56) and
 * docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md (#58) demonstrated for
 * WDK_USDT_EVM's lockFunds()/releaseFunds()/refundFunds()/splitFunds().
 *
 * Properties this file exists to satisfy (full reasoning in the two docs
 * above, not re-derived here):
 *   A — Durable Operation Truth: identity for a logical economic
 *       operation is persisted BEFORE the external submission, not
 *       merely inferred from Escrow.status afterward.
 *   B — Unknown Outcome Safety: a call whose outcome is genuinely
 *       ambiguous (submitted, response lost) must not become blindly
 *       retryable — ensureAttempt() below refuses a second submission
 *       and requires reconciliation (a receipt check, if a hash exists)
 *       or manual intervention (if it doesn't).
 *   C — Submission != Confirmation: waitForReceiptOutcome() below never
 *       reports success on a bare returned hash — only on a real,
 *       queried receipt with status 1.
 *
 * Deliberately WDK-specific — this module is imported ONLY by
 * wdk-settlement.provider.ts. It is not a generic cross-rail primitive:
 * MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM's own release/refund/split
 * paths are client-signature-collection or read-only verification, not
 * self-initiated custodial transfers, so they have no equivalent need
 * (docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md §10).
 *
 * Escrow.status (the semantic escrow lifecycle) is deliberately left
 * untouched by this file — this is a separate, lower-level truth layer
 * underneath it (Fase 10's own architectural preference). A caller whose
 * attempt is blocked here sees a thrown EscrowError; escrow.service.ts's
 * own existing claim/revert logic is unmodified and still runs exactly
 * as before — the real safety property (no second on-chain transfer for
 * one logical operation) is enforced HERE, before WalletAccountEvm.transfer()
 * is ever called again, regardless of what Escrow.status says.
 *
 * CTO Gate Correction (2026-09-08) — closing the PREPARED -> transfer() ->
 * SUBMITTED crash window. The original version of this file only wrote
 * SUBMISSION_UNKNOWN from inside a catch block, AFTER transfer() had
 * already thrown — meaning a crash DURING the transfer() call itself
 * (after a real broadcast may already have occurred, before the JS
 * promise ever settles) left the row at PREPARED, and the original
 * ensureAttempt() treated PREPARED as unconditionally safe to reuse. That
 * was wrong: PREPARED alone never proved transfer() hadn't been called —
 * it only proved the LAST write this row received was "identity
 * recorded." markSubmissionAttempted() below is now called by
 * wdk-settlement.provider.ts's executeTransfer() immediately BEFORE
 * transfer() — a durable, conservative pre-commit that the submission
 * boundary may be crossed. A crash at any point from that write onward
 * (including mid-transfer(), after a real broadcast) now leaves the row
 * at SUBMISSION_UNKNOWN, which this file's own SUBMISSION_UNKNOWN branch
 * already blocks unconditionally — no further change was needed there.
 * PREPARED now only persists if the crash happened strictly between
 * ensureAttempt() returning and that immediately-next, synchronous
 * pre-commit write (no intervening `await` in between other than the
 * pre-commit call itself) — a real, disclosed, but now minimal residual
 * window (see docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md §22's own updated
 * residual list), not eliminated by construction (that would require a
 * distributed/2PC mechanism this mission does not authorize).
 */
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import type { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import type { WdkTransferOperationType } from '@prisma/client'
import { wdkTransferAttemptRepository } from './wdk-transfer-attempt-repository'

// The minimal WDK account surface this file needs — real, public API
// (WalletAccountReadOnlyEvm.getTransactionReceipt(), inherited by
// WalletAccountEvm; UPSTREAM DOCUMENTED, confirmed directly in the
// installed @tetherto/wdk-wallet-evm source). Typed narrowly so tests can
// supply a minimal fake without implementing the whole real class.
export type ReceiptCapableAccount = Pick<WalletAccountEvm, 'getTransactionReceipt'>

export type EnsureAttemptResult =
  | { action: 'RESUME_CONFIRMED'; txHash: string }
  | { action: 'PROCEED'; attemptId: string }

// CTO Gate Correction (2026-09-08) — the integrity guard below used to
// compare amounts via Number(a) !== Number(b), a floating-point
// comparison on values that must be compared exactly (a real duplicate-
// attempt check on money, per this file's own governing property). Pure
// string normalization instead: strips leading zeros from the whole part
// and trailing zeros from the fraction, so "5", "5.0", and "5.00000000"
// all normalize identically without ever parsing through a float. Not a
// general-purpose decimal library — this codebase's own amounts are
// always non-negative decimal strings (toBaseUnits()/fromBaseUnits()'s
// own domain), so signs are deliberately not handled.
function normalizeDecimalString(value: string): string {
  const [wholeRaw, fractionRaw = ''] = value.trim().split('.')
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionRaw.replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

// Exported (Issue #251) - the terminal-restart reconciler needs the exact same exact-decimal-string
// comparison to verify a durable WdkTransferAttempt's amount against Escrow.lockedAmount, rather than
// re-implementing a second, possibly-diverging comparison.
export function decimalAmountsEqual(a: string, b: string): boolean {
  return normalizeDecimalString(a) === normalizeDecimalString(b)
}

/**
 * Called BEFORE every real transfer() attempt. Persists durable identity
 * for a fresh logical operation, or determines from existing durable
 * state whether this exact call can safely resume (already confirmed),
 * must be blocked (ambiguous outcome, unresolved), or may proceed with a
 * newly-created attempt (a prior attempt reached a state proven safe to
 * retry from).
 */
export async function ensureAttempt(
  escrowId: string,
  operationType: WdkTransferOperationType,
  destination: string,
  amount: string,
  account: ReceiptCapableAccount
): Promise<EnsureAttemptResult> {
  const latest = await wdkTransferAttemptRepository.findLatest(escrowId, operationType)

  if (!latest) {
    const created = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    return { action: 'PROCEED', attemptId: created.id }
  }

  // Integrity guard, not a strict idempotency key: a stale attempt row
  // for this exact (escrowId, operationType) whose destination/amount
  // genuinely differ from this call's own computed values indicates a
  // real anomaly (a bug upstream, or a genuinely different logical
  // operation reusing the same discriminator) — loud failure, not a
  // silent reuse of mismatched state. Amount compared via exact decimal
  // string normalization (decimalAmountsEqual, above) — never floating
  // point — since Decimal's own string formatting need not match the
  // caller's exactly (e.g. "5" vs "5.00000000").
  if (latest.destination !== destination || !decimalAmountsEqual(latest.amount.toString(), amount)) {
    throw new EscrowError(
      `WdkTransferAttempt ${latest.id} for escrow ${escrowId}/${operationType} recorded destination=${latest.destination} amount=${latest.amount.toString()}, but this call computed destination=${destination} amount=${amount} — refusing to reconcile against a mismatched prior attempt.`
    )
  }

  switch (latest.status) {
    case 'CONFIRMED': {
      if (!latest.txHash) {
        throw new EscrowError(`WdkTransferAttempt ${latest.id} is CONFIRMED but has no persisted txHash — data integrity violation, refusing to resume`)
      }
      return { action: 'RESUME_CONFIRMED', txHash: latest.txHash }
    }

    case 'SUBMITTED': {
      if (!latest.txHash) {
        throw new EscrowError(`WdkTransferAttempt ${latest.id} is SUBMITTED but has no persisted txHash — data integrity violation`)
      }
      const receipt = await account.getTransactionReceipt(latest.txHash)
      if (!receipt) {
        throw new EscrowError(
          `WDK_USDT_EVM ${operationType} for escrow ${escrowId} was already submitted (tx ${latest.txHash}) and is still pending confirmation on-chain — refusing to submit a second transfer for the same logical operation. Retry later; this same check will re-query the transaction's receipt automatically.`
        )
      }
      if (receipt.status === 1) {
        await wdkTransferAttemptRepository.updateStatus(latest.id, 'CONFIRMED', undefined, ['SUBMITTED'])
        return { action: 'RESUME_CONFIRMED', txHash: latest.txHash }
      }
      // status === 0 — reverted on-chain. The prior attempt definitively
      // did not deliver funds (a receipt with a real, queried status is
      // the strongest evidence this system has), so a fresh attempt for
      // the same logical operation is genuinely safe to start.
      await wdkTransferAttemptRepository.updateStatus(latest.id, 'REVERTED', undefined, ['SUBMITTED'])
      const created = await wdkTransferAttemptRepository.replaceActive(latest.id, ['REVERTED'], { escrowId, operationType, destination, amount })
      return { action: 'PROCEED', attemptId: created.id }
    }

    case 'SUBMISSION_UNKNOWN':
      // No txHash was ever obtained for the prior attempt — there is
      // nothing to query, so no automatic reconciliation is possible
      // (docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md's own disclosed
      // residual: "Se reconciliation sem tx hash não puder ser
      // determinística com segurança: bloquear retry... Não inventar
      // certeza"). Correct STOP, not an artificial PASS.
      throw new EscrowError(
        `WDK_USDT_EVM ${operationType} for escrow ${escrowId} has an attempt (${latest.id}) whose outcome is UNKNOWN — the prior provider call failed before any transaction hash was obtained, so Sails cannot determine whether an external transfer already occurred. Refusing to submit a new transfer for the same logical operation. This requires manual/operator reconciliation (checking the deterministic escrow/treasury address's on-chain history directly) before any further attempt is safe.`
      )

    case 'PREPARED':
      // CTO Gate Correction (2026-09-08) — corrected reasoning; PREPARED
      // is NOT proof that transfer() was never invoked in general (that
      // was the original, wrong justification here). It is safe to reuse
      // ONLY because of this file's own header-comment fix:
      // wdk-settlement.provider.ts's executeTransfer() now calls
      // markSubmissionAttempted() (below) — a durable, conservative
      // pre-commit to SUBMISSION_UNKNOWN — immediately before transfer()
      // is ever called, with no other `await` in between. A row can only
      // still be found at PREPARED here if the crash happened strictly
      // between ensureAttempt() returning and that immediately-next
      // synchronous write — a real but now minimal residual window, not
      // the entire transfer() network round-trip. Any crash from that
      // pre-commit onward (including mid-transfer(), after a real
      // broadcast) leaves the row at SUBMISSION_UNKNOWN instead, which
      // this function's own SUBMISSION_UNKNOWN branch already blocks
      // unconditionally. (Concurrent duplicate callers are separately
      // excluded before this function is ever reached, by
      // escrow.service.ts's own pre-existing atomic
      // claimEscrowTransition() — unrelated to this sequential-crash
      // concern.)
      return { action: 'PROCEED', attemptId: latest.id }

    case 'FAILED_BEFORE_SUBMISSION': {
      const created = await wdkTransferAttemptRepository.replaceActive(latest.id, ['FAILED_BEFORE_SUBMISSION'], { escrowId, operationType, destination, amount })
      return { action: 'PROCEED', attemptId: created.id }
    }

    case 'REVERTED': {
      // Reached directly (not via the SUBMITTED branch above) only when
      // a caller starts a fresh ensureAttempt() call after a PRIOR
      // ensureAttempt() call already reconciled and recorded REVERTED —
      // same reasoning as the SUBMITTED branch's own REVERTED handling:
      // a definitively reverted transfer proves no funds moved, so a
      // fresh attempt is safe.
      const created = await wdkTransferAttemptRepository.replaceActive(latest.id, ['REVERTED'], { escrowId, operationType, destination, amount })
      return { action: 'PROCEED', attemptId: created.id }
    }

    default: {
      const exhaustive: never = latest.status
      throw new EscrowError(`WdkTransferAttempt ${latest.id} has an unrecognized status: ${String(exhaustive)}`)
    }
  }
}

/**
 * CTO Gate Correction (2026-09-08) — the durable pre-submission commit.
 * MUST be called by the caller (wdk-settlement.provider.ts's
 * executeTransfer()) immediately before invoking transfer(), with no
 * other `await` in between. Writes SUBMISSION_UNKNOWN — not a new status
 * value: "the outcome of any submission is unknown" is exactly true both
 * before the call (nothing has happened yet) and during/after a crash
 * mid-call (the real outcome is unknown), and the caller overwrites it to
 * SUBMITTED with the real hash the instant transfer() actually resolves.
 * This is what closes the PREPARED -> transfer() -> SUBMITTED crash
 * window: see this file's own header comment and ensureAttempt()'s
 * PREPARED case for the full reasoning.
 */
export async function markSubmissionAttempted(attemptId: string): Promise<void> {
  await wdkTransferAttemptRepository.updateStatus(attemptId, 'SUBMISSION_UNKNOWN', undefined, ['PREPARED'])
}

export type ReceiptOutcome = 'CONFIRMED' | 'REVERTED' | 'PENDING'

/**
 * Bounded poll for a transaction's receipt after a fresh broadcast — NOT
 * a background worker, NOT unbounded: a plain in-request loop, same
 * category as bounded-rpc.ts's own withBoundedRetry() for reads, applied
 * here to a write's post-submission confirmation instead. Returns
 * 'PENDING' (not an error) if the bound is reached with no receipt yet —
 * the caller is responsible for treating that as "submitted, not yet
 * confirmed," never as success.
 *
 * Confirmation DEPTH (waiting for N blocks after inclusion, to guard
 * against a shallow reorg) is explicitly NOT implemented here — 1
 * confirmation (a real, non-null receipt) is this mission's minimum
 * requirement; deeper confirmation is disclosed as future hardening
 * (docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md), not built now.
 */
export async function waitForReceiptOutcome(account: ReceiptCapableAccount, hash: string): Promise<ReceiptOutcome> {
  const attempts = config.wdk.receiptPollAttempts
  const intervalMs = config.wdk.receiptPollIntervalMs
  for (let attempt = 0; attempt < attempts; attempt++) {
    const receipt = await account.getTransactionReceipt(hash)
    if (receipt) {
      return receipt.status === 1 ? 'CONFIRMED' : 'REVERTED'
    }
    if (attempt < attempts - 1) {
      await delay(intervalMs)
    }
  }
  return 'PENDING'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
