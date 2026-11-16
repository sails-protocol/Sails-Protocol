// tests/integration/tradeAdmissionModes.test.ts
//
// CTO 344 - the E21 transactional trade admission is selectable and OFF by default (config.features.
// tradeAdmissionTransactional, env TRADE_ADMISSION_TRANSACTIONAL=true). Real PostgreSQL:
//   M1  the default is the pre-E21 path, byte-for-byte: no own Trade Intent, the Offer Intent walked to NEGOTIATING,
//       the claim settled COMPLETED by withIdempotency(), a replay returns the same trade;
//   M2  the flag on selects the transactional admission: own Trade Intent, Offer Intent untouched, claim COMPLETED;
//   X1  a key admitted by the transactional path and retried after switching to legacy replays the same trade;
//   X2  a key admitted by the legacy path and retried after switching to transactional replays the same trade;
//   X3  a legacy claim with no recorded outcome (FAILED) is refused by the transactional path (409
//       IDEMPOTENCY_OUTCOME_UNKNOWN, nothing written) - it never re-runs it. The legacy path keeps main's behavior.
// Both paths share the idempotency scope 'openp2p.trade.create' on purpose: separate scopes would let a retry after a
// mode switch create a second trade for one attempt.
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

jest.setTimeout(120_000)

describe('CTO 344 - trade admission mode flag (real PostgreSQL)', () => {
  const pg = createPostgresIntegrationHarness()
  let prisma: any
  let config: any
  let liquidityRouter: any
  let tradeService: any
  let hashIdempotentPayload: (p: unknown) => string
  let defaultMode: boolean

  beforeAll(async () => {
    delete process.env.TRADE_ADMISSION_TRANSACTIONAL // this suite proves the default
    await pg.probe()
    pg.requirePostgres('trade admission modes')
    ;({ config } = require('../../src/config'))
    defaultMode = config.features.tradeAdmissionTransactional
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ hashIdempotentPayload } = require('../../src/common/idempotency'))
    require('../../src/core/intent-engine').intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
  })

  afterAll(async () => {
    if (config) config.features.tradeAdmissionTransactional = defaultMode
    await prisma?.$disconnect()
    await closeTestRedis()
  })

  const mode = (transactional: boolean) => { config.features.tradeAdmissionTransactional = transactional }
  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  const offerOf = (sellerId: string) =>
    liquidityRouter.createOffer({ userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'OTHER' })
  const admit = (offerId: string, buyerId: string, idempotencyKey?: string) =>
    tradeService.createTrade({ offerId, counterpartyId: buyerId, amount: '0.001', idempotencyKey })
  const intentStatus = async (id: string) => (await prisma.intent.findUnique({ where: { id } }))?.status
  const claimOf = (participantId: string, key: string) =>
    prisma.idempotencyKey.findUnique({ where: { scope_participantId_key: { scope: 'openp2p.trade.create', participantId, key } } })
  const parties = async () => {
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    return { seller, buyer, offer }
  }

  it('M1: the default (flag unset) is the pre-E21 path', async () => {
    expect(defaultMode).toBe(false)
    mode(false)
    const { buyer, offer } = await parties()
    const before = await intentStatus(offer.intentId)
    const key = `m1-${randomUUID()}`
    const trade = await admit(offer.id, buyer.id, key)
    expect(trade.tradeIntentId ?? null).toBeNull() // no own Trade Intent
    expect(await intentStatus(offer.intentId)).toBe('NEGOTIATING') // the Offer Intent is walked, as on main
    expect(before).not.toBe('NEGOTIATING')
    expect(await claimOf(buyer.id, key)).toMatchObject({ status: 'COMPLETED', resultRef: trade.id })
    expect((await admit(offer.id, buyer.id, key)).id).toBe(trade.id) // replay
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)
  })

  it('M2: the flag on selects the transactional admission', async () => {
    mode(true)
    const { buyer, offer } = await parties()
    const before = await intentStatus(offer.intentId)
    const key = `m2-${randomUUID()}`
    const trade = await admit(offer.id, buyer.id, key)
    expect(trade.tradeIntentId).toEqual(expect.any(String))
    expect(trade.tradeIntentId).not.toBe(offer.intentId)
    expect(await intentStatus(trade.tradeIntentId)).toBe('NEGOTIATING')
    expect(await intentStatus(offer.intentId)).toBe(before) // the Offer Intent is never transitioned by a trade
    expect(await claimOf(buyer.id, key)).toMatchObject({ status: 'COMPLETED', resultRef: trade.id })
  })

  it('X1: transactional admission, then a retry with the same key after switching to legacy -> the same trade', async () => {
    const { buyer, offer } = await parties()
    const key = `x1-${randomUUID()}`
    mode(true)
    const first = await admit(offer.id, buyer.id, key)
    mode(false)
    const retried = await admit(offer.id, buyer.id, key)
    expect(retried.id).toBe(first.id)
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)
  })

  it('X2: legacy admission, then a retry with the same key after switching to transactional -> the same trade', async () => {
    const { buyer, offer } = await parties()
    const key = `x2-${randomUUID()}`
    mode(false)
    const first = await admit(offer.id, buyer.id, key)
    mode(true)
    const retried = await admit(offer.id, buyer.id, key)
    expect(retried.id).toBe(first.id)
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)
  })

  it('X3: a legacy claim without a recorded outcome is refused by the transactional path, never re-run', async () => {
    const { buyer, offer } = await parties()
    const key = `x3-${randomUUID()}`
    await prisma.idempotencyKey.create({
      data: { scope: 'openp2p.trade.create', participantId: buyer.id, key, requestHash: hashIdempotentPayload({ offerId: offer.id, amount: '0.001' }), status: 'FAILED' },
    })
    mode(true)
    await expect(admit(offer.id, buyer.id, key)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' })
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(0)
    expect(await claimOf(buyer.id, key)).toMatchObject({ status: 'FAILED', resultRef: null })
  })
})
