// tests/integration/tradeAdmissionAtomicity.test.ts
//
// E21 slice 1 (Issue #105; CTO 24 6811594078 / 6811766719; CTO 223) on real PostgreSQL: a trade is admitted in ONE
// transaction (COMPLETED idempotency claim, Offer re-validated under FOR SHARE, its own Trade Intent born
// NEGOTIATING, the Trade, the durable openp2p.trade.created and the durable opening of the negotiation), so:
//   S1-S9   independence of trades on one offer, same-key concurrency, post-commit dispatch failure, the second
//           sequential buyer (RED on main a530fdc1: "Invalid Intent transition: NEGOTIATING -> DISCOVERING"),
//           refusal / crash before and after the commit, legacy (L1) trades, cancel/lock isolation;
//   F-1/F-7 DELETE /v1/intents/:id precedence (403 -> 409 -> 404) and caller-scoped by-intent lookup, no leakage;
//   C1-C7   a legacy claim without a recorded outcome is never resolved by correlation, and the PostgreSQL session
//           time zone cannot change the replay's answer (C7: this path compares no SQL now() values, proven anyway);
//   plus the transactional event-store contract, Offer-close races and the migration's constraints and reversal.
// Invariant 3b (seller PaymentAccount binding, E22) is NOT exercised: this slice does not implement it.

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { randomBytes, randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const SCOPE = 'openp2p.trade.create'

describe('E21 slice 1 — transactional, idempotent trade admission (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  // DDL fixtures (fault-injection trigger, disabling the guard trigger, the documented reversal) need the schema owner.
  // They go through the administrator connection when one is given (the restricted-runtime CI lane sets
  // ADMIN_DATABASE_URL); the admission itself always runs on the app client, never with widened runtime privileges.
  let ddl: PrismaClient
  let eventBus: any
  let liquidityRouter: any
  let tradeService: any
  let negotiationService: any
  let intentEngine: any
  let emitEscrowTransition: any
  let recoverIntents: (opts?: { graceMs?: number }) => Promise<{ republished: string[] }>
  let hashIdempotentPayload: (p: unknown) => string
  let app: FastifyInstance
  let redis: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ddl = process.env.ADMIN_DATABASE_URL ? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.ADMIN_DATABASE_URL }) }) : prisma
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ negotiationService } = require('../../src/modules/open-p2p/negotiation.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ hashIdempotentPayload } = require('../../src/common/idempotency'))
    ;({ redis } = require('../../src/common/redis'))
    recoverIntents = (opts) => require('../../src/core/intent-publication-recovery').recoverUnpublishedIntentEvents(opts)
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false }) // also registers the real event handlers
    await app.ready()
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    await app?.close()
    await prisma?.$disconnect()
    if (ddl && ddl !== prisma) await ddl.$disconnect()
    await closeTestRedis()
  })

  afterEach(() => jest.restoreAllMocks())

  // ─── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────
  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  const offerOf = (sellerId: string) =>
    liquidityRouter.createOffer({ userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'OTHER' })
  const admit = (offerId: string, buyerId: string, idempotencyKey?: string, amount = '0.001') =>
    tradeService.createTrade({ offerId, counterpartyId: buyerId, amount, idempotencyKey })
  const intentStatus = async (id: string) => (await prisma.intent.findUnique({ where: { id } }))?.status
  const durable = (correlationId: string, eventName?: string) =>
    prisma.durableEventRecord.findMany({ where: { correlationId, ...(eventName ? { eventName } : {}) }, orderBy: { publishedAt: 'asc' } })
  const claimsOf = (participantId: string) => prisma.idempotencyKey.findMany({ where: { scope: SCOPE, participantId } })
  const snapshot = async () => ({
    trades: await prisma.trade.count(),
    intents: await prisma.intent.count(),
    intentEvents: await prisma.intentEvent.count(),
    durableEvents: await prisma.durableEventRecord.count(),
    claims: await prisma.idempotencyKey.count({ where: { scope: SCOPE } }),
  })
  async function session(participantId: string): Promise<string> {
    const token = `e21-${randomUUID()}`
    await redis.set(`auth:session:${token}`, participantId, 'EX', 600)
    return token
  }
  const http = async (method: 'GET' | 'POST' | 'DELETE', url: string, participantId: string, payload?: object) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${await session(participantId)}` }, ...(payload ? { payload } : {}) })
    return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body }
  }
  // A trade as main persisted it before this slice: the Offer's Intent and no Intent of its own.
  const legacyTrade = (offer: any, buyerId: string) =>
    prisma.trade.create({ data: { offerId: offer.id, buyerId, sellerId: offer.userId, asset: 'BTC', amount: '0.001', priceUsd: '60000', totalUsd: '60', intentId: offer.intentId } })
  function barrier() {
    let release!: () => void
    const wait = new Promise<void>((r) => { release = r })
    return { wait, release }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const expectChain = (events: Array<{ prevHash: string; entryHash: string }>) => {
    expect(events[0].prevHash).toBe('genesis')
    for (let i = 1; i < events.length; i++) expect(events[i].prevHash).toBe(events[i - 1].entryHash)
  }

  async function expectOwnTradeIntent(trade: any, offer: any) {
    expect(trade.tradeIntentId).toBeTruthy()
    expect(trade.tradeIntentId).not.toBe(offer.intentId)
    expect(trade.intentId).toBe(offer.intentId) // published meaning unchanged
    const intent = (await prisma.intent.findUnique({ where: { id: trade.tradeIntentId } }))!
    expect(intent).toMatchObject({ type: 'TradeIntent', status: 'NEGOTIATING', parentIntentId: offer.intentId, expiresAt: null })
    const chain = await prisma.intentEvent.findMany({ where: { intentId: intent.id }, orderBy: { createdAt: 'asc' } })
    expect(chain[0]).toMatchObject({ fromStatus: null, toStatus: 'NEGOTIATING', prevHash: 'genesis', eventName: 'intent.created' })
    const events = await durable(trade.id)
    expect(events.map((e) => e.eventName)).toEqual(['openp2p.trade.created', 'negotiation.opened', 'openp2p.trade.status_changed'])
    expectChain(events)
  }

  // ─── S1-S4 ─────────────────────────────────────────────────────────────────────────────────────────────────
  it('S1 — 8 buyers, distinct keys, one offer, concurrently: 8 independent trades, each with its own Intent', async () => {
    pg.requirePostgres('S1')
    const seller = await user()
    const offer = await offerOf(seller.id)
    const buyers = await Promise.all(Array.from({ length: 8 }, user))
    const trades = await Promise.all(buyers.map((b) => admit(offer.id, b.id, `k-${b.id}`)))

    expect(new Set(trades.map((t: any) => t.id)).size).toBe(8)
    expect(new Set(trades.map((t: any) => t.tradeIntentId)).size).toBe(8)
    for (const t of trades) await expectOwnTradeIntent(t, offer)
    for (const [i, b] of buyers.entries()) {
      const claims = await claimsOf(b.id)
      expect(claims).toHaveLength(1)
      expect(claims[0]).toMatchObject({ status: 'COMPLETED', resultRef: trades[i].id })
    }
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED') // invariant 1
  })

  it('S2 — same key, 6 concurrent requests: one trade, one claim, one Trade Intent, the same answer for all', async () => {
    pg.requirePostgres('S2')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const results = await Promise.all(Array.from({ length: 6 }, () => admit(offer.id, buyer.id, 'same-key')))

    expect(new Set(results.map((t: any) => t.id)).size).toBe(1)
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)
    expect(await claimsOf(buyer.id)).toHaveLength(1)
    expect(await prisma.intent.count({ where: { parentIntentId: offer.intentId } })).toBe(1)
    expect(await durable(results[0].id)).toHaveLength(3)
  })

  it('S3 — post-commit dispatch failure: still 201 over HTTP, the same trade on replay, the durable event redeliverable by hand', async () => {
    pg.requirePostgres('S3')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    jest.spyOn(eventBus, 'dispatchCommitted').mockImplementation(() => { throw new Error('SIMULATED dispatch failure') })

    const first = await http('POST', '/v1/openp2p/trades', buyer.id, { offerId: offer.id, amount: '0.001', idempotencyKey: 's3' })
    expect(first.status).toBe(201)
    expect(first.body.data.tradeIntentId).toBeTruthy()
    jest.restoreAllMocks()

    const replay = await http('POST', '/v1/openp2p/trades', buyer.id, { offerId: offer.id, amount: '0.001', idempotencyKey: 's3' })
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)

    // R-a: no automatic redelivery; the durable row exists and the documented manual redeliver reaches consumers.
    const [created] = await durable(first.body.data.id, 'openp2p.trade.created')
    const seen: string[] = []
    eventBus.onDurable('openp2p.trade.created', (e: any) => { if (e.payload.tradeId === first.body.data.id) seen.push(e.eventId) })
    expect(await eventBus.redeliver(created.id)).toBe(true)
    expect(seen).toEqual([created.id])
  })

  it('S4 — a second sequential buyer on the same offer gets 201 (an error on main) and an Intent of its own', async () => {
    pg.requirePostgres('S4')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const ta = await http('POST', '/v1/openp2p/trades', a.id, { offerId: offer.id, amount: '0.001' })
    const tb = await http('POST', '/v1/openp2p/trades', b.id, { offerId: offer.id, amount: '0.001' })
    expect([ta.status, tb.status]).toEqual([201, 201])
    expect(tb.body.data.tradeIntentId).not.toBe(ta.body.data.tradeIntentId)
    await expectOwnTradeIntent(tb.body.data, offer)
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')
  })

  // ─── S5: nothing survives a refusal or a crash before the commit ─────────────────────────────────────────────
  it('S5a — refused admissions (inactive offer, own offer, out-of-bounds amount, unknown offer) leave nothing and the key stays usable', async () => {
    pg.requirePostgres('S5a')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    await prisma.offer.update({ where: { id: offer.id }, data: { status: 'PAUSED' } })
    const before = await snapshot()

    await expect(admit(offer.id, buyer.id, 's5a')).rejects.toMatchObject({ statusCode: 400 })
    await expect(admit(offer.id, seller.id, 's5a-own')).rejects.toMatchObject({ statusCode: 400 })
    await prisma.offer.update({ where: { id: offer.id }, data: { status: 'ACTIVE' } })
    await expect(admit(offer.id, buyer.id, 's5a', '5')).rejects.toThrow(/outside Offer/)
    await expect(admit('no-such-offer', buyer.id, 's5a-missing')).rejects.toMatchObject({ statusCode: 404 })
    expect(await snapshot()).toEqual(before)

    const trade = await admit(offer.id, buyer.id, 's5a')
    await expectOwnTradeIntent(trade, offer)
  })

  it('S5b — a crash after the Trade Intent, the Trade and the events, before the commit, rolls ALL of it back (negotiation included); nothing is dispatched', async () => {
    pg.requirePostgres('S5b')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const dispatched: string[] = []
    eventBus.onDurable('openp2p.trade.created', (e: any) => { if (e.payload.offerId === offer.id) dispatched.push(e.eventId) })
    let crashedTradeId = ''
    jest.spyOn(negotiationService, 'openInTransaction').mockImplementationOnce(async (tx: any, trade: any) => {
      crashedTradeId = trade.id
      await eventBus.publishInTransaction(tx, 'negotiation.opened', { tradeId: trade.id, buyerId: trade.buyerId, sellerId: trade.sellerId }, trade.id)
      throw new Error('SIMULATED_CRASH before commit')
    })
    const before = await snapshot()

    await expect(admit(offer.id, buyer.id, 's5b')).rejects.toThrow(/SIMULATED_CRASH/)
    expect(crashedTradeId).toBeTruthy()
    expect(await snapshot()).toEqual(before)
    expect(await prisma.trade.findUnique({ where: { id: crashedTradeId } })).toBeNull()
    expect(await durable(crashedTradeId)).toHaveLength(0)
    expect(dispatched).toEqual([])
    expect(negotiationService.getStatus(crashedTradeId)).toBe('CREATED') // in-memory state never set

    const retried = await admit(offer.id, buyer.id, 's5b')
    await expectOwnTradeIntent(retried, offer)
  })

  it('S5c — the database refusing the Trade insert (after the Trade Intent was written) rolls the Intent and the claim back', async () => {
    pg.requirePostgres('S5c')
    await ddl.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_e21_trade_fault() RETURNS trigger AS $$
      BEGIN IF NEW.amount = 0.777 THEN RAISE EXCEPTION 'SIMULATED_CRASH on trades insert'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await ddl.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_e21_trade_fault_trg ON trades')
    await ddl.$executeRawUnsafe('CREATE TRIGGER test_e21_trade_fault_trg BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION test_e21_trade_fault()')
    try {
      const seller = await user()
      const buyer = await user()
      const offer = await offerOf(seller.id)
      const before = await snapshot()
      await expect(admit(offer.id, buyer.id, 's5c', '0.777')).rejects.toThrow(/SIMULATED_CRASH/)
      expect(await snapshot()).toEqual(before)
      expect(await claimsOf(buyer.id)).toHaveLength(0)
    } finally {
      await ddl.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_e21_trade_fault_trg ON trades')
    }
  })

  it('S6 — a crash right after the commit (no dispatch, no owed publication): the trade is whole, replay returns it, recovery pays intent.created once', async () => {
    pg.requirePostgres('S6')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    jest.spyOn(eventBus, 'dispatchCommitted').mockImplementation(() => { throw new Error('SIMULATED process death') })
    jest.spyOn(intentEngine, 'publishCommittedIntentEvent').mockRejectedValue(new Error('SIMULATED process death'))

    const trade = await admit(offer.id, buyer.id, 's6')
    jest.restoreAllMocks()

    expect((await claimsOf(buyer.id))[0]).toMatchObject({ status: 'COMPLETED', resultRef: trade.id })
    await expectOwnTradeIntent(trade, offer)
    const genesis = (await prisma.intentEvent.findFirst({ where: { intentId: trade.tradeIntentId } }))!
    expect(genesis.publishedAt).toBeNull()
    expect(await durable(trade.tradeIntentId, 'intent.created')).toHaveLength(0)

    expect((await admit(offer.id, buyer.id, 's6')).id).toBe(trade.id)
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(1)

    expect((await recoverIntents({ graceMs: 0 })).republished).toContain(genesis.id)
    expect((await recoverIntents({ graceMs: 0 })).republished).not.toContain(genesis.id)
    const published = await durable(trade.tradeIntentId, 'intent.created')
    expect(published).toHaveLength(1)
    expect(published[0].payload).toMatchObject({ intentId: trade.tradeIntentId, type: 'TradeIntent', parentIntentId: offer.intentId, transitionId: genesis.id })
  })

  // ─── Offer re-validation under concurrency (FOR SHARE) ─────────────────────────────────────────────────────
  it('an Offer status change committed first is seen by the admission: it waits on the row, then refuses and writes nothing', async () => {
    pg.requirePostgres('close-first')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const hold = barrier()
    const locked = barrier()
    const closer = prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'PAUSED' } })
      locked.release()
      await hold.wait
    }, { timeout: 30_000 })
    await locked.wait
    const before = await snapshot()
    let settled = false
    const admission = admit(offer.id, buyer.id, 'close-first').finally(() => { settled = true })
    await sleep(500)
    expect(settled).toBe(false) // blocked on the Offer row
    hold.release()
    await closer
    await expect(admission).rejects.toThrow(/not active \(status: PAUSED\)/)
    expect(await snapshot()).toEqual(before)
  })

  it('an Offer status change requested during an admission waits for its commit; a concurrent admission on the same Offer does not', async () => {
    pg.requirePostgres('close-during')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const hold = barrier()
    const entered = barrier()
    const original = negotiationService.openInTransaction.bind(negotiationService)
    jest.spyOn(negotiationService, 'openInTransaction').mockImplementationOnce(async (tx: any, trade: any) => {
      entered.release()
      await hold.wait
      return original(tx, trade)
    })
    const held = admit(offer.id, a.id, 'close-during')
    await entered.wait
    const other = await admit(offer.id, b.id, 'close-during-b') // FOR SHARE does not block a second admission
    expect(other.tradeIntentId).toBeTruthy()
    let closeDone = false
    let tradesOfAWhenClosed = -1
    const close = liquidityRouter.updateOfferStatus(offer.id, 'PAUSED', seller.id).then(async () => {
      closeDone = true
      tradesOfAWhenClosed = await prisma.trade.count({ where: { buyerId: a.id } })
    })
    await sleep(500)
    expect(closeDone).toBe(false) // the Offer status write waits for the admission holding the row
    hold.release()
    const trade = await held
    await close
    expect(tradesOfAWhenClosed).toBe(1) // the close landed only after the admission committed
    await expectOwnTradeIntent(trade, offer)
  })

  // ─── S7: legacy (L1) trades keep their behaviour, except a sibling no longer rewrites the shared Intent ──────
  it('S7 — cancelling a legacy trade with a live sibling leaves the shared Intent intact and audits it; the last one cancels it as before', async () => {
    pg.requirePostgres('S7')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    await prisma.intent.update({ where: { id: offer.intentId }, data: { status: 'NEGOTIATING' } }) // as main left it
    const la = await legacyTrade(offer, a.id)
    const lb = await legacyTrade(offer, b.id)

    await tradeService.updateStatus(la.id, 'CANCELLED', a.id)
    expect(await intentStatus(offer.intentId)).toBe('NEGOTIATING')
    const [audit] = await durable(la.id, 'openp2p.trade.intent_unchanged')
    expect(audit.payload).toEqual({ tradeId: la.id, intentId: offer.intentId, reason: 'SHARED_INTENT_SIBLING_TRADES_LIVE', triggeredBy: a.id })

    await tradeService.updateStatus(lb.id, 'CANCELLED', b.id)
    expect(await intentStatus(offer.intentId)).toBe('CANCELLED')
    expect(await durable(lb.id, 'openp2p.trade.intent_unchanged')).toHaveLength(0)
    expect((await prisma.trade.findUnique({ where: { id: lb.id } }))!.tradeIntentId).toBeNull() // never back-filled
  })

  it('S7b — cancelling a legacy trade whose shared Intent is already terminal succeeds without touching the Intent', async () => {
    pg.requirePostgres('S7b')
    const seller = await user()
    const a = await user()
    const offer = await offerOf(seller.id)
    await prisma.intent.update({ where: { id: offer.intentId }, data: { status: 'CANCELLED' } })
    const la = await legacyTrade(offer, a.id)
    const historyBefore = await prisma.intentEvent.count({ where: { intentId: offer.intentId } })

    await tradeService.updateStatus(la.id, 'CANCELLED', a.id)
    expect((await prisma.trade.findUnique({ where: { id: la.id } }))!.status).toBe('CANCELLED')
    expect(await prisma.intentEvent.count({ where: { intentId: offer.intentId } })).toBe(historyBefore)
    const [audit] = await durable(la.id, 'openp2p.trade.intent_unchanged')
    expect(audit.payload).toMatchObject({ reason: 'SHARED_INTENT_ALREADY_TERMINAL' })
  })

  it('S7c — new trades on an offer that already has legacy trades are independent, and the legacy rows stay legacy', async () => {
    pg.requirePostgres('S7c')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const la = await legacyTrade(offer, a.id)
    const tb = await admit(offer.id, b.id)
    await expectOwnTradeIntent(tb, offer)
    await tradeService.updateStatus(tb.id, 'CANCELLED', b.id)
    expect(await intentStatus(tb.tradeIntentId)).toBe('CANCELLED')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')
    expect(await prisma.trade.findUnique({ where: { id: la.id } })).toMatchObject({ tradeIntentId: null, status: 'PENDING' })
  })

  // ─── S8 / S9: one trade's lifecycle never moves another trade's (or the offer's) Intent ───────────────────────
  async function lockEscrow(trade: any) {
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'FUNDS_LOCKED', lockedAmount: '0.001', asset: 'BTC' } })
    await emitEscrowTransition(escrow.id, trade.id, 'CREATED', 'FUNDS_LOCKED', trade.sellerId, 'settlement.escrow.locked', {})
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'FUNDS_LOCKED' } }))!
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) return
      await sleep(50)
    }
    throw new Error('escrow lock was not projected')
  }

  it("S8 — cancelling trade A moves only A's Intent; S8b — locking trade B's escrow moves only B's Intent", async () => {
    pg.requirePostgres('S8')
    const seller = await user()
    const [a, b, c] = [await user(), await user(), await user()]
    const offer = await offerOf(seller.id)
    const [ta, tb, tc] = [await admit(offer.id, a.id), await admit(offer.id, b.id), await admit(offer.id, c.id)]

    await tradeService.updateStatus(ta.id, 'CANCELLED', a.id)
    expect(await intentStatus(ta.tradeIntentId)).toBe('CANCELLED')
    expect(await intentStatus(tb.tradeIntentId)).toBe('NEGOTIATING')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')

    await lockEscrow(tb)
    expect(await intentStatus(tb.tradeIntentId)).toBe('COMMITTED')
    expect(await intentStatus(tc.tradeIntentId)).toBe('NEGOTIATING')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')
    await tradeService.updateStatus(tc.id, 'CANCELLED', c.id) // a sibling stays cancellable
    expect(await intentStatus(tc.tradeIntentId)).toBe('CANCELLED')
  })

  it("S9 — B's escrow lock and A's cancellation, concurrently, do not interfere", async () => {
    pg.requirePostgres('S9')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const [ta, tb] = [await admit(offer.id, a.id), await admit(offer.id, b.id)]
    await Promise.all([tradeService.updateStatus(ta.id, 'CANCELLED', a.id), lockEscrow(tb)])
    expect(await intentStatus(ta.tradeIntentId)).toBe('CANCELLED')
    expect(await intentStatus(tb.tradeIntentId)).toBe('COMMITTED')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')
  })

  // ─── F-7: by-intent lookup is deterministic and caller-scoped ───────────────────────────────────────────────
  it('F-7 — a Trade Intent resolves for its buyer and seller only; a stranger and an unknown Intent get the same 404', async () => {
    pg.requirePostgres('F-7 own')
    const seller = await user()
    const [a, stranger] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const ta = await admit(offer.id, a.id)

    for (const who of [a.id, seller.id]) {
      const res = await http('GET', `/v1/openp2p/trades/by-intent/${ta.tradeIntentId}`, who)
      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(ta.id)
    }
    const strangerRes = await http('GET', `/v1/openp2p/trades/by-intent/${ta.tradeIntentId}`, stranger.id)
    const unknownRes = await http('GET', `/v1/openp2p/trades/by-intent/${randomUUID()}`, stranger.id)
    expect([strangerRes.status, unknownRes.status]).toEqual([404, 404])
    expect(strangerRes.body.error).toBe(unknownRes.body.error)
    for (const leaked of [ta.id, a.id, seller.id]) expect(strangerRes.raw).not.toContain(leaked)
  })

  it("F-7 — an Offer Intent resolves to the caller's own trade; several -> 409 AMBIGUOUS_INTENT with only the caller's ids", async () => {
    pg.requirePostgres('F-7 offer')
    const seller = await user()
    const [a, b, stranger] = [await user(), await user(), await user()]
    const offer = await offerOf(seller.id)
    const ta1 = await admit(offer.id, a.id)
    const tb = await admit(offer.id, b.id)
    const url = `/v1/openp2p/trades/by-intent/${offer.intentId}`

    const bRes = await http('GET', url, b.id)
    expect(bRes.status).toBe(200)
    expect(bRes.body.data.id).toBe(tb.id)

    const ta2 = await admit(offer.id, a.id)
    const aRes = await http('GET', url, a.id)
    expect(aRes.status).toBe(409)
    expect(aRes.body.error).toBe('AMBIGUOUS_INTENT')
    expect([...aRes.body.details.tradeIds].sort()).toEqual([ta1.id, ta2.id].sort())
    expect(aRes.raw).not.toContain(tb.id)
    expect(aRes.raw).not.toContain(b.id)

    const sellerRes = await http('GET', url, seller.id)
    expect(sellerRes.status).toBe(409)
    expect([...sellerRes.body.details.tradeIds].sort()).toEqual([ta1.id, ta2.id, tb.id].sort())
    expect((await http('GET', url, stranger.id)).status).toBe(404)
  })

  // ─── F-1: DELETE /v1/intents/:id — 403 before 409 INTENT_BOUND, 404 unknown, 200 free ───────────────────────
  it('F-1 — non-owner 403 (never learns the binding), owner of a bound Intent 409 INTENT_BOUND, unknown 404, free Intent 200', async () => {
    pg.requirePostgres('F-1')
    const seller = await user()
    const [a, stranger] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const ta = await admit(offer.id, a.id)

    const strangerOnTradeIntent = await http('DELETE', `/v1/intents/${ta.tradeIntentId}`, stranger.id)
    const strangerOnOfferIntent = await http('DELETE', `/v1/intents/${offer.intentId}`, stranger.id)
    expect([strangerOnTradeIntent.status, strangerOnOfferIntent.status]).toEqual([403, 403])
    expect(strangerOnTradeIntent.raw).not.toContain('BOUND')
    expect(strangerOnTradeIntent.raw).not.toContain(ta.id)

    const ownerTrade = await http('DELETE', `/v1/intents/${ta.tradeIntentId}`, a.id)
    const ownerOffer = await http('DELETE', `/v1/intents/${offer.intentId}`, seller.id)
    expect([ownerTrade.status, ownerOffer.status]).toEqual([409, 409])
    expect([ownerTrade.body.error, ownerOffer.body.error]).toEqual(['INTENT_BOUND', 'INTENT_BOUND'])
    expect(await intentStatus(ta.tradeIntentId)).toBe('NEGOTIATING')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')

    expect((await http('DELETE', `/v1/intents/${randomUUID()}`, a.id)).status).toBe(404)
    const free = await intentEngine.create('TradeIntent', { asset: 'BTC', side: 'BUY', minValue: '0.001', maxValue: '0.01' }, a.id)
    expect((await http('DELETE', `/v1/intents/${free.id}`, stranger.id)).status).toBe(403)
    expect((await http('DELETE', `/v1/intents/${free.id}`, a.id)).status).toBe(200)
    expect(await intentStatus(free.id)).toBe('CANCELLED')
  })

  // ─── C1-C6: a legacy claim with no recorded outcome is never resolved by correlation ────────────────────────
  async function legacyClaim(participantId: string, offerId: string, key: string, status: 'IN_PROGRESS' | 'FAILED' = 'IN_PROGRESS') {
    return prisma.idempotencyKey.create({
      data: { scope: SCOPE, participantId, key, requestHash: hashIdempotentPayload({ offerId, amount: '0.001' }), status, createdAt: new Date(Date.now() - 60_000) },
    })
  }
  async function expectUnresolved(offerId: string, participantId: string, key: string): Promise<string[]> {
    const res = await http('POST', '/v1/openp2p/trades', participantId, { offerId, amount: '0.001', idempotencyKey: key })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('IDEMPOTENCY_OUTCOME_UNKNOWN')
    expect(res.body.details.authoritative).toBe(false)
    return res.body.details.unverifiedCandidateTradeIds
  }

  it('C1/C6 — two same-shape legacy claims and one perfectly correlated legacy trade: neither claim is resolved, the trade is only a hint', async () => {
    pg.requirePostgres('C1')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const c1 = await legacyClaim(buyer.id, offer.id, 'c1-a')
    const c2 = await legacyClaim(buyer.id, offer.id, 'c1-b')
    const lt = await legacyTrade(offer, buyer.id) // same offer, same amount, right after both claims
    const tradesBefore = await prisma.trade.count()

    expect(await expectUnresolved(offer.id, buyer.id, 'c1-a')).toEqual([lt.id])
    expect(await expectUnresolved(offer.id, buyer.id, 'c1-b')).toEqual([lt.id])
    for (const c of [c1, c2]) expect(await prisma.idempotencyKey.findUnique({ where: { id: c.id } })).toMatchObject({ status: 'IN_PROGRESS', resultRef: null })
    expect(await prisma.trade.count()).toBe(tradesBefore)
  })

  it("C1b/C3 — a trade another claim owns, or a taker's trade seen from the maker, is not even a hint; a FAILED legacy claim stays unresolved too", async () => {
    pg.requirePostgres('C1b')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const owned = await legacyTrade(offer, buyer.id)
    await prisma.idempotencyKey.create({ data: { scope: SCOPE, participantId: buyer.id, key: 'c1b-done', requestHash: 'x', status: 'COMPLETED', resultRef: owned.id } })
    await legacyClaim(buyer.id, offer.id, 'c1b-open')
    expect(await expectUnresolved(offer.id, buyer.id, 'c1b-open')).toEqual([])

    await legacyClaim(seller.id, offer.id, 'c3-maker')
    expect(await expectUnresolved(offer.id, seller.id, 'c3-maker')).toEqual([])

    const loose = await legacyTrade(offer, buyer.id)
    await legacyClaim(buyer.id, offer.id, 'c1b-failed', 'FAILED')
    expect(await expectUnresolved(offer.id, buyer.id, 'c1b-failed')).toEqual([loose.id])
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(2)
  })

  it('C2/C4/C5 — concurrent replays of a legacy claim never attribute and never create; a keyless new-path trade is never a candidate', async () => {
    pg.requirePostgres('C4')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const claim = await legacyClaim(buyer.id, offer.id, 'c4')
    const keyless = await admit(offer.id, buyer.id)
    const lt = await legacyTrade(offer, buyer.id)
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => admit(offer.id, buyer.id, 'c4')))
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', details: { authoritative: false, unverifiedCandidateTradeIds: [lt.id] } })
    }
    expect(await prisma.idempotencyKey.findUnique({ where: { id: claim.id } })).toMatchObject({ status: 'IN_PROGRESS', resultRef: null })
    expect(await prisma.trade.count({ where: { buyerId: buyer.id } })).toBe(2)
    expect(keyless.tradeIntentId).toBeTruthy()
  })

  it('a legacy claim WITH a recorded outcome (resultRef) replays that trade; the key reused with a different payload is refused', async () => {
    pg.requirePostgres('legacy completed')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const lt = await legacyTrade(offer, buyer.id)
    await prisma.idempotencyKey.create({ data: { scope: SCOPE, participantId: buyer.id, key: 'lc', requestHash: hashIdempotentPayload({ offerId: offer.id, amount: '0.001' }), status: 'UNKNOWN', resultRef: lt.id } })
    expect((await admit(offer.id, buyer.id, 'lc')).id).toBe(lt.id)
    await expect(admit(offer.id, buyer.id, 'lc', '0.002')).rejects.toMatchObject({ statusCode: 400 })
  })

  // ─── C7: the PostgreSQL session time zone cannot change a legacy-claim replay ──────────────────────────────
  // The hint window compares two timestamp(3) columns (no SQL now()); this proves a non-UTC application session gets
  // the very same non-authoritative answer, and changes nothing, as a UTC one.
  it('C7 — the session time zone cannot change a legacy-claim replay: same 409, same hints, nothing written (real session zones)', async () => {
    pg.requirePostgres('C7')
    const seller = await user()
    const buyer = await user()
    const offer = await offerOf(seller.id)
    const claim = await legacyClaim(buyer.id, offer.id, 'c7')
    const at = (createdAt: Date) =>
      prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: offer.userId, asset: 'BTC', amount: '0.001', priceUsd: '60000', totalUsd: '60', intentId: offer.intentId, createdAt } })
    await at(new Date(claim.createdAt.getTime() - 1)) // 1 ms before the claim: never a hint
    const onEdge = await at(claim.createdAt) // exactly at the claim: a hint (gte)
    const later = await legacyTrade(offer, buyer.id) // DB/Prisma default createdAt, ~60 s after the claim
    const replayWith = (service: any) =>
      service.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001', idempotencyKey: 'c7' }).then(
        () => { throw new Error('C7: a legacy claim replay must never succeed') },
        (err: any) => ({ statusCode: err.statusCode, code: err.code, details: err.details }),
      )
    const offerIntent = () => prisma.intent.findUnique({ where: { id: offer.intentId } })
    const before = { snap: await snapshot(), claim: await prisma.idempotencyKey.findUnique({ where: { id: claim.id } }), intent: await offerIntent() }

    const expected = { statusCode: 409, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', details: { authoritative: false, unverifiedCandidateTradeIds: [onEdge.id, later.id] } }
    const [utcSession] = await prisma.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`
    expect(await replayWith(tradeService)).toEqual(expected)

    const answers: Record<string, unknown> = {}
    for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12', 'America/Sao_Paulo']) {
      expect(tz).not.toBe(utcSession.tz)
      const zoned = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c TimeZone=${tz}` }) })
      const saved = (global as any).__prisma
      let isolated: any
      let isolatedRedis: any
      let isolatedPrisma: any
      try {
        ;(global as any).__prisma = zoned // the isolated module tree's database singleton is the zoned client
        jest.isolateModules(() => {
          isolated = require('../../src/modules/open-p2p/trade.service').tradeService
          isolatedRedis = require('../../src/common/redis').redis
          isolatedPrisma = require('../../src/common/database').prisma
        })
        expect(isolatedPrisma).toBe(zoned) // the service under test really runs on the zoned client
        const [s] = await zoned.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`
        expect(s.tz).toBe(tz) // ...and its session REALLY is in that zone (cannot pass vacuously)
        answers[tz] = await replayWith(isolated)
      } finally {
        ;(global as any).__prisma = saved
        isolatedRedis?.disconnect()
        await zoned.$disconnect()
      }
    }
    for (const answer of Object.values(answers)) expect(answer).toEqual(expected)
    expect({ snap: await snapshot(), claim: await prisma.idempotencyKey.findUnique({ where: { id: claim.id } }), intent: await offerIntent() }).toEqual(before)
  })

  // ─── the transactional event-store contract ───────────────────────────────────────────────────────────────
  it('publishInTransaction holds the correlation lock until the caller commits, dispatches nothing before dispatchCommitted(), and keeps one chain', async () => {
    pg.requirePostgres('publishInTransaction')
    const correlationId = `e21-${randomUUID()}`
    const seen: string[] = []
    eventBus.onDurable('negotiation.terms_agreed', (e: any) => { if (e.correlationId === correlationId) seen.push(e.eventId) })
    const hold = barrier()
    const wrote = barrier()
    let inTx: any
    const tx = prisma.$transaction(async (t) => {
      inTx = await eventBus.publishInTransaction(t, 'negotiation.terms_agreed', { tradeId: correlationId }, correlationId)
      wrote.release()
      await hold.wait
    }, { timeout: 30_000 })
    await wrote.wait
    let plainDone = false
    const plain = eventBus.emit('negotiation.terms_agreed', { tradeId: correlationId }, correlationId).then(() => { plainDone = true })
    await sleep(500)
    expect(plainDone).toBe(false) // publish() waits on the advisory lock the open transaction holds
    expect(seen).toEqual([])
    hold.release()
    await tx
    await plain
    expect(seen).toHaveLength(1) // only the plain publish() dispatched itself
    eventBus.dispatchCommitted(inTx)
    const chain = await durable(correlationId)
    expect(chain.map((e) => e.id)).toEqual([inTx.eventId, seen[0]])
    expect(seen[1]).toBe(inTx.eventId)
    expectChain(chain)
  })

  it('a rolled-back publishInTransaction leaves no row, and the next publish starts the chain at genesis', async () => {
    pg.requirePostgres('publishInTransaction rollback')
    const correlationId = `e21-${randomUUID()}`
    await expect(prisma.$transaction(async (t) => {
      await eventBus.publishInTransaction(t, 'negotiation.terms_agreed', { tradeId: correlationId }, correlationId)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await durable(correlationId)).toHaveLength(0)
    await eventBus.emit('negotiation.terms_agreed', { tradeId: correlationId }, correlationId)
    expect((await durable(correlationId))[0].prevHash).toBe('genesis')
  })

  // ─── migration 20261115120000: constraints, trigger, reversal ───────────────────────────────────────────────
  it("the schema forbids an Offer's or a legacy trade's Intent as a trade's own Intent, changing or sharing it, and RESTRICTs its deletion", async () => {
    pg.requirePostgres('migration constraints')
    const seller = await user()
    const [a, b] = [await user(), await user()]
    const offer = await offerOf(seller.id)
    const otherOffer = await offerOf(seller.id)
    const lt = await legacyTrade(offer, a.id)
    const ta = await admit(offer.id, b.id)
    const free = await intentEngine.create('TradeIntent', { asset: 'BTC', side: 'BUY', minValue: '0.001', maxValue: '0.01' }, a.id)
    const base = { offerId: offer.id, buyerId: a.id, sellerId: seller.id, asset: 'BTC' as const, amount: '0.001', priceUsd: '60000', totalUsd: '60' }

    // Legacy shapes stay insertable: no Intent at all (pre-RFC-018 offer) and the shared Offer Intent.
    await expect(prisma.trade.create({ data: { ...base, intentId: null } })).resolves.toMatchObject({ tradeIntentId: null })
    await expect(prisma.trade.create({ data: { ...base, intentId: offer.intentId } })).resolves.toMatchObject({ tradeIntentId: null })
    await expect(prisma.trade.create({ data: { ...base, intentId: offer.intentId, tradeIntentId: offer.intentId } })).rejects.toThrow(/Intent of its own|distinct_from_offer_intent/)
    await expect(prisma.trade.create({ data: { ...base, intentId: null, tradeIntentId: otherOffer.intentId } })).rejects.toThrow(/Intent of its own/)
    await expect(prisma.trade.create({ data: { ...base, intentId: null, tradeIntentId: lt.intentId! } })).rejects.toThrow(/Intent of its own/)
    await expect(prisma.$executeRawUnsafe('UPDATE trades SET "tradeIntentId" = $1 WHERE id = $2', free.id, lt.id)).rejects.toThrow(/fixed at creation/)
    await expect(prisma.$executeRawUnsafe('UPDATE trades SET "tradeIntentId" = NULL WHERE id = $1', ta.id)).rejects.toThrow(/fixed at creation/)
    await expect(prisma.trade.create({ data: { ...base, intentId: ta.tradeIntentId } })).rejects.toThrow(/another trade's own Intent/)
    await expect(prisma.trade.create({ data: { ...base, intentId: offer.intentId, tradeIntentId: ta.tradeIntentId } })).rejects.toThrow(/Unique constraint|tradeIntentId/)
    // CHECK alone (trigger disabled inside a rolled-back transaction): the own Intent can never equal the offer Intent.
    await expect(ddl.$transaction(async (t) => {
      await t.$executeRawUnsafe('ALTER TABLE trades DISABLE TRIGGER trades_trade_intent_guard')
      await t.$executeRawUnsafe(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", "intentId", "tradeIntentId", "updatedAt") VALUES ($1, $2, $3, $4, 'BTC', 0.001, 60000, 60, $5, $5, now())`, randomUUID(), offer.id, a.id, seller.id, free.id)
    })).rejects.toThrow(/trades_trade_intent_distinct_from_offer_intent/)
    const fk = await prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(`SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'trades_tradeIntentId_fkey'`)
    expect(fk[0].confdeltype).toBe('r') // ON DELETE RESTRICT
    expect(await prisma.trade.findUnique({ where: { id: ta.id } })).toMatchObject({ tradeIntentId: ta.tradeIntentId })
  })

  it('the documented reversal runs cleanly against the migrated schema (executed, then rolled back)', async () => {
    pg.requirePostgres('migration reversal')
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../../prisma/migrations/20261115120000_trade_admission_trade_intent/migration.sql'), 'utf8') as string
    const reversal = sql.split(/\r?\n/).filter((l) => /^-- {3}(DROP|ALTER) /.test(l)).map((l) => l.replace(/^--\s+/, ''))
    expect(reversal).toHaveLength(7)
    const columnCount = async (q: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] }) =>
      Number((await q.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'tradeIntentId'`))[0].n)
    await expect(ddl.$transaction(async (t) => {
      for (const stmt of reversal) await t.$executeRawUnsafe(stmt)
      expect(await columnCount(t)).toBe(0)
      throw new Error('ROLLBACK_REVERSAL')
    }, { timeout: 30_000 })).rejects.toThrow('ROLLBACK_REVERSAL')
    expect(await columnCount(prisma)).toBe(1)
  })
})
