import { isNavActive } from '../src/components/layout/navMatch'

const TRADES = { to: '/profile/active', also: ['/profile/history'] }
const PROFILE = { to: '/profile', end: true }
const MARKET = { to: '/', end: true }

describe('sidebar active state', () => {
  it('lights Trades on both trade list routes', () => {
    expect(isNavActive('/profile/active', TRADES)).toBe(true)
    expect(isNavActive('/profile/history', TRADES)).toBe(true)
    expect(isNavActive('/profile', TRADES)).toBe(false)
    expect(isNavActive('/profile/new-offer', TRADES)).toBe(false)
  })

  it('keeps Perfil and Market exact', () => {
    expect(isNavActive('/profile', PROFILE)).toBe(true)
    expect(isNavActive('/profile/active', PROFILE)).toBe(false)
    expect(isNavActive('/', MARKET)).toBe(true)
    expect(isNavActive('/settings', MARKET)).toBe(false)
  })

  it('prefix-matches non-end entries only on a path boundary', () => {
    expect(isNavActive('/disputes/abc', { to: '/disputes' })).toBe(true)
    expect(isNavActive('/disputesx', { to: '/disputes' })).toBe(false)
  })
})
