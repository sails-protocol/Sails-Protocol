/**
 * Counterparty rating at the end of a trade (reputation.rate(), POST /v1/reputation/rate): 1-5 stars and
 * an optional comment, one per rater per trade, only between the two parties. Informational only: it
 * never changes reputationScore (RFC-007).
 */
export type RatingScore = 1 | 2 | 3 | 4 | 5
export interface RatingInput { score: RatingScore; comment?: string }

/** Comment limit (CTO 28 Complemento 051-A; DECISIONS.md "Avaliações portáteis"). Counted in UTF-16 units, like a JS/zod `.max()`. */
export const MAX_RATING_COMMENT = 280
/** The counter is announced (aria-live polite) only from here on, so typing is not read out on every key. */
export const RATING_COUNTER_LIVE_FROM = 260

/** Characters over the limit (0 when within it). Counts what the person typed or pasted: never truncated. */
export function commentOverBy(comment: string): number {
  return Math.max(0, comment.length - MAX_RATING_COMMENT)
}

/** The form's value as the SDK input, or why it cannot be sent. Empty comments are left out; a long one is refused, never cut. */
export function validateRating(score: number | null, comment: string): { ok: true; input: RatingInput } | { ok: false; error: 'score' | 'comment' } {
  if (score === null || !Number.isInteger(score) || score < 1 || score > 5) return { ok: false, error: 'score' }
  if (commentOverBy(comment) > 0) return { ok: false, error: 'comment' }
  const trimmed = comment.trim()
  return { ok: true, input: trimmed ? { score: score as RatingScore, comment: trimmed } : { score: score as RatingScore } }
}

/** The server's repeat answer: 400 "<rater> has already rated trade <id>" (reputation.service.ts). */
export function isAlreadyRatedError(err: unknown): boolean {
  return err instanceof Error && /already rated/i.test(err.message)
}

/**
 * Convenience memory for this tab only (sessionStorage): which trades this viewer already rated, so
 * the form does not come back after a reload. Not a source of truth: the server still answers
 * "already rated" if the memory is lost.
 */
export type RatedMemory = 'rated' | 'already'
const KEY = (tradeId: string) => `sails_ui_rated:${tradeId}`
type Store = Pick<Storage, 'getItem' | 'setItem'>

export function readRated(store: Store | undefined, tradeId: string): RatedMemory | null {
  try {
    const v = store?.getItem(KEY(tradeId))
    return v === 'rated' || v === 'already' ? v : null
  } catch {
    return null
  }
}

export function saveRated(store: Store | undefined, tradeId: string, value: RatedMemory): void {
  try { store?.setItem(KEY(tradeId), value) } catch { /* convenience only */ }
}

export function sessionStore(): Store | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}
