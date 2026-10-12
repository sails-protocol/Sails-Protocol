/**
 * Technical Debt #61 bounded remediation (2026-09-10) — Public OfferDetail
 * disclosure boundary.
 *
 * GET /v1/liquidity/offers/:id is unauthenticated by design (offer
 * discovery must work before any trade forms). Before this remediation,
 * getOffer() returned the raw persisted Offer row — including
 * `paymentDetails` (the seller's real payment destination: bank/PIX/
 * wallet instructions) — to any caller who could guess or enumerate an
 * offer id, with no trade ever having formed. This file is the
 * adversarial regression suite for the fix: an explicit
 * PublicOfferDetail projection (liquidity.service.ts), and confirms the
 * already-authorized path (GET /v1/openp2p/trades/:id, gated by
 * requireAuth + an explicit buyer/seller ownership check,
 * SECURITY_AUDIT_REPORT.md §2) is unaffected.
 */
export {} // forces this file to be a module (no top-level import/export
// otherwise) so its top-level consts don't leak into the shared global
// scope and collide with another such file's identically named ones —
// this exact collision (mockTradeFindUnique vs.
// tests/settlementOrchestrator.test.ts's own) was caught for real in CI
// (tests/liquidityOfferRouteCollision.test.ts's own header comment
// documents the same fix for the same class of bug, Missão 06).

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: { start: jest.fn(), stop: jest.fn(), get: jest.fn(), getStatus: jest.fn() },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))

jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

const mockOfferFindUnique = jest.fn()
const mockOfferFindMany = jest.fn()
const mockTradeFindUnique = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    offer: {
      findUnique: (...args: unknown[]) => mockOfferFindUnique(...args),
      findMany: (...args: unknown[]) => mockOfferFindMany(...args),
    },
    trade: {
      findUnique: (...args: unknown[]) => mockTradeFindUnique(...args),
    },
  },
}))

const redisStore = new Map<string, string>()
jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value)
      return Promise.resolve('OK')
    }),
    del: jest.fn((key: string) => {
      redisStore.delete(key)
      return Promise.resolve(1)
    }),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildApp } = require('../src/app')

async function authedSession(participantId: string): Promise<string> {
  const token = `session-${participantId}`
  redisStore.set(`auth:session:${token}`, participantId)
  return token
}

// The exact raw row shape prisma.offer.findUnique's `select` now returns
// (liquidity.service.ts's getOffer()) — a realistic full row, including
// the two fields (paymentDetails, on the offer; the rest that must never
// reach a public caller) this suite exists to prove never leak.
function fullOfferRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'offer-1', asset: 'BTC', side: 'SELL',
    priceUsd: '65000.00000000', priceBrl: '325000.00000000',
    minAmount: '0.00100000', maxAmount: '0.50000000',
    paymentMethod: 'PIX', status: 'ACTIVE', network: 'mainnet', description: 'Fast trader',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    user: {
      id: 'seller-1', publicKey: 'a'.repeat(64), displayName: 'Alice', peerId: 'b'.repeat(64),
      verified: true, reputationScore: 4.5, totalTrades: 10, disputeCount: 2,
    },
    ...overrides,
  }
}

describe('Public OfferDetail disclosure boundary (Technical Debt #61)', () => {
  jest.setTimeout(30_000)

  let app: import('fastify').FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('GET /v1/liquidity/offers/:id', () => {
    it('does not expose paymentDetails, even if the persistence layer were to return it', async () => {
      // Adversarial: the mock includes paymentDetails, proving the boundary
      // is the explicit `select`/mapper, not merely "the mock never sends it."
      mockOfferFindUnique.mockResolvedValueOnce(fullOfferRow({ paymentDetails: 'PIX key: seller@example.com' }))

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      expect(res.statusCode).toBe(200)
      const data = JSON.parse(res.body).data
      expect(data.paymentDetails).toBeUndefined()
      expect(JSON.stringify(data)).not.toContain('seller@example.com')
    })

    it('does not expose raw persistence-only Offer fields (userId, moduleId, protocolVersion, intentType, intentId)', async () => {
      mockOfferFindUnique.mockResolvedValueOnce(
        fullOfferRow({ userId: 'seller-1', moduleId: 'openliquidity', protocolVersion: '0.1', intentType: 'TRADE', intentId: 'intent-1' })
      )

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      const data = JSON.parse(res.body).data
      for (const field of ['userId', 'moduleId', 'protocolVersion', 'intentType', 'intentId']) {
        expect(data[field]).toBeUndefined()
      }
    })

    it('seller projection does not expose disputeCount, totalVolumeBtc, or createdAt', async () => {
      mockOfferFindUnique.mockResolvedValueOnce(fullOfferRow({
        user: { ...fullOfferRow().user, totalVolumeBtc: '12.5', createdAt: new Date('2020-01-01T00:00:00.000Z') },
      }))

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      const seller = JSON.parse(res.body).data.seller
      expect(seller.disputeCount).toBeUndefined()
      expect(seller.totalVolumeBtc).toBeUndefined()
      expect(seller.createdAt).toBeUndefined()
    })

    it('seller projection exposes exactly the canonical public identity + reputation fields, with disputeRate derived like reputation.service.ts does', async () => {
      mockOfferFindUnique.mockResolvedValueOnce(fullOfferRow())

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      const seller = JSON.parse(res.body).data.seller
      expect(seller).toEqual({
        id: 'seller-1', publicKey: 'a'.repeat(64), displayName: 'Alice', peerId: 'b'.repeat(64),
        verified: true, reputationScore: 4.5, totalTrades: 10,
        disputeRate: 0.2, // disputeCount(2) / totalTrades(10), same formula as reputation.service.ts's getScore()
      })
    })

    it('still exposes every field a discovery/evaluation UI needs', async () => {
      mockOfferFindUnique.mockResolvedValueOnce(fullOfferRow())

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      const data = JSON.parse(res.body).data
      expect(data).toMatchObject({
        id: 'offer-1', asset: 'BTC', side: 'SELL',
        priceUsd: '65000.00000000', priceBrl: '325000.00000000',
        minAmount: '0.00100000', maxAmount: '0.50000000',
        paymentMethod: 'PIX', status: 'ACTIVE', network: 'mainnet', description: 'Fast trader',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      })
    })

    it('the top-level response shape cannot silently expand when the Prisma schema gains fields — exact key allowlist', async () => {
      mockOfferFindUnique.mockResolvedValueOnce(fullOfferRow({
        // Simulates a brand-new column the Prisma model might grow in the
        // future, present in the mocked "DB row" but never named in
        // getOffer()'s explicit `select` — proves the boundary is the
        // select/mapper, not an accidental absence in this one fixture.
        someFutureColumn: 'should never appear',
      }))

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers/offer-1' })
      const data = JSON.parse(res.body).data
      expect(Object.keys(data).sort()).toEqual(
        // #235 R7H-E3C — paymentAccountBound: whether the SELL maker committed an account, never which one.
        ['asset', 'createdAt', 'description', 'id', 'maxAmount', 'minAmount', 'network', 'paymentAccountBound', 'paymentMethod', 'priceBrl', 'priceUsd', 'seller', 'side', 'status', 'updatedAt'].sort()
      )
      expect(Object.keys(data.seller).sort()).toEqual(
        ['disputeRate', 'displayName', 'id', 'peerId', 'publicKey', 'reputationScore', 'totalTrades', 'verified'].sort()
      )
    })
  })

  describe('GET /v1/liquidity/offers (aggregate discovery) — unaffected by the OfferDetail boundary change', () => {
    it('still returns the LiquidityOffer aggregation shape, no seller object, no paymentDetails', async () => {
      mockOfferFindMany.mockResolvedValueOnce([{
        id: 'offer-1', asset: 'BTC', side: 'SELL',
        priceUsd: '65000.00000000', minAmount: '0.00100000', maxAmount: '0.50000000',
        paymentMethod: 'PIX', user: { reputationScore: 4.5 },
      }])

      const res = await app.inject({ method: 'GET', url: '/v1/liquidity/offers?asset=BTC&side=SELL' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.offers[0]).toEqual({
        id: 'offer-1', source: 'internal', asset: 'BTC', side: 'SELL',
        priceUsd: '65000.00000000', minAmount: '0.00100000', maxAmount: '0.50000000',
        paymentMethods: ['PIX'], traderReputation: 4.5,
      })
    })
  })

  describe('GET /v1/openp2p/trades/:id — the authorized paymentDetails path, unaffected', () => {
    const tradeRow = {
      id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', status: 'ACTIVE',
      escrow: null, messages: [],
      offer: fullOfferRow({ paymentDetails: 'PIX key: seller@example.com' }),
    }

    it('a real participant (buyer) still receives the real paymentDetails', async () => {
      const token = await authedSession('buyer-1')
      mockTradeFindUnique.mockResolvedValueOnce(tradeRow)

      const res = await app.inject({
        method: 'GET', url: '/v1/openp2p/trades/trade-1',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data.offer.paymentDetails).toBe('PIX key: seller@example.com')
    })

    it('a real participant (seller) still receives the real paymentDetails', async () => {
      const token = await authedSession('seller-1')
      mockTradeFindUnique.mockResolvedValueOnce(tradeRow)

      const res = await app.inject({
        method: 'GET', url: '/v1/openp2p/trades/trade-1',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data.offer.paymentDetails).toBe('PIX key: seller@example.com')
    })

    it('an authenticated non-participant is rejected with 403 and never receives paymentDetails', async () => {
      const token = await authedSession('stranger-1')
      mockTradeFindUnique.mockResolvedValueOnce(tradeRow)

      const res = await app.inject({
        method: 'GET', url: '/v1/openp2p/trades/trade-1',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(403)
      expect(res.body).not.toContain('seller@example.com')
    })

    it('an unauthenticated caller is rejected with 401 and never receives paymentDetails', async () => {
      mockTradeFindUnique.mockResolvedValueOnce(tradeRow)

      const res = await app.inject({ method: 'GET', url: '/v1/openp2p/trades/trade-1' })

      expect(res.statusCode).toBe(401)
      expect(res.body).not.toContain('seller@example.com')
    })
  })
})
