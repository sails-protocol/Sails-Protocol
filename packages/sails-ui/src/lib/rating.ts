/**
 * Counterparty rating at the end of a trade (reputation.rate(), POST /v1/reputation/rate): 1-5 stars and
 * an optional comment, one per rater per trade, only between the two parties. Informational only: it
 * never changes reputationScore (RFC-007).
 */
export type RatingScore = 1 | 2 | 3 | 4 | 5
export interface RatingInput { score: RatingScore; comment?: string }

/** The form's value as the SDK input, or why it cannot be sent. Empty comments are left out. */
export function validateRating(score: number | null, comment: string): { ok: true; input: RatingInput } | { ok: false; error: 'score' } {
  if (score === null || !Number.isInteger(score) || score < 1 || score > 5) return { ok: false, error: 'score' }
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
