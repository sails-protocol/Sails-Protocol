/**
 * Market Spaces view logic (DECISIONS.md "Mercados (Market Spaces): diretriz do CTO, 2026-11-22"): category filter,
 * page slicing for Explorar mercados, the remembered grid/list choice of Meus mercados, the entry policy summary,
 * the demo-only "Verificado" criteria and who may see a market's offers. Pure; storage is passed in.
 */
import type { EntryPolicy, MarketCategory } from './marketContract'
import type { MarketView } from './myMarkets'

export const MARKET_CATEGORIES: readonly MarketCategory[] = ['GENERAL', 'P2P_TRADER', 'BUSINESS_OTC', 'REGIONAL']
export type CategoryFilter = MarketCategory | 'all'

export function filterByCategory<T extends Pick<MarketView, 'category'>>(markets: readonly T[], filter: CategoryFilter): T[] {
  return filter === 'all' ? [...markets] : markets.filter((m) => m.category === filter)
}

/** One page of a list, shaped like sails.markets.discover's answer. Negative or fractional input is clamped. */
export function pageOf<T>(items: readonly T[], limit: number, offset = 0): { items: T[]; total: number; limit: number; offset: number } {
  const l = Math.max(1, Math.floor(limit))
  const o = Math.max(0, Math.floor(offset))
  return { items: items.slice(o, o + l), total: items.length, limit: l, offset: o }
}

export type ViewMode = 'grid' | 'list'
export const VIEW_MODE_KEY = 'sails_my_markets_view'
type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Grid by default; anything unreadable (private window, blocked storage, junk value) falls back to grid. */
export function readViewMode(store: Store | undefined): ViewMode {
  try { return store?.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}

export function saveViewMode(store: Store | undefined, mode: ViewMode): boolean {
  try { store?.setItem(VIEW_MODE_KEY, mode); return !!store } catch { return false }
}

/**
 * Only an https link is ever rendered as the admin's KYC provider form (no javascript:, data: or plain http).
 * Returns the normalized URL or null.
 */
export function safeHttpsUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' && !!u.hostname ? u.href : null
  } catch { return null }
}

/** The KYC default the wizard proposes for "KYC acima de um valor" (PO example: US$ 10 mil). */
export const KYC_DEFAULT_THRESHOLD_USD = 10_000

/** What the market page says about KYC; `formUrl` only when it is a safe https link. */
export type KycSummary =
  | { kind: 'none' }
  | { kind: 'above'; thresholdUsd: number; formUrl: string | null }
  | { kind: 'all'; formUrl: string | null }

export function kycSummary(policy: Pick<EntryPolicy, 'kyc' | 'thresholdUsd' | 'providerUrl'> | undefined): KycSummary {
  if (!policy || policy.kyc === 'none') return { kind: 'none' }
  const formUrl = safeHttpsUrl(policy.providerUrl)
  if (policy.kyc === 'all') return { kind: 'all', formUrl }
  const t = policy.thresholdUsd
  return { kind: 'above', thresholdUsd: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : KYC_DEFAULT_THRESHOLD_USD, formUrl }
}

/** Fictional "Verificado" criteria, demo only; the real criteria are not defined (CTO and protocol, N1). */
export const DEMO_VERIFIED_CRITERIA = { minRating: 4.5, minRatings: 50, minTrades: 100, minVolumeUsd: 50_000 } as const
export interface DemoMarketStats { rating: number; ratings: number; trades: number; volumeUsd: number }

export function meetsDemoVerifiedCriteria(s: DemoMarketStats | undefined): boolean {
  const c = DEMO_VERIFIED_CRITERIA
  return !!s && s.rating >= c.minRating && s.ratings >= c.minRatings && s.trades >= c.minTrades && s.volumeUsd >= c.minVolumeUsd
}

/**
 * Whether the screen lists a market's offers: always for a public one; for a private one only after the person
 * joined (member or admin). Screen-level only: the real access control belongs to the protocol and the SDKs.
 */
export function canSeeOffers(m: Pick<MarketView, 'visibility' | 'relation'>): boolean {
  return m.visibility === 'public' || m.relation === 'member' || m.relation === 'admin'
}
