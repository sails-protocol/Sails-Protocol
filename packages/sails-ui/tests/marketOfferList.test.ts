import { compareOffers, isOwnOffer, offerAcceptsUsdAmount, sellerTrust } from '../src/components/marketplace/offerList'
import { DEFAULT_FILTERS } from '../src/types'
import type { Offer, User } from '../src/types'

function user(patch: Partial<User> = {}): User {
  return {
    id: 'unknown', publicKey: '', displayName: null, peerId: null, reputationScore: 0, totalTrades: 0,
    disputeCount: 0, totalVolumeBtc: 0, verified: false, createdAt: '', ...patch,
  }
}

function offer(id: string, patch: Partial<Offer> = {}, u: Partial<User> = {}): Offer {
  return {
    id, userId: 'unknown', user: user(u), asset: 'BTC', side: 'SELL', priceUsd: 100, fiatCurrency: 'USD', priceFiat: 100,
    minAmount: 0.001, maxAmount: 0.01, paymentMethod: 'PIX', status: 'ACTIVE', country: 'BR',
    tradedWithCurrentUser: false, blockedRelationship: false, createdAt: '', ...patch,
  }
}

const ids = (list: Offer[]) => list.map((o) => o.id)

describe('Market default sort', () => {
  it('defaults to reputation', () => {
    expect(DEFAULT_FILTERS.sortBy).toBe('reputation')
  })

  it('orders by reputation desc, then best price for the visitor', () => {
    const list = [
      offer('sell-low-rep', { priceUsd: 90 }, { reputationScore: 10 }),
      offer('sell-high', { priceUsd: 110 }, { reputationScore: 50 }),
      offer('sell-cheap', { priceUsd: 95 }, { reputationScore: 50 }),
      offer('buy-low', { side: 'BUY', priceUsd: 90 }, { reputationScore: 30 }),
      offer('buy-high', { side: 'BUY', priceUsd: 99 }, { reputationScore: 30 }),
    ]
    // Buying from SELL offers: cheapest first. Selling to BUY offers: highest bid first.
    expect(ids([...list].sort(compareOffers('reputation')))).toEqual(['sell-cheap', 'sell-high', 'buy-high', 'buy-low', 'sell-low-rep'])
  })

  it('keeps the price and trades sorts', () => {
    const list = [offer('a', { priceUsd: 3 }, { totalTrades: 1 }), offer('b', { priceUsd: 1 }, { totalTrades: 9 })]
    expect(ids([...list].sort(compareOffers('price')))).toEqual(['b', 'a'])
    expect(ids([...list].sort(compareOffers('trades')))).toEqual(['b', 'a'])
  })
})

describe('Market seller cell', () => {
  // The cell's visible trust text; the icon kinds are checked once below.
  const seller = (o: Offer) => { const t = sellerTrust(o); return { name: t.name, parts: t.items.map((i) => i.text) } }

  it('real list offer: no name, no counters -> reputation only, no placeholders', () => {
    const o = offer('x', { makerStats: { totalTrades: undefined, disputeCount: undefined } }, { reputationScore: 92 })
    expect(seller(o)).toEqual({ name: null, parts: ['Reputação 92'] })
  })

  it('shows name and counters when the summary carries them', () => {
    const o = offer('x', { makerStats: { totalTrades: 12, disputeCount: 1 } }, { displayName: 'Carol', reputationScore: 19 })
    expect(seller(o)).toEqual({ name: 'Carol', parts: ['Reputação 19', '12 trades', '1 disputa'] })
  })

  it('shows trade count without inventing a dispute count', () => {
    const o = offer('x', { makerStats: { totalTrades: 1 } }, { reputationScore: 2 })
    expect(seller(o).parts).toEqual(['Reputação 2', '1 trade'])
  })

  it('name without counters keeps only the reputation line', () => {
    const o = offer('x', { makerStats: {} }, { displayName: 'Maré', reputationScore: 0 })
    expect(seller(o)).toEqual({ name: 'Maré', parts: ['Reputação 0'] })
  })

  it('offers built from a full User use its counters', () => {
    const o = offer('x', {}, { displayName: 'Ana', reputationScore: 40, totalTrades: 20, disputeCount: 0 })
    expect(seller(o).parts).toEqual(['Reputação 40', '20 trades', '0 disputas'])
    expect(sellerTrust(o).items.map((i) => i.kind)).toEqual(['reputation', 'trades', 'disputes'])
  })
})

describe('Market amount filter (USD)', () => {
  // 0.001-0.01 BTC at $100,000 = $100-$1,000
  const btc = offer('btc', { priceUsd: 100000, minAmount: 0.001, maxAmount: 0.01 })

  it('compares the USD amount with limits converted at the offer price', () => {
    expect(offerAcceptsUsdAmount(btc, 100)).toBe(true)
    expect(offerAcceptsUsdAmount(btc, 500)).toBe(true)
    expect(offerAcceptsUsdAmount(btc, 1000)).toBe(true)
    expect(offerAcceptsUsdAmount(btc, 99)).toBe(false)
    expect(offerAcceptsUsdAmount(btc, 1001)).toBe(false)
  })

  it('does not compare a USD amount against raw asset units', () => {
    // 0.005 would pass a raw BTC-unit check; as $0.005 it is below the $100 minimum.
    expect(offerAcceptsUsdAmount(btc, 0.005)).toBe(false)
  })

  it('an empty or zero amount filters nothing', () => {
    expect(offerAcceptsUsdAmount(btc, 0)).toBe(true)
    expect(offerAcceptsUsdAmount(btc, Number(''))).toBe(true)
    expect(offerAcceptsUsdAmount(btc, NaN)).toBe(true)
  })
})

describe('isOwnOffer', () => {
  it('matches by id from the viewer own offer list (the public list has no owner id)', () => {
    expect(isOwnOffer(offer('mine'), new Set(['mine']), 'me')).toBe(true)
    expect(isOwnOffer(offer('theirs'), new Set(['mine']), 'me')).toBe(false)
  })
  it('matches by owner id only when the offer carries a real one', () => {
    expect(isOwnOffer(offer('a', { userId: 'me' }), new Set(), 'me')).toBe(true)
    expect(isOwnOffer(offer('a'), new Set(), 'unknown')).toBe(false)
    expect(isOwnOffer(offer('a', { userId: 'me' }), new Set(), null)).toBe(false)
  })
})
