import type { MarketplaceSort, Offer } from '../../types'

/**
 * Seller cell for the Market list: name plus one compact trust line.
 * Only the reputation is guaranteed (GET /v1/liquidity/offers returns traderReputation);
 * name, trade count and dispute count appear only when the offer actually carries them,
 * so a missing value is left out instead of shown as "—" or a made-up 0.
 */
export function sellerTrust(offer: Offer): { name: string | null; parts: string[] } {
  // Real summaries carry `makerStats` (fields undefined when the route did not return them);
  // offers built from a full User (mock data) use that User's counters.
  const stats = offer.makerStats ?? offer.user
  const parts = [`Reputação ${offer.user.reputationScore.toFixed(0)}`]
  if (stats.totalTrades !== undefined) parts.push(`${stats.totalTrades} ${stats.totalTrades === 1 ? 'trade' : 'trades'}`)
  if (stats.disputeCount !== undefined) parts.push(`${stats.disputeCount} ${stats.disputeCount === 1 ? 'disputa' : 'disputas'}`)
  return { name: offer.user.displayName || null, parts }
}

// Best price for the visitor: buying from a SELL offer wants the lowest, selling to a BUY offer the highest.
function bestPriceFirst(a: Offer, b: Offer): number {
  if (a.side !== b.side) return 0
  return a.side === 'SELL' ? a.priceUsd - b.priceUsd : b.priceUsd - a.priceUsd
}

export function compareOffers(sortBy: MarketplaceSort): (a: Offer, b: Offer) => number {
  if (sortBy === 'trades') return (a, b) => b.user.totalTrades - a.user.totalTrades
  if (sortBy === 'price') return (a, b) => a.priceUsd - b.priceUsd
  return (a, b) => b.user.reputationScore - a.user.reputationScore || bestPriceFirst(a, b)
}

/** "Valor" filter: the amount is in USD, so compare it with the offer's limits converted at its own priceUsd. */
export function offerAcceptsUsdAmount(offer: Offer, usd: number): boolean {
  if (!(usd > 0)) return true
  return usd >= offer.minAmount * offer.priceUsd && usd <= offer.maxAmount * offer.priceUsd
}
