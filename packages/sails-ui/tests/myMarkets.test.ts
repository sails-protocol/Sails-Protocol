import { composeMyMarkets, defaultMarketTarget, ownMarkets, type MarketView } from '../src/lib/myMarkets'

const DEFAULT: MarketView = { id: 'public', name: 'Mercado público', visibility: 'public', relation: 'default', infrastructure: 'network' }
const LOJA: MarketView = { id: 'loja', name: 'Loja Exemplo', visibility: 'public', relation: 'follows', infrastructure: 'network' }
const ABC: MarketView = { id: 'abc', name: 'Clientes Empresa ABC', visibility: 'private', relation: 'member', infrastructure: 'own' }
const AMIGOS: MarketView = { id: 'amigos', name: 'Bitcoin Amigos PY', visibility: 'private', relation: 'member', infrastructure: 'network' }

describe('markets composition', () => {
  it('default first, then other public markets, then private markets, each by name', () => {
    expect(composeMyMarkets(DEFAULT, [ABC, LOJA, AMIGOS]).map((m) => m.id)).toEqual(['public', 'loja', 'amigos', 'abc'])
  })

  it('only the default market when nothing else is known', () => {
    expect(composeMyMarkets(DEFAULT, [])).toEqual([DEFAULT])
  })

  it('drops a second default and duplicate ids, and does not mutate the input', () => {
    const input = [ABC, { ...DEFAULT, id: 'fake-default' }, AMIGOS, { ...AMIGOS }]
    expect(composeMyMarkets(DEFAULT, input).map((m) => m.id)).toEqual(['public', 'amigos', 'abc'])
    expect(input.map((m) => m.id)).toEqual(['abc', 'fake-default', 'amigos', 'amigos'])
  })

  it('infrastructure never changes the order', () => {
    const own = composeMyMarkets(DEFAULT, [{ ...AMIGOS, infrastructure: 'own' }, { ...ABC, infrastructure: 'network' }])
    expect(own.map((m) => m.id)).toEqual(['public', 'amigos', 'abc'])
  })
})

describe('mundo aberto: a market joined by invite', () => {
  it('comes right after the default market', () => {
    const joined: MarketView = { id: 'convite', name: 'Zeta Clube', visibility: 'private', relation: 'member', infrastructure: 'network', joinedByInvite: true }
    expect(composeMyMarkets(DEFAULT, [LOJA, ABC, joined]).map((m) => m.id)).toEqual(['public', 'convite', 'loja', 'abc'])
  })
})

describe('own markets', () => {
  it('leaves out markets the person only could discover', () => {
    const clube: MarketView = { id: 'clube', name: 'Clube', visibility: 'public', relation: 'none', infrastructure: 'network' }
    expect(ownMarkets([DEFAULT, clube, LOJA]).map((m) => m.id)).toEqual(['public', 'loja'])
  })
})

describe('default market on open', () => {
  const all = [DEFAULT, LOJA, ABC]
  it('opens the saved market while the person still belongs to it', () => {
    expect(defaultMarketTarget('abc', all)).toBe('abc')
    expect(defaultMarketTarget('loja', all)).toBe('loja')
  })
  it('falls back to Mercado Sails when nothing is saved, the default is saved, the market is gone or was left', () => {
    expect(defaultMarketTarget(null, all)).toBeNull()
    expect(defaultMarketTarget('public', all)).toBeNull()
    expect(defaultMarketTarget('gone', all)).toBeNull()
    expect(defaultMarketTarget('abc', [DEFAULT, { ...ABC, relation: 'none' }])).toBeNull()
  })
})
