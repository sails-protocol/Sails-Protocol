// tests/integration/tradeClaimReconciliation.test.ts
//
// #235 R7H-NF-E3C-5 (B2, Gate C corrective) — legacy `openp2p.trade.create` idempotency claims are OBSERVED, never
// attributed. Real PostgreSQL, real routes.
//
// CTO FREEZE: a legacy IN_PROGRESS claim never becomes COMPLETED merely because a trade matches participant, payload
// hash and timestamp. Correlation is not causation. These tests replace the earlier ones that expected an inferred
// MATCHED; they are the independent audit's C1-C7 reproductions turned into enforcement:
//   C1 a claim cannot steal another claim's trade        C5 forced interleaving: no double attribution
//   C2 a claim cannot claim a keyless trade              C6 window / amount-rendering boundaries, strongest correlation
//   C3 a maker's claim cannot claim a taker's trade      C7 the session time zone cannot change authority
//   C4 natural concurrency: no double attribution
// plus: no inferred MATCHED is possible (code AND database), uncertainty is never FAILED, a replay never creates a
// second trade, and what is exposed is caller-scoped and explicitly non-authoritative.
//
// The legacy world is built by direct inserts (the shape the pre-B2 code left behind): a trade row without
// tradeIntentId, and a claim row left IN_PROGRESS, with an explicit UTC createdAt (what the Prisma client wrote).

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { type Party, participant, boundSellOffer, takeOffer, call, cleanupFixtures } from './tradeIntentFixtures'

/** Session time zones the reconciliation path is exercised under: UTC, west, east, half-hour and the extremes. */
const SESSION_ZONES = ['UTC', 'America/Sao_Paulo', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Etc/GMT+12'] as const

describe('#235 R7H-NF-E3C-5 B2 Gate C — legacy claims are observed, never attributed (real PostgreSQL)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let rec: typeof import('../../src/modules/open-p2p/trade-claim-reconciliation')
  let hashIdempotentPayload: (p: unknown) => string
  const zoned: Record<string, PrismaClient> = {}
  const users: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    rec = require('../../src/modules/open-p2p/trade-claim-reconciliation')
    ;({ hashIdempotentPayload } = require('../../src/common/idempotency'))
    app = await require('../../src/app').buildApp({ registerSwaggerUi: false })
    await app.ready()
    // One real connection pool per session time zone (the pool's startup option, not a SET on a random connection).
    for (const tz of SESSION_ZONES) {
      zoned[tz] = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c TimeZone=${tz}` }) })
    }
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await prisma.$executeRaw`ALTER TABLE idempotency_reconciliation_audit DISABLE TRIGGER idempotency_reconciliation_audit_append_only`
      await prisma.$executeRaw`DELETE FROM idempotency_reconciliation_audit WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`ALTER TABLE idempotency_reconciliation_audit ENABLE TRIGGER idempotency_reconciliation_audit_append_only`
      await cleanupFixtures(prisma, users)
    } finally {
      await Promise.all(Object.values(zoned).map((c) => c.$disconnect()))
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  const who = async (label: string): Promise<Party> => { const p = await participant(label); users.push(p.id); return p }
  const ago = (ms: number) => new Date(Date.now() - ms)
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
  const UNKNOWN = [409, 'IDEMPOTENCY_OUTCOME_UNKNOWN']
  const brief = (r: { statusCode: number; body: string }) => [r.statusCode, JSON.parse(r.body).error]
  const bodyOf = (r: { body: string }) => JSON.parse(r.body)

  async function world(label: string) {
    const seller = await who(`${label}-s`)
    const { offer, account } = await boundSellOffer(seller)
    const taker = await who(`${label}-t`)
    return { seller, offer, account, taker }
  }

  /** A legacy trade: the row the pre-B2 service committed (no tradeIntentId), taken by `takerId` from `offer`. */
  async function legacyTrade(offer: { id: string; userId: string; intentId: string }, takerId: string, accountId: string, amount = '0.0005', createdAt: Date = new Date()) {
    return prisma.trade.create({
      data: {
        offerId: offer.id, buyerId: takerId, sellerId: offer.userId, asset: 'BTC', amount, priceUsd: '65000', totalUsd: '32.5',
        intentId: offer.intentId, sellerPaymentAccountId: accountId, createdAt,
      },
    })
  }

  /** A claim an old-code request left behind, with an explicit UTC `createdAt` (what the Prisma client wrote). */
  async function legacyClaim(ownerId: string, offerId: string, requestAmount: string, createdAt: Date, status = 'IN_PROGRESS', resultRef: string | null = null) {
    const id = randomUUID()
    const key = 'lk-' + id.slice(0, 12)
    await prisma.$executeRaw`
      INSERT INTO idempotency_keys (id, scope, "participantId", key, "requestHash", status, "resultRef", "createdAt")
      VALUES (${id}, 'openp2p.trade.create', ${ownerId}, ${key}, ${hashIdempotentPayload({ offerId, amount: requestAmount })},
              ${status}::"IdempotencyKeyStatus", ${resultRef}, ${createdAt})`
    return { id, key }
  }

  const claimRow = async (id: string) => (await prisma.$queryRaw<Array<{ status: string; resultRef: string | null; completedAt: Date | null }>>`
    SELECT status::text AS status, "resultRef", "completedAt" FROM idempotency_keys WHERE id = ${id}`)[0]
  /** The claim is exactly as the old code left it: not COMPLETED, not FAILED, no result, no completion time. */
  const expectUntouched = async (id: string) => expect(await claimRow(id)).toEqual({ status: 'IN_PROGRESS', resultRef: null, completedAt: null })
  const referencing = async (tradeId: string) => (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM idempotency_keys WHERE "resultRef" = ${tradeId}`)[0].n
  const auditRows = (claimId: string) => prisma.$queryRaw<Array<{ decision: string; candidateTradeIds: string[]; decidedBy: string; evidence: any }>>`
    SELECT decision, "candidateTradeIds", "decidedBy", evidence FROM idempotency_reconciliation_audit WHERE "claimId" = ${claimId} ORDER BY "decidedAt"`
  const tradeCount = (offerId: string) => prisma.trade.count({ where: { offerId } })
  const replay = (p: Party, offerId: string, key: string, amount = '0.0005') =>
    call(app, p, 'POST', '/v1/openp2p/trades', { offerId, amount, idempotencyKey: key })

  // ─── C1: a claim cannot steal another claim's trade ───────────────────────────────────────────────────

  it('C1 — a claim cannot steal another claim\'s trade: two claims of the same shape, one trade; neither is resolved', async () => {
    pg.requirePostgres('GC-C1')
    const { offer, account, taker } = await world('c1')
    const t0 = ago(10 * 60_000)
    const k1 = await legacyClaim(taker.id, offer.id, '0.0005', t0)                       // request 1: died BEFORE creating anything
    const k2 = await legacyClaim(taker.id, offer.id, '0.0005', plus(t0, 2_000))          // request 2 (a new key): its trade is T
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 2_050))

    for (const k of [k1, k2]) expect((await rec.observeLegacyTradeClaim(k.id, 'audit')).decision).toBe('UNRESOLVED')
    await expectUntouched(k1.id)
    await expectUntouched(k2.id)
    expect(await referencing(T.id)).toBe(0)                                              // T belongs to no claim at all
    for (const k of [k1, k2]) expect(brief(await replay(taker, offer.id, k.key))).toEqual(UNKNOWN)
    expect(await tradeCount(offer.id)).toBe(1)                                           // and replaying created nothing
    await expectUntouched(k1.id)
    await expectUntouched(k2.id)
  })

  it('C1b — a trade durably referenced by another claim is that claim\'s and is never offered to a different one', async () => {
    pg.requirePostgres('GC-C1b')
    const { offer, account, taker } = await world('c1b')
    const t0 = ago(10 * 60_000)
    const stuck = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 2_050))
    // The OLD code settled the second claim itself: its own `resultRef` IS durable causal evidence — for that claim only.
    const settled = await legacyClaim(taker.id, offer.id, '0.0005', plus(t0, 2_000), 'COMPLETED', T.id)

    const outcome = await rec.observeLegacyTradeClaim(stuck.id, 'audit')
    expect([outcome.decision, outcome.unverifiedCandidateTradeIds]).toEqual(['UNRESOLVED', []])
    await expectUntouched(stuck.id)
    expect(await claimRow(settled.id)).toMatchObject({ status: 'COMPLETED', resultRef: T.id })
    expect(await referencing(T.id)).toBe(1)                                              // still exactly the one claim
    expect(brief(await replay(taker, offer.id, stuck.key))).toEqual(UNKNOWN)
    const own = await replay(taker, offer.id, settled.key)                               // the durable link IS honoured
    expect([own.statusCode, bodyOf(own).data.id]).toEqual([201, T.id])
  })

  // ─── C2: a claim cannot claim a keyless trade ─────────────────────────────────────────────────────────

  it('C2 — a claim cannot claim a keyless trade: it is at most an unverified hint', async () => {
    pg.requirePostgres('GC-C2')
    const { offer, account, taker } = await world('c2')
    const t0 = ago(10 * 60_000)
    const k = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const keyless = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 5_000)) // a request with no key: no claim exists for it

    const outcome = await rec.observeLegacyTradeClaim(k.id, 'audit')
    expect(outcome).toEqual({ claimId: k.id, decision: 'UNRESOLVED', unverifiedCandidateTradeIds: [keyless.id] })
    await expectUntouched(k.id)
    expect(await referencing(keyless.id)).toBe(0)
    const res = await replay(taker, offer.id, k.key)
    expect(brief(res)).toEqual(UNKNOWN)
    expect(bodyOf(res).details).toEqual({ authoritative: false, unverifiedCandidateTradeIds: [keyless.id] })
    expect(await tradeCount(offer.id)).toBe(1)
  })

  // ─── C3: a maker's claim cannot claim a taker's trade ─────────────────────────────────────────────────

  it('C3 — a maker\'s claim cannot claim a taker\'s trade, and the taker\'s trade is not even a hint', async () => {
    pg.requirePostgres('GC-C3')
    const { offer, account, seller: maker } = await world('c3')
    const taker = await who('c3-q')
    const t0 = ago(10 * 60_000)
    const k = await legacyClaim(maker.id, offer.id, '0.0005', t0)                         // a claim by the offer's OWN maker...
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 1_000))   // ...and somebody else's trade on that offer

    const outcome = await rec.observeLegacyTradeClaim(k.id, 'audit')
    expect([outcome.decision, outcome.unverifiedCandidateTradeIds]).toEqual(['UNRESOLVED', []])
    await expectUntouched(k.id)
    expect(await referencing(T.id)).toBe(0)
    const res = await replay(maker, offer.id, k.key)
    expect(brief(res)).toEqual(UNKNOWN)
    expect(bodyOf(res).details).toEqual({ authoritative: false, unverifiedCandidateTradeIds: [] })
    expect(res.body).not.toContain(taker.id)                                              // nothing about the other participant
    expect(res.body).not.toContain(T.id)
  })

  // ─── C4 / C5: concurrent workers cannot produce double attribution ────────────────────────────────────

  it('C4 — natural concurrency: workers racing on same-shape claims never attribute, never duplicate', async () => {
    pg.requirePostgres('GC-C4')
    const { offer, account, taker } = await world('c4')
    const base = ago(6 * 3_600_000)
    const claims: string[] = []
    const trades: string[] = []
    for (let i = 0; i < 20; i++) {
      const t = plus(base, i * 120_000)
      const k1 = await legacyClaim(taker.id, offer.id, '0.0005', t)
      const k2 = await legacyClaim(taker.id, offer.id, '0.0005', plus(t, 1))
      const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t, 50))
      claims.push(k1.id, k2.id)
      trades.push(T.id)
      const out = await Promise.all([
        rec.observeLegacyTradeClaim(k1.id, 'worker-a'), rec.observeLegacyTradeClaim(k2.id, 'worker-b'), rec.observeLegacyTradeClaim(k1.id, 'worker-c'),
      ])
      expect(out.map((o) => o.decision)).toEqual(['UNRESOLVED', 'UNRESOLVED', 'UNRESOLVED'])
    }
    for (const id of claims) {
      await expectUntouched(id)
      expect(await auditRows(id)).toHaveLength(1)                                        // exactly one observation per claim
    }
    for (const id of trades) expect(await referencing(id)).toBe(0)                       // no trade was attributed — to anyone
    expect(await tradeCount(offer.id)).toBe(20)
  })

  it('C5 — forced interleaving: two observers of one claim both reach the audit insert before either lands', async () => {
    pg.requirePostgres('GC-C5')
    const { offer, account, taker } = await world('c5')
    const t0 = ago(10 * 60_000)
    const k = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 50))
    const original = prisma.$executeRaw.bind(prisma) as (...a: any[]) => Promise<number>
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation(((strings: any, ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : ''
      if (!sql.includes('idempotency_reconciliation_audit')) return original(strings, ...values)
      if (++arrived === 2) release()
      return Promise.race([gate, new Promise((r) => setTimeout(r, 5_000))]).then(() => original(strings, ...values))
    }) as any)
    let out: any[]
    try {
      out = await Promise.all([rec.observeLegacyTradeClaim(k.id, 'worker-a'), rec.observeLegacyTradeClaim(k.id, 'worker-b')])
    } finally { spy.mockRestore() }
    expect(arrived).toBe(2)                                                              // both really were at the insert together
    expect(out.map((o) => o.decision)).toEqual(['UNRESOLVED', 'UNRESOLVED'])             // and neither failed
    expect(await auditRows(k.id)).toHaveLength(1)                                        // the database let exactly one land
    await expectUntouched(k.id)
    expect(await referencing(T.id)).toBe(0)
  })

  // ─── C6: boundaries, and the strongest correlation there is ───────────────────────────────────────────

  it('C6 — no correlation, however strong or weak, resolves a claim: window and amount-rendering boundaries', async () => {
    pg.requirePostgres('GC-C6')
    const { offer, account, taker } = await world('c6')
    const base = ago(2 * 86_400_000)
    // [label, claim payload amount, trade stored amount, trade offset after the claim (ms), inside the hint window?]
    const cases: Array<[string, string, string, number, boolean]> = [
      ['the strongest correlation: one trade, identical payload, 50 ms after the claim', '0.0005', '0.0005', 50, true],
      ['29.9 s after the claim', '0.0005', '0.0005', 29_900, true],
      ['30.5 s after the claim', '0.0005', '0.0005', 30_500, false],
      ['1 ms BEFORE the claim', '0.0005', '0.0005', -1, false],
      ['payload rendered "0.00050000" (the stored form)', '0.00050000', '0.0005', 10, true],
      ['payload rendered "0.00050"', '0.00050', '0.0005', 10, true],
      ['payload rendered "5e-4"', '5e-4', '0.0005', 10, true],
      ['payload "0.000500001", amount rounded by the store', '0.000500001', '0.000500001', 10, true],
    ]
    for (const [i, [label, claimAmount, tradeAmount, offsetMs, inWindow]] of cases.entries()) {
      const t = plus(base, i * 600_000)
      const k = await legacyClaim(taker.id, offer.id, claimAmount, t)
      const T = await legacyTrade(offer, taker.id, account.id, tradeAmount, plus(t, offsetMs))
      const outcome = await rec.observeLegacyTradeClaim(k.id, 'audit')
      expect([label, outcome.decision, outcome.unverifiedCandidateTradeIds]).toEqual([label, 'UNRESOLVED', inWindow ? [T.id] : []])
      await expectUntouched(k.id)
      expect([label, await referencing(T.id)]).toEqual([label, 0])
    }
    // The strongest case through the real route: still 409, still no trade, still not completed.
    const k = await legacyClaim(taker.id, offer.id, '0.0005', ago(30 * 60_000))
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(ago(30 * 60_000), 50))
    const before = await tradeCount(offer.id)
    expect(brief(await replay(taker, offer.id, k.key))).toEqual(UNKNOWN)
    expect(await tradeCount(offer.id)).toBe(before)
    await expectUntouched(k.id)
    expect(await referencing(T.id)).toBe(0)
  })

  // ─── C7: the session time zone cannot change reconciliation authority ─────────────────────────────────

  it('C7 — the session time zone cannot change what is observed, recorded or gated (five real session zones)', async () => {
    pg.requirePostgres('GC-C7')
    const { offer, account, taker } = await world('c7')
    const base = ago(8 * 3_600_000)
    const hintsByZone: Record<string, string[]> = {}
    for (const [i, tz] of SESSION_ZONES.entries()) {
      const client = zoned[tz]
      const [session] = await client.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`
      expect(session.tz).toBe(tz)                                                        // the session REALLY is in that zone

      // Prisma-convention rows (UTC wall clock): a claim and, 1 s later, a legacy trade.
      const t = plus(base, i * 600_000)
      const k = await legacyClaim(taker.id, offer.id, '0.0005', t)
      const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t, 1_000))
      const outcome = await rec.observeLegacyTradeClaim(k.id, `tz:${tz}`, client)
      expect(outcome.decision).toBe('UNRESOLVED')
      hintsByZone[tz] = outcome.unverifiedCandidateTradeIds.map((id) => (id === T.id ? 'T' : id))
      await expectUntouched(k.id)
      expect(await referencing(T.id)).toBe(0)

      // The audit timestamp is the UTC clock, whatever the session zone (a session-local now() is hours off here).
      const [skew] = await prisma.$queryRaw<Array<{ s: number }>>`
        SELECT abs(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - "decidedAt")))::float8 AS s
        FROM idempotency_reconciliation_audit WHERE "claimId" = ${k.id}`
      expect(skew.s).toBeLessThan(120)

      // The bulk age gate runs on the database's UTC clock: a claim written just now is never "old", an old one always is.
      const fresh = await legacyClaim(taker.id, offer.id, '0.0007', new Date())
      const old = await legacyClaim(taker.id, offer.id, '0.0009', ago(2 * 3_600_000))
      const done = (await rec.observeLegacyTradeClaims({ olderThanMs: 60_000, limit: 1000, observedBy: `bulk:${tz}` }, client)).map((o) => o.claimId)
      expect([tz, done.includes(old.id), done.includes(fresh.id)]).toEqual([tz, true, false])
      await expectUntouched(fresh.id)
      await expectUntouched(old.id)
    }
    for (const tz of SESSION_ZONES) expect(hintsByZone[tz]).toEqual(['T'])               // identical in every zone

    // A claim written with the DATABASE default createdAt in a non-UTC session carries a session-local wall clock. It
    // may shift which hints appear; it can never resolve anything.
    const skewed = randomUUID()
    await zoned['Pacific/Kiritimati'].$executeRaw`
      INSERT INTO idempotency_keys (id, scope, "participantId", key, "requestHash")
      VALUES (${skewed}, 'openp2p.trade.create', ${taker.id}, ${'sk-' + skewed.slice(0, 8)}, ${hashIdempotentPayload({ offerId: offer.id, amount: '0.0005' })})`
    for (const tz of SESSION_ZONES) {
      expect((await rec.observeLegacyTradeClaim(skewed, `tz:${tz}`, zoned[tz])).decision).toBe('UNRESOLVED')
    }
    await expectUntouched(skewed)
    expect(await auditRows(skewed)).toHaveLength(1)
    expect(brief(await replay(taker, offer.id, 'sk-' + skewed.slice(0, 8)))).toEqual(UNKNOWN)
  })

  // ─── No inferred MATCHED, no FAILED, no second trade ──────────────────────────────────────────────────

  it('NO INFERRED MATCHED — the database itself refuses any decision but UNRESOLVED, and a second observation of a claim', async () => {
    pg.requirePostgres('GC-vocabulary')
    const { offer, taker } = await world('voc')
    const k = await legacyClaim(taker.id, offer.id, '0.0005', ago(3_600_000))
    await rec.observeLegacyTradeClaim(k.id, 'audit')
    const insert = (decision: string, claimId: string) => prisma.$executeRaw`
      INSERT INTO idempotency_reconciliation_audit (id, "claimId", scope, "participantId", decision, "candidateTradeIds", evidence, "decidedBy")
      VALUES (${randomUUID()}, ${claimId}, 'openp2p.trade.create', ${taker.id}, ${decision}, '[]'::jsonb, '{}'::jsonb, 'attacker')`
    for (const decision of ['MATCHED', 'AMBIGUOUS', 'NO_ATTRIBUTABLE_TRADE', 'COMPLETED', 'FAILED']) {
      await expect(insert(decision, randomUUID())).rejects.toThrow(/unresolved_only/)
    }
    await expect(insert('UNRESOLVED', k.id)).rejects.toThrow(/claim_unresolved_key|duplicate key/i) // one observation per claim
    await expect(prisma.$executeRaw`UPDATE idempotency_reconciliation_audit SET decision = 'MATCHED' WHERE "claimId" = ${k.id}`).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRaw`DELETE FROM idempotency_reconciliation_audit WHERE "claimId" = ${k.id}`).rejects.toThrow(/append-only/)
    const rows = await auditRows(k.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: 'UNRESOLVED', decidedBy: 'audit' })
    expect(rows[0].evidence).toMatchObject({ policy: 'NO_INFERRED_ATTRIBUTION_V1', authoritative: false, basis: 'CORRELATION_ONLY' })
  })

  it('NOTHING CAN ATTRIBUTE — the module exposes observation only, writes nothing but the append-only audit, accepts no trade id', () => {
    expect(Object.keys(rec).sort()).toEqual(['HINT_WINDOW_SECONDS', 'MAX_HINTS', 'observeLegacyTradeClaim', 'observeLegacyTradeClaims'])
    expect(rec.observeLegacyTradeClaim.length).toBeLessThanOrEqual(2)                    // (claimId, observedBy[, db]) — no trade id
    const src = readFileSync(join(__dirname, '../../src/modules/open-p2p/trade-claim-reconciliation.ts'), 'utf8')
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/\bUPDATE\b/i)
    expect(code).not.toMatch(/\bDELETE\b/i)
    expect(code).not.toMatch(/INSERT INTO\s+(?!idempotency_reconciliation_audit\b)/i)
    expect(code).not.toMatch(/'(COMPLETED|FAILED|UNKNOWN|MATCHED)'/)
  })

  it('UNCERTAINTY IS NEVER FAILED — and only IN_PROGRESS claims of the trade-creation scope are ever observed', async () => {
    pg.requirePostgres('GC-states')
    const { offer, account, taker } = await world('st')
    const t0 = ago(3 * 3_600_000)
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 100))
    const stuck = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const completed = await legacyClaim(taker.id, offer.id, '0.0005', t0, 'COMPLETED', T.id)
    const failed = await legacyClaim(taker.id, offer.id, '0.0006', t0, 'FAILED')
    const unknown = await legacyClaim(taker.id, offer.id, '0.0005', t0, 'UNKNOWN', T.id)
    const otherScope = randomUUID()
    await prisma.$executeRaw`INSERT INTO idempotency_keys (id, scope, "participantId", key, "requestHash", "createdAt")
      VALUES (${otherScope}, 'liquidity.offer.create', ${taker.id}, ${'os-' + otherScope.slice(0, 8)}, 'h', ${t0})`

    for (const c of [completed, failed, unknown]) expect((await rec.observeLegacyTradeClaim(c.id, 'audit')).decision).toBe('SKIPPED')
    expect((await rec.observeLegacyTradeClaim(otherScope, 'audit')).decision).toBe('SKIPPED')
    expect((await rec.observeLegacyTradeClaim(randomUUID(), 'audit')).decision).toBe('SKIPPED')
    for (const id of [completed.id, failed.id, unknown.id, otherScope]) expect(await auditRows(id)).toEqual([])
    await rec.observeLegacyTradeClaims({ olderThanMs: 60_000, limit: 1000, observedBy: 'bulk' })
    expect(await claimRow(completed.id)).toMatchObject({ status: 'COMPLETED', resultRef: T.id })
    expect(await claimRow(failed.id)).toMatchObject({ status: 'FAILED', resultRef: null })
    expect(await claimRow(unknown.id)).toMatchObject({ status: 'UNKNOWN', resultRef: T.id })
    await expectUntouched(stuck.id)                                                      // the one unresolved claim: still unresolved
    expect((await auditRows(stuck.id)).map((r) => r.decision)).toEqual(['UNRESOLVED'])
    // The bulk worker is itself idempotent: nothing left to observe for what it already observed.
    const again = (await rec.observeLegacyTradeClaims({ olderThanMs: 60_000, limit: 1000, observedBy: 'bulk-2' })).map((o) => o.claimId)
    expect(again).not.toContain(stuck.id)
    expect(await auditRows(stuck.id)).toHaveLength(1)
  })

  it('A REPLAY NEVER CREATES A TRADE — 409 every time, sequential and concurrent; the claim is never completed or failed; one observation', async () => {
    pg.requirePostgres('GC-replay')
    const { offer, account, taker } = await world('rp')
    const other = await who('rp-o')
    const t0 = ago(3_600_000)
    const k = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const mine = [await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 100)), await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 900))]
    const theirs = await legacyTrade(offer, other.id, account.id, '0.0005', plus(t0, 500))   // identical shape, another participant
    const b2 = await takeOffer(app, taker, offer.id, null)                                    // and a B2 trade of the same caller, just now
    expect(b2.statusCode).toBe(201)
    const before = await tradeCount(offer.id)

    const first = await replay(taker, offer.id, k.key)
    expect(brief(first)).toEqual(UNKNOWN)
    expect(bodyOf(first).details).toEqual({ authoritative: false, unverifiedCandidateTradeIds: mine.map((m) => m.id) })
    expect(first.body).not.toContain(other.id)                                           // no other participant's data...
    expect(first.body).not.toContain(theirs.id)                                          // ...nor trade
    expect(bodyOf(first).message).toMatch(/not known/)
    expect(bodyOf(first).message).toMatch(/hints only/)

    const burst = await Promise.all(Array.from({ length: 12 }, () => replay(taker, offer.id, k.key)))
    for (const r of burst) expect(brief(r)).toEqual(UNKNOWN)
    for (let i = 0; i < 3; i++) expect(brief(await replay(taker, offer.id, k.key))).toEqual(UNKNOWN)
    expect(await tradeCount(offer.id)).toBe(before)                                      // 16 replays, not one new trade
    await expectUntouched(k.id)
    expect(await auditRows(k.id)).toHaveLength(1)                                        // one immutable observation, not sixteen
    expect((await auditRows(k.id))[0].candidateTradeIds).toEqual(mine.map((m) => m.id))
    expect(await referencing(mine[0].id) + await referencing(mine[1].id)).toBe(0)

    // A different request under the same key is still refused as such (400), and observes nothing new.
    const other400 = await replay(taker, offer.id, k.key, '0.0009')
    expect(other400.statusCode).toBe(400)
    expect(await auditRows(k.id)).toHaveLength(1)
  })

  it('HINTS ARE BOUNDED AND CALLER-SCOPED — at most MAX_HINTS, oldest first, only the owner\'s own legacy trades', async () => {
    pg.requirePostgres('GC-hints')
    const { offer, account, taker } = await world('hn')
    const t0 = ago(3_600_000)
    const k = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    const made: string[] = []
    for (let i = 0; i < rec.MAX_HINTS + 5; i++) made.push((await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 100 + i * 10))).id)
    const outcome = await rec.observeLegacyTradeClaim(k.id, 'audit')
    expect(outcome.unverifiedCandidateTradeIds).toEqual(made.slice(0, rec.MAX_HINTS))
    expect((await auditRows(k.id))[0].candidateTradeIds).toEqual(made.slice(0, rec.MAX_HINTS))
    await expectUntouched(k.id)
  })

  it('B2 TRADES ARE NEVER HINTS — a trade admitted by B2 owns its claim (or none), so it is never the product of a legacy claim', async () => {
    pg.requirePostgres('GC-b2')
    const { offer, taker } = await world('b2')
    // Keyless on purpose: a B2 trade admitted WITH a key is already shielded by "referenced by another claim"; one
    // admitted without a key has no claim at all, so only the legacy-shape (tradeIntentId IS NULL) rule excludes it.
    expect((await takeOffer(app, taker, offer.id, null)).statusCode).toBe(201)
    const b2 = await prisma.trade.findFirstOrThrow({ where: { offerId: offer.id, tradeIntentId: { not: null } } })
    const stuck = await legacyClaim(taker.id, offer.id, '0.0005', plus(b2.createdAt, -50)) // 50 ms before it, identical request
    const outcome = await rec.observeLegacyTradeClaim(stuck.id, 'audit')
    expect([outcome.decision, outcome.unverifiedCandidateTradeIds]).toEqual(['UNRESOLVED', []])
    await expectUntouched(stuck.id)
    expect(await referencing(b2.id)).toBe(0)
    expect(brief(await replay(taker, offer.id, stuck.key))).toEqual(UNKNOWN)
    expect(await tradeCount(offer.id)).toBe(1)
  })

  it('A FAILED OBSERVATION CHANGES NOTHING — if the audit cannot be written the replay is still the same 409, never a 500, never a guess', async () => {
    pg.requirePostgres('GC-observation-failure')
    const { offer, account, taker } = await world('of')
    const t0 = ago(3_600_000)
    const k = await legacyClaim(taker.id, offer.id, '0.0005', t0)
    await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t0, 100))
    const original = prisma.$executeRaw.bind(prisma) as (...a: any[]) => Promise<number>
    const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation(((strings: any, ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : ''
      if (sql.includes('idempotency_reconciliation_audit')) return Promise.reject(new Error('simulated audit write failure'))
      return original(strings, ...values)
    }) as any)
    let res: { statusCode: number; body: string }
    try { res = await replay(taker, offer.id, k.key) } finally { spy.mockRestore() }
    expect(brief(res)).toEqual(UNKNOWN)
    expect(bodyOf(res).details).toEqual({ authoritative: false, unverifiedCandidateTradeIds: [] })
    expect(await auditRows(k.id)).toEqual([])
    await expectUntouched(k.id)
    expect(await tradeCount(offer.id)).toBe(1)
  })

  it('BULK WORKER — records the not-yet-observed IN_PROGRESS claims older than the cutoff, oldest first, once; settles nothing', async () => {
    pg.requirePostgres('GC-bulk')
    const { offer, account, taker } = await world('bk')
    const t = ago(2 * 3_600_000)
    const T = await legacyTrade(offer, taker.id, account.id, '0.0005', plus(t, 50))
    const older = await legacyClaim(taker.id, offer.id, '0.0005', plus(t, -60_000))
    const old = await legacyClaim(taker.id, offer.id, '0.0005', t)
    const fresh = await legacyClaim(taker.id, offer.id, '0.0009', new Date())
    const done = await rec.observeLegacyTradeClaims({ olderThanMs: 60_000, limit: 1000, observedBy: 'bulk' })
    const ids = done.map((d) => d.claimId)
    expect(ids).toContain(old.id)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(fresh.id)                                                  // too young: its request may still be in flight
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(old.id))                      // oldest first
    for (const d of done) expect(d.decision).toBe('UNRESOLVED')
    for (const c of [older, old, fresh]) await expectUntouched(c.id)
    expect(await referencing(T.id)).toBe(0)
    expect((await auditRows(fresh.id))).toEqual([])
    expect((await rec.observeLegacyTradeClaims({ olderThanMs: 60_000, limit: 1000, observedBy: 'bulk-2' })).map((o) => o.claimId)).not.toContain(old.id)
  })
})
