import { isNavActive, LEGACY_REDIRECTS, legacyRedirect, TRADES_ROUTES } from '../src/components/layout/navMatch'

// Same shape as NAV_ITEMS' Trades entry (layout/Sidebar.tsx).
const TRADES = { to: TRADES_ROUTES.active, also: ['/trade'] }
const PROFILE = { to: '/profile', end: true }
const MARKET = { to: '/', end: true }

describe('main menu active state', () => {
  it('lights Trades on every Trades tab', () => {
    for (const path of Object.values(TRADES_ROUTES)) expect(isNavActive(path, TRADES)).toBe(true)
    expect(isNavActive('/profile', TRADES)).toBe(false)
    expect(isNavActive('/tradesx', TRADES)).toBe(false)
  })

  it('lights Trades on a trade page, and only there', () => {
    expect(isNavActive('/trade/c41d9e73-demo-a2', TRADES)).toBe(true)
    expect(isNavActive('/trade', TRADES)).toBe(true)
    expect(isNavActive('/trader', TRADES)).toBe(false)
    expect(isNavActive('/trade/abc', PROFILE)).toBe(false)
  })

  it('keeps Perfil and Market exact', () => {
    expect(isNavActive('/profile', PROFILE)).toBe(true)
    expect(isNavActive('/trades/offers', PROFILE)).toBe(false)
    expect(isNavActive('/', MARKET)).toBe(true)
    expect(isNavActive('/settings', MARKET)).toBe(false)
  })

  it('prefix-matches non-end entries only on a path boundary, and honours `also`', () => {
    expect(isNavActive('/disputes/abc', { to: '/disputes' })).toBe(true)
    expect(isNavActive('/disputesx', { to: '/disputes' })).toBe(false)
    expect(isNavActive('/b', { to: '/a', also: ['/b'] })).toBe(true)
  })
})

describe('legacy redirects', () => {
  it('maps every old address to its new Trades tab', () => {
    expect(LEGACY_REDIRECTS).toEqual({
      '/profile/active': '/trades',
      '/profile/history': '/trades/history',
      '/profile/new-offer': '/trades/offers/new',
      '/disputes': '/trades/disputes',
    })
  })

  it('keeps query and hash, and tolerates a trailing slash', () => {
    expect(legacyRedirect({ pathname: '/disputes', search: '?case=1', hash: '#x' })).toEqual({ pathname: '/trades/disputes', search: '?case=1', hash: '#x' })
    expect(legacyRedirect({ pathname: '/profile/history/' })).toEqual({ pathname: '/trades/history', search: '', hash: '' })
  })

  it('leaves current routes alone', () => {
    expect(legacyRedirect({ pathname: '/profile' })).toBeNull()
    expect(legacyRedirect({ pathname: '/trades' })).toBeNull()
    expect(legacyRedirect({ pathname: '/' })).toBeNull()
  })

  it('never redirects to another legacy address (no loops)', () => {
    for (const to of Object.values(LEGACY_REDIRECTS)) expect(LEGACY_REDIRECTS[to]).toBeUndefined()
  })
})
