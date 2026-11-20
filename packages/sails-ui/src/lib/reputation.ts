/**
 * Trust-signal helpers inspired directly by Noones' P2P profile pattern
 * (support.noones.com/hc/en-us/articles/6125374217743-Feedback-and-Reputation
 * — a positive-feedback percentage, plus a tenure/volume "Power Trader"
 * badge), researched and requested directly (2026-07-29).
 *
 * Deliberately NOT a literal port of Noones' thumbs-up/down tally: the
 * real backend (reputation.service.ts) has no such counter. What it
 * genuinely has is `recordOutcome()` — a POSITIVE/NEGATIVE/NEUTRAL
 * classification per trade, real-time incremented into `User.
 * reputationScore` (a running, unbounded +2/-5 sum, not a 0-100 or 0-1
 * ratio — see that file's own header comment) — and a separate `rate()`
 * 1-5 star system that's real but not yet exposed to this UI's `User`
 * type at all. Both `totalTrades` and `disputeCount` (this file's own
 * inputs) already are real, already on `User` today. `positiveFeedbackPct`
 * is this UI's own honest derivation from those two — "trades that
 * didn't end in a dispute" — not a claim that the real backend tracks
 * a literal positive/negative feedback percentage anywhere. Every call
 * site pairs this with an `InfoTooltip` saying so.
 */
import type { User } from '../types'

export function positiveFeedbackPct(user: Pick<User, 'totalTrades' | 'disputeCount'>): number {
  if (user.totalTrades === 0) return 100
  return Math.round((1 - user.disputeCount / user.totalTrades) * 100)
}

// Thresholds are this UI's own editorial choice (not a real backend
// concept) — roughly what Noones' own help docs describe for their
// "Power Trader"-tier badges (meaningful trade volume, high positive
// rate), picked to be achievable by this reference UI's seed data
// without being trivially true for a brand-new account.
const POWER_TRADER_MIN_TRADES = 20
const POWER_TRADER_MIN_POSITIVE_PCT = 95

export function isPowerTrader(user: Pick<User, 'totalTrades' | 'disputeCount'>): boolean {
  return user.totalTrades >= POWER_TRADER_MIN_TRADES && positiveFeedbackPct(user) >= POWER_TRADER_MIN_POSITIVE_PCT
}

// Technical Debt #61 (2026-09-10) — the public single-offer view
// (OfferDetail.tsx, sailsClient.liquidity.getOffer()) no longer carries
// a seller's raw `disputeCount`: only reputation.service.ts's own
// derived `disputeRate` is part of the approved public disclosure
// contract (docs/TECHNICAL_DEBT_AUDIT.md #61 — capped at canonical
// public Identity + Reputation disclosure). `disputeRatePct` below is a
// plain display helper (dispute rate as a percentage, e.g. 0.02 -> 2) —
// it is NOT the complement of positiveFeedbackPct() and must never be
// subtracted from 100 to approximate it: `100 - Math.round(x * 100)`
// and `Math.round((1 - x) * 100)` disagree at rounding boundaries (e.g.
// x = 0.045: the first gives 95, the second — positiveFeedbackPct()'s
// own real formula — gives 96; found for real, not theoretical, CTO
// review 2026-09-10). `positivePctFromDisputeRate` below reproduces
// positiveFeedbackPct()'s exact rounding by computing the same
// `Math.round((1 - x) * 100)` directly from the canonical field, so
// isPowerTraderFromCanonical()'s threshold behavior matches
// isPowerTrader()'s exactly, not merely approximately. `disputeRate` is
// already 0 when `totalTrades` is 0 (reputation.service.ts's own
// getScore()), so no separate zero-trades branch is needed here the way
// positiveFeedbackPct() needs one for raw division. The other three
// callers of positiveFeedbackPct()/isPowerTrader() above
// (TradeParties.tsx, Profile.tsx, Trade.tsx) still read from the full,
// authenticated `User` shape and are unaffected by any of this.
/** One definition of an account's dispute rate for Profile and Meus Trades: disputes opened ÷ completed trades (server counters). */
export const ACCOUNT_DISPUTE_RATE_DEFINITION =
  'Trades seus que entraram em disputa ÷ trades concluídos, pelos contadores da sua conta (os mesmos da reputação). Trades reembolsados ou ainda em disputa entram só no numerador; quando a conta não fecha em uma porcentagem, mostramos o número de disputas.'

// disputeCount rises on every dispute; totalTrades only on release/split (events/handlers.ts),
// so refunded or open disputes can push the ratio past 100% or have no denominator at all.
export function formatAccountDisputeRate(user: Pick<User, 'totalTrades' | 'disputeCount'>): string {
  if (user.disputeCount === 0) return '0%'
  if (user.totalTrades === 0 || user.disputeCount > user.totalTrades) {
    return `${user.disputeCount} ${user.disputeCount === 1 ? 'disputa' : 'disputas'}`
  }
  return `${Math.round((user.disputeCount / user.totalTrades) * 100)}%`
}

export function disputeRatePct(disputeRate: number): number {
  return Math.round(disputeRate * 100)
}

function positivePctFromDisputeRate(disputeRate: number): number {
  return Math.round((1 - disputeRate) * 100)
}

export function isPowerTraderFromCanonical(seller: { totalTrades: number; disputeRate: number }): boolean {
  return seller.totalTrades >= POWER_TRADER_MIN_TRADES && positivePctFromDisputeRate(seller.disputeRate) >= POWER_TRADER_MIN_POSITIVE_PCT
}

// RFC-021 D7 (real peer vouching) — mirrors vouch.service.ts's own
// server-enforced eligibility bar (MIN_VOUCHER_TRADES = 3, reputationScore
// > 0) purely so VouchButton.tsx can hide/disable itself instead of
// letting someone tap a button guaranteed to 400. The server remains the
// real gate; this is UX only, not a security boundary.
const MIN_VOUCHER_TRADES = 3

export function canVouch(user: Pick<User, 'totalTrades' | 'reputationScore'>): boolean {
  return user.totalTrades >= MIN_VOUCHER_TRADES && user.reputationScore > 0
}

/** The one display format for reputationScore everywhere ("96 pontos"): an unbounded +2/-5 sum, never a star rating. */
export function formatReputation(score: number): string {
  return `${score.toFixed(0)} pontos`
}
