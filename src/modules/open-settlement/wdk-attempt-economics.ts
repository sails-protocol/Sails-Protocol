/**
 * #235 R7G-F6B — whether a WdkTransferAttempt proves it moved no funds and cannot move any: no transaction
 * was ever signed (PREPARED, FAILED_BEFORE_SUBMISSION — for a legacy transfer() attempt PREPARED also
 * preceded transfer()), or its signed transaction is final with status 0 (REVERTED written only by the
 * signed-raw LOCK authority, which requires finality). A legacy REVERTED (the old status !== 1 rule) proves
 * nothing; every other state, including a committed signed transaction not yet mined and any future state,
 * may hold or move funds. Read by cancellation (UNILATERAL_INTENT_REVOCATION_V1) and by refund-from-CREATED
 * (DF2). Dependency-free on purpose: trade-repository reaches it.
 */
export function wdkAttemptIsNonEconomic(a: { status: string; authority: string }): boolean {
  if (a.status === 'PREPARED' || a.status === 'FAILED_BEFORE_SUBMISSION') return true
  return a.status === 'REVERTED' && a.authority === 'SIGNED_RAW_V1'
}
