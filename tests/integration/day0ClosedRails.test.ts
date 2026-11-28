// tests/integration/day0ClosedRails.test.ts
//
// Despacho 064 (CTO), Gatekeeper criteria H2/H3 (GK_criterios_bloqueio_arkade_D064.md): LN_BTC / LIGHTNING_HODL are
// closed for Day 0. Each entry point refuses with HTTP 409 RAIL_CLOSED BEFORE any write, on real PostgreSQL:
//   P1 offer creation, P2 intent creation, P3 trade admission (an older LN_BTC offer), P4 escrow creation (implicit
//   LN_BTC and explicit LIGHTNING_HODL for every asset without a settlement scope), P5 Pear offer announcement.
// After each refusal, offers, offer envelopes, intents, intent events, durable events, trades, idempotency keys and
// escrows are counted again: zero new rows. Regression: BTC offers and trades still work.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('Despacho 064: LN_BTC / LIGHTNING_HODL closed for Day 0 at every entry point (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let liquidityRouter: any
  let tradeService: any
  let intentEngine: any
  let app: FastifyInstance
  let redis: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ redis } = require('../../src/common/redis'))
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await prisma?.$disconnect()
    await closeTestRedis()
  })

  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  async function session(participantId: string): Promise<string> {
    const token = `d064-${randomUUID()}`
    await redis.set(`auth:session:${token}`, participantId, 'EX', 600)
    return token
  }
  const post = async (url: string, participantId: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${await session(participantId)}` }, payload })

  const counts = async () => ({
    offers: await prisma.offer.count(),
    offerEnvelopes: await prisma.offerEnvelope.count(),
    intents: await prisma.intent.count(),
    intentEvents: await prisma.intentEvent.count(),
    durableEvents: await prisma.durableEventRecord.count(),
    trades: await prisma.trade.count(),
    idempotencyKeys: await prisma.idempotencyKey.count(),
    escrows: await prisma.escrow.count(),
  })
  const expectRailClosed = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'RAIL_CLOSED' })
  }

  it('P1: POST /v1/liquidity/offers with LN_BTC is refused (409 RAIL_CLOSED) and writes nothing', async () => {
    pg.requirePostgres('P1 offer')
    const seller = await user()
    const before = await counts()
    const res = await post('/v1/liquidity/offers', seller.id, {
      asset: 'LN_BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', idempotencyKey: randomUUID(),
    })
    expectRailClosed(res)
    expect(await counts()).toEqual(before)
  })

  it('P2: POST /v1/intents with an LN_BTC TradeIntent is refused and writes nothing', async () => {
    pg.requirePostgres('P2 intent')
    const buyer = await user()
    const before = await counts()
    const res = await post('/v1/intents', buyer.id, { type: 'TradeIntent', payload: { asset: 'LN_BTC', side: 'BUY' } })
    expectRailClosed(res)
    expect(await counts()).toEqual(before)
  })

  it('P3: an older LN_BTC offer cannot become a trade (409, the idempotency claim is rolled back too)', async () => {
    pg.requirePostgres('P3 admission')
    const seller = await user()
    const buyer = await user()
    // a pre-Despacho-064 offer, written directly as it may exist in a database today
    const legacy = await prisma.offer.create({
      data: { userId: seller.id, asset: 'LN_BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE' },
    })
    const before = await counts()
    const res = await post('/v1/openp2p/trades', buyer.id, { offerId: legacy.id, amount: '0.001', idempotencyKey: randomUUID() })
    expectRailClosed(res)
    expect(await counts()).toEqual(before)
  })

  it('P4: escrow creation refuses implicit LN_BTC and explicit LIGHTNING_HODL for every asset without a settlement scope', async () => {
    pg.requirePostgres('P4 escrow')
    const seller = await user()
    const buyer = await user()
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' }) // regression: BTC still trades
    const before = await counts()

    expectRailClosed(await post('/v1/settlement/escrow', buyer.id, { tradeId: trade.id, asset: 'LN_BTC', lockedAmount: '0.001' }))
    for (const asset of ['LN_BTC', 'USDT_LIGHTNING', 'SPARK', 'STACKS', 'RSK_BTC']) {
      expectRailClosed(await post('/v1/settlement/escrow', buyer.id, { tradeId: trade.id, asset, type: 'LIGHTNING_HODL', lockedAmount: '0.001' }))
    }
    expect(await counts()).toEqual(before)
  })

  it('P5: POST /v1/peers/broadcast-offer for LN_BTC is refused before any node is consulted', async () => {
    pg.requirePostgres('P5 pear')
    const seller = await user()
    const before = await counts()
    const res = await post('/v1/peers/broadcast-offer', seller.id, { offerId: randomUUID(), asset: 'LN_BTC', side: 'SELL', priceUsd: '60000' })
    expectRailClosed(res) // not the 409 CONFLICT "No active node" this route returns otherwise
    expect(await counts()).toEqual(before)
  })

  it('regression: a BTC offer is still created through the same route', async () => {
    pg.requirePostgres('regression BTC')
    const seller = await user()
    const res = await post('/v1/liquidity/offers', seller.id, { asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    expect(res.statusCode).toBe(201)
  })
})
