// tests/integration/intentBindingAndLookup.test.ts
//
// #235 R7H-NF-E3C-5 — Gate A: F-1 (bound Intents cannot be cancelled through the generic Intents API) and F-7
// (caller-scoped, deterministic by-intent lookup), on real PostgreSQL through the real routes.
//
// F-1: an Intent referenced by an Offer or a Trade is refused with 409 INTENT_BOUND — atomically with the
// cancellation (the check and the transition share one transaction holding the Intent's FOR UPDATE lock), only after
// the ownership test, with zero state / event effects. Free-standing Intents stay owner-cancellable.
// F-7: GET /v1/openp2p/trades/by-intent/:id resolves only trades the CALLER is a party to — one → 200, none (or a
// non-party) → 404, several → 409 AMBIGUOUS_INTENT listing only the caller's own ids; no other participant's trade
// id or identity ever appears in any response.

import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { type Party, participant, call, brief, boundSellOffer, takeOffer, cleanupFixtures } from './tradeIntentFixtures'

describe('#235 R7H-NF-E3C-5 Gate A — F-1 bound-Intent cancellation, F-7 by-intent lookup (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  const users: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
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

  const who = async (label: string): Promise<Party> => { const p = await participant(label); users.push(p.id); return p }
  const intentRow = (id: string) => prisma.intent.findUniqueOrThrow({ where: { id } })
  const eventCount = async (intentId: string) => ({
    intentEvents: await prisma.intentEvent.count({ where: { intentId } }),
    durable: await prisma.durableEventRecord.count({ where: { correlationId: intentId } }),
  })

  /** An offer with `n` trades taken by `n` distinct buyers (each tolerated even if its response is an error). */
  async function offerWithTrades(label: string, n: number) {
    const seller = await who(`${label}-s`)
    const { offer } = await boundSellOffer(seller)
    const buyers: Party[] = []
    for (let i = 0; i < n; i++) {
      const b = await who(`${label}-b${i}`)
      buyers.push(b)
      await takeOffer(app, b, offer.id)
    }
    const trades = await prisma.trade.findMany({ where: { offerId: offer.id }, orderBy: { createdAt: 'asc' } })
    expect(trades).toHaveLength(n)
    return { seller, offer, buyers, trades }
  }

  // ─── F-1 ──────────────────────────────────────────────────────────────────────────────────────────────

  it('F-1 OFFER INTENT: the maker cannot cancel the Intent behind a live offer — 409, zero effects, and the buyers can still cancel their trades', async () => {
    pg.requirePostgres('F1-offer')
    const { seller, offer, buyers, trades } = await offerWithTrades('f1a', 2)
    const before = { intent: await intentRow(offer.intentId), ...(await eventCount(offer.intentId)) }

    const res = await call(app, seller, 'DELETE', `/v1/intents/${offer.intentId}`)
    expect([res.statusCode, JSON.parse(res.body).error]).toEqual([409, 'INTENT_BOUND'])

    const after = { intent: await intentRow(offer.intentId), ...(await eventCount(offer.intentId)) }
    expect(after).toEqual(before) // status, updatedAt, IntentEvents and durable events all unchanged
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('ACTIVE')
    // The defect this closes: with the Intent cancelled, no buyer could cancel (500). The buyer still can. (That a
    // SECOND buyer can also cancel — independent Trade Intents — is asserted in tradeIntentIsolation.test.ts.)
    const cancel = await call(app, buyers[0], 'PATCH', `/v1/openp2p/trades/${trades[0].id}/status`, { status: 'CANCELLED' })
    expect(cancel.statusCode).toBe(200)
  })

  it('F-1 PRECEDENCE: a non-owner gets 403 (never 409 — no binding information), an unknown Intent 404; neither changes anything', async () => {
    pg.requirePostgres('F1-precedence')
    const { offer, buyers } = await offerWithTrades('f1b', 1)
    const before = { intent: await intentRow(offer.intentId), ...(await eventCount(offer.intentId)) }
    const stranger = await who('f1b-x')
    expect(brief(await call(app, buyers[0], 'DELETE', `/v1/intents/${offer.intentId}`))).toBe('403 FORBIDDEN')
    expect(brief(await call(app, stranger, 'DELETE', `/v1/intents/${offer.intentId}`))).toBe('403 FORBIDDEN')
    expect(brief(await call(app, stranger, 'DELETE', `/v1/intents/00000000-0000-0000-0000-000000000000`))).toBe('404 NOT_FOUND')
    expect(brief(await call(app, null, 'DELETE', `/v1/intents/${offer.intentId}`))).toMatch(/^401/)
    expect({ intent: await intentRow(offer.intentId), ...(await eventCount(offer.intentId)) }).toEqual(before)
  })

  it('F-1 FREE-STANDING: an Intent no offer or trade references is still cancelled by its owner (200, CANCELLED, one transition event)', async () => {
    pg.requirePostgres('F1-free')
    const owner = await who('f1c-o')
    const { intentEngine } = require('../../src/core/intent-engine')
    const created = await intentEngine.create('TradeIntent', { asset: 'BTC', side: 'BUY', maxValue: '100', minValue: '10', fiatMethod: 'PIX' }, owner.id)
    const res = await call(app, owner, 'DELETE', `/v1/intents/${created.id}`)
    expect(res.statusCode).toBe(200)
    expect((await intentRow(created.id)).status).toBe('CANCELLED')
    expect(await prisma.intentEvent.count({ where: { intentId: created.id, toStatus: 'CANCELLED' } })).toBe(1)
    // A second cancel is a clean refusal, not a second effect.
    expect((await call(app, owner, 'DELETE', `/v1/intents/${created.id}`)).statusCode).toBeGreaterThanOrEqual(400)
    expect(await prisma.intentEvent.count({ where: { intentId: created.id, toStatus: 'CANCELLED' } })).toBe(1)
  })

  it('F-1 TOCTOU: a referencing INSERT that commits while the cancellation waits on the Intent row lock is seen — the Intent is NOT cancelled', async () => {
    pg.requirePostgres('F1-toctou')
    const owner = await who('f1d-o')
    const { intentEngine } = require('../../src/core/intent-engine')
    const created = await intentEngine.create('TradeIntent', { asset: 'BTC', side: 'SELL', maxValue: '100', minValue: '10', fiatMethod: 'PIX' }, owner.id)
    const binder = new Client({ connectionString: process.env.DATABASE_URL })
    await binder.connect()
    try {
      await binder.query('BEGIN')
      // The reference is written but not committed: its foreign key holds FOR KEY SHARE on the Intent row.
      await binder.query(
        `INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "intentId", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'BTC', 'SELL', 1, 0.0001, 1, 'PIX', $2, now())`, [owner.id, created.id])
      const cancel = call(app, owner, 'DELETE', `/v1/intents/${created.id}`)
      const admin = new Client({ connectionString: process.env.DATABASE_URL })
      await admin.connect()
      await new Promise((r) => setTimeout(r, 400))
      const [{ waiting }] = (await admin.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows
      await admin.end()
      expect(waiting).toBeGreaterThanOrEqual(1) // the cancellation is blocked on the Intent row, not racing past it
      await binder.query('COMMIT')
      const res = await cancel
      expect([res.statusCode, JSON.parse(res.body).error]).toEqual([409, 'INTENT_BOUND'])
      expect((await intentRow(created.id)).status).not.toBe('CANCELLED')
    } finally {
      await binder.query('ROLLBACK').catch(() => undefined)
      await binder.end()
    }
  })

  // ─── F-7 ──────────────────────────────────────────────────────────────────────────────────────────────

  it('F-7 ONE TRADE: the maker and the taker each resolve the offer Intent to exactly that trade', async () => {
    pg.requirePostgres('F7-one')
    const { seller, offer, buyers, trades } = await offerWithTrades('f7a', 1)
    for (const party of [seller, buyers[0]]) {
      const res = await call(app, party, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data.id).toBe(trades[0].id)
    }
  })

  it('F-7 SEVERAL TRADES: each taker resolves their OWN trade; the maker gets 409 AMBIGUOUS_INTENT listing only the maker\'s trades', async () => {
    pg.requirePostgres('F7-many')
    const { seller, offer, buyers, trades } = await offerWithTrades('f7b', 3)
    for (let i = 0; i < 3; i++) {
      const res = await call(app, buyers[i], 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
      expect([res.statusCode, JSON.parse(res.body).data.id]).toEqual([200, trades[i].id])
    }
    const res = await call(app, seller, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
    const body = JSON.parse(res.body)
    expect([res.statusCode, body.error]).toEqual([409, 'AMBIGUOUS_INTENT'])
    expect([...body.details.tradeIds].sort()).toEqual(trades.map((t) => t.id).sort())
    // A buyer is party to one trade only: their 409 would list nothing but their own — and they never get one.
  })

  it('F-7 ISOLATION: a stranger and an unknown Intent are indistinguishable 404s, and no response names another participant\'s trade or identity', async () => {
    pg.requirePostgres('F7-isolation')
    const { seller, offer, buyers, trades } = await offerWithTrades('f7c', 2)
    const stranger = await who('f7c-x')
    const unknown = await call(app, stranger, 'GET', `/v1/openp2p/trades/by-intent/00000000-0000-0000-0000-000000000000`)
    const probe = await call(app, stranger, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
    expect([probe.statusCode, JSON.parse(probe.body).error]).toEqual([404, 'NOT_FOUND'])
    expect([unknown.statusCode, JSON.parse(unknown.body).error]).toEqual([404, 'NOT_FOUND'])
    // Nothing of the other participants in any of the responses a non-party (or a taker about the OTHER taker) sees.
    const everyone = [seller.id, buyers[0].id, buyers[1].id, ...trades.map((t) => t.id)]
    for (const text of [probe.body, unknown.body]) for (const secret of everyone) expect(text).not.toContain(secret)
    // Taker 0 sees only their own trade — the response never mentions taker 1's trade id or participant id.
    const mine = await call(app, buyers[0], 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
    expect(mine.statusCode).toBe(200)
    for (const secret of [buyers[1].id, trades[1].id]) expect(mine.body).not.toContain(secret)
    // And an unauthenticated caller learns nothing.
    expect((await call(app, null, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)).statusCode).toBe(401)
  })

  it('F-7 NO findFirst: the answer for the maker does not depend on row order — it is always the same deterministic 409', async () => {
    pg.requirePostgres('F7-deterministic')
    const { seller, offer } = await offerWithTrades('f7d', 2)
    const outcomes = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const res = await call(app, seller, 'GET', `/v1/openp2p/trades/by-intent/${offer.intentId}`)
      outcomes.add(`${res.statusCode} ${JSON.parse(res.body).error}`)
    }
    expect([...outcomes]).toEqual(['409 AMBIGUOUS_INTENT'])
  })
})
