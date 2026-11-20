import {
  orderMarketContexts,
  groupMarketContexts,
  contextBlock,
  isSelectableContext,
  resolveContextSelection,
  hasOnlyPublicContexts,
  type MarketContextView,
} from '../src/lib/marketContext'

const pub: MarketContextView = { id: 'pub', name: 'Público', kind: 'public', access: 'open' }
const cB: MarketContextView = { id: 'cb', name: 'Beta', kind: 'community', access: 'open' }
const cA: MarketContextView = { id: 'ca', name: 'Alfa', kind: 'community', access: 'open' }
const rMember: MarketContextView = { id: 'rm', name: 'Aaa', kind: 'restricted', access: 'restricted', memberStatus: 'member' }
const rNone: MarketContextView = { id: 'rn', name: 'Bbb', kind: 'restricted', access: 'restricted', memberStatus: 'none' }
const gone: MarketContextView = { id: 'x', name: 'Pausada', kind: 'community', access: 'unavailable', unavailableReason: 'r' }

describe('market context helpers (D1 prototype)', () => {
  it('orders public, then communities, then restricted, alphabetically inside a kind, without mutating', () => {
    const input = [rMember, cB, gone, pub, cA]
    expect(orderMarketContexts(input).map((o) => o.id)).toEqual(['pub', 'ca', 'cb', 'x', 'rm'])
    expect(input[0]).toBe(rMember)
  })

  it('groups by kind in order and drops empty groups', () => {
    expect(groupMarketContexts([rMember, pub]).map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([['public', ['pub']], ['restricted', ['rm']]])
  })

  it('tells "access not granted" apart from "market unavailable"', () => {
    expect(contextBlock(pub)).toBeNull()
    expect(contextBlock(rMember)).toBeNull()
    for (const memberStatus of ['none', 'invited', undefined] as const) {
      expect(contextBlock({ ...rNone, memberStatus })).toBe('not-granted')
    }
    // Unavailable wins even for a member: the market itself cannot be reached.
    expect(contextBlock({ ...gone, memberStatus: 'member' })).toBe('unavailable')
  })

  it('never activates a blocked or unknown context', () => {
    const all = [pub, cA, gone, rNone, rMember]
    expect(isSelectableContext(gone)).toBe(false)
    expect(isSelectableContext(rNone)).toBe(false)
    expect(resolveContextSelection(all, 'x')).toBeNull()
    expect(resolveContextSelection(all, 'rn')).toBeNull()
    expect(resolveContextSelection(all, 'nope')).toBeNull()
    expect(resolveContextSelection(all, 'rm')).toBe('rm')
    expect(resolveContextSelection(all, 'ca')).toBe('ca')
  })

  it('detects the communities empty state', () => {
    expect(hasOnlyPublicContexts([pub])).toBe(true)
    expect(hasOnlyPublicContexts([pub, cA])).toBe(false)
  })
})
