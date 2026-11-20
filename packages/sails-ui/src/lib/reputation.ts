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
  return `Reputação ${score.toFixed(0)}`
}

/**
 * The one copy source for how reputationScore is computed (reputation.service.ts:57-58, RFC-007, RFC-021 D7
 * VOUCH_BURN_PENALTY). An unbounded sum: never shown as a fraction, percentage, stars or tier.
 */
export const REPUTATION_EXPLANATION: Explanation & { trigger: string } = {
  title: 'Como a reputação é calculada',
  lines: [
    '+2 por trade concluído',
    '−5 por disputa perdida',
    '0 em cancelamento de comum acordo ou divisão',
    '−5 para quem apadrinhou alguém que perde a primeira disputa',
  ],
  footer: 'É uma soma de pontos, sem valor máximo: 82 significa 82 pontos acumulados, não 82 de 100. Avaliações por estrelas não entram na conta.',
  trigger: 'Como funciona a reputação',
}

/**
 * The one compact trader trust line ("Reputação 96 · 312 trades · 1 disputa"), shared by the Market rows,
 * the trade parties and the offer detail. Only the reputation is guaranteed; a count the source did not
 * return is left out instead of shown as "—" or a made-up 0.
 */
export function trustItems(t: { reputationScore: number; totalTrades?: number; disputeCount?: number }): TrustLineItem[] {
  const items: TrustLineItem[] = [{ kind: 'reputation', text: formatReputation(t.reputationScore), srText: `${formatReputation(t.reputationScore)} pontos` }]
  if (t.totalTrades !== undefined) items.push({ kind: 'trades', text: `${t.totalTrades} ${t.totalTrades === 1 ? 'trade' : 'trades'}` })
  if (t.disputeCount !== undefined) items.push({ kind: 'disputes', text: `${t.disputeCount} ${t.disputeCount === 1 ? 'disputa' : 'disputas'}` })
  return items
}

/** The same trust line as plain strings, for accessible labels and text use. */
export function trustParts(t: { reputationScore: number; totalTrades?: number; disputeCount?: number }): string[] {
  return trustItems(t).map((item) => item.text)
}

/**
 * Star ratings (reputation.rate(), RFC-007): 1-5 per trade, informational only, never part of
 * reputationScore. Reading them back has no endpoint yet (LOOSE_WIRES.readRatings), so screens show
 * "Em breve" with this explanation and no number.
 */
export const RATINGS_EXPLANATION: Explanation = {
  title: 'Sobre as avaliações',
  lines: [
    'De 1 a 5 estrelas, dadas pela contraparte ao fim de um trade',
    'Só informativas: não mudam a reputação',
    'A leitura das avaliações ainda não está disponível',
  ],
}
