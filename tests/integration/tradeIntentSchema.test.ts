// tests/integration/tradeIntentSchema.test.ts
//
// #235 R7H-NF-E3C-5 — Phase B: migration 20261018120000_trade_scoped_intent, proven on real PostgreSQL.
//
// "trades"."tradeIntentId" is additive and nullable (historical trades keep NULL — nothing is back-filled), unique,
// a real foreign key (RESTRICT), fixed at creation, and can only ever be an Intent of the trade's own: never an
// offer's or a legacy trade's shared Intent. Direct SQL (the owner's credential) is held to all of it.

import { readFileSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { type Party, participant, boundSellOffer, cleanupFixtures } from './tradeIntentFixtures'

describe('#235 R7H-NF-E3C-5 B — trades.tradeIntentId migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let db: Client
  const users: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    app = await require('../../src/app').buildApp({ registerSwaggerUi: false }) // registers the Intent type handlers
    await app.ready()
    db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try { await cleanupFixtures(prisma, users) } finally {
      await db.end()
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const who = async (label: string): Promise<Party> => { const p = await participant(label); users.push(p.id); return p }
  async function freeIntent(owner: Party) {
    const { intentEngine } = require('../../src/core/intent-engine')
    return intentEngine.create('TradeIntent', { asset: 'BTC', side: 'BUY', maxValue: '100', minValue: '10', fiatMethod: 'PIX' }, owner.id)
  }
  /** A direct INSERT of a trade, the way any non-application writer would; `tradeIntentId` and `intentId` are the variables. */
  async function insertTrade(offer: { id: string; userId: string }, buyerId: string, over: { tradeIntentId?: string | null; intentId?: string | null } = {}) {
    const id = randomUUID()
    await db.query(
      `INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", "intentId", "tradeIntentId", "updatedAt")
       VALUES ($1,$2,$3,$4,'USDT_ERC20',1,1,1,$5,$6,now())`,
      [id, offer.id, buyerId, offer.userId, over.intentId ?? null, over.tradeIntentId ?? null])
    return id
  }
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code} ${String(e.message).slice(0, 80)}`)

  /** An ungoverned-asset offer (no E3 binding needed) so direct trade inserts exercise only the tradeIntentId rules. */
  async function plainOffer(seller: Party) {
    const { liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service')
    return liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '1', maxAmount: '100', paymentMethod: 'OTHER' })
  }

  it('SCHEMA: the column is nullable, uniquely indexed and foreign-keyed with RESTRICT; the legacy-Intent index exists', async () => {
    pg.requirePostgres('B-schema')
    const [col] = (await db.query(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='trades' AND column_name='tradeIntentId'`)).rows
    expect([col.is_nullable, col.data_type]).toEqual(['YES', 'text'])
    const idx = (await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='trades' AND indexname IN ('trades_tradeIntentId_key','trades_intentId_idx')`)).rows
    expect(idx.map((r) => r.indexname).sort()).toEqual(['trades_intentId_idx', 'trades_tradeIntentId_key'])
    expect(idx.find((r) => r.indexname === 'trades_tradeIntentId_key')!.indexdef).toMatch(/UNIQUE/)
    const [fk] = (await db.query(`SELECT confdeltype FROM pg_constraint WHERE conname='trades_tradeIntentId_fkey'`)).rows
    expect(fk.confdeltype).toBe('r') // RESTRICT
  })

  it('ADDITIVE: the migration contains no statement that reads or rewrites an existing trade, offer or intent row', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261018120000_trade_scoped_intent/migration.sql'), 'utf8')
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/\bUPDATE\s+"?(trades|offers|intents)"?\s+SET\b/i) // a back-fill would be an UPDATE ... SET
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).toMatch(/ADD COLUMN "tradeIntentId" TEXT;/) // nullable: no NOT NULL, no DEFAULT
    expect(code).not.toMatch(/"tradeIntentId" TEXT (NOT NULL|DEFAULT)/i)
  })

  it('HISTORICAL SHAPE: a trade without a trade Intent is valid (the legacy shape) and stays NULL', async () => {
    pg.requirePostgres('B-legacy')
    const [seller, buyer] = [await who('b-l-s'), await who('b-l-b')]
    const offer = await plainOffer(seller)
    const id = await insertTrade(offer, buyer.id, { intentId: offer.intentId })
    expect((await prisma.trade.findUniqueOrThrow({ where: { id } })).tradeIntentId).toBeNull()
  })

  it('UNIQUE + FK: one Intent backs at most one trade; an unknown Intent is refused; a referenced Intent cannot be deleted', async () => {
    pg.requirePostgres('B-unique-fk')
    const [seller, b1, b2] = [await who('b-u-s'), await who('b-u-b1'), await who('b-u-b2')]
    const offer = await plainOffer(seller)
    const intent = await freeIntent(b1)
    const first = await insertTrade(offer, b1.id, { intentId: offer.intentId, tradeIntentId: intent.id })
    expect(await code(insertTrade(offer, b2.id, { intentId: offer.intentId, tradeIntentId: intent.id }))).toMatch(/^23505/)
    expect(await code(insertTrade(offer, b2.id, { intentId: offer.intentId, tradeIntentId: randomUUID() }))).toMatch(/^23503/)
    // A referenced Intent cannot be deleted. PostgreSQL reports a RESTRICT violation as 23001 from 18 on and as 23503 on
    // earlier servers (CI runs 16), and an Intent that has events is also held by intent_events' own FK — whichever
    // trigger fires first answers. So: (1) the Intent with events is refused (either family code); (2) a BARE Intent
    // (no events) is held by trades.tradeIntentId alone, and the error names exactly that constraint.
    expect(await code(db.query(`DELETE FROM intents WHERE id = $1`, [intent.id]))).toMatch(/^(23001|23503)/)
    const bare = await prisma.intent.create({ data: { type: 'TradeIntent', participantId: b2.id, moduleId: 'openp2p', payload: {}, status: 'NEGOTIATING' } })
    const bareTrade = await insertTrade(offer, b2.id, { intentId: offer.intentId, tradeIntentId: bare.id })
    const refusal = await db.query(`DELETE FROM intents WHERE id = $1`, [bare.id]).then(() => null, (e: { code?: string; message?: string }) => e)
    expect(refusal?.code).toMatch(/^(23001|23503)/)
    expect(refusal?.message).toContain('trades_tradeIntentId_fkey')
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: bareTrade } })).tradeIntentId).toBe(bare.id)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: first } })).tradeIntentId).toBe(intent.id)
  })

  it('WRITE-ONCE: set, change and clear are all refused after creation — including NULL -> value on a legacy trade', async () => {
    pg.requirePostgres('B-write-once')
    const [seller, buyer] = [await who('b-w-s'), await who('b-w-b')]
    const offer = await plainOffer(seller)
    const [i1, i2] = [await freeIntent(buyer), await freeIntent(buyer)]
    const owned = await insertTrade(offer, buyer.id, { intentId: offer.intentId, tradeIntentId: i1.id })
    const legacy = await insertTrade(offer, buyer.id, { intentId: offer.intentId })
    expect(await code(db.query(`UPDATE trades SET "tradeIntentId" = $2 WHERE id = $1`, [owned, i2.id]))).toMatch(/^23000.*fixed at creation/)
    expect(await code(db.query(`UPDATE trades SET "tradeIntentId" = NULL WHERE id = $1`, [owned]))).toMatch(/^23000.*fixed at creation/)
    expect(await code(db.query(`UPDATE trades SET "tradeIntentId" = $2 WHERE id = $1`, [legacy, i2.id]))).toMatch(/^23000.*fixed at creation/)
    // An UPDATE that does not touch the column is unaffected.
    expect(await code(db.query(`UPDATE trades SET status = 'ACTIVE' WHERE id = $1`, [owned]))).toBe('ok')
  })

  it('OWN INTENT ONLY: a trade Intent can be neither the trade\'s offer Intent, nor any offer\'s Intent, nor a legacy trade\'s shared Intent', async () => {
    pg.requirePostgres('B-own-only')
    const [seller, buyer, other] = [await who('b-o-s'), await who('b-o-b'), await who('b-o-x')]
    const offerA = await plainOffer(seller)
    const offerB = await plainOffer(other)
    // The row's own offer Intent: refused by the trigger (an offer references it) — and, independently, by the CHECK
    // constraint, which is the second line of defence for any writer that skips triggers (session_replication_role).
    expect(await code(insertTrade(offerA, buyer.id, { intentId: offerA.intentId, tradeIntentId: offerA.intentId }))).toMatch(/^23000.*of its own/)
    const [chk] = (await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'trades_trade_intent_distinct_from_offer_intent'`)).rows
    expect(chk.def).toMatch(/"tradeIntentId" IS DISTINCT FROM "intentId"/)
    // Another offer's Intent: the trigger.
    expect(await code(insertTrade(offerA, buyer.id, { intentId: offerA.intentId, tradeIntentId: offerB.intentId }))).toMatch(/^23000.*of its own/)
    // A legacy trade's shared Intent (offer A's Intent is already some trade's intentId).
    await insertTrade(offerA, buyer.id, { intentId: offerA.intentId })
    const legacyShared = await freeIntent(seller)
    await insertTrade(offerB, buyer.id, { intentId: legacyShared.id }) // a legacy trade whose shared Intent is legacyShared
    expect(await code(insertTrade(offerA, buyer.id, { intentId: offerA.intentId, tradeIntentId: legacyShared.id }))).toMatch(/^23000.*of its own/)
  })

  it('PRISMA: the generated client round-trips tradeIntentId and its relation in both directions', async () => {
    pg.requirePostgres('B-prisma')
    const [seller, buyer] = [await who('b-p-s'), await who('b-p-b')]
    const offer = await plainOffer(seller)
    const intent = await freeIntent(buyer)
    const id = await insertTrade(offer, buyer.id, { intentId: offer.intentId, tradeIntentId: intent.id })
    const trade = await prisma.trade.findUniqueOrThrow({ where: { id }, include: { tradeIntent: true, intent: true } })
    expect([trade.tradeIntent?.id, trade.intent?.id]).toEqual([intent.id, offer.intentId])
    const back = await prisma.intent.findUniqueOrThrow({ where: { id: intent.id }, include: { tradeOwned: true } })
    expect(back.tradeOwned?.id).toBe(id)
    // The legacy relation is unchanged: the offer Intent still lists the trade among its `trades`.
    const offerIntent = await prisma.intent.findUniqueOrThrow({ where: { id: offer.intentId }, include: { trades: true } })
    expect(offerIntent.trades.map((t) => t.id)).toContain(id)
  })
})
