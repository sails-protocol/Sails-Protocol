import { DEMO_VERIFIED_CRITERIA, KYC_DEFAULT_THRESHOLD_USD, canSeeOffers, filterByCategory, kycSummary, meetsDemoVerifiedCriteria, pageOf, readViewMode, safeHttpsUrl, saveViewMode, VIEW_MODE_KEY } from '../src/lib/marketSpaces'
import { toMarketView, type Market } from '../src/lib/marketContract'
import { FUTURE_PAYMENT_ASSETS, SPACE_PRODUCTS, spaceProduct } from '../src/lib/spaceCatalog'

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

describe('Comunidades: category filter and pages', () => {
  const list = [{ id: 'a', category: 'GENERAL' as const }, { id: 'b', category: 'REGIONAL' as const }, { id: 'c', category: 'GENERAL' as const }]
  it('filters by category, "all" keeps everything and never mutates', () => {
    expect(filterByCategory(list, 'GENERAL').map((m) => m.id)).toEqual(['a', 'c'])
    expect(filterByCategory(list, 'COMMERCE')).toEqual([])
    const all = filterByCategory(list, 'all')
    expect(all).toEqual(list)
    expect(all).not.toBe(list)
  })

  it('slices a page shaped like discover (items, total, limit, offset)', () => {
    const items = Array.from({ length: 7 }, (_, i) => i)
    expect(pageOf(items, 3)).toEqual({ items: [0, 1, 2], total: 7, limit: 3, offset: 0 })
    expect(pageOf(items, 3, 6)).toEqual({ items: [6], total: 7, limit: 3, offset: 6 })
    expect(pageOf(items, 0, -2)).toEqual({ items: [0], total: 7, limit: 1, offset: 0 })
  })
})

describe('Meus mercados: grid or list, remembered', () => {
  it('defaults to grid, reads list, ignores junk', () => {
    expect(readViewMode(undefined)).toBe('grid')
    expect(readViewMode(store())).toBe('grid')
    expect(readViewMode(store({ [VIEW_MODE_KEY]: 'list' }))).toBe('list')
    expect(readViewMode(store({ [VIEW_MODE_KEY]: 'table' }))).toBe('grid')
    expect(readViewMode(store(), 'list')).toBe('list')
    expect(readViewMode(store({ [VIEW_MODE_KEY]: 'grid' }), 'list')).toBe('grid')
  })

  it('saves, and survives storage that throws', () => {
    const s = store()
    expect(saveViewMode(s, 'list')).toBe(true)
    expect(s.m.get(VIEW_MODE_KEY)).toBe('list')
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readViewMode(broken)).toBe('grid')
    expect(saveViewMode(broken, 'list')).toBe(false)
  })
})

describe('entry policy summary', () => {
  it('only https links are rendered', () => {
    expect(safeHttpsUrl('https://kyc.example/form')).toBe('https://kyc.example/form')
    expect(safeHttpsUrl('http://kyc.example')).toBeNull()
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpsUrl('not a url')).toBeNull()
    expect(safeHttpsUrl(undefined)).toBeNull()
  })

  it('summarizes none, above a value (with default) and all', () => {
    expect(kycSummary(undefined)).toEqual({ kind: 'none' })
    expect(kycSummary({ kyc: 'none' })).toEqual({ kind: 'none' })
    expect(kycSummary({ kyc: 'above_threshold', thresholdUsd: 25000, providerUrl: 'https://kyc.example' })).toEqual({ kind: 'above', thresholdUsd: 25000, formUrl: 'https://kyc.example/' })
    expect(kycSummary({ kyc: 'above_threshold', thresholdUsd: -1 })).toEqual({ kind: 'above', thresholdUsd: KYC_DEFAULT_THRESHOLD_USD, formUrl: null })
    expect(kycSummary({ kyc: 'all', providerUrl: 'javascript:x' })).toEqual({ kind: 'all', formUrl: null })
  })
})

describe('demo "Verificado" (fictional criteria) and private offers', () => {
  const c = DEMO_VERIFIED_CRITERIA
  const ok = { rating: c.minRating, ratings: c.minRatings, trades: c.minTrades, volumeUsd: c.minVolumeUsd }
  it('needs every fictional criterion', () => {
    expect(meetsDemoVerifiedCriteria(ok)).toBe(true)
    expect(meetsDemoVerifiedCriteria(undefined)).toBe(false)
    expect(meetsDemoVerifiedCriteria({ ...ok, rating: 4.4 })).toBe(false)
    expect(meetsDemoVerifiedCriteria({ ...ok, ratings: 49 })).toBe(false)
    expect(meetsDemoVerifiedCriteria({ ...ok, trades: 99 })).toBe(false)
    expect(meetsDemoVerifiedCriteria({ ...ok, volumeUsd: 49_999 })).toBe(false)
  })

  it('private offers only for members and admins', () => {
    expect(canSeeOffers({ visibility: 'public', relation: 'none' })).toBe(true)
    expect(canSeeOffers({ visibility: 'private', relation: 'none' })).toBe(false)
    expect(canSeeOffers({ visibility: 'private', relation: 'follows' })).toBe(false)
    expect(canSeeOffers({ visibility: 'private', relation: 'member' })).toBe(true)
    expect(canSeeOffers({ visibility: 'private', relation: 'admin' })).toBe(true)
  })
})

describe('contract draft adapter', () => {
  const m: Market = {
    id: 'x', name: 'X', description: 'd', category: 'REGIONAL', profile: 'EMPRESA_OTC', visibility: 'PRIVATE', participantsCount: 3,
    adminIdentity: 'k', createdAt: '2026-01-01T00:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: false, state: 'PUBLISHED',
  }
  it('maps visibility, relation (follower = follows) and counts', () => {
    const v = toMarketView(m, { marketId: 'x', relation: 'follower', joinedAt: '' })
    expect(v).toMatchObject({ id: 'x', visibility: 'private', relation: 'follows', participants: 3, category: 'REGIONAL', profile: 'EMPRESA_OTC', infrastructure: 'network' })
    expect(toMarketView(m).relation).toBe('none')
  })
})

describe('space catalog (Satsails service, demo prices)', () => {
  it('three one-time products and future payment assets only', () => {
    expect(SPACE_PRODUCTS.map((p) => [p.id, p.demoPriceUsd])).toEqual([['community', 497], ['private', 997], ['business', 1997]])
    expect(FUTURE_PAYMENT_ASSETS).toEqual(['BTC', 'USDT', 'USDC'])
    expect(spaceProduct('private')?.demoPriceUsd).toBe(997)
    expect(spaceProduct('monthly')).toBeNull()
  })
})

describe('simulated space checkout (demo)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkoutNetworks, checkoutStepNumber, demoEquivalent, nextCheckoutStep } = require('../src/lib/spaceCatalog') as typeof import('../src/lib/spaceCatalog')
  type Ev = Parameters<typeof nextCheckoutStep>[1]
  const run = (events: Ev[]) => events.reduce(nextCheckoutStep, 'catalog' as ReturnType<typeof nextCheckoutStep>)

  it('walks catalog -> payment -> awaiting -> confirming -> confirmed -> acquired', () => {
    expect(run([{ type: 'next' }, { type: 'next' }])).toBe('awaiting')
    expect(run([{ type: 'next' }, { type: 'next' }, { type: 'simulatePaid' }, { type: 'settled' }, { type: 'next' }])).toBe('acquired')
  })

  it('back works until the demo confirmation; no skipping the simulated payment', () => {
    expect(nextCheckoutStep('payment', { type: 'back' })).toBe('catalog')
    expect(nextCheckoutStep('awaiting', { type: 'back' })).toBe('payment')
    expect(nextCheckoutStep('confirming', { type: 'back' })).toBe('payment')
    expect(nextCheckoutStep('confirmed', { type: 'back' })).toBe('confirmed')
    expect(nextCheckoutStep('awaiting', { type: 'next' })).toBe('awaiting')
    expect(nextCheckoutStep('payment', { type: 'simulatePaid' })).toBe('payment')
    expect(nextCheckoutStep('awaiting', { type: 'settled' })).toBe('awaiting')
    expect(nextCheckoutStep('acquired', { type: 'reset' })).toBe('catalog')
  })

  it('numbers at most three checkout steps', () => {
    expect(['catalog', 'payment', 'awaiting', 'confirming', 'confirmed', 'acquired'].map((s) => checkoutStepNumber(s as never))).toEqual([null, 1, 2, 2, 2, 3])
  })

  it('lists only the catalog networks of the chosen asset', () => {
    const pairs = [{ asset: 'BTC', network: 'bitcoin' }, { asset: 'BTC', network: null }, { asset: 'USDT', network: 'tron' }, { asset: 'USDC', network: 'base' }]
    expect(checkoutNetworks('BTC', pairs).map((p) => p.network)).toEqual(['bitcoin'])
    expect(checkoutNetworks('USDT', pairs).map((p) => p.network)).toEqual(['tron'])
  })

  it('converts at a fixed demo quote, rounded per asset, and refuses a bad quote', () => {
    expect(demoEquivalent(497, 'BTC', 100_000)).toBe(0.00497)
    expect(demoEquivalent(1997, 'USDT', 1)).toBe(1997)
    expect(demoEquivalent(997, 'USDC', 0.9999)).toBe(997.1)
    expect(demoEquivalent(497, 'BTC', 0)).toBeNull()
    expect(demoEquivalent(497, 'BTC', undefined)).toBeNull()
  })
})

describe('off-trade warning heuristic (soft, never blocks)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { looksOffTrade } = require('../src/lib/offTradeRisk') as typeof import('../src/lib/offTradeRisk')
  it('flags payment details or moving the deal outside the trade', () => {
    for (const m of ['meu email é ana@exemplo.com', 'liga 11 98765-4321', 'chave 123e4567-e89b-12d3-a456-426614174000', 'me chama em wa.me/5511999', 't.me/fulano', 'manda direto que é mais rápido', 'pago por fora', 'Minha chave Pix é o CPF']) {
      expect(looksOffTrade(m)).toBe(true)
    }
  })
  it('leaves ordinary trade talk alone', () => {
    for (const m of ['Preciso comprar USDT, uns US$ 200', 'Abro a oferta agora', 'Pode ser por Pix dentro do trade?', 'Combinado, 1.500 reais']) {
      expect(looksOffTrade(m)).toBe(false)
    }
  })
})

describe('demo market offers (stand-in for liquidity.discover({ marketId }))', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { offersForMarket } = require('../src/lib/marketSpaces') as typeof import('../src/lib/marketSpaces')
  const offers = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}` }))
  it('is deterministic, a subset, and never empty when offers exist', () => {
    const a = offersForMarket(offers, 'm1')
    expect(offersForMarket(offers, 'm1')).toEqual(a)
    expect(a.length).toBeGreaterThan(0)
    expect(a.every((o) => offers.includes(o))).toBe(true)
    expect(offersForMarket([], 'm1')).toEqual([])
    expect(offersForMarket([{ id: 'x' }], 'anything').length).toBe(1)
  })
})
