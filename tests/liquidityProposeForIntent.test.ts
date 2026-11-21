/**
 * Missão 02 Fase 4/5 — liquidityRouter.proposeForIntent() in isolation.
 * Only ../src/common/database is mocked (the one real dependency this
 * code path touches); no HTTP, no rate limiter, no app instance — this is
 * the sort/filter/counterproposal logic itself, independent of route
 * wiring (already covered separately in routes.test.ts's RFC-023 block).
 */
export {} // forces this file to be a module (no top-level import/export
// otherwise) so its top-level `const mockOfferFindMany` doesn't leak into
// the shared global scope and collide with another such file's
// identically named one (found for real, Missão 06: colliding with
// tests/liquidityOfferRouteCollision.test.ts's own module-scope one).
const mockOfferFindMany = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: { offer: { findMany: (...args: unknown[]) => mockOfferFindMany(...args) } },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { liquidityRouter } = require('../src/modules/open-liquidity/liquidity.service')

const sellOffer = (overrides: Record<string, unknown> = {}) => ({
  id: 'offer-1', asset: 'BTC', side: 'SELL', priceUsd: '65000',
  minAmount: '0.01', maxAmount: '1', paymentMethod: 'PIX',
  user: { reputationScore: 50 },
  ...overrides,
})

describe('liquidityRouter.proposeForIntent() — Missão 02 Fase 4', () => {
  beforeEach(() => {
    mockOfferFindMany.mockReset()
  })

  it('returns a full match when a real offer clears price/reputation/amount', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer()])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })
    expect(result.match?.id).toBe('offer-1')
    expect(result.counterProposal).toBeNull()
  })

  it('returns a counterProposal, never a match, when the nearest offer clears amount/reputation but misses only on price', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ priceUsd: '75000' })])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })
    expect(result.match).toBeNull()
    expect(result.counterProposal).toEqual({
      referenceOfferId: 'offer-1',
      listedPriceUsd: '75000',
      suggestedPriceUsd: '70000',
      reasoning: expect.any(String),
    })
  })

  it('offers no counterProposal when the near-miss also fails reputation', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ priceUsd: '75000', user: { reputationScore: 10 } })])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })
    expect(result.match).toBeNull()
    expect(result.counterProposal).toBeNull()
  })

  it('offers no counterProposal when the near-miss also fails the offer\'s own amount bounds', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ priceUsd: '75000', minAmount: '0.5' })])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })
    expect(result.match).toBeNull()
    expect(result.counterProposal).toBeNull()
  })

  it('with no price bound declared at all, any price clears — a full match, not a counterProposal', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ priceUsd: '75000' })])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { minReputation: 40 })
    expect(result.match?.id).toBe('offer-1')
    expect(result.counterProposal).toBeNull()
  })

  it('the suggested counter price never exceeds the buyer\'s own declared ceiling, however far above it the listed price is', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ priceUsd: '1000000' })])
    const result = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })
    expect(Number(result.counterProposal?.suggestedPriceUsd)).toBeLessThanOrEqual(70000)
  })

  it('a SELL-side Intent counters at its own price floor (minPriceUsd), not a ceiling', async () => {
    mockOfferFindMany.mockResolvedValueOnce([{
      id: 'offer-2', asset: 'BTC', side: 'BUY', priceUsd: '50000',
      minAmount: '0.01', maxAmount: '1', paymentMethod: 'PIX', user: { reputationScore: 50 },
    }])
    const result = await liquidityRouter.proposeForIntent('BTC', 'SELL', '0.1', { priceMin: '60000', minReputation: 40 })
    expect(result.match).toBeNull()
    expect(result.counterProposal?.suggestedPriceUsd).toBe('60000')
  })

  // Missão 02 Fase 5 item 14 — determinism. Same inputs, called twice,
  // must produce the exact same result — proven directly against the
  // logic itself rather than through a shared HTTP app instance.
  it('is deterministic: identical inputs always pick the same offer, in the same shape', async () => {
    const offers = [sellOffer({ id: 'offer-a', priceUsd: '65000' }), sellOffer({ id: 'offer-b', priceUsd: '64000' })]
    mockOfferFindMany.mockResolvedValueOnce(offers)
    const first = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })

    mockOfferFindMany.mockResolvedValueOnce(offers)
    const second = await liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { priceMax: '70000', minReputation: 40 })

    expect(first).toEqual(second)
    expect(first.match?.id).toBe('offer-b') // cheapest SELL offer, deterministically
  })
})

// UX-048 (CTO, GK): minReputationScore is a canonical score threshold (cumulative, may be negative) and fails closed: an
// offer whose trader reputation is unknown is excluded. The legacy path (no threshold, or the deprecated alias passed
// as minReputation) is unchanged: unknown counts as 0 and the default floor is 0.
describe('liquidityRouter.proposeForIntent(): reputation threshold (UX-048)', () => {
  beforeEach(() => {
    mockOfferFindMany.mockReset()
  })
  const propose = (minReputationScore?: number) =>
    liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', minReputationScore === undefined ? {} : { minReputationScore })
  const proposeLegacy = (minReputation: number) => liquidityRouter.proposeForIntent('BTC', 'BUY', '0.1', { minReputation })

  it('a negative threshold admits a negative score at or above it, and refuses one below it', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: -3 } })])
    expect((await propose(-5)).match?.id).toBe('offer-1')
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: -6 } })])
    expect((await propose(-5)).match).toBeNull()
  })

  it('a threshold of -5: an unknown reputation is excluded, a score of 0 is included', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: {} })])
    expect((await propose(-5)).match).toBeNull()
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: 0 } })])
    expect((await propose(-5)).match?.id).toBe('offer-1')
  })

  it('a threshold of 0: score 0 passes, unknown does not', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: 0 } })])
    expect((await propose(0)).match?.id).toBe('offer-1')
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: {} })])
    expect((await propose(0)).match).toBeNull()
  })

  it('no threshold keeps the historical floor of 0: unknown and 0 pass, a negative score does not', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: {} })])
    expect((await propose()).match?.id).toBe('offer-1')
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: 0 } })])
    expect((await propose()).match?.id).toBe('offer-1')
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: -1 } })])
    expect((await propose()).match).toBeNull()
  })

  it('the deprecated alias is unchanged: an unknown reputation with a threshold of 0 is included', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: {} })])
    expect((await proposeLegacy(0)).match?.id).toBe('offer-1')
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: 3 } })])
    expect((await proposeLegacy(4)).match).toBeNull()
  })

  it('a threshold above 5 works on the cumulative score (no 0-5 ceiling)', async () => {
    mockOfferFindMany.mockResolvedValueOnce([sellOffer({ user: { reputationScore: 120 } })])
    expect((await propose(100)).match?.id).toBe('offer-1')
  })
})
