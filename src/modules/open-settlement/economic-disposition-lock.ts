/**
 * The advisory-lock scope of one dispute's economic authority (ADR-005 s3). A leaf module on purpose: the commit
 * path (dispute-outcome.ts), the gate (economic-disposition-authority.ts, which now also depends on the commit
 * path's record reader through disputed-outcome-binding.ts) and every other holder name the same key without
 * importing each other.
 */
export function economicDispositionLockKey(disputeId: string): string {
  return `economic-disposition:${disputeId}`
}
