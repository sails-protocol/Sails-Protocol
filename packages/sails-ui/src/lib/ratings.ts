/**
 * Star-rating summary display (reputation.rate(), RFC-007): 1-5 per trade, informational only, never part
 * of reputationScore. No endpoint reads ratings back yet (LOOSE_WIRES.readRatings), so real data never
 * carries a summary and every reader here returns null. Only the dev demo fills `demoRatings` /
 * `demoMemberSince`, through the guards in lib/demoMarkers.ts (DECISIONS.md, Market e ofertas, Avaliações).
 */
import type { TrustLineItem } from '../components/ui/trustTypes'
import { formatMonthYear } from './format'

export interface RatingSummary { average: number; count: number }

/** Demo-only fields a mapped offer or seller may carry (undefined for real data). */
export interface DemoRatingFields { demoRatings?: RatingSummary; demoMemberSince?: string }

/** A summary only when it is a real 1-5 average over at least one rating; anything else is null (never a guess). */
export function ratingSummaryOf(value: unknown): RatingSummary | null {
  const r = value as Partial<RatingSummary> | null | undefined
  if (!r || typeof r.average !== 'number' || typeof r.count !== 'number') return null
  if (!(r.average >= 1 && r.average <= 5) || !Number.isInteger(r.count) || r.count < 1) return null
  return { average: r.average, count: r.count }
}

export const offerRatings = (offer: DemoRatingFields): RatingSummary | null => ratingSummaryOf(offer.demoRatings)
export const sellerRatings = (seller: DemoRatingFields): RatingSummary | null => ratingSummaryOf(seller.demoRatings)

/** "nov. de 2026" for a demo member-since, or null (real public data has no sign-up date: LOOSE_WIRES.publicMemberSince). */
export function sellerMemberSince(seller: DemoRatingFields): string | null {
  return (seller.demoMemberSince && formatMonthYear(seller.demoMemberSince)) || null
}

const average = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const countLabel = (n: number) => `${n.toLocaleString('pt-BR')} ${n === 1 ? 'avaliação' : 'avaliações'}`

/** Accessible name shared by both forms: "Avaliação média 4,8 de 5, 126 avaliações". */
export function ratingSrText(r: RatingSummary): string {
  return `Avaliação média ${average(r.average)} de 5, ${countLabel(r.count)}`
}

/** Compact list form, after the trust line: star + "4,8 (126)". Never "/5". */
export function ratingCompactItem(r: RatingSummary): TrustLineItem {
  return { kind: 'rating', text: `${average(r.average)} (${r.count.toLocaleString('pt-BR')})`, srText: ratingSrText(r) }
}

/** Full detail/Profile form after the star: "4,8 · 126 avaliações". */
export function ratingFullText(r: RatingSummary): string {
  return `${average(r.average)} · ${countLabel(r.count)}`
}
