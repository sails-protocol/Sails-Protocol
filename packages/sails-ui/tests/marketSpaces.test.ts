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
    expect(filterByCategory(list, 'BUSINESS_OTC')).toEqual([])
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
