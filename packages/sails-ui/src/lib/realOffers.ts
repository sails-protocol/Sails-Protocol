/**
 * Real Marketplace data — @satsails/p2p-trading-sdk's `liquidity.discover()`
 * (GET /v1/liquidity/offers), replacing `offersStore.ts`'s mocked
 * MOCK_OFFERS + localStorage layer.
 *
 * `discover()` only filters by asset+side (both required) — no
 * "give me everything" route exists (verified against
 * src/modules/open-liquidity/liquidity.routes.ts directly, same
 * limitation the SDK's own liquidity.ts doc comment already discloses).
 * To show the Marketplace's "Todos" default, this fans out one call per
 * (asset, side) combination and merges — 20 requests worst case (10
 * ASSETS × 2 sides), acceptable for this reference UI's scale, not a
 * pattern a high-traffic production client should copy without a real
 * "list all" backend route.
 *
 * `LiquidityOfferSummary` (the real response shape — see
 * packages/sails-sdk/src/modules/liquidity.ts's own comment for the bug
 * this uncovered) is missing several fields the UI's `Offer` type wants
 * (seller displayName, country, description, paymentDetails,
 * network) — the real /v1/liquidity/offers route genuinely doesn't
 * return them today. Filled with honest placeholders below, each
 * commented, not silently invented as if real.
 */
import type { LiquidityOfferSummary } from '@satsails/p2p-trading-sdk'
import { sailsClient } from './sailsClient'
import type { AssetType, Offer, PaymentMethod, TradeSide, User } from '../types'
import { ASSETS } from '../data/mock'

// `@satsails/p2p-trading-sdk`'s own `discover()` is typed against the *real* backend
// AssetType (no `DEPIX` — see types.ts's own comment on why this UI's
// broader `AssetType` has it). A real GET for an asset the backend
// doesn't recognize would either 400 or, worse, silently mismatch —
// neither is useful, and there provably can be no real DePix offers
// yet regardless. Short-circuit instead of calling discover() at all.
const REAL_ASSETS = new Set<string>(ASSETS)

function summaryToOffer(s: LiquidityOfferSummary): Offer {
  const price = Number(s.priceUsd)
  // GET /v1/liquidity/offers doesn't return the owning User row at all
  // (only traderReputation, mapOfferToLiquidityOffer() in
  // liquidity.service.ts) — displayName/verified/etc. aren't available
  // without a second real lookup this reference UI doesn't make yet.
  const placeholderUser: User = {
    id: 'unknown',
    publicKey: '',
    displayName: null,
    peerId: null,
    reputationScore: s.traderReputation ?? 0,
    totalTrades: 0,
    disputeCount: 0,
    totalVolumeBtc: 0,
    verified: false,
    createdAt: new Date().toISOString(),
  }

  return {
    id: s.id,
    userId: 'unknown', // not returned by this route — see placeholderUser's comment
    user: placeholderUser,
    asset: s.asset,
    side: s.side,
    priceUsd: price,
    fiatCurrency: 'USD', // discover() returns priceUsd, never a converted BRL price
    priceFiat: price,
    minAmount: Number(s.minAmount),
    maxAmount: Number(s.maxAmount),
    paymentMethod: (s.paymentMethods[0] as PaymentMethod) ?? 'PIX',
    status: 'ACTIVE', // discover()/getAggregatedOffers() only ever returns ACTIVE offers (liquidity.service.ts's own where clause)
    country: 'BR', // not returned by this route — no real country field exists on Offer yet, same gap types.ts's own header already discloses
    tradedWithCurrentUser: false, // needs a real trade-history join this route doesn't do — see types.ts's own comment on this field
    blockedRelationship: false, // no real block-list backend yet — same as above
    createdAt: new Date().toISOString(), // not returned by this route
  }
}

// Real gap fixed here (Fase 3 E2E follow-up): a single `limit: 50` call
// per (asset, side) still hard-caps at 50 — a freshly-published offer
// can still be permanently unreachable once 50+ offers accumulate for
// that pair (confirmed directly: this exact thing broke
// e2e/flows/p2p-trade-happy-path.spec.ts once the shared local dev
// Postgres had enough leftover test offers). The backend and SDK
// already support full limit+offset pagination (liquidity.routes.ts,
// sails-sdk's discover()) — this was the one caller never using it
// beyond a single page. `discover()`'s real response has no
// total/hasMore field (DiscoverResult is just {offers, sources}), so
// "a short page means the last page" is the correct, standard way to
// know when to stop — not a total count this route doesn't return.
// Narrower than the UI's own `AssetType` on purpose (this file's own
// comment above on `REAL_ASSETS`) — `@satsails/p2p-trading-sdk`'s `discover()` is typed
// against the real backend enum, which has no `DEPIX`.
async function fetchAllPages(asset: (typeof ASSETS)[number], side: TradeSide): Promise<{ offers: Offer[]; failed: boolean }> {
  const pageSize = 50 // the route's own max (docs/TODO.md §25)
  const collected: Offer[] = []
  let offset = 0

  for (;;) {
    let page: LiquidityOfferSummary[]
    try {
      page = (await sailsClient.liquidity.discover({ asset, side, limit: pageSize, offset })).offers
    } catch (err) {
      console.error(`[realOffers] discover(${asset}, ${side}, offset=${offset}) failed:`, err)
      return { offers: collected, failed: true }
    }
    for (const s of page) collected.push(summaryToOffer(s))
    if (page.length < pageSize) break // short page — no more pages
    offset += pageSize
  }

  return { offers: collected, failed: false }
}

function isRealAsset(a: AssetType): a is (typeof ASSETS)[number] {
  return REAL_ASSETS.has(a)
}

// `hadError` (2026-08-02) — closes a real SLC-audit finding: every
// discover() failure used to be swallowed silently (only console.error'd
// above), so a total backend outage rendered identically to "no offers
// match your filters" in Marketplace.tsx. Fanning out up to 20 requests
// means a single boolean can't mean "the whole page errored" — it means
// "at least one (asset, side) pair's fetch failed," which is enough for
// Marketplace.tsx to show a real warning without pretending a partial
// failure is a total one.
export async function fetchOffers(asset: AssetType | 'Todos', side: TradeSide | 'Todos'): Promise<{ offers: Offer[]; hadError: boolean }> {
  // DEPIX (or any future UI-only asset) has no real backend offers by
  // definition — 'Todos' only ever needs the real `ASSETS` (not
  // `ASSETS_FILTERABLE`, which is for the picker's *options*, not what
  // this fans real network calls out to); a direct single-asset request
  // for DEPIX specifically short-circuits the same way.
  if (asset !== 'Todos' && !isRealAsset(asset)) return { offers: [], hadError: false }
  const assets: (typeof ASSETS)[number][] = asset === 'Todos' ? [...ASSETS] : [asset]
  const sides: TradeSide[] = side === 'Todos' ? ['BUY', 'SELL'] : [side]

  const results = await Promise.all(
    assets.flatMap((a) => sides.map((s) => fetchAllPages(a, s)))
  )

  const seen = new Map<string, Offer>()
  let hadError = false
  for (const result of results) {
    if (result.failed) hadError = true
    for (const o of result.offers) seen.set(o.id, o)
  }
  return { offers: [...seen.values()], hadError }
}
