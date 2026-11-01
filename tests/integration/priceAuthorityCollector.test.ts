// tests/integration/priceAuthorityCollector.test.ts
//
// #235 R7H-E2 — the canonical BTC/USD price authority on real PostgreSQL.
//
// Sources are four local HTTP servers (one per exchange, distinct host:port) serving the exchanges' live payload
// shapes, reached through the production adapters and boundedFetch(). Database work runs under two login roles
// created here: one member of sails_app (the application's credential) and one member of sails_quote_collector
// (the collector's), so privileges are proven for the credentials a deployment uses, not for the test superuser.

import { createServer, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createHash, randomBytes } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { Client, Pool, type PoolClient } from 'pg'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { BITSTAMP, COINBASE, GEMINI, KRAKEN, type PriceSource } from '../../src/modules/open-valuation/price-sources'
import { assertCollectorCredential, collectAndPublish, type CollectOutcome } from '../../src/modules/open-valuation/quote-collector'
import { publishCanonicalQuote, quoteIdFor, readAuthorizationQuote, windowStartOf } from '../../src/modules/open-valuation/canonical-quote'

type Fixture = { status: number; delayMs: number; payload: () => unknown; requests: number }
const OPERATORS = ['KRAKEN', 'COINBASE', 'BITSTAMP', 'GEMINI'] as const
type Operator = (typeof OPERATORS)[number]
const ECONOMIC = ['valuation_quotes', 'price_observations', 'trade_limit_policy_versions', 'trade_limit_rail_policies', 'trade_limit_method_policies']

/** Live payload shapes (2026-10-08), at the given price and source age. */
const PAYLOAD: Record<Operator, (price: string, ageMs: number) => unknown> = {
  KRAKEN: (price) => ({ error: [], result: { XXBTZUSD: { a: [price, '1', '1.000'], b: [price, '1', '1.000'], c: [price, '0.0002'] } } }),
  COINBASE: (price, ageMs) => ({ price, time: new Date(Date.now() - ageMs).toISOString().replace('Z', '123456Z') }),
  BITSTAMP: (price, ageMs) => ({ last: price, timestamp: String(Math.floor((Date.now() - ageMs) / 1000)) }),
  GEMINI: (price, ageMs) => ({ last: price, volume: { BTC: '1', timestamp: Date.now() - ageMs } }),
}

describe('#235 R7H-E2 — canonical price authority (real PostgreSQL, local price sources)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  const tag = randomBytes(4).toString('hex')
  const roles = { app: `r7he2_app_${tag}`, collector: `r7he2_col_${tag}` }
  const password = randomBytes(12).toString('hex')
  const servers: Server[] = []
  const fixtures = {} as Record<Operator, Fixture>
  const sources = {} as Record<Operator, PriceSource>
  const pools: Pool[] = []
  const quoteIds = new Set<string>()
  const owned: string[] = []
  let admin: Client
  let appPool: Pool
  let collectorPool: Pool
  let appUrl = ''
  let collectorUrl = ''

  const urlAs = (role: string) => {
    const u = new URL(process.env.DATABASE_URL as string)
    u.username = role
    u.password = password
    return u.toString()
  }
  const pool = (url: string) => {
    const p = new Pool({ connectionString: url, max: 3 })
    pools.push(p)
    return p
  }
  const all = () => OPERATORS.map((o) => sources[o])
  /** Every source answering at `price` (or its own entry in `prices`), fresh. */
  function serve(prices: Partial<Record<Operator, string>> & { all?: string } = {}, ageMs: Partial<Record<Operator, number>> = {}) {
    for (const o of OPERATORS) {
      const price = prices[o] ?? prices.all ?? '82754.90'
      Object.assign(fixtures[o], { status: 200, delayMs: 0, payload: () => PAYLOAD[o](price, ageMs[o] ?? 1_000) })
    }
  }
  const down = (...ops: Operator[]) => ops.forEach((o) => Object.assign(fixtures[o], { status: 503, payload: () => ({ message: 'maintenance' }) }))
  const collect = async (p: Pool = collectorPool, src: PriceSource[] = all(), timeoutMs = 2_000): Promise<CollectOutcome> => {
    const out = await collectAndPublish({ pool: p, sources: src, sourceTimeoutMs: timeoutMs })
    if (out.quoteId) quoteIds.add(out.quoteId)
    return out
  }
  const currentWindowId = async () => {
    const now = new Date((await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t)
    const id = quoteIdFor('BTC', windowStartOf(now, 30))
    quoteIds.add(id)
    return id
  }
  const rows = async (id: string) => Number((await admin.query(`SELECT count(*) AS n FROM valuation_quotes WHERE id = $1`, [id])).rows[0].n)
  const expectDenied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' })

  async function purge() {
    const ids = [...quoteIds]
    await admin.query('BEGIN')
    for (const t of ['exposure_reservations', 'price_observations', 'valuation_quotes']) await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_immutability_guard`)
    await admin.query(`DELETE FROM exposure_reservations WHERE "quoteId" = ANY($1)`, [ids])
    await admin.query(`DELETE FROM price_observations WHERE "quoteId" = ANY($1)`, [ids])
    await admin.query(`DELETE FROM valuation_quotes WHERE id = ANY($1)`, [ids])
    for (const t of ['exposure_reservations', 'price_observations', 'valuation_quotes']) await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER ${t}_immutability_guard`)
    await admin.query('COMMIT')
  }

  /** A seller-bound PIX trade with a new MULTISIG escrow (state fixture, written as the owner). */
  async function escrowFixture() {
    const t = randomBytes(5).toString('hex')
    const [s, b] = [`r7he2-s-${t}`, `r7he2-b-${t}`]
    owned.push(s, b)
    await admin.query(`INSERT INTO users (id, "publicKey", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())`, [s, randomBytes(32).toString('hex'), b, randomBytes(32).toString('hex')])
    await admin.query(`INSERT INTO payment_accounts (id, "ownerId", "accountHash", "paymentMethod", "updatedAt") VALUES ($1, $2, $3, 'PIX', now())`, [`pa-${t}`, s, randomBytes(32).toString('hex')])
    await admin.query(`INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "paymentAccountId", "updatedAt") VALUES ($1, $2, 'BTC', 'SELL', 1, 0.00000001, 100, 'PIX', $3, now())`, [`o-${t}`, s, `pa-${t}`])
    await admin.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt") VALUES ($1, $2, $3, $4, 'BTC', 0.001, 1, 1, 'ACTIVE', $5, now())`, [`t-${t}`, `o-${t}`, b, s, `pa-${t}`])
    await admin.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES ($1, $2, 'MULTISIG', 'CREATED', 0.001, 'BTC', now())`, [`e-${t}`, `t-${t}`])
    return { seller: s, account: `pa-${t}`, trade: `t-${t}`, escrow: `e-${t}` }
  }
  const reserveAs = (p: Pool, f: Awaited<ReturnType<typeof escrowFixture>>, quoteId: string, exposureUsd: string) =>
    p.query(`INSERT INTO exposure_reservations (id, "tradeId", "escrowId", "sellerId", "paymentAccountId", "policyVersionId", "quoteId", "paymentMethod", "escrowType", asset, "assetAmount", "exposureUsd")
             VALUES ($1, $2, $3, $4, $5, 'r7-trade-authorization-policy-v1', $6, 'PIX', 'MULTISIG', 'BTC', 0.001, $7)`, [`r-${randomBytes(5).toString('hex')}`, f.trade, f.escrow, f.seller, f.account, quoteId, exposureUsd])

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    admin = new Client({ connectionString: process.env.DATABASE_URL })
    await admin.connect()
    await admin.query(`CREATE ROLE ${roles.app} LOGIN PASSWORD '${password}' IN ROLE sails_app`)
    await admin.query(`CREATE ROLE ${roles.collector} LOGIN PASSWORD '${password}' IN ROLE sails_quote_collector`)
    appUrl = urlAs(roles.app)
    collectorUrl = urlAs(roles.collector)
    appPool = pool(appUrl)
    collectorPool = pool(collectorUrl)
    const paths: Record<Operator, string> = { KRAKEN: '/0/public/Ticker?pair=XBTUSD', COINBASE: '/products/BTC-USD/ticker', BITSTAMP: '/api/v2/ticker/btcusd/', GEMINI: '/v1/pubticker/btcusd' }
    const real: Record<Operator, PriceSource> = { KRAKEN, COINBASE, BITSTAMP, GEMINI }
    for (const o of OPERATORS) {
      const f: Fixture = { status: 200, delayMs: 0, payload: () => ({}), requests: 0 }
      fixtures[o] = f
      const server = createServer((_req, res: ServerResponse) => {
        f.requests++
        const body = JSON.stringify(f.payload())
        setTimeout(() => { res.statusCode = f.status; res.end(body) }, f.delayMs)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      servers.push(server)
      sources[o] = { ...real[o], url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${paths[o]}` }
    }
  })

  beforeEach(async () => {
    if (!pg.isAvailable()) return
    serve()
    await purge()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await purge()
      await admin.query(`DELETE FROM escrows WHERE "tradeId" IN (SELECT id FROM trades WHERE "sellerId" = ANY($1))`, [owned])
      await admin.query(`DELETE FROM trades WHERE "sellerId" = ANY($1)`, [owned])
      await admin.query(`DELETE FROM offers WHERE "userId" = ANY($1)`, [owned])
      await admin.query(`DELETE FROM payment_accounts WHERE "ownerId" = ANY($1)`, [owned])
      await admin.query(`DELETE FROM users WHERE id = ANY($1)`, [owned])
    } finally {
      for (const p of pools) await Promise.race([p.end().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))])
      for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)) }
      await admin.query(`DROP ROLE IF EXISTS ${roles.app}`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${roles.collector}`).catch(() => undefined)
      await admin.end()
    }
  })

  // ─── roles and grants ─────────────────────────────────────────────────────────────────────────────────────

  it('ROLES: the application role has full DML except on economic evidence; the collector role can only publish; neither owns or bypasses anything', async () => {
    pg.requirePostgres('ROLES')
    const privileges = async (role: string) => (await admin.query(
      `SELECT c.relname AS t, concat_ws(',', CASE WHEN has_table_privilege($1, c.oid, 'SELECT') THEN 'S' END, CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'I' END,
              CASE WHEN has_table_privilege($1, c.oid, 'UPDATE') THEN 'U' END, CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'D' END, CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE') THEN 'T' END) AS p
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`, [role])).rows as Array<{ t: string; p: string }>
    const app = await privileges(roles.app)
    for (const { t, p } of app) {
      const expected = ECONOMIC.includes(t) || t === '_prisma_migrations' ? 'S' : t === 'exposure_reservations' ? 'S,I' : 'S,I,U,D'
      expect([t, p]).toEqual([t, expected])
    }
    expect(app.length).toBeGreaterThan(50)
    const collector = (await privileges(roles.collector)).filter((r) => r.p)
    expect(collector).toEqual([
      { t: 'price_observations', p: 'S,I' }, { t: 'trade_limit_policy_versions', p: 'S' }, { t: 'trade_limit_rail_policies', p: 'S' }, { t: 'valuation_quotes', p: 'S,I' },
    ])
    const attrs = (await admin.query(`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owns FROM pg_roles r WHERE rolname = ANY($1) ORDER BY 1`, [[roles.app, roles.collector, 'sails_app', 'sails_quote_collector']])).rows
    for (const r of attrs) expect([r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.owns]).toEqual([r.rolname, false, false, false, false, 0])
  })

  it('APP CREDENTIAL: cannot publish, fabricate, rewrite or bypass economic evidence — by SQL or through the publisher', async () => {
    pg.requirePostgres('APP')
    const published = await collect()
    expect(published.status).toBe('PUBLISHED')
    const id = published.quoteId as string
    const q = (await admin.query(`SELECT "windowStart"::text AS ws, "asOf"::text AS a FROM valuation_quotes WHERE id = $1`, [id])).rows[0]
    await expectDenied(appPool.query(`INSERT INTO valuation_quotes (id, "policyVersionId", "baseAsset", "windowStart", "asOf", "collectedAt", "priceMaxUsd", "priceMedianUsd", "observationCount", "sourceSpreadBps") VALUES ('BTC:1', 'r7-trade-authorization-policy-v1', 'BTC', $1, $2, $2, 1, 1, 2, 0)`, [q.ws, q.a]))
    await expectDenied(appPool.query(`INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "collectedAt", "payloadSha256") VALUES ('x', $1, 'FAKE', 1, now(), $2)`, [id, '0'.repeat(64)]))
    await expectDenied(appPool.query(`UPDATE valuation_quotes SET "priceMaxUsd" = 1 WHERE id = $1`, [id]))
    await expectDenied(appPool.query(`DELETE FROM price_observations WHERE "quoteId" = $1`, [id]))
    await expectDenied(appPool.query(`TRUNCATE valuation_quotes CASCADE`))
    await expectDenied(appPool.query(`INSERT INTO trade_limit_policy_versions (id, version, label, "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds") VALUES ('x', 99, 'x', 1000000, 1000000, 120, 30, 10, 10000, 2, 60, 15)`))
    await expectDenied(appPool.query(`UPDATE trade_limit_method_policies SET eligible = true`))
    await expectDenied(appPool.query(`ALTER TABLE valuation_quotes DISABLE TRIGGER valuation_quotes_insert_guard`))
    await expectDenied(appPool.query(`SET session_replication_role = replica`))
    expect((await admin.query(`SELECT "priceMaxUsd", "observationCount" FROM valuation_quotes WHERE id = $1`, [id])).rows).toEqual([{ priceMaxUsd: '82754.90000000', observationCount: 3 }])
    // Through the production publisher: refused by the database, nothing written.
    await purge()
    const viaApp = await collect(appPool)
    expect(viaApp).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/permission denied/) })
    expect(await rows(viaApp.quoteId as string)).toBe(0)
    await expect(assertCollectorCredential(appPool, true, { warn: jest.fn() } as any)).rejects.toThrow(/cannot publish quotes/)
  })

  it('APP CREDENTIAL: ordinary application work still runs (users, accounts, offers, trades, escrows, lifecycle updates, reads)', async () => {
    pg.requirePostgres('APP-WORK')
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: appUrl }) })
    try {
      const t = randomBytes(5).toString('hex')
      const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7he2-app-s-${t}` } })
      const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7he2-app-b-${t}` } })
      owned.push(seller.id, buyer.id)
      const account = await prisma.paymentAccount.create({ data: { ownerId: seller.id, accountHash: randomBytes(32).toString('hex'), paymentMethod: 'PIX' } })
      const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '82000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX', paymentAccountId: account.id } })
      const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '82000', totalUsd: '82', sellerPaymentAccountId: account.id } })
      const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' } })
      await prisma.trade.update({ where: { id: trade.id }, data: { status: 'ACTIVE', escrowId: escrow.id } })
      await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'FUNDS_LOCKED', txLockId: 'ab'.repeat(32), txLockVout: 0 } })
      await prisma.paymentAccount.update({ where: { id: account.id }, data: { completedTrades: { increment: 1 } } })
      expect(await prisma.escrow.count({ where: { id: escrow.id, status: 'FUNDS_LOCKED' } })).toBe(1)
      expect(await prisma.valuationQuote.count()).toBeGreaterThanOrEqual(0) // reads economic evidence
      expect(await prisma.tradeLimitPolicyVersion.count({ where: { version: 1 } })).toBe(1)
    } finally {
      await prisma.$disconnect()
    }
  })

  // ─── publication ──────────────────────────────────────────────────────────────────────────────────────────

  it('PUBLISH: the collector credential publishes one complete quote at the conservative max, observations named by operator with payload digests; it can do nothing else', async () => {
    pg.requirePostgres('PUBLISH')
    await assertCollectorCredential(collectorPool, true, { warn: jest.fn() } as any)
    serve({ KRAKEN: '82754.90', COINBASE: '82752.62', BITSTAMP: '82756.43', GEMINI: '82774.56' })
    const out = await collect()
    expect(out).toMatchObject({ status: 'PUBLISHED', accepted: ['COINBASE', 'KRAKEN', 'BITSTAMP'], excluded: [], failures: [] })
    const q = (await admin.query(`SELECT * FROM valuation_quotes WHERE id = $1`, [out.quoteId])).rows[0]
    expect([q.priceMaxUsd, q.priceMedianUsd, q.observationCount, q.sourceSpreadBps, q.policyVersionId]).toEqual(['82756.43000000', '82754.90000000', 3, 1, 'r7-trade-authorization-policy-v1'])
    const o = (await admin.query(`SELECT id, operator, "priceUsd", "sourceTimestamp" IS NULL AS "noTs", "payloadSha256" FROM price_observations WHERE "quoteId" = $1 ORDER BY operator`, [out.quoteId])).rows
    expect(o.map((r) => [r.id, r.operator, r.priceUsd, r.noTs])).toEqual([
      [`${out.quoteId}:BITSTAMP`, 'BITSTAMP', '82756.43000000', false], [`${out.quoteId}:COINBASE`, 'COINBASE', '82752.62000000', false], [`${out.quoteId}:KRAKEN`, 'KRAKEN', '82754.90000000', true],
    ])
    expect(o.every((r) => /^[0-9a-f]{64}$/.test(r.payloadSha256))).toBe(true)
    // The reserve was not needed and is not part of the quote.
    expect(o.some((r) => r.operator === 'GEMINI')).toBe(false)
    // The collector credential cannot rewrite evidence or touch anything else.
    await expectDenied(collectorPool.query(`UPDATE valuation_quotes SET "priceMaxUsd" = 1 WHERE id = $1`, [out.quoteId]))
    await expectDenied(collectorPool.query(`DELETE FROM price_observations WHERE "quoteId" = $1`, [out.quoteId]))
    await expectDenied(collectorPool.query(`SELECT 1 FROM trades LIMIT 1`))
    await expectDenied(collectorPool.query(`INSERT INTO exposure_reservations (id) VALUES ('x')`))
    await expectDenied(collectorPool.query(`INSERT INTO trade_limit_policy_versions (id) VALUES ('x')`))
    // A superuser credential is refused as the collector in production (strict), warned about otherwise.
    const su = pool(process.env.DATABASE_URL as string)
    await expect(assertCollectorCredential(su, true, { warn: jest.fn() } as any)).rejects.toThrow(/over-privileged \(superuser, owner, rewrite, application\)/)
    const warn = jest.fn()
    await assertCollectorCredential(su, false, { warn } as any)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringMatching(/over-privileged/) }))
  })

  it('ADVERSARIAL — extreme price: excluded and reported, never dominating; the quote max comes from the agreeing set', async () => {
    pg.requirePostgres('EXTREME')
    serve({ KRAKEN: '82754.90', COINBASE: '165509.80', BITSTAMP: '82756.43' })
    const out = await collect()
    expect(out).toMatchObject({ status: 'PUBLISHED', accepted: ['KRAKEN', 'BITSTAMP'], excluded: [{ operator: 'COINBASE', reason: 'OUTSIDE_AGREEMENT', price: '165509.8' }] })
    const q = (await admin.query(`SELECT "priceMaxUsd", "observationCount" FROM valuation_quotes WHERE id = $1`, [out.quoteId])).rows[0]
    expect(q).toEqual({ priceMaxUsd: '82756.43000000', observationCount: 2 })
  })

  it('ADVERSARIAL — disagreement beyond 1 %: no quote; the window stays empty', async () => {
    pg.requirePostgres('DISAGREE')
    serve({ KRAKEN: '80000', COINBASE: '82000', BITSTAMP: '84000', GEMINI: '86000' })
    const out = await collect()
    expect(out).toMatchObject({ status: 'REFUSED', reason: 'INSUFFICIENT_AGREEMENT' })
    expect(await rows(out.quoteId as string)).toBe(0)
  })

  it('ADVERSARIAL — stale sources cannot make a quote eligible; a fresh reserve can complete an agreeing set, a stale one cannot', async () => {
    pg.requirePostgres('STALE')
    serve({}, { COINBASE: 300_000, BITSTAMP: 300_000, GEMINI: 300_000 })
    const out = await collect()
    expect(out).toMatchObject({ status: 'REFUSED' })
    expect(out.excluded?.filter((e) => e.reason === 'STALE_SOURCE_TIMESTAMP').map((e) => e.operator).sort()).toEqual(['BITSTAMP', 'COINBASE', 'GEMINI'])
    expect(await rows(out.quoteId as string)).toBe(0)
    serve({}, { COINBASE: 300_000, BITSTAMP: 300_000, GEMINI: 2_000 })
    const viaReserve = await collect()
    expect(viaReserve).toMatchObject({ status: 'PUBLISHED', accepted: ['GEMINI', 'KRAKEN'].sort() })
  })

  it('ADVERSARIAL — duplicated identities: an aliased or repeated operator is refused before any source is queried; the database rejects a repeated operator too', async () => {
    pg.requirePostgres('DUPLICATE')
    const before = OPERATORS.map((o) => fixtures[o].requests)
    await expect(collect(collectorPool, [sources.KRAKEN, { ...sources.KRAKEN, operator: 'KRAKEN_PRO' }, sources.BITSTAMP])).rejects.toThrow(/share the endpoint host/)
    await expect(collect(collectorPool, [sources.KRAKEN, { ...sources.BITSTAMP, operator: 'KRAKEN' }])).rejects.toThrow(/listed twice/)
    expect(OPERATORS.map((o) => fixtures[o].requests)).toEqual(before)
    const id = await currentWindowId()
    expect(await rows(id)).toBe(0)
    // Two observations under one operator in one quote, written straight by the collector credential: refused.
    const t = new Date((await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t)
    quoteIds.add(quoteIdFor('BTC', windowStartOf(t, 30)))
    await expect(publishCanonicalQuote(collectorPool, {
      policyVersionId: 'r7-trade-authorization-policy-v1', asset: 'BTC', windowStart: windowStartOf(t, 30), asOf: t, collectedAt: t,
      summary: { priceMaxUsd: '82754.90000000', priceMedianUsd: '82754.90000000', observationCount: 2, sourceSpreadBps: 0 },
      observations: [1, 2].map(() => ({ operator: 'KRAKEN', price: new Prisma.Decimal('82754.9'), sourceTimestamp: t, collectedAt: t, payloadSha256: '0'.repeat(64) })),
    })).rejects.toMatchObject({ code: '23505' })
    expect(await rows(quoteIdFor('BTC', windowStartOf(t, 30)))).toBe(0)
  })

  it('OUTAGE — sources down, malformed or timing out: no quote, authorization fails closed; existing escrows keep settling under the application credential', async () => {
    pg.requirePostgres('OUTAGE')
    Object.assign(fixtures.KRAKEN, { payload: () => ({ error: [], result: { XXBTZUSD: { c: [82754.9, '1'] } } }) }) // JSON number: malformed
    down('COINBASE', 'GEMINI')
    Object.assign(fixtures.BITSTAMP, { delayMs: 1_500 }) // beyond the 500 ms source timeout below
    const out = await collect(collectorPool, all(), 500)
    expect(out).toMatchObject({ status: 'REFUSED', reason: 'INSUFFICIENT_AGREEMENT' })
    expect(out.failures?.map((f) => f.operator).sort()).toEqual(['BITSTAMP', 'COINBASE', 'GEMINI', 'KRAKEN'])
    expect(out.failures?.find((f) => f.operator === 'BITSTAMP')?.reason).toMatch(/timed out/)
    expect(out.failures?.find((f) => f.operator === 'KRAKEN')?.reason).toMatch(/decimal string/)
    expect(await rows(out.quoteId as string)).toBe(0)
    // New authorization: no usable quote, and the database refuses a reservation without one.
    expect(await readAuthorizationQuote(appPool)).toBeNull()
    const f = await escrowFixture()
    await expect(reserveAs(appPool, f, out.quoteId as string, '82.76')).rejects.toMatchObject({ code: '23000' })
    // Existing escrow lifecycle (funding, release) is untouched by the outage.
    await appPool.query(`UPDATE escrows SET status = 'FUNDS_LOCKED', "txLockId" = $2, "txLockVout" = 0 WHERE id = $1`, [f.escrow, 'cd'.repeat(32)])
    await appPool.query(`UPDATE escrows SET status = 'COMPLETED', "txReleaseId" = $2 WHERE id = $1`, [f.escrow, 'ef'.repeat(32)])
    expect((await admin.query(`SELECT status::text FROM escrows WHERE id = $1`, [f.escrow])).rows[0].status).toBe('COMPLETED')
  })

  it('OUTAGE — no settlement, dispute or recovery code depends on the price authority (static)', () => {
    const root = join(__dirname, '../../src')
    const files: string[] = []
    const walk = (d: string) => readdirSync(d).forEach((n) => { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p) })
    walk(root)
    const outside = files.filter((f) => !relative(root, f).startsWith('modules' + require('path').sep + 'open-valuation'))
    const importers = outside.filter((f) => /from '[^']*open-valuation\//.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).replace(/\\/g, '/'))
    expect(importers).toEqual(['app.ts'])
    const readers = outside.filter((f) => /valuation_quotes|price_observations|valuationQuote|priceObservation/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).replace(/\\/g, '/'))
    expect(readers).toEqual(['app.ts']) // the startup separation check only
  })

  it('RETRY / RESTART: a refused window is published by the next collection once sources recover; a new collector instance continues idempotently', async () => {
    pg.requirePostgres('RETRY')
    down('KRAKEN', 'COINBASE', 'BITSTAMP', 'GEMINI')
    expect((await collect()).status).toBe('REFUSED')
    serve()
    const restarted = pool(collectorUrl)
    const out = await collect(restarted)
    expect(out.status).toBe('PUBLISHED')
    const again = await collect(pool(collectorUrl))
    // Same window: nothing to do. (Only if the 30 s window rolled over between the two calls is it a new publication.)
    expect(again).toEqual(again.quoteId === out.quoteId ? { status: 'ALREADY_PUBLISHED', quoteId: out.quoteId } : expect.objectContaining({ status: 'PUBLISHED' }))
    expect(OPERATORS.reduce((n, o) => n + fixtures[o].requests, 0)).toBeGreaterThan(0)
  })

  it('LATE: sources answering after the publication bound (10 s, 1 s margin) publish nothing', async () => {
    pg.requirePostgres('LATE')
    for (const o of OPERATORS) fixtures[o].delayMs = 9_200
    const out = await collect(collectorPool, all(), 9_800)
    expect(out).toMatchObject({ status: 'LATE' })
    expect(await rows(out.quoteId as string)).toBe(0)
  })

  // ─── concurrency and crashes ──────────────────────────────────────────────────────────────────────────────

  it('CONCURRENCY: six collectors (own pools) racing one window publish exactly one complete quote; every loser yields, none overwrites', async () => {
    pg.requirePostgres('CONCURRENCY')
    let n = 0
    for (const o of OPERATORS) Object.assign(fixtures[o], { delayMs: 300, payload: () => PAYLOAD[o]((82750 + (n++ % 7)).toFixed(2), 1_000) })
    const outs = await Promise.all(Array.from({ length: 6 }, () => collect(pool(collectorUrl))))
    const statuses = outs.map((o) => o.status).sort()
    expect(statuses.filter((s) => s === 'PUBLISHED')).toHaveLength(1)
    expect(statuses.every((s) => ['PUBLISHED', 'LOST_RACE', 'ALREADY_PUBLISHED'].includes(s))).toBe(true)
    const winner = outs.find((o) => o.status === 'PUBLISHED') as CollectOutcome
    const q = (await admin.query(`SELECT "priceMaxUsd", "observationCount", (SELECT max("priceUsd") FROM price_observations WHERE "quoteId" = $1) AS m, (SELECT count(*)::int FROM price_observations WHERE "quoteId" = $1) AS c FROM valuation_quotes WHERE id = $1`, [winner.quoteId])).rows[0]
    expect([q.priceMaxUsd, q.observationCount]).toEqual([q.m, q.c])
    expect(q.c).toBe(winner.accepted?.length)
    expect(Number((await admin.query(`SELECT count(*) AS n FROM valuation_quotes WHERE id = $1`, [winner.quoteId])).rows[0].n)).toBe(1)
  })

  it('CRASH: a connection killed mid-publication leaves no quote at all; a restarted collector publishes the window', async () => {
    pg.requirePostgres('CRASH')
    // The publisher's transaction client terminates its own backend (as a crash would) right before the second
    // observation; everything else goes through the real pool.
    const real = pool(collectorUrl)
    real.on('error', () => undefined)
    const crashing = { query: real.query.bind(real), connect: async () => {
      const client: PoolClient = await real.connect()
      client.on('error', () => undefined) // its backend is about to be terminated
      const query = client.query.bind(client) as (...a: any[]) => any
      let observations = 0
      ;(client as any).query = async (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO price_observations') && ++observations === 2) {
          await admin.query('SELECT pg_terminate_backend($1)', [(client as any).processID])
        }
        return query(...args)
      }
      return client
    } } as unknown as Pool
    const out = await collect(crashing)
    expect(out).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/terminat|connection error/i) })
    expect(await rows(out.quoteId as string)).toBe(0)
    expect(Number((await admin.query(`SELECT count(*) AS n FROM price_observations WHERE "quoteId" = $1`, [out.quoteId])).rows[0].n)).toBe(0)
    const restarted = await collect(pool(collectorUrl))
    expect(restarted.status).toBe('PUBLISHED')
  })

  it('CRASH: the database unreachable at publication (after the sources answered) writes nothing; the next collection publishes', async () => {
    pg.requirePostgres('CRASH2')
    const real = pool(collectorUrl)
    const broken = { query: real.query.bind(real), connect: async () => { throw new Error('connection refused (simulated)') } } as unknown as Pool
    const out = await collect(broken)
    expect(out).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/connection refused/) })
    expect(await rows(out.quoteId as string)).toBe(0)
    expect((await collect()).status).toBe('PUBLISHED')
  })

  // ─── authorization boundary ───────────────────────────────────────────────────────────────────────────────

  it('NEWEST: an older valid quote is never the authorization quote once a newer canonical quote exists; a stale newest quote authorizes nothing', async () => {
    pg.requirePostgres('NEWEST')
    // An older, cheaper quote (previous window), planted as history with the publication-time guards lifted.
    const guards: Array<[string, string]> = [['valuation_quotes', 'valuation_quotes_insert_guard'], ['valuation_quotes', 'valuation_quotes_completeness_guard'], ['price_observations', 'price_observations_completeness_guard']]
    const t = new Date((await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC' - interval '40 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t)
    const older = quoteIdFor('BTC', windowStartOf(t, 30))
    quoteIds.add(older)
    const utc = (d: Date) => d.toISOString().slice(0, 23)
    await admin.query('BEGIN')
    for (const [tb, g] of guards) await admin.query(`ALTER TABLE ${tb} DISABLE TRIGGER ${g}`)
    await admin.query(`INSERT INTO valuation_quotes (id, "policyVersionId", "baseAsset", "windowStart", "asOf", "collectedAt", "priceMaxUsd", "priceMedianUsd", "observationCount", "sourceSpreadBps")
                       VALUES ($1, 'r7-trade-authorization-policy-v1', 'BTC', $2, $3, $3, 40000, 40000, 2, 0)`, [older, utc(windowStartOf(t, 30)), utc(t)])
    for (const op of ['KRAKEN', 'COINBASE']) {
      await admin.query(`INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ($1, $2, $3, 40000, $4, $4, $5)`, [`${older}:${op}`, older, op, utc(t), '0'.repeat(64)])
    }
    for (const [tb, g] of guards) await admin.query(`ALTER TABLE ${tb} ENABLE TRIGGER ${g}`)
    await admin.query('COMMIT')
    expect(await rows(older)).toBe(1)
    expect(await readAuthorizationQuote(appPool)).toMatchObject({ id: older, priceMaxUsd: '40000.00000000' })
    const out = await collect()
    expect(out.status).toBe('PUBLISHED')
    expect(await readAuthorizationQuote(appPool)).toMatchObject({ id: out.quoteId, priceMaxUsd: '82754.90000000' })
    // The database agrees: a reservation on the older quote is refused, on the newest accepted.
    const f = await escrowFixture()
    await expect(reserveAs(appPool, f, older, '40.00')).rejects.toMatchObject({ code: '23000' })
    await reserveAs(appPool, f, out.quoteId as string, '82.76')
    expect(Number((await admin.query(`SELECT count(*) AS n FROM exposure_reservations WHERE "tradeId" = $1`, [f.trade])).rows[0].n)).toBe(1)
  })
})
