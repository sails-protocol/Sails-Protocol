/**
 * #235 R7H-NF-E3C-5 (B2) — which Intent carries a trade's lifecycle.
 *
 * A trade admitted since B2 owns an Intent of its own (`tradeIntentId`): its cancellation, escrow lock, settlement
 * and refund transition THAT Intent, and no other trade's lifecycle can move it. A trade admitted before B2 has none
 * (NULL, never back-filled) and keeps following the Offer Intent it shared (`intentId`), exactly as before — its
 * protections are the same, plus the explicit skip policy of `legacySharedIntentCancelDecision()`.
 * `null`: a trade of an offer that predates RFC-018 (no Intent at all) — nothing to transition.
 */
export function lifecycleIntentId(trade: { tradeIntentId?: string | null; intentId?: string | null }): string | null {
  return trade.tradeIntentId ?? trade.intentId ?? null
}

/** Intent statuses with no outgoing transition (core/state-machine.ts): the lifecycle they describe has ended. */
const TERMINAL_INTENT_STATUSES: readonly string[] = ['FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED']

export type LegacyIntentCancelDecision =
  | { action: 'TRANSITION' }
  | { action: 'SKIP'; reason: 'SHARED_INTENT_SIBLING_TRADES_LIVE' | 'SHARED_INTENT_ALREADY_TERMINAL' }

/**
 * L1 — what cancelling a LEGACY trade (no tradeIntentId) does to the Offer Intent it shares with sibling trades.
 * Evaluated only after every economic cancellation guard (escrow governance, unilateral revocation) has passed, inside
 * the cancellation transaction. The Intent is left untouched — and the skip is recorded as a durable event, never as
 * a fabricated transition — in exactly two cases, both explained by OTHER trades rather than by this one:
 *   - another trade on the same Intent is still live: its state is the siblings', cancelling this trade must not
 *     rewrite it (the pre-B2 defect: it made every sibling un-cancellable) and, if a sibling locked escrow, the
 *     Intent's COMMITTED is theirs; or
 *   - no sibling is live and the Intent is already TERMINAL: the shared lifecycle ended, nothing is left to protect.
 * Everything else is exactly the pre-B2 behaviour: the transition is attempted, and an Intent that cannot be
 * cancelled (COMMITTED/SETTLING with no live sibling to explain it, e.g. #235 R7G-B1's F1) refuses the WHOLE
 * cancellation with no durable effect. A trade that has its OWN escrow never skips either.
 */
export function legacySharedIntentCancelDecision(input: {
  tradeHasEscrow: boolean
  liveSiblingTrades: number
  intentStatus: string
}): LegacyIntentCancelDecision {
  if (input.tradeHasEscrow) return { action: 'TRANSITION' }
  if (input.liveSiblingTrades > 0) return { action: 'SKIP', reason: 'SHARED_INTENT_SIBLING_TRADES_LIVE' }
  if (TERMINAL_INTENT_STATUSES.includes(input.intentStatus)) return { action: 'SKIP', reason: 'SHARED_INTENT_ALREADY_TERMINAL' }
  return { action: 'TRANSITION' }
}
