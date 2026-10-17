/**
 * #235 R7H-E2 — which observations become a canonical quote. Pure and exact (Prisma.Decimal throughout).
 *
 * 1. Observations whose source timestamp is stale or ahead of asOf (policy bounds) are excluded.
 * 2. The accepted set is the largest group of observations, contiguous in price, whose spread is within the
 *    policy's disagreement bound relative to the group's median, with at least the policy's minimum operators.
 *    An extreme price therefore falls outside the group instead of moving it. Two different groups of that
 *    largest size mean the sources disagree about the price: nothing is selected (fail closed), never a pick.
 * 3. The accepted set needs at least one source timestamp (the schema's freshness anchor).
 * The authorization price is the set's maximum (conservative); the median is the reference.
 *
 * These are the same rules valuation_quote_assert_complete() enforces at commit, so a selection the database
 * would refuse is never attempted.
 */
import { Prisma } from '@prisma/client'
import type { SourceObservation } from './price-sources'

export interface QuotePolicy {
  quoteWindowSeconds: number
  quotePublicationMaxSeconds: number
  maxSourceDisagreementBps: number
  minAgreeingOperators: number
  sourceMaxAgeSeconds: number
  sourceFutureSkewSeconds: number
}

export interface Exclusion {
  operator: string
  reason: 'STALE_SOURCE_TIMESTAMP' | 'FUTURE_SOURCE_TIMESTAMP' | 'OUTSIDE_AGREEMENT'
  price: string
}

export interface QuoteSummary {
  priceMaxUsd: string
  priceMedianUsd: string
  observationCount: number
  sourceSpreadBps: number
}

export type Selection =
  | { ok: true; accepted: SourceObservation[]; excluded: Exclusion[]; summary: QuoteSummary }
  | { ok: false; reason: 'INSUFFICIENT_AGREEMENT' | 'AMBIGUOUS_AGREEMENT' | 'NO_TIMESTAMPED_SOURCE'; excluded: Exclusion[] }

function median(sorted: Prisma.Decimal[]): Prisma.Decimal {
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) / 2] : sorted[n / 2 - 1].plus(sorted[n / 2]).div(2)
}

function agrees(prices: Prisma.Decimal[], bps: number): boolean {
  return prices[prices.length - 1].minus(prices[0]).times(10000).lte(median(prices).times(bps))
}

export function selectAgreeingSet(asOf: Date, observations: readonly SourceObservation[], policy: QuotePolicy): Selection {
  const excluded: Exclusion[] = []
  const oldest = asOf.getTime() - policy.sourceMaxAgeSeconds * 1000
  const newest = asOf.getTime() + policy.sourceFutureSkewSeconds * 1000
  const fresh = observations.filter((o) => {
    const t = o.sourceTimestamp?.getTime()
    if (t !== undefined && t < oldest) excluded.push({ operator: o.operator, reason: 'STALE_SOURCE_TIMESTAMP', price: o.price.toFixed() })
    else if (t !== undefined && t > newest) excluded.push({ operator: o.operator, reason: 'FUTURE_SOURCE_TIMESTAMP', price: o.price.toFixed() })
    else return true
    return false
  })

  const sorted = [...fresh].sort((a, b) => a.price.comparedTo(b.price) || a.operator.localeCompare(b.operator))
  const prices = sorted.map((o) => o.price)
  let best: Array<[number, number]> = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (!agrees(prices.slice(i, j + 1), policy.maxSourceDisagreementBps)) continue
      const size = j - i + 1
      const bestSize = best.length ? best[0][1] - best[0][0] + 1 : 0
      if (size > bestSize) best = [[i, j]]
      else if (size === bestSize) best.push([i, j])
    }
  }
  const outside = (keep: SourceObservation[]) =>
    sorted.filter((o) => !keep.includes(o)).map((o) => ({ operator: o.operator, reason: 'OUTSIDE_AGREEMENT' as const, price: o.price.toFixed() }))

  if (!best.length || best[0][1] - best[0][0] + 1 < policy.minAgreeingOperators) {
    return { ok: false, reason: 'INSUFFICIENT_AGREEMENT', excluded: [...excluded, ...outside([])] }
  }
  if (best.length > 1) return { ok: false, reason: 'AMBIGUOUS_AGREEMENT', excluded: [...excluded, ...outside([])] }

  const accepted = sorted.slice(best[0][0], best[0][1] + 1)
  excluded.push(...outside(accepted))
  if (!accepted.some((o) => o.sourceTimestamp)) return { ok: false, reason: 'NO_TIMESTAMPED_SOURCE', excluded }

  const acceptedPrices = accepted.map((o) => o.price)
  const hi = acceptedPrices[acceptedPrices.length - 1]
  const mid = median(acceptedPrices)
  return {
    ok: true,
    accepted,
    excluded,
    summary: {
      priceMaxUsd: hi.toFixed(8),
      priceMedianUsd: mid.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
      observationCount: accepted.length,
      sourceSpreadBps: hi.minus(acceptedPrices[0]).times(10000).div(mid).ceil().toNumber(),
    },
  }
}
