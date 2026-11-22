/**
 * Trust-signal display helpers. Every value shown comes from a real server
 * field: `reputationScore` (an unbounded +2/-5 running sum from
 * reputation.service.ts, never a 0-100 or star scale), `totalTrades`,
 * `disputeCount`/`disputeRate`. No UI-derived percentages or badges
 * (CTO Despacho 033 removed "N% positivo" and "Power Trader", which were
 * thresholds this UI invented).
 */
import type { User } from '../types'
import type { Explanation, TrustLineItem } from '../components/ui/trustTypes'
import { t } from '../i18n'

/** One definition of an account's dispute rate for Profile and Meus Trades: disputes opened ÷ completed trades (server counters). */
export const accountDisputeRateDefinition = () => t('reputation.disputeRateDefinition')

// The explanation objects below use getters so they follow the interface language on every read.

// disputeCount rises on every dispute; totalTrades only on release/split (events/handlers.ts),
// so refunded or open disputes can push the ratio past 100% or have no denominator at all.
export function formatAccountDisputeRate(user: Pick<User, 'totalTrades' | 'disputeCount'>): string {
  if (user.disputeCount === 0) return '0%'
  if (user.totalTrades === 0 || user.disputeCount > user.totalTrades) {
    return disputeCountText(user.disputeCount)
  }
  return `${Math.round((user.disputeCount / user.totalTrades) * 100)}%`
}

export function disputeRatePct(disputeRate: number): number {
  return Math.round(disputeRate * 100)
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

/** The one display format for reputationScore everywhere ("Reputação 96"): an unbounded +2/-5 sum, never a star rating or "pontos". */
export function formatReputation(score: number): string {
  return t('reputation.score', { score: score.toFixed(0) })
}

// Counts are passed as strings (no digit grouping, as before); pt-BR puts 0 in the "one" plural form, hence the Zero keys.
const tradeCountText = (n: number) => (n === 0 ? t('reputation.tradesZero') : t('reputation.trades', { count: String(n) }))
const disputeCountText = (n: number) => (n === 0 ? t('reputation.disputesZero') : t('reputation.disputes', { count: String(n) }))

/**
 * The one copy source for how reputationScore is computed (reputation.service.ts:57-58, RFC-007, RFC-021 D7
 * VOUCH_BURN_PENALTY). An unbounded sum: never shown as a fraction, percentage, stars or tier.
 */
export const REPUTATION_EXPLANATION: Explanation & { trigger: string } = {
  get title() { return t('reputation.explanation.title') },
  get lines() {
    return [
      t('reputation.explanation.completed'),
      t('reputation.explanation.disputeLost'),
      t('reputation.explanation.neutral'),
      t('reputation.explanation.vouchBurn'),
    ]
  },
  get footer() { return t('reputation.explanation.footer') },
  get trigger() { return t('reputation.explanation.trigger') },
}

/**
 * The one compact trader trust line ("Reputação 96 · 312 trades · 1 disputa"), shared by the Market rows,
 * the trade parties and the offer detail. Only the reputation is guaranteed; a count the source did not
 * return is left out instead of shown as "—" or a made-up 0.
 */
export function trustItems(s: { reputationScore: number; totalTrades?: number; disputeCount?: number }): TrustLineItem[] {
  const items: TrustLineItem[] = [{ kind: 'reputation', text: formatReputation(s.reputationScore), srText: t('reputation.scoreSr', { score: s.reputationScore.toFixed(0) }) }]
  if (s.totalTrades !== undefined) items.push({ kind: 'trades', text: tradeCountText(s.totalTrades) })
  if (s.disputeCount !== undefined) items.push({ kind: 'disputes', text: disputeCountText(s.disputeCount) })
  return items
}

/** The same trust line as plain strings, for accessible labels and text use. */
export function trustParts(s: { reputationScore: number; totalTrades?: number; disputeCount?: number }): string[] {
  return trustItems(s).map((item) => item.text)
}

/**
 * Star ratings (reputation.rate(), RFC-007): 1-5 per trade, informational only, never part of
 * reputationScore. Reading them back has no endpoint yet (LOOSE_WIRES.readRatings), so screens show
 * "Em breve" with this explanation and no number.
 */
export const RATINGS_EXPLANATION: Explanation = {
  get title() { return t('reputation.ratings.title') },
  get lines() { return [t('reputation.ratings.scale'), t('reputation.ratings.informational'), t('reputation.ratings.unavailable')] },
}

/** The same explanation when a rating summary is on screen, which today happens only with the dev demo's fictional data. */
export const RATINGS_DEMO_EXPLANATION: Explanation = {
  get title() { return RATINGS_EXPLANATION.title },
  get lines() { return [t('reputation.ratings.scale'), t('reputation.ratings.informational'), t('reputation.ratings.demoUnavailable')] },
}
