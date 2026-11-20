import {
  orderMarketContexts,
  isSelectableContext,
  resolveContextSelection,
  canViewContextContent,
  hasOnlyPublicContexts,
  type MarketContextView,
} from '../src/lib/marketContext'

const pub: MarketContextView = { id: 'pub', name: 'Público', kind: 'public', access: 'open' }
const cB: MarketContextView = { id: 'cb', name: 'Beta', kind: 'community', access: 'open' }
const cA: MarketContextView = { id: 'ca', name: 'Alfa', kind: 'community', access: 'open' }
const priv: MarketContextView = { id: 'pv', name: 'Aaa', kind: 'private', access: 'restricted', memberStatus: 'member' }
const gone: MarketContextView = { id: 'x', name: 'Pausada', kind: 'community', access: 'unavailable', unavailableReason: 'r' }

describe('market context helpers (D1 prototype)', () => {
  it('orders public, then communities, then private, alphabetically inside a kind, without mutating', () => {
    const input = [priv, cB, gone, pub, cA]
    expect(orderMarketContexts(input).map((o) => o.id)).toEqual(['pub', 'ca', 'cb', 'x', 'pv'])
    expect(input[0]).toBe(priv)
  })

  it('never activates an unavailable or unknown context', () => {
    const all = [pub, cA, gone]
    expect(isSelectableContext(gone)).toBe(false)
    expect(resolveContextSelection(all, 'x')).toBeNull()
    expect(resolveContextSelection(all, 'nope')).toBeNull()
    expect(resolveContextSelection(all, 'ca')).toBe('ca')
  })

  it('shows a restricted context only to members', () => {
    expect(canViewContextContent(pub)).toBe(true)
    expect(canViewContextContent(priv)).toBe(true)
    for (const memberStatus of ['none', 'invited', undefined] as const) {
      expect(canViewContextContent({ ...priv, memberStatus })).toBe(false)
    }
    expect(canViewContextContent({ ...gone, memberStatus: 'member' })).toBe(false)
  })

  it('detects the communities empty state', () => {
    expect(hasOnlyPublicContexts([pub])).toBe(true)
    expect(hasOnlyPublicContexts([pub, cA])).toBe(false)
  })
})
