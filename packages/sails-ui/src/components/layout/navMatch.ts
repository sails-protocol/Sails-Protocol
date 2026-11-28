/**
 * Active-state rule for a nav entry: `end` means exact match, otherwise
 * the path or any child path; `also` lists sibling routes the entry owns.
 */
export function isNavActive(pathname: string, item: { to: string; end?: boolean; also?: readonly string[] }): boolean {
  const matches = (to: string, end?: boolean) => pathname === to || (!end && to !== '/' && pathname.startsWith(`${to}/`))
  return matches(item.to, item.end) || (item.also ?? []).some((to) => matches(to))
}

/** Trades section routes (DECISIONS.md "Reorganização pela visão do usuário"): one URL per tab. */
export const TRADES_ROUTES = {
  active: '/trades',
  history: '/trades/history',
  offers: '/trades/offers',
  newOffer: '/trades/offers/new',
  disputes: '/trades/disputes',
} as const

/** Market hub routes (CTO final correction for plan 1.4): markets live inside the Market area; the offer list stays at '/'. */
export const MARKETS_ROUTES = {
  explore: '/markets',
  mine: '/markets/mine',
  create: '/markets/new',
  join: '/markets/join',
} as const

/** One market's page (Market Spaces): a sibling of the hub tabs, not a tab. The id is opaque (lib/marketContract.ts). */
export const MARKET_PAGE_ROUTE = '/markets/:id'
export const marketPath = (id: string) => `/markets/${encodeURIComponent(id)}`
/** Mercado aberto named explicitly, so "/" does not forward to the saved default market (MarketHome). */
export const MARKET_OPEN_PATH = '/?market=public'

/** "Comprar espaço": a Satsails commercial service, demo only, kept apart from the markets hub (lib/spaceCatalog.ts). */
export const SPACE_SHOP_ROUTE = '/markets/space'

/** Old addresses that keep working: each one redirects (replace) to its new home. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  '/profile/active': TRADES_ROUTES.active,
  '/profile/history': TRADES_ROUTES.history,
  '/profile/new-offer': TRADES_ROUTES.newOffer,
  '/disputes': TRADES_ROUTES.disputes,
}

/** Where an old address now lives, keeping its query and hash; null when the path is not a legacy one. */
export function legacyRedirect(location: { pathname: string; search?: string; hash?: string }): { pathname: string; search: string; hash: string } | null {
  const pathname = LEGACY_REDIRECTS[location.pathname.replace(/\/+$/, '') || '/']
  return pathname ? { pathname, search: location.search ?? '', hash: location.hash ?? '' } : null
}
