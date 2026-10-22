// tests/integration/tradeIntentAtomicAdmission.test.ts
//
// #235 R7H-NF-E3C-5 (B2) — the atomic admission unit, Trade-scoped Intents and lifecycle isolation, on real
// PostgreSQL through the real routes.
//
// One transaction commits (or rolls back as a whole): the idempotency result, the trade's OWN Intent with its
// hash-chained IntentEvents, the Trade, the unchanged E3C admission check, and the durable trade / negotiation / Intent
// events. These tests prove the properties that make that matter:
//   - many buyers accept ONE standing offer, each answered 201 with an independent trade and Intent (S1, S4);
//   - the same key under concurrency converges on one durable trade (S2) and is recovered after commit, in a "restarted"
//     module graph, and even after the offer became inactive (S6);
//   - a refusal or a crash BEFORE commit leaves nothing — no claim, Intent, trade or event — and the key is reusable (S5);
//   - a failure AFTER commit (event dispatch) is never an error for the committed trade (S3);
//   - one trade's cancellation / escrow lock cannot corrupt another's lifecycle (S8), and legacy shared-Intent trades are
//     handled by the explicit, audited L1 policy (S7);
//   - durable event ordering and both hash chains are intact.

import { createHash, randomUUID } from 'crypto'
import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { type Party, participant, call, brief, boundSellOffer, takeOffer, idemKey, cleanupFixtures } from './tradeIntentFixtures'

const WALK = ['CREATED', 'VALIDATED', 'COORDINATED', 'DISCOVERING', 'MATCHED', 'NEGOTIATING']
const TRADE_EVENTS = ['openp2p.trade.created', 'negotiation.opened', 'openp2p.trade.status_changed']
const INTENT_EVENTS = ['intent.created', 'intent.validated', 'intent.coordinated', 'intent.discovering', 'intent.matched', 'intent.negotiating']

describe('#235 R7H-NF-E3C-5 B2 — atomic admission, trade-scoped Intents, lifecycle isolation (real PostgreSQL)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let escrowService: any
  let eventStoreModule: any
  const users: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    eventStoreModule = require('../../src/common/events/event-store')
    app = await require('../../src/app').buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try { await cleanupFixtures(prisma, users) } finally {
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────

  const who = async (label: string): Promise<Party> => { const p = await participant(label); users.push(p.id); return p }
  const intentStatus = async (id: string) => (await prisma.intent.findUniqueOrThrow({ where: { id } })).status
  const tradesOf = (offerId: string) => prisma.trade.findMany({ where: { offerId }, orderBy: { createdAt: 'asc' } })
  const claimsFor = (keys: string[]) =>
    prisma.$queryRaw<Array<{ key: string; status: string; resultRef: string | null }>>`
      SELECT key, status::text AS status, "resultRef" FROM idempotency_keys WHERE key = ANY(${keys})`
  const tradeBody = (r: { body: string }) => JSON.parse(r.body).data

  async function freshOffer(label: string) {
    const seller = await who(`${label}-s`)
    const { offer, account } = await boundSellOffer(seller)
    return { seller, offer, account }
  }

  /** IntentEvents of an Intent: statuses in order, and the sha256(from|to|triggeredBy|prev) chain recomputed. */
  async function expectIntentChain(intentId: string, statuses: string[]) {
    const events = await prisma.intentEvent.findMany({ where: { intentId }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => e.toStatus)).toEqual(statuses)
    let prev = 'genesis'
    for (const e of events) {
      const hash = createHash('sha256').update(`${e.fromStatus ?? ''}|${e.toStatus}|${e.triggeredBy}|${prev}`).digest('hex')
      expect([e.prevHash, e.entryHash]).toEqual([prev, hash])
      prev = hash
    }
  }

  /** Durable events of one correlation: names in order, strictly increasing publishedAt, and the entry-hash chain recomputed. */
  async function expectDurableChain(correlationId: string, names: string[]) {
    const rows = await prisma.durableEventRecord.findMany({ where: { correlationId }, orderBy: { publishedAt: 'asc' } })
    expect(rows.map((r) => r.eventName)).toEqual(names)
    let prev = eventStoreModule.GENESIS_HASH
    let last = ''
    for (const r of rows) {
      expect(r.prevHash).toBe(prev)
      expect(r.entryHash).toBe(eventStoreModule.computeEntryHash(r.eventName, r.publishedAt, r.payload, prev))
      expect(r.publishedAt > last).toBe(true)
      prev = r.entryHash
      last = r.publishedAt
    }
  }

  /** What a refused or crashed admission may leave behind for this participant + key: nothing. */
  async function expectNothingDurable(taker: Party, offerId: string, key: string) {
    expect(await prisma.trade.count({ where: { offerId, buyerId: taker.id } })).toBe(0)
    expect((await claimsFor([key])).length).toBe(0)
    expect(await prisma.intent.count({ where: { participantId: taker.id } })).toBe(0)
    expect(await prisma.$queryRaw<any[]>`SELECT 1 FROM durable_events WHERE payload::text LIKE ${'%' + taker.id + '%'}`).toEqual([])
  }

  // ─── S1 / S4: multiple buyers, one standing offer ─────────────────────────────────────────────────────

  it('S1 EIGHT BUYERS, DISTINCT KEYS, ONE OFFER: every one is answered 201 with an independent trade and its own Intent; the offer\'s Intent is never touched', async () => {
    pg.requirePostgres('B2-S1')
    const { offer } = await freshOffer('s1')
    const takers = await Promise.all(Array.from({ length: 8 }, (_, i) => who(`s1-t${i}`)))
    const keys = takers.map(() => idemKey())
    const res = await Promise.all(takers.map((t, i) => takeOffer(app, t, offer.id, keys[i])))
    expect(res.map(brief)).toEqual(Array(8).fill('201 ok'))

    const trades = await tradesOf(offer.id)
    expect(trades).toHaveLength(8)
    expect(new Set(trades.map((t) => t.tradeIntentId)).size).toBe(8)            // 8 distinct trade Intents
    for (const t of trades) {
      expect(t.intentId).toBe(offer.intentId)                                    // the published meaning is unchanged
      expect(t.tradeIntentId).toBeTruthy()
      expect(t.tradeIntentId).not.toBe(offer.intentId)
      expect(await intentStatus(t.tradeIntentId!)).toBe('NEGOTIATING')
      const intent = await prisma.intent.findUniqueOrThrow({ where: { id: t.tradeIntentId! } })
      expect([intent.participantId, intent.parentIntentId, intent.expiresAt, intent.type]).toEqual([t.buyerId, offer.intentId, null, 'TradeIntent'])
      await expectIntentChain(t.tradeIntentId!, WALK)
      await expectDurableChain(t.tradeIntentId!, INTENT_EVENTS)
      await expectDurableChain(t.id, TRADE_EVENTS)
    }
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')               // the advertisement's lifecycle is its own
    const claims = await claimsFor(keys)
    expect(claims.map((c) => c.status)).toEqual(Array(8).fill('COMPLETED'))
    expect(new Set(claims.map((c) => c.resultRef))).toEqual(new Set(trades.map((t) => t.id)))
  })

  it('S4 SEQUENTIAL SECOND BUYER (no concurrency at all): 201 — the case that was a deterministic 500 for a live trade', async () => {
    pg.requirePostgres('B2-S4')
    const { offer } = await freshOffer('s4')
    const [a, b] = [await who('s4-a'), await who('s4-b')]
    expect(brief(await takeOffer(app, a, offer.id))).toBe('201 ok')
    expect(brief(await takeOffer(app, b, offer.id))).toBe('201 ok')
    const trades = await tradesOf(offer.id)
    expect(await Promise.all(trades.map((t) => intentStatus(t.tradeIntentId!)))).toEqual(['NEGOTIATING', 'NEGOTIATING'])
  })

  // ─── S2: same key ─────────────────────────────────────────────────────────────────────────────────────

  it('S2 SAME KEY, SIX CONCURRENT REQUESTS: one durable trade, every response is that trade (201), one claim, one Intent — and a later replay is the same trade', async () => {
    pg.requirePostgres('B2-S2')
    const { offer } = await freshOffer('s2')
    const taker = await who('s2-t')
    const key = idemKey()
    const res = await Promise.all(Array.from({ length: 6 }, () => takeOffer(app, taker, offer.id, key)))
    expect(res.map((r) => r.statusCode)).toEqual(Array(6).fill(201))
    expect(new Set(res.map((r) => tradeBody(r).id)).size).toBe(1)
    const trades = await tradesOf(offer.id)
    expect(trades).toHaveLength(1)
    expect(await prisma.intent.count({ where: { participantId: taker.id } })).toBe(1)
    const claims = await claimsFor([key])
    expect(claims).toEqual([{ key, status: 'COMPLETED', resultRef: trades[0].id }])
    expect(tradeBody(await takeOffer(app, taker, offer.id, key)).id).toBe(trades[0].id)
    // The same key with a different request is refused, never silently reused.
    const other = await takeOffer(app, taker, offer.id, key, '0.0007')
    expect([other.statusCode, JSON.parse(other.body).error]).toEqual([400, 'VALIDATION_ERROR'])
    expect(await tradesOf(offer.id)).toHaveLength(1)
  })

  // ─── S3: failure after commit ─────────────────────────────────────────────────────────────────────────

  it('S3 POST-COMMIT DISPATCH FAILURE: the committed trade is answered 201 (never a false error), its events are durable, and a replay returns the same trade', async () => {
    pg.requirePostgres('B2-S3')
    const { offer } = await freshOffer('s3')
    const taker = await who('s3-t')
    const key = idemKey()
    const real = eventStoreModule.PostgresEventStore.prototype.publishInTransaction
    const spy = jest.spyOn(eventStoreModule.PostgresEventStore.prototype, 'publishInTransaction').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const out = await real.apply(this, args)
      return { eventId: out.eventId, dispatch: () => { throw new Error('simulated post-commit dispatch failure') } }
    })
    let res: any
    try { res = await takeOffer(app, taker, offer.id, key) } finally { spy.mockRestore() }
    expect(res.statusCode).toBe(201)
    const [trade] = await tradesOf(offer.id)
    expect(tradeBody(res).id).toBe(trade.id)
    await expectDurableChain(trade.id, TRADE_EVENTS)                         // durable although nothing was dispatched
    await expectDurableChain(trade.tradeIntentId!, INTENT_EVENTS)
    expect((await claimsFor([key]))[0].status).toBe('COMPLETED')
    expect(tradeBody(await takeOffer(app, taker, offer.id, key)).id).toBe(trade.id)
    expect(await tradesOf(offer.id)).toHaveLength(1)
  })

  // ─── S5: refusal and crash before commit ──────────────────────────────────────────────────────────────

  it('S5a E3C REFUSAL leaves nothing — no claim, no Intent, no trade, no event — and a refused key is not poisoned', async () => {
    pg.requirePostgres('B2-S5a')
    const seller = await who('s5a-s')
    const { liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service')
    const unbound = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX' })
    const taker = await who('s5a-t')
    const key = idemKey()
    for (let i = 0; i < 2; i++) {
      const res = await takeOffer(app, taker, unbound.id, key)
      expect([res.statusCode, JSON.parse(res.body).error]).toEqual([409, 'TRADE_ADMISSION_REFUSED'])
      await expectNothingDurable(taker, unbound.id, key)
    }
    expect(await intentStatus(unbound.intentId)).toBe('COORDINATED')
  })

  it('S5b CRASH BEFORE COMMIT: the backend dies mid-transaction (after the Intent is written) — nothing durable remains, the key is reusable, the retry succeeds once', async () => {
    pg.requirePostgres('B2-S5b')
    const { offer } = await freshOffer('s5b')
    const taker = await who('s5b-t')
    const key = idemKey()
    const { intentEngine } = require('../../src/core/intent-engine')
    const real = intentEngine.createInTransaction.bind(intentEngine)
    const spy = jest.spyOn(intentEngine, 'createInTransaction').mockImplementation(async (tx: any, input: any) => {
      const out = await real(tx, input)
      await tx.$queryRaw`SELECT pg_terminate_backend(pg_backend_pid())` // the process dies with the Intent, the claim and events uncommitted
      return out
    })
    let crashed: any
    try { crashed = await takeOffer(app, taker, offer.id, key) } finally { spy.mockRestore() }
    expect(crashed.statusCode).toBeGreaterThanOrEqual(500)
    await expectNothingDurable(taker, offer.id, key)
    const retry = await takeOffer(app, taker, offer.id, key)
    expect(retry.statusCode).toBe(201)
    expect(await tradesOf(offer.id)).toHaveLength(1)
    expect(await prisma.intent.count({ where: { participantId: taker.id } })).toBe(1)
  })

  it('S5c FAILURE AFTER THE TRADE EVENTS ARE WRITTEN, BEFORE COMMIT: the trade, its Intent, its claim AND its events all roll back together', async () => {
    pg.requirePostgres('B2-S5c')
    const { offer } = await freshOffer('s5c')
    const taker = await who('s5c-t')
    const key = idemKey()
    const { eventBus } = require('../../src/common/events/event-bus')
    const real = eventBus.publishInTransaction.bind(eventBus)
    let calls = 0
    const spy = jest.spyOn(eventBus, 'publishInTransaction').mockImplementation(async (...args: any[]) => {
      const dispatch = await real(...args)            // the events are written inside the transaction...
      if (++calls === 2) throw new Error('simulated failure after the trade events were written') // ...then the unit fails
      return dispatch
    })
    let res: any
    try { res = await takeOffer(app, taker, offer.id, key) } finally { spy.mockRestore() }
    expect(calls).toBe(2)
    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    await expectNothingDurable(taker, offer.id, key)
    expect(brief(await takeOffer(app, taker, offer.id, key))).toBe('201 ok') // and the key is reusable
  })

  // ─── S6: crash after commit, restart, replay ──────────────────────────────────────────────────────────

  it('S6 CRASH AFTER COMMIT: a "restarted" module graph replays the key — same trade, no second trade or Intent — even after the offer was cancelled', async () => {
    pg.requirePostgres('B2-S6')
    const { seller, offer } = await freshOffer('s6')
    const taker = await who('s6-t')
    const key = idemKey()
    const first = await takeOffer(app, taker, offer.id, key)
    expect(first.statusCode).toBe(201)
    const tradeId = tradeBody(first).id
    // The advertisement is withdrawn afterwards: a replay must still answer from the claim, not re-validate.
    expect((await call(app, seller, 'PATCH', `/v1/liquidity/offers/${offer.id}/status`, { status: 'CANCELLED' })).statusCode).toBe(200)
    // A fresh module graph = a restarted process: no in-memory negotiation status, no caches.
    let replayedId: string | undefined
    await jest.isolateModulesAsync(async () => {
      const { tradeService: fresh } = require('../../src/modules/open-p2p/trade.service')
      const replayed = await fresh.createTrade({ offerId: offer.id, counterpartyId: taker.id, amount: '0.0005', idempotencyKey: key })
      replayedId = replayed.id
    })
    expect(replayedId).toBe(tradeId)
    expect(await tradesOf(offer.id)).toHaveLength(1)
    expect(await prisma.intent.count({ where: { participantId: taker.id } })).toBe(1)
    expect((await claimsFor([key]))[0]).toEqual({ key, status: 'COMPLETED', resultRef: tradeId })
  })

  // ─── S8: lifecycle isolation ──────────────────────────────────────────────────────────────────────────

  it('S8 ISOLATION: cancelling one trade, locking another\'s escrow and cancelling a third never touch each other\'s Intent — and the maker cannot cancel any of them through /intents', async () => {
    pg.requirePostgres('B2-S8')
    const { seller, offer } = await freshOffer('s8')
    const [a, b, c] = [await who('s8-a'), await who('s8-b'), await who('s8-c')]
    for (const t of [a, b, c]) expect(brief(await takeOffer(app, t, offer.id))).toBe('201 ok')
    const [ta, tb, tc] = await tradesOf(offer.id)

    // A cancels: only A's Intent moves.
    expect((await call(app, a, 'PATCH', `/v1/openp2p/trades/${ta.id}/status`, { status: 'CANCELLED' })).statusCode).toBe(200)
    expect(await intentStatus(ta.tradeIntentId!)).toBe('CANCELLED')
    expect(await intentStatus(tb.tradeIntentId!)).toBe('NEGOTIATING')
    expect(await intentStatus(tc.tradeIntentId!)).toBe('NEGOTIATING')
    expect(await intentStatus(offer.intentId)).toBe('COORDINATED')

    // B's escrow locks: only B's Intent becomes COMMITTED (the S9 contradiction: it used to fight A's cancellation).
    const escrow = await escrowService.createEscrow({ tradeId: tb.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, seller.id)
    await escrowService.lockFunds(escrow.id, seller.id)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && (await intentStatus(tb.tradeIntentId!)) !== 'COMMITTED') await new Promise((r) => setTimeout(r, 100))
    expect(await intentStatus(tb.tradeIntentId!)).toBe('COMMITTED')
    expect(await intentStatus(ta.tradeIntentId!)).toBe('CANCELLED')
    expect(await intentStatus(tc.tradeIntentId!)).toBe('NEGOTIATING')

    // C is still cancellable after A's cancellation and B's lock (was a 500 for every sibling).
    expect((await call(app, c, 'PATCH', `/v1/openp2p/trades/${tc.id}/status`, { status: 'CANCELLED' })).statusCode).toBe(200)
    expect(await intentStatus(tc.tradeIntentId!)).toBe('CANCELLED')
    expect(await intentStatus(tb.tradeIntentId!)).toBe('COMMITTED')

    // The generic Intents API refuses every Intent that backs an offer or a trade (F-1), for owner and non-owner alike.
    expect(brief(await call(app, seller, 'DELETE', `/v1/intents/${offer.intentId}`))).toBe('409 INTENT_BOUND')
    expect(brief(await call(app, b, 'DELETE', `/v1/intents/${tb.tradeIntentId}`))).toBe('409 INTENT_BOUND')
    expect(brief(await call(app, seller, 'DELETE', `/v1/intents/${tb.tradeIntentId}`))).toBe('403 FORBIDDEN')
    expect(await intentStatus(tb.tradeIntentId!)).toBe('COMMITTED')
  })

  it('S8b A TRADE CANCELLED WHILE ITS OWN ESCROW IS FUNDED stays refused (E3/F8 guards unchanged) and its Intent does not move', async () => {
    pg.requirePostgres('B2-S8b')
    const { seller, offer } = await freshOffer('s8b')
    const buyer = await who('s8b-b')
    expect(brief(await takeOffer(app, buyer, offer.id))).toBe('201 ok')
    const [trade] = await tradesOf(offer.id)
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, seller.id)
    await escrowService.lockFunds(escrow.id, seller.id)
    const res = await call(app, buyer, 'PATCH', `/v1/openp2p/trades/${trade.id}/status`, { status: 'CANCELLED' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(await intentStatus(trade.tradeIntentId!)).not.toBe('CANCELLED')
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).status).not.toBe('CANCELLED')
  })

  // ─── S7: legacy shared-Intent trades, L1 ──────────────────────────────────────────────────────────────

  /**
   * A world as it existed before B2: one Offer Intent walked to NEGOTIATING and shared by trades without a
   * tradeIntentId. Built by direct inserts (the historical shape) — the product no longer produces it.
   */
  async function legacyWorld(label: string, n: number) {
    const { seller, offer, account } = await freshOffer(label)
    const { intentEngine } = require('../../src/core/intent-engine')
    for (const to of ['DISCOVERING', 'MATCHED', 'NEGOTIATING'] as const) {
      await intentEngine.transition(offer.intentId, to, 'system:legacy-fixture', `intent.${to.toLowerCase()}`, { intentId: offer.intentId, candidateIds: [], negotiationId: 'legacy' })
    }
    const buyers: Party[] = []
    const trades: any[] = []
    for (let i = 0; i < n; i++) {
      const b = await who(`${label}-b${i}`)
      buyers.push(b)
      trades.push(await prisma.trade.create({
        data: {
          offerId: offer.id, buyerId: b.id, sellerId: seller.id, asset: 'BTC', amount: '0.0005', priceUsd: '65000', totalUsd: '32.5',
          intentId: offer.intentId, sellerPaymentAccountId: account.id,
        },
      }))
    }
    return { seller, offer, buyers, trades }
  }
  const unchangedEvents = (tradeId: string) =>
    prisma.durableEventRecord.findMany({ where: { correlationId: tradeId, eventName: 'openp2p.trade.intent_unchanged' } })

  it('S7 LEGACY (L1): cancelling a legacy trade leaves the shared Intent alone while a sibling is live — audited, never fabricated — and the last one out cancels it', async () => {
    pg.requirePostgres('B2-S7')
    const { offer, buyers, trades } = await legacyWorld('s7', 2)
    const historyBefore = await prisma.intentEvent.count({ where: { intentId: offer.intentId } })

    const first = await call(app, buyers[0], 'PATCH', `/v1/openp2p/trades/${trades[0].id}/status`, { status: 'CANCELLED' })
    expect(first.statusCode).toBe(200)
    expect(await intentStatus(offer.intentId)).toBe('NEGOTIATING')                                  // sibling still depends on it
    expect(await prisma.intentEvent.count({ where: { intentId: offer.intentId } })).toBe(historyBefore) // no transition invented
    const audit = await unchangedEvents(trades[0].id)
    expect(audit).toHaveLength(1)
    expect(audit[0].payload).toMatchObject({ tradeId: trades[0].id, intentId: offer.intentId, intentStatus: 'NEGOTIATING', reason: 'SHARED_INTENT_SIBLING_TRADES_LIVE', liveSiblingTrades: 1, triggeredBy: buyers[0].id })
    // The sibling's obligations are untouched.
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trades[1].id } })).status).toBe('PENDING')

    // Last one out: no live sibling remains, so the Intent follows this trade exactly as it always did.
    const second = await call(app, buyers[1], 'PATCH', `/v1/openp2p/trades/${trades[1].id}/status`, { status: 'CANCELLED' })
    expect(second.statusCode).toBe(200)
    expect(await intentStatus(offer.intentId)).toBe('CANCELLED')
    expect(await unchangedEvents(trades[1].id)).toHaveLength(0)
  })

  it('S7b LEGACY (L1): a shared Intent that is already TERMINAL (no live sibling) no longer blocks the trade\'s own cancellation — recorded, not forced', async () => {
    pg.requirePostgres('B2-S7b')
    const { offer, buyers, trades } = await legacyWorld('s7b', 2)
    // The sibling completed (its escrow settled): trade COMPLETED, the shared Intent FULFILLED.
    await prisma.$executeRaw`UPDATE trades SET status = 'COMPLETED' WHERE id = ${trades[0].id}`
    await prisma.$executeRaw`UPDATE intents SET status = 'FULFILLED' WHERE id = ${offer.intentId}`
    const res = await call(app, buyers[1], 'PATCH', `/v1/openp2p/trades/${trades[1].id}/status`, { status: 'CANCELLED' })
    expect(res.statusCode).toBe(200)
    expect(await intentStatus(offer.intentId)).toBe('FULFILLED')
    const audit = await unchangedEvents(trades[1].id)
    expect(audit[0].payload).toMatchObject({ reason: 'SHARED_INTENT_ALREADY_TERMINAL', intentStatus: 'FULFILLED', liveSiblingTrades: 0 })
    // Proof the skip is not a bypass: the sibling's COMPLETED trade was never cancellable by this route.
    const bad = await call(app, buyers[0], 'PATCH', `/v1/openp2p/trades/${trades[0].id}/status`, { status: 'CANCELLED' })
    expect(bad.statusCode).toBe(400)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trades[0].id } })).status).toBe('COMPLETED')
  })

  it('S7d LEGACY: R7G-B1\'s defence is intact — a COMMITTED shared Intent that no live sibling explains still refuses the WHOLE cancellation, with no durable effect', async () => {
    pg.requirePostgres('B2-S7d')
    const { offer, buyers, trades } = await legacyWorld('s7d', 1)
    await prisma.$executeRaw`UPDATE intents SET status = 'COMMITTED' WHERE id = ${offer.intentId}`
    const historyBefore = await prisma.intentEvent.count({ where: { intentId: offer.intentId } })
    const statusEventsBefore = await prisma.durableEventRecord.count({ where: { correlationId: trades[0].id } })
    const res = await call(app, buyers[0], 'PATCH', `/v1/openp2p/trades/${trades[0].id}/status`, { status: 'CANCELLED' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trades[0].id } })).status).toBe('PENDING')
    expect(await intentStatus(offer.intentId)).toBe('COMMITTED')
    expect(await prisma.intentEvent.count({ where: { intentId: offer.intentId } })).toBe(historyBefore)
    expect(await unchangedEvents(trades[0].id)).toHaveLength(0)
    expect(await prisma.durableEventRecord.count({ where: { correlationId: trades[0].id } })).toBe(statusEventsBefore)
  })

  it('S7c LEGACY: a legacy trade with its OWN funded escrow is never skipped — the existing guards refuse it, and no sibling can cancel it', async () => {
    pg.requirePostgres('B2-S7c')
    const { seller, offer, buyers, trades } = await legacyWorld('s7c', 2)
    const escrow = await escrowService.createEscrow({ tradeId: trades[0].id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, seller.id)
    await escrowService.lockFunds(escrow.id, seller.id)
    await new Promise((r) => setTimeout(r, 1500))
    // The sibling cancels theirs: the funded trade's obligations and the Intent state they rest on stay.
    expect((await call(app, buyers[1], 'PATCH', `/v1/openp2p/trades/${trades[1].id}/status`, { status: 'CANCELLED' })).statusCode).toBe(200)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trades[0].id } })).status).not.toBe('CANCELLED')
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('FUNDS_LOCKED')
    // The funded trade itself cannot be cancelled unilaterally.
    const own = await call(app, buyers[0], 'PATCH', `/v1/openp2p/trades/${trades[0].id}/status`, { status: 'CANCELLED' })
    expect(own.statusCode).toBeGreaterThanOrEqual(400)
    expect(await intentStatus(offer.intentId)).toBe('COMMITTED')
  })

  // ─── legacy claims in the new scope ───────────────────────────────────────────────────────────────────

  it('LEGACY CLAIMS: an old FAILED claim is reclaimed atomically with the new admission; an IN_PROGRESS claim is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, never a new trade', async () => {
    pg.requirePostgres('B2-legacy-claims')
    const { offer } = await freshOffer('lc')
    const { hashIdempotentPayload } = require('../../src/common/idempotency')
    const requestHash = hashIdempotentPayload({ offerId: offer.id, amount: '0.0005' })
    const seed = (taker: Party, key: string, status: string) =>
      prisma.$executeRaw`INSERT INTO idempotency_keys (id, scope, "participantId", key, "requestHash", status, "createdAt")
        VALUES (${randomUUID()}, 'openp2p.trade.create', ${taker.id}, ${key}, ${requestHash}, ${status}::"IdempotencyKeyStatus", now() - interval '1 hour')`

    const failedTaker = await who('lc-f')
    const failedKey = idemKey()
    await seed(failedTaker, failedKey, 'FAILED')
    const reclaimed = await takeOffer(app, failedTaker, offer.id, failedKey)
    expect(reclaimed.statusCode).toBe(201)
    expect((await claimsFor([failedKey]))[0]).toEqual({ key: failedKey, status: 'COMPLETED', resultRef: tradeBody(reclaimed).id })

    const stuckTaker = await who('lc-s')
    const stuckKey = idemKey()
    await seed(stuckTaker, stuckKey, 'IN_PROGRESS')
    const stuck = await takeOffer(app, stuckTaker, offer.id, stuckKey)
    expect([stuck.statusCode, JSON.parse(stuck.body).error]).toEqual([409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'])
    expect(await prisma.trade.count({ where: { offerId: offer.id, buyerId: stuckTaker.id } })).toBe(0)
    expect((await claimsFor([stuckKey]))[0].status).toBe('IN_PROGRESS') // never rewritten by a guess
  })

  it('NO KEY: a request without an idempotency key is still one atomic unit (own Intent, durable events) — and, as documented, not deduplicated', async () => {
    pg.requirePostgres('B2-nokey')
    const { offer } = await freshOffer('nk')
    const taker = await who('nk-t')
    expect(brief(await takeOffer(app, taker, offer.id, null))).toBe('201 ok')
    expect(brief(await takeOffer(app, taker, offer.id, null))).toBe('201 ok')
    const trades = await tradesOf(offer.id)
    expect(trades).toHaveLength(2)
    expect(await prisma.$queryRaw<any[]>`SELECT 1 FROM idempotency_keys WHERE "participantId" = ${taker.id}`).toEqual([]) // truly keyless: no claim row
    for (const t of trades) {
      await expectDurableChain(t.id, TRADE_EVENTS)
      await expectIntentChain(t.tradeIntentId!, WALK)
    }
  })

  // ─── lookups through the trade Intent ─────────────────────────────────────────────────────────────────

  it('LOOKUP: a trade resolves through its OWN Intent for both parties and for nobody else; GET /trades/:id exposes tradeIntentId additively', async () => {
    pg.requirePostgres('B2-lookup')
    const { seller, offer } = await freshOffer('lk')
    const [a, b] = [await who('lk-a'), await who('lk-b')]
    await takeOffer(app, a, offer.id)
    await takeOffer(app, b, offer.id)
    const [ta, tb] = await tradesOf(offer.id)
    for (const party of [a, seller]) {
      const res = await call(app, party, 'GET', `/v1/openp2p/trades/by-intent/${ta.tradeIntentId}`)
      expect([res.statusCode, tradeBody(res).id]).toEqual([200, ta.id])
    }
    expect(brief(await call(app, b, 'GET', `/v1/openp2p/trades/by-intent/${ta.tradeIntentId}`))).toBe('404 NOT_FOUND')
    const detail = await call(app, a, 'GET', `/v1/openp2p/trades/${ta.id}`)
    expect([tradeBody(detail).tradeIntentId, tradeBody(detail).intentId]).toEqual([ta.tradeIntentId, offer.intentId])
    // And the maker's lookup by the OFFER's Intent is the deterministic ambiguity, listing exactly the maker's trades.
    const amb = await call(app, seller, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
    expect([amb.statusCode, JSON.parse(amb.body).error]).toEqual([409, 'AMBIGUOUS_INTENT'])
    expect([...JSON.parse(amb.body).details.tradeIds].sort()).toEqual([ta.id, tb.id].sort())
  })

  // ─── database-level proof the unit is one transaction ─────────────────────────────────────────────────

  it('ATOMICITY (database): while an admission is mid-transaction, none of its rows is visible to another connection; after commit all are', async () => {
    pg.requirePostgres('B2-atomic-visibility')
    const { offer } = await freshOffer('av')
    const taker = await who('av-t')
    const key = idemKey()
    const { intentEngine } = require('../../src/core/intent-engine')
    const real = intentEngine.createInTransaction.bind(intentEngine)
    const observer = new Client({ connectionString: process.env.DATABASE_URL })
    await observer.connect()
    let seenMidTransaction: Record<string, number> | undefined
    const spy = jest.spyOn(intentEngine, 'createInTransaction').mockImplementation(async (tx: any, input: any) => {
      const out = await real(tx, input) // the claim and the Intent rows are now written, uncommitted
      const count = async (sql: string, p: unknown[]) => Number((await observer.query(sql, p)).rows[0].n)
      seenMidTransaction = {
        claims: await count(`SELECT count(*) n FROM idempotency_keys WHERE key = $1`, [key]),
        intents: await count(`SELECT count(*) n FROM intents WHERE "participantId" = $1`, [taker.id]),
        intentEvents: await count(`SELECT count(*) n FROM intent_events WHERE "intentId" = $1`, [out.id]),
        durable: await count(`SELECT count(*) n FROM durable_events WHERE "correlationId" = $1`, [out.id]),
        trades: await count(`SELECT count(*) n FROM trades WHERE "buyerId" = $1`, [taker.id]),
      }
      return out
    })
    try {
      expect((await takeOffer(app, taker, offer.id, key)).statusCode).toBe(201)
    } finally { spy.mockRestore(); await observer.end() }
    expect(seenMidTransaction).toEqual({ claims: 0, intents: 0, intentEvents: 0, durable: 0, trades: 0 })
    expect((await claimsFor([key])).length).toBe(1)
    expect(await prisma.intent.count({ where: { participantId: taker.id } })).toBe(1)
  })
})
