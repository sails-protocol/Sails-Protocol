/**
 * wdk-execution-truth.ts — what remains of the WDK transfer() execution-truth layer (Bounded Remediation, WDK
 * Fund-Moving Safety, 2026-09-08).
 *
 * #235 R7G-F6B / R7G-F6C — WDK no longer moves funds through transfer() (an RPC-chosen nonce and a hash known
 * only after the broadcast). Every LOCK, release, refund and split leg is now a transaction signed with an
 * explicit nonce and persisted before any broadcast (wdk-lock-authority.ts, wdk-outbound-authority.ts), so
 * the pre-submission bookkeeping this module used to run around transfer() (ensureAttempt(),
 * markSubmissionAttempted(), waitForReceiptOutcome()) has no caller and was removed with that path.
 *
 * What remains serves the read-only reconciliation of LEGACY transfer() attempts (#251,
 * wdk-settlement.provider.ts's reconcileTerminalTransfer()): an exact decimal comparison and the receipt
 * classification that never turns an unrecognized status into a revert (NF2).
 */

// Pure string normalization (never a float): strips leading zeros from the whole part and trailing zeros from the
// fraction, so "5", "5.0" and "5.00000000" compare equal. This codebase's amounts are non-negative decimal strings.
function normalizeDecimalString(value: string): string {
  const [wholeRaw, fractionRaw = ''] = value.trim().split('.')
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionRaw.replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

// Exported (Issue #251) - the terminal-restart reconciler compares a durable WdkTransferAttempt's amount with
// Escrow.lockedAmount exactly.
export function decimalAmountsEqual(a: string, b: string): boolean {
  return normalizeDecimalString(a) === normalizeDecimalString(b)
}

/**
 * #235 R7G-F6B — NF2. A receipt proves success only with status 1 and a revert only with status 0
 * (ethers TransactionReceipt.status: number | null). null, undefined, any other number or a malformed
 * receipt is unresolved: never REVERTED.
 */
export function receiptStatusOf(receipt: unknown): 1 | 0 | null {
  const status = (receipt as { status?: unknown } | null | undefined)?.status
  return status === 1 ? 1 : status === 0 ? 0 : null
}
