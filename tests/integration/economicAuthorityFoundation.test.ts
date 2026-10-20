// tests/integration/economicAuthorityFoundation.test.ts
//
// #235 R7H-E1 — economic authorization foundation (R7_TRADE_AUTHORIZATION_POLICY_V1), on real PostgreSQL.
//
// The database alone holds the invariants: every write here is direct SQL (no service, no application check), so
// what passes is what any writer — a future collector, a buggy service or a hand-typed statement — is held to.
// Quotes are published the way the later collector slice will publish them: one transaction, the quote row
// `INSERT … ON CONFLICT (id) DO NOTHING` on its deterministic id, then its observations, committed together. The id
// is the only unique key of a quote: with a second unique index on the same window, a concurrent loser can hit that
// index instead of the arbiter and fail rather than yield (observed here before the schema was narrowed to one).
//
// Policy-version proofs run inside transactions that are rolled back (a committed version would become the
// version in force for every later test); everything else is committed and asserted on the committed rows.

import { Client, types } from 'pg'
import { Prisma } from '@prisma/client'
import { createHash, randomBytes } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const POLICY_V1 = 'r7-trade-authorization-policy-v1'
const WINDOW_MS = 30_000
const MIGRATIONS = join(__dirname, '../../prisma/migrations')
const E1_MIGRATION = '20261015120000_economic_authority_foundation'

type Sql = Pick<Client, 'query'>
type Obs = { operator: string; price: string; sourceTs?: Date | null; collectedAt?: Date }
/** Every quote id this suite ever tried to publish (ids are deterministic), so cleanup never misses one. */
const publishedQuotes = new Set<string>()

type QuoteSpec = { asOf?: Date; obs: Obs[]; override?: Partial<Record<'priceMaxUsd' | 'priceMedianUsd' | 'observationCount' | 'sourceSpreadBps' | 'policyVersionId' | 'id', string | number>> }

/** Timestamp literal for `timestamp(3) without time zone` columns, which hold UTC. */
const ts = (d: Date) => d.toISOString().slice(0, 23)
const windowOf = (d: Date) => new Date(Math.floor(d.getTime() / WINDOW_MS) * WINDOW_MS)
const quoteIdOf = (windowStart: Date) => `BTC:${windowStart.getTime() / 1000}`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const D = (v: string | number) => new Prisma.Decimal(v)
/** `timestamp without time zone` read back as UTC, not as the test machine's local time. */
const utc = (s: string) => new Date(`${s.replace(' ', 'T')}Z`)
/** Raw text for timestamps (no local-time Date conversion); every other type as node-pg parses it. */
const rawTimestamps = { getTypeParser: (oid: number, format?: any) => (oid === 1114 ? (v: string) => v : types.getTypeParser(oid, format)) }

/** The quote summary a correct publisher derives from its observations (exact decimals, median rounded to 8 dp). */
function summarize(prices: string[]) {
  const sorted = prices.map(D).sort((a, b) => a.comparedTo(b))
  const n = sorted.length
  if (n === 0) return { priceMaxUsd: '0', priceMedianUsd: '0', observationCount: 0, sourceSpreadBps: 0 }
  const hi = sorted[n - 1]
  const lo = sorted[0]
  const median = n % 2 ? sorted[(n - 1) / 2] : sorted[n / 2 - 1].plus(sorted[n / 2]).div(2)
  return {
    priceMaxUsd: hi.toFixed(8),
    priceMedianUsd: median.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
    observationCount: n,
    sourceSpreadBps: hi.minus(lo).times(10000).div(median).ceil().toNumber(),
  }
}

/** Publishes a quote (and, if this publisher won the window, its observations) inside the caller's transaction. */
async function publish(c: Sql, spec: QuoteSpec): Promise<{ id: string; won: boolean; asOf: Date }> {
  const asOf = spec.asOf ?? new Date(Date.now() - 2_000)
  const windowStart = windowOf(asOf)
  const collectedAt = new Date(asOf.getTime() + 500)
  const s = { ...summarize(spec.obs.map((o) => o.price)), policyVersionId: POLICY_V1, id: quoteIdOf(windowStart), ...spec.override }
  publishedQuotes.add(String(s.id))
  const r = await c.query(
    `INSERT INTO valuation_quotes (id, "policyVersionId", "baseAsset", "windowStart", "asOf", "collectedAt", "priceMaxUsd", "priceMedianUsd", "observationCount", "sourceSpreadBps")
     VALUES ($1, $2, 'BTC', $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [s.id, s.policyVersionId, ts(windowStart), ts(asOf), ts(collectedAt), s.priceMaxUsd, s.priceMedianUsd, s.observationCount, s.sourceSpreadBps],
  )
  if (r.rowCount === 0) return { id: String(s.id), won: false, asOf }
  for (const o of spec.obs) {
    const sourceTs = o.sourceTs === undefined ? new Date(asOf.getTime() - 1_000) : o.sourceTs
    await c.query(
      `INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`obs-${randomBytes(8).toString('hex')}`, s.id, o.operator, o.price, sourceTs ? ts(sourceTs) : null, ts(o.collectedAt ?? new Date(asOf.getTime() + 200)), sha(`${o.operator}:${o.price}`)],
    )
  }
  return { id: String(s.id), won: true, asOf }
}

/** Three agreeing operators around a 50,000.00000000 USD maximum (spread 41 bps, within the 100 bps policy). */
const AGREEING: Obs[] = [
  { operator: 'KRAKEN', price: '49800.00000000', sourceTs: null },
  { operator: 'COINBASE', price: '50000.00000000' },
  { operator: 'BITSTAMP', price: '49900.00000000' },
]

describe('#235 R7H-E1 — economic authorization foundation (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  const url = () => process.env.DATABASE_URL as string
  const clients: Client[] = []
  const ownedUsers: string[] = []
  let db: Client

  async function connect(connectionString = url()) {
    const c = new Client({ connectionString, types: rawTimestamps })
    await c.connect()
    clients.push(c)
    return c
  }

  async function release(c: Client) {
    clients.splice(clients.indexOf(c), 1)
    await c.end().catch(() => undefined)
  }

  /** Runs `fn` in a transaction on its own connection and commits; rolls back and rethrows on any failure. */
  async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await connect()
    await c.query('BEGIN')
    try {
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      await release(c)
    }
  }

  /** Runs `fn` in a transaction that is always rolled back. */
  async function rolledBack<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await connect()
    await c.query('BEGIN')
    try {
      return await fn(c)
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await release(c)
    }
  }

  /** Asserts the statement is refused by the database with the given SQLSTATE (inside a savepoint, so the tx survives). */
  async function refused(c: Sql, code: string, text: string, params: unknown[] = []) {
    await c.query('SAVEPOINT probe')
    try {
      await expect(c.query(text, params)).rejects.toMatchObject({ code })
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT probe')
    }
  }

  const count = async (text: string, params: unknown[] = []) => Number((await db.query(text, params)).rows[0].n)
  const quoteRows = (id: string) => count(`SELECT count(*) AS n FROM valuation_quotes WHERE id = $1`, [id])
  /** Committed quotes of any id for the window containing `asOf`. */
  const windowRows = (asOf: Date) => count(`SELECT count(*) AS n FROM valuation_quotes WHERE "windowStart" = $1`, [ts(windowOf(asOf))])

  /** Purges committed quote evidence of this suite (immutable by design: the guards are lifted for cleanup only). */
  async function purge() {
    const ids = [...publishedQuotes]
    await committed(async (c) => {
      for (const t of ['exposure_reservations', 'price_observations', 'valuation_quotes']) {
        await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_immutability_guard`)
      }
      await c.query(`DELETE FROM exposure_reservations WHERE "quoteId" = ANY($1)`, [ids])
      await c.query(`DELETE FROM price_observations WHERE "quoteId" = ANY($1)`, [ids])
      await c.query(`DELETE FROM valuation_quotes WHERE id = ANY($1)`, [ids])
      for (const t of ['exposure_reservations', 'price_observations', 'valuation_quotes']) {
        await c.query(`ALTER TABLE ${t} ENABLE TRIGGER ${t}_immutability_guard`)
      }
    })
    publishedQuotes.clear()
  }

  /** Commits a complete quote with the given observations for the current window. */
  async function currentQuote(obs: Obs[] = AGREEING) {
    const q = await committed((c) => publish(c, { obs }))
    expect(q.won).toBe(true)
    return q
  }

  /**
   * Plants a quote as historical state: it was published on time when it was current, so the publication-time
   * guards (insert bound and its commit-time re-check) are lifted for the fixture only. Its summary is consistent by
   * construction (publish() derives it from the observations).
   */
  async function plantHistorical(asOf: Date, obs: Obs[]) {
    const guards: Array<[string, string]> = [['valuation_quotes', 'valuation_quotes_insert_guard'], ['valuation_quotes', 'valuation_quotes_completeness_guard'], ['price_observations', 'price_observations_completeness_guard']]
    return committed(async (c) => {
      for (const [t, g] of guards) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`)
      const q = await publish(c, { asOf, obs })
      for (const [t, g] of guards) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER ${g}`)
      return q
    })
  }

  type Fixture = { sellerId: string; buyerId: string; accountId: string; offerId: string; tradeId: string; escrowId: string; amount: string }

  /** A seller-bound PIX trade with a new, unfunded MULTISIG escrow — the only shape V1 can authorize. */
  async function fixture(c: Sql, o: { amount?: string; accountMethod?: string; offerMethod?: string; tradeStatus?: string; escrowStatus?: string; txLockId?: string | null; bind?: boolean; historical?: boolean } = {}): Promise<Fixture> {
    const tag = randomBytes(6).toString('hex')
    const amount = o.amount ?? '0.00100000'
    const f = { sellerId: `r7he1-s-${tag}`, buyerId: `r7he1-b-${tag}`, accountId: `r7he1-pa-${tag}`, offerId: `r7he1-o-${tag}`, tradeId: `r7he1-t-${tag}`, escrowId: `r7he1-e-${tag}`, amount }
    for (const id of [f.sellerId, f.buyerId]) {
      await c.query(`INSERT INTO users (id, "publicKey", "displayName", "updatedAt") VALUES ($1, $2, $1, now())`, [id, randomBytes(32).toString('hex')])
      ownedUsers.push(id)
    }
    await c.query(`INSERT INTO payment_accounts (id, "ownerId", "accountHash", "paymentMethod", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [f.accountId, f.sellerId, sha(tag), o.accountMethod ?? 'PIX'])
    await c.query(
      `INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "paymentAccountId", "updatedAt") VALUES ($1, $2, 'BTC', 'SELL', 1, 0.00000001, 100, $3, $4, now())`,
      [f.offerId, f.sellerId, o.offerMethod ?? 'PIX', f.accountId],
    )
    await c.query(
      `INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt")
       VALUES ($1, $2, $3, $4, 'BTC', $5, 1, 1, $6, $7, now())`,
      [f.tradeId, f.offerId, f.buyerId, f.sellerId, amount, o.tradeStatus ?? 'ACTIVE', o.bind === false ? null : f.accountId],
    )
    // historical: an escrow R7H-E3 refuses at creation (non-PIX or unbound), planted as a pre-E3 row so the E1
    // reservation guard's own refusal is still proven (defense in depth). Only the E3 creation guard is lifted, and
    // only inside this fixture's transaction.
    if (o.historical) await c.query('ALTER TABLE escrows DISABLE TRIGGER escrows_trade_economic_binding_guard')
    await c.query(
      `INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "txLockId", "updatedAt") VALUES ($1, $2, 'MULTISIG', $3, $4, 'BTC', $5, now())`,
      [f.escrowId, f.tradeId, o.escrowStatus ?? 'CREATED', amount, o.txLockId ?? null],
    )
    if (o.historical) await c.query('ALTER TABLE escrows ENABLE TRIGGER escrows_trade_economic_binding_guard')
    await c.query(`UPDATE trades SET "escrowId" = $1 WHERE id = $2`, [f.escrowId, f.tradeId])
    return f
  }

  const RESERVE = `INSERT INTO exposure_reservations (id, "tradeId", "escrowId", "sellerId", "paymentAccountId", "policyVersionId", "quoteId", "paymentMethod", "escrowType", asset, "assetAmount", "exposureUsd")
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MULTISIG', 'BTC', $9, $10)`
  /** Reservation parameters for fixture `f` at quote `quoteId`, exposure as given (callers compute the expected value). */
  const reservation = (f: Fixture, quoteId: string, exposureUsd: string, over: Partial<Record<'tradeId' | 'escrowId' | 'sellerId' | 'paymentAccountId' | 'policyVersionId' | 'paymentMethod' | 'assetAmount', string>> = {}) => [
    `r7he1-r-${randomBytes(6).toString('hex')}`,
    over.tradeId ?? f.tradeId,
    over.escrowId ?? f.escrowId,
    over.sellerId ?? f.sellerId,
    over.paymentAccountId ?? f.accountId,
    over.policyVersionId ?? POLICY_V1,
    quoteId,
    over.paymentMethod ?? 'PIX',
    over.assetAmount ?? f.amount,
    exposureUsd,
  ]
  /** Conservative exposure: amount x max price, rounded up to the cent. */
  const exposure = (amount: string, maxPrice: string) => D(amount).times(maxPrice).times(100).ceil().div(100).toFixed(2)

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    db = await connect()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await purge()
      await committed(async (c) => {
        await c.query(`ALTER TABLE exposure_reservations DISABLE TRIGGER exposure_reservations_immutability_guard`)
        await c.query(`DELETE FROM exposure_reservations WHERE "sellerId" = ANY($1)`, [ownedUsers])
        await c.query(`ALTER TABLE exposure_reservations ENABLE TRIGGER exposure_reservations_immutability_guard`)
        await c.query(`UPDATE trades SET "escrowId" = NULL WHERE "sellerId" = ANY($1)`, [ownedUsers])
        await c.query(`DELETE FROM escrows WHERE "tradeId" IN (SELECT id FROM trades WHERE "sellerId" = ANY($1))`, [ownedUsers])
        await c.query(`DELETE FROM trades WHERE "sellerId" = ANY($1)`, [ownedUsers])
        await c.query(`DELETE FROM offers WHERE "userId" = ANY($1)`, [ownedUsers])
        await c.query(`DELETE FROM payment_accounts WHERE "ownerId" = ANY($1)`, [ownedUsers])
        await c.query(`DELETE FROM users WHERE id = ANY($1)`, [ownedUsers])
      })
    } finally {
      for (const c of clients) await c.end().catch(() => undefined)
    }
  })

  // ─── policy versions ──────────────────────────────────────────────────────────────────────────────────────

  beforeEach(async () => {
    if (pg.isAvailable()) await purge()
  })

  it('V1 is seeded exactly as frozen: 250.00 / 750.00 USD, 120 s / 30 s, 100 bps, 2 operators, MULTISIG/BTC, PIX 90 days only', async () => {
    pg.requirePostgres('V1')
    const v = (await db.query(`SELECT * FROM trade_limit_policy_versions WHERE id = $1`, [POLICY_V1])).rows[0]
    expect([v.version, v.openSettlementCapUsd, v.rollingFiatCapUsd, v.quoteMaxAgeSeconds, v.quoteWindowSeconds, v.quotePublicationMaxSeconds, v.maxSourceDisagreementBps, v.minAgreeingOperators])
      .toEqual([1, '250.00', '750.00', 120, 30, 10, 100, 2])
    expect(v.label).toMatch(/experimental/)
    expect((await db.query(`SELECT "escrowType"::text || '/' || asset::text AS r FROM trade_limit_rail_policies WHERE "policyVersionId" = $1`, [POLICY_V1])).rows.map((r) => r.r)).toEqual(['MULTISIG/BTC'])
    const methods = (await db.query(`SELECT "paymentMethod"::text AS m, eligible, "fiatWindowDays" AS d, "evidenceClass"::text AS e FROM trade_limit_method_policies WHERE "policyVersionId" = $1`, [POLICY_V1])).rows
    expect(methods).toEqual([{ m: 'PIX', eligible: true, d: 90, e: 'REGULATORY' }])
    // No tier, promotion or unlimited concept exists in the schema at all.
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trade_limit_policy_versions'`)).rows.map((r) => r.column_name)
    expect(cols.filter((n: string) => /tier|promot|unlimited/i.test(n))).toEqual([])
  })

  const V2 = (over: Record<string, unknown> = {}) => {
    const v = { id: `r7he1-v-${randomBytes(4).toString('hex')}`, version: 2, label: 'test', activatedAt: null as string | null, open: '100.00', fiat: '300.00', maxAge: 120, window: 30, pub: 10, bps: 100, ops: 2, srcAge: 60, skew: 15, ...over }
    return [
      `INSERT INTO trade_limit_policy_versions (id, version, label, "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds")
       VALUES ($1, $2, $3, coalesce($4::timestamp, now() AT TIME ZONE 'UTC'), $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [v.id, v.version, v.label, v.activatedAt, v.open, v.fiat, v.maxAge, v.window, v.pub, v.bps, v.ops, v.srcAge, v.skew],
    ] as const
  }

  it('1: a valid policy version (with its rail and method rows, same transaction) is inserted and becomes the version in force', async () => {
    pg.requirePostgres('1')
    await rolledBack(async (c) => {
      const [text, params] = V2()
      await c.query(text, [...params])
      await c.query(`INSERT INTO trade_limit_rail_policies VALUES ($1, 'MULTISIG', 'BTC')`, [params[0]])
      await c.query(`INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ($1, 'PIX', true, 120, 'REGULATORY', 'HIGH')`, [params[0]])
      expect((await c.query(`SELECT trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC') AS v`)).rows[0].v).toBe(params[0])
      // A scheduled (future) version does not take effect early.
      const [t3, p3] = V2({ version: 3, activatedAt: ts(new Date(Date.now() + 3_600_000)) })
      await c.query(t3, [...p3])
      expect((await c.query(`SELECT trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC') AS v`)).rows[0].v).toBe(params[0])
    })
  })

  it('2: invalid numeric policy values are rejected (no zero/negative/unlimited caps, < 2 operators, bad bps, age < window)', async () => {
    pg.requirePostgres('2')
    await rolledBack(async (c) => {
      for (const bad of [{ open: '0' }, { open: '-1.00' }, { fiat: '0.00' }, { open: null }, { fiat: null }, { ops: 1 }, { bps: -1 }, { bps: 10001 }, { maxAge: 20, window: 30 }, { window: 0 }, { pub: 0 }, { pub: 121 }, { srcAge: 0 }, { skew: -1 }, { label: ' ' }]) {
        const [text, params] = V2(bad)
        await refused(c, bad.open === null || bad.fiat === null ? '23502' : '23514', text, [...params])
      }
      // Versions only move forward: no lower/equal number, no backdated or out-of-order activation.
      for (const bad of [{ version: 1 }, { activatedAt: ts(new Date(Date.now() - 86_400_000)) }]) {
        const [text, params] = V2(bad)
        await refused(c, '23000', text, [...params])
      }
    })
  })

  it('3 / C3: a missing, ineligible, UNVERIFIED or late-added method can never become eligible', async () => {
    pg.requirePostgres('3')
    // V1 is closed: no method can be added to it after its creating transaction (OTHER / BANK_TRANSFER included).
    for (const m of ['OTHER', 'BANK_TRANSFER', 'TED']) {
      await expect(db.query(`INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ($1, $2, true, 90, 'REGULATORY', 'HIGH')`, [POLICY_V1, m]))
        .rejects.toMatchObject({ code: '23000' })
    }
    await expect(db.query(`UPDATE trade_limit_method_policies SET eligible = true WHERE "policyVersionId" = $1`, [POLICY_V1])).rejects.toMatchObject({ code: '23000' })
    await rolledBack(async (c) => {
      const [text, params] = V2()
      await c.query(text, [...params])
      // Eligible requires documented evidence and a fiat window.
      await refused(c, '23514', `INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ($1, 'OTHER', true, 90, 'UNVERIFIED', 'LOW')`, [params[0]])
      await refused(c, '23514', `INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ($1, 'TED', true, NULL, 'REGULATORY', 'HIGH')`, [params[0]])
    })

    const q = await currentQuote()
    // Reservations: TED account + TED offer (no method row), PIX-labelled snapshot over a TED account, PIX offer over a TED account.
    const ted = await committed((c) => fixture(c, { accountMethod: 'TED', offerMethod: 'TED', historical: true }))
    await expect(db.query(RESERVE, reservation(ted, q.id, exposure(ted.amount, '50000'), { paymentMethod: 'TED' }))).rejects.toMatchObject({ code: '23000' })
    await expect(db.query(RESERVE, reservation(ted, q.id, exposure(ted.amount, '50000'), { paymentMethod: 'PIX' }))).rejects.toMatchObject({ code: '23000' })
    const mixed = await committed((c) => fixture(c, { accountMethod: 'TED', offerMethod: 'PIX', historical: true }))
    await expect(db.query(RESERVE, reservation(mixed, q.id, exposure(mixed.amount, '50000')))).rejects.toMatchObject({ code: '23000' })
    const other = await committed((c) => fixture(c, { accountMethod: 'PIX', offerMethod: 'OTHER', historical: true }))
    await expect(db.query(RESERVE, reservation(other, q.id, exposure(other.amount, '50000')))).rejects.toMatchObject({ code: '23000' })
    // An unbound trade (no seller account) has nothing to authorize.
    const unbound = await committed((c) => fixture(c, { bind: false, historical: true }))
    await expect(db.query(RESERVE, reservation(unbound, q.id, exposure(unbound.amount, '50000')))).rejects.toMatchObject({ code: '23000' })
    expect(await count(`SELECT count(*) AS n FROM exposure_reservations WHERE "tradeId" = ANY($1)`, [[ted.tradeId, mixed.tradeId, other.tradeId, unbound.tradeId]])).toBe(0)
    await purge()
  })

  // ─── quotes ───────────────────────────────────────────────────────────────────────────────────────────────

  it('4: a complete quote and its observations commit together, under the deterministic id, with an exact summary', async () => {
    pg.requirePostgres('4')
    const q = await currentQuote()
    expect(q.won).toBe(true)
    const row = (await db.query(`SELECT * FROM valuation_quotes WHERE id = $1`, [q.id])).rows[0]
    expect(q.id).toBe(`BTC:${utc(row.windowStart).getTime() / 1000}`)
    expect([row.priceMaxUsd, row.priceMedianUsd, row.observationCount, row.sourceSpreadBps, row.policyVersionId]).toEqual(['50000.00000000', '49900.00000000', 3, 41, POLICY_V1])
    const obs = (await db.query(`SELECT operator, "priceUsd" FROM price_observations WHERE "quoteId" = $1 ORDER BY operator`, [q.id])).rows
    expect(obs).toEqual([{ operator: 'BITSTAMP', priceUsd: '49900.00000000' }, { operator: 'COINBASE', priceUsd: '50000.00000000' }, { operator: 'KRAKEN', priceUsd: '49800.00000000' }])
    await purge()
  })

  it('5: a second publication for the same window is idempotently ignored (ON CONFLICT) or rejected (plain INSERT)', async () => {
    pg.requirePostgres('5')
    const first = await currentQuote()
    const second = await committed((c) => publish(c, { obs: [{ operator: 'KRAKEN', price: '1.00000000' }, { operator: 'GEMINI', price: '1.00000000' }] }))
    expect(second).toMatchObject({ id: first.id, won: false })
    const row = (await db.query(`SELECT * FROM valuation_quotes WHERE id = $1`, [first.id])).rows[0]
    await expect(db.query(
      `INSERT INTO valuation_quotes (id, "policyVersionId", "baseAsset", "windowStart", "asOf", "collectedAt", "priceMaxUsd", "priceMedianUsd", "observationCount", "sourceSpreadBps") VALUES ($1, $2, 'BTC', $3, $4, $4, 1, 1, 2, 0)`,
      [first.id, POLICY_V1, row.windowStart, row.asOf],
    )).rejects.toMatchObject({ code: '23505' })
    expect((await db.query(`SELECT "priceMaxUsd" FROM valuation_quotes WHERE id = $1`, [first.id])).rows[0].priceMaxUsd).toBe('50000.00000000')
    expect(await count(`SELECT count(*) AS n FROM price_observations WHERE "quoteId" = $1`, [first.id])).toBe(3)
    await purge()
  })

  it('6 / C1: a quote with absent, insufficient, inconsistent or out-of-bounds evidence never commits', async () => {
    pg.requirePostgres('6')
    const attempts: Array<[string, QuoteSpec]> = [
      ['no observations', { obs: [], override: { priceMaxUsd: '50000', priceMedianUsd: '50000', observationCount: 2, sourceSpreadBps: 0 } }],
      ['one operator', { obs: [{ operator: 'KRAKEN', price: '50000' }], override: { observationCount: 2 } }],
      ['declares 3, has 2', { obs: AGREEING.slice(1), override: { observationCount: 3 } }],
      ['max below the highest observation', { obs: AGREEING, override: { priceMaxUsd: '49900.00000000' } }],
      ['median not the observations\' median', { obs: AGREEING, override: { priceMedianUsd: '49800.00000000' } }],
      ['spread misdeclared', { obs: AGREEING, override: { sourceSpreadBps: 0 } }],
      ['sources disagree by > 1%', { obs: [{ operator: 'KRAKEN', price: '49000' }, { operator: 'COINBASE', price: '50000' }] }],
      ['no observation carries a source timestamp', { obs: [{ operator: 'KRAKEN', price: '50000', sourceTs: null }, { operator: 'COINBASE', price: '50000', sourceTs: null }] }],
      ['stale source (> 60 s before asOf)', { obs: [{ operator: 'KRAKEN', price: '50000', sourceTs: new Date(Date.now() - 120_000) }, { operator: 'COINBASE', price: '50000' }] }],
      ['future source (> 15 s after asOf)', { obs: [{ operator: 'KRAKEN', price: '50000', sourceTs: new Date(Date.now() + 60_000) }, { operator: 'COINBASE', price: '50000' }] }],
      ['observation collected before asOf', { obs: [{ operator: 'KRAKEN', price: '50000', collectedAt: new Date(Date.now() - 60_000) }, { operator: 'COINBASE', price: '50000' }] }],
    ]
    for (const [label, spec] of attempts) {
      const asOf = spec.asOf ?? new Date(Date.now() - 2_000)
      await expect(committed((c) => publish(c, { ...spec, asOf }))).rejects.toMatchObject({ code: expect.stringMatching(/^23/) })
      expect([label, await windowRows(asOf)]).toEqual([label, 0])
    }
    // Field-level refusals at insert time.
    const bad: Array<[string, QuoteSpec, string]> = [
      ['zero price', { obs: [{ operator: 'KRAKEN', price: '0' }, { operator: 'COINBASE', price: '50000' }] }, '23514'],
      ['negative price', { obs: [{ operator: 'KRAKEN', price: '-50000' }, { operator: 'COINBASE', price: '50000' }], override: { priceMedianUsd: '50000', sourceSpreadBps: 0 } }, '23514'],
      ['duplicate operator', { obs: [{ operator: 'KRAKEN', price: '50000' }, { operator: 'KRAKEN', price: '50000' }] }, '23505'],
      ['non-canonical operator label', { obs: [{ operator: 'Kraken', price: '50000' }, { operator: 'KRAKEN', price: '50000' }] }, '23514'],
      ['non-deterministic id', { obs: AGREEING, override: { id: 'BTC:1' } }, '23000'],
      ['policy not in force', { obs: AGREEING, override: { policyVersionId: 'nope' } }, '23000'],
      ['backdated (asOf two windows ago)', { obs: AGREEING, asOf: new Date(Date.now() - 70_000) }, '23000'],
      ['future asOf', { obs: AGREEING, asOf: new Date(Date.now() + 60_000) }, '23000'],
    ]
    for (const [label, spec, code] of bad) {
      const asOf = spec.asOf ?? new Date(Date.now() - 2_000)
      await expect(committed((c) => publish(c, { ...spec, asOf }))).rejects.toMatchObject({ code })
      expect([label, await windowRows(asOf)]).toEqual([label, 0])
    }
  })

  it('C1/C5: no observation can be added after the completeness check (SET CONSTRAINTS IMMEDIATE) or from another transaction', async () => {
    pg.requirePostgres('C1b')
    let id = ''
    await expect(committed(async (c) => {
      id = (await publish(c, { obs: AGREEING })).id
      await c.query('SET CONSTRAINTS ALL IMMEDIATE')
      await c.query(`INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ('obs-late', $1, 'GEMINI', 99999, NULL, now() AT TIME ZONE 'UTC', $2)`, [id, sha('x')])
    })).rejects.toMatchObject({ code: '23000' })
    expect(await quoteRows(id)).toBe(0)

    const q = await currentQuote()
    // Refused by the INSERT itself (not only by the commit-time completeness re-check).
    await rolledBack((c) => refused(c, '23000', `INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ('obs-late2', $1, 'GEMINI', 99999, NULL, now() AT TIME ZONE 'UTC', $2)`, [q.id, sha('y')]))
    await expect(db.query(`INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ('obs-late2', $1, 'GEMINI', 99999, NULL, now() AT TIME ZONE 'UTC', $2)`, [q.id, sha('y')]))
      .rejects.toMatchObject({ code: '23000' })
    expect(await count(`SELECT count(*) AS n FROM price_observations WHERE "quoteId" = $1`, [q.id])).toBe(3)
    await purge()
  })

  it('D4: a quote is published within 10 s of its asOf — at insert and at commit; the 30 s window alignment does not stand in for it', async () => {
    pg.requirePostgres('D4')
    // 8 s after asOf: inside the bound.
    const onTime = await committed((c) => publish(c, { asOf: new Date(Date.now() - 8_000), obs: AGREEING }))
    expect(onTime.won).toBe(true)
    expect(await quoteRows(onTime.id)).toBe(1)
    await purge()
    // 12 s after asOf: the INSERT itself is refused, although asOf is still within its 30 s window.
    const lateAsOf = new Date(Date.now() - 12_000)
    await rolledBack(async (c) => {
      await c.query('SAVEPOINT late')
      await expect(publish(c, { asOf: lateAsOf, obs: AGREEING })).rejects.toMatchObject({ code: '23000' })
      await c.query('ROLLBACK TO SAVEPOINT late')
    })
    expect(await windowRows(lateAsOf)).toBe(0)
    // Inserted 7 s after asOf, committed after 11 s: refused at commit — a transaction held open cannot publish late.
    let held = ''
    await expect(committed(async (c) => {
      held = (await publish(c, { asOf: new Date(Date.now() - 7_000), obs: AGREEING })).id
      await new Promise((r) => setTimeout(r, 4_000))
    })).rejects.toMatchObject({ code: '23000' })
    expect(await quoteRows(held)).toBe(0)
  })

  it('7: committed quote evidence cannot be updated, deleted or truncated', async () => {
    pg.requirePostgres('7')
    const q = await currentQuote()
    const before = (await db.query(`SELECT q.*, (SELECT json_agg(o ORDER BY o.operator) FROM price_observations o WHERE o."quoteId" = q.id) AS obs FROM valuation_quotes q WHERE q.id = $1`, [q.id])).rows[0]
    for (const stmt of [
      `UPDATE valuation_quotes SET "priceMaxUsd" = 1 WHERE id = $1`,
      `UPDATE valuation_quotes SET "asOf" = "asOf" - interval '1 hour' WHERE id = $1`,
      `UPDATE valuation_quotes SET "policyVersionId" = "policyVersionId" WHERE id = $1`,
      `DELETE FROM valuation_quotes WHERE id = $1`,
      `UPDATE price_observations SET "priceUsd" = 1 WHERE "quoteId" = $1`,
      `UPDATE price_observations SET operator = 'GEMINI' WHERE "quoteId" = $1`,
      `DELETE FROM price_observations WHERE "quoteId" = $1`,
    ]) {
      await expect(db.query(stmt, [q.id])).rejects.toMatchObject({ code: '23000' })
    }
    for (const t of ['valuation_quotes', 'price_observations', 'trade_limit_policy_versions', 'trade_limit_method_policies', 'trade_limit_rail_policies', 'exposure_reservations']) {
      await expect(db.query(`TRUNCATE ${t} CASCADE`)).rejects.toMatchObject({ code: '23000' })
    }
    for (const stmt of [`UPDATE trade_limit_policy_versions SET "openSettlementCapUsd" = 1000000`, `DELETE FROM trade_limit_rail_policies`, `DELETE FROM trade_limit_policy_versions`]) {
      await expect(db.query(stmt)).rejects.toMatchObject({ code: '23000' })
    }
    const after = (await db.query(`SELECT q.*, (SELECT json_agg(o ORDER BY o.operator) FROM price_observations o WHERE o."quoteId" = q.id) AS obs FROM valuation_quotes q WHERE q.id = $1`, [q.id])).rows[0]
    expect(after).toEqual(before)
    await purge()
  })

  it('14 / C1: concurrent publishers produce exactly one complete quote; an in-flight quote is invisible; a failed publisher yields the window', async () => {
    pg.requirePostgres('14')
    // Six nodes race for the same window, each with its own (valid) observations.
    const asOf = new Date(Date.now() - 2_000)
    const nodes = await Promise.all(Array.from({ length: 6 }, () => connect()))
    await Promise.all(nodes.map((c) => c.query('BEGIN')))
    const results = await Promise.allSettled(nodes.map(async (c, i) => {
      const r = await publish(c, { asOf, obs: [{ operator: 'KRAKEN', price: `${50000 + i}` }, { operator: 'COINBASE', price: `${50010 + i}` }, { operator: 'BITSTAMP', price: `${50020 + i}` }] })
      await c.query('COMMIT')
      return r
    }))
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([])
    const won = results.filter((r) => r.status === 'fulfilled' && r.value.won)
    expect(won).toHaveLength(1)
    const id = (won[0] as PromiseFulfilledResult<{ id: string }>).value.id
    expect(await count(`SELECT count(*) AS n FROM valuation_quotes WHERE "windowStart" = $1`, [ts(windowOf(asOf))])).toBe(1)
    const q = (await db.query(`SELECT "priceMaxUsd", (SELECT max("priceUsd") FROM price_observations WHERE "quoteId" = $1) AS m, (SELECT count(*)::int FROM price_observations WHERE "quoteId" = $1) AS n FROM valuation_quotes WHERE id = $1`, [id])).rows[0]
    expect([q.priceMaxUsd, q.m, q.n]).toEqual([q.m, q.m, 3])
    await purge()
    for (const c of nodes) await release(c)

    // A: quote inserted, observations not yet — a reader sees nothing; B blocks on the window; A fails at commit; B wins.
    const [a, b] = [await connect(), await connect()]
    await a.query('BEGIN')
    const aOut = await publish(a, { obs: [] , override: { priceMaxUsd: '1', priceMedianUsd: '1', observationCount: 2, sourceSpreadBps: 0 } })
    expect(aOut.won).toBe(true)
    expect(await quoteRows(aOut.id)).toBe(0)
    await b.query('BEGIN')
    const bOut = publish(b, { obs: AGREEING }).then(async (r) => { await b.query('COMMIT'); return r })
    await new Promise((r) => setTimeout(r, 300))
    await expect(a.query('COMMIT')).rejects.toMatchObject({ code: '23000' })
    const bWon = await bOut
    expect(bWon).toMatchObject({ id: aOut.id, won: true })
    expect((await db.query(`SELECT "priceMaxUsd", "observationCount" FROM valuation_quotes WHERE id = $1`, [bWon.id])).rows[0]).toEqual({ priceMaxUsd: '50000.00000000', observationCount: 3 })
    await purge()
    await release(a)
    await release(b)
  })

  // ─── reservations ─────────────────────────────────────────────────────────────────────────────────────────

  it('8 + exact decimals: a reservation commits at exactly ceil(amount x max price) to the cent, at cap, never above it', async () => {
    pg.requirePostgres('8')
    const q = await currentQuote()
    // 0.005 BTC x 50,000.00 = 250.00 USD — exactly the open settlement cap.
    const atCap = await committed((c) => fixture(c, { amount: '0.00500000' }))
    await db.query(RESERVE, reservation(atCap, q.id, '250.00'))
    const r = (await db.query(`SELECT * FROM exposure_reservations WHERE "tradeId" = $1`, [atCap.tradeId])).rows[0]
    expect([r.escrowId, r.sellerId, r.paymentAccountId, r.policyVersionId, r.quoteId, r.paymentMethod, r.escrowType, r.asset, r.assetAmount, r.exposureUsd])
      .toEqual([atCap.escrowId, atCap.sellerId, atCap.accountId, POLICY_V1, q.id, 'PIX', 'MULTISIG', 'BTC', '0.00500000', '250.00'])
    // authorizedAt is the database clock, not the caller's.
    expect(Math.abs(utc(r.authorizedAt).getTime() - Date.now())).toBeLessThan(10_000)

    // 0.00500020 BTC x 50,000 = 250.01 USD — one cent above the cap.
    const overCap = await committed((c) => fixture(c, { amount: '0.00500020' }))
    expect(exposure(overCap.amount, '50000')).toBe('250.01')
    await expect(db.query(RESERVE, reservation(overCap, q.id, '250.01'))).rejects.toMatchObject({ code: '23000' })
    // The smallest valid amount still reserves a positive, rounded-up cent: 1 sat x 50,000 = 0.0005 -> 0.01.
    const dust = await committed((c) => fixture(c, { amount: '0.00000001' }))
    await expect(db.query(RESERVE, reservation(dust, q.id, '0.00'))).rejects.toMatchObject({ code: '23000' })
    await db.query(RESERVE, reservation(dust, q.id, '0.01'))
    // Under-valuation (rounding down / truncation) and over-valuation are both refused: the value is derived, not declared.
    const odd = await committed((c) => fixture(c, { amount: '0.00123457' }))
    expect(exposure(odd.amount, '50000')).toBe('61.73')
    for (const wrong of ['61.72', '61.74', '0.01']) {
      await expect(db.query(RESERVE, reservation(odd, q.id, wrong))).rejects.toMatchObject({ code: '23000' })
    }
    await db.query(RESERVE, reservation(odd, q.id, '61.73'))
    expect(await count(`SELECT count(*) AS n FROM exposure_reservations WHERE "tradeId" = ANY($1)`, [[atCap.tradeId, overCap.tradeId, dust.tradeId, odd.tradeId]])).toBe(3)
    await purge()
  })

  it('9 / 10: one reservation per trade and per escrow — by the guard and, with the guard lifted, by the unique indexes themselves', async () => {
    pg.requirePostgres('9')
    const q = await currentQuote()
    const f = await committed((c) => fixture(c))
    const g = await committed((c) => fixture(c))
    const value = exposure(f.amount, '50000')
    await db.query(RESERVE, reservation(f, q.id, value))
    await expect(db.query(RESERVE, reservation(f, q.id, value))).rejects.toMatchObject({ code: '23505' })
    // Another trade's reservation cannot point at f's escrow (snapshot mismatch).
    await expect(db.query(RESERVE, reservation(g, q.id, value, { escrowId: f.escrowId }))).rejects.toMatchObject({ code: '23000' })
    await rolledBack(async (c) => {
      await c.query(`ALTER TABLE exposure_reservations DISABLE TRIGGER exposure_reservations_insert_guard`)
      await refused(c, '23505', RESERVE, reservation(g, q.id, value, { escrowId: f.escrowId }))
      await refused(c, '23505', RESERVE, reservation(g, q.id, value, { tradeId: f.tradeId }))
    })
    expect(await count(`SELECT count(*) AS n FROM exposure_reservations WHERE "tradeId" = ANY($1)`, [[f.tradeId, g.tradeId]])).toBe(1)
    await purge()
  })

  it('11 / 12 / C4: a committed reservation and the rows it snapshotted cannot drift; settlement of the escrow is not blocked', async () => {
    pg.requirePostgres('11')
    const q = await currentQuote()
    const f = await committed((c) => fixture(c))
    const other = await committed((c) => fixture(c))
    await db.query(RESERVE, reservation(f, q.id, exposure(f.amount, '50000')))
    const snapshot = async () => (await db.query(`SELECT * FROM exposure_reservations WHERE "tradeId" = $1`, [f.tradeId])).rows[0]
    const before = await snapshot()

    for (const set of [`"exposureUsd" = 0.01`, `"assetAmount" = 0.00000001`, `"paymentAccountId" = '${other.accountId}'`, `"sellerId" = '${other.sellerId}'`, `"quoteId" = "quoteId"`,
      `"policyVersionId" = "policyVersionId"`, `"paymentMethod" = 'TED'`, `"authorizedAt" = now()`]) {
      await expect(db.query(`UPDATE exposure_reservations SET ${set} WHERE "tradeId" = $1`, [f.tradeId])).rejects.toMatchObject({ code: '23000' })
    }
    await expect(db.query(`DELETE FROM exposure_reservations WHERE "tradeId" = $1`, [f.tradeId])).rejects.toMatchObject({ code: '23000' })

    // Sources of the snapshot: account/seller substitution, method relabel, amount/asset changes are refused.
    for (const [stmt, id] of [
      [`UPDATE trades SET "sellerPaymentAccountId" = '${other.accountId}' WHERE id = $1`, f.tradeId],
      [`UPDATE trades SET "sellerId" = '${other.sellerId}' WHERE id = $1`, f.tradeId],
      [`UPDATE trades SET amount = amount * 2 WHERE id = $1`, f.tradeId],
      [`UPDATE trades SET "offerId" = '${other.offerId}' WHERE id = $1`, f.tradeId],
      [`UPDATE escrows SET "lockedAmount" = "lockedAmount" * 2 WHERE id = $1`, f.escrowId],
      [`UPDATE escrows SET type = 'MOCK' WHERE id = $1`, f.escrowId],
      [`UPDATE payment_accounts SET "paymentMethod" = 'OTHER' WHERE id = $1`, f.accountId],
      [`UPDATE payment_accounts SET "ownerId" = '${other.sellerId}' WHERE id = $1`, f.accountId],
      [`UPDATE offers SET "paymentMethod" = 'BANK_TRANSFER' WHERE id = $1`, f.offerId],
      [`DELETE FROM trades WHERE id = $1`, f.tradeId],
      [`DELETE FROM payment_accounts WHERE id = $1`, f.accountId],
    ] as const) {
      await expect(db.query(stmt, [id])).rejects.toMatchObject({ code: expect.stringMatching(/^23/) })
    }
    // A new policy version (here in a rolled-back transaction) does not reinterpret the reservation.
    await rolledBack(async (c) => {
      const [text, params] = V2({ open: '1.00', fiat: '1.00' })
      await c.query(text, [...params])
      expect((await c.query(`SELECT "policyVersionId", "exposureUsd" FROM exposure_reservations WHERE "tradeId" = $1`, [f.tradeId])).rows[0]).toEqual({ policyVersionId: POLICY_V1, exposureUsd: before.exposureUsd })
    })
    // The escrow's own lifecycle — funding, completion — and the trade's status are untouched by the reservation.
    await db.query(`UPDATE escrows SET status = 'FUNDS_LOCKED', "txLockId" = $2 WHERE id = $1`, [f.escrowId, 'ab'.repeat(32)])
    await db.query(`UPDATE escrows SET status = 'COMPLETED', "txReleaseId" = $2 WHERE id = $1`, [f.escrowId, 'cd'.repeat(32)])
    await db.query(`UPDATE trades SET status = 'COMPLETED' WHERE id = $1`, [f.tradeId])
    await db.query(`UPDATE payment_accounts SET signed = true WHERE id = $1`, [f.accountId])
    expect(await snapshot()).toEqual(before)
    await purge()
  })

  it('13: invalid references are rejected — by the guard and, with the guard lifted, by the foreign keys', async () => {
    pg.requirePostgres('13')
    const q = await currentQuote()
    const f = await committed((c) => fixture(c))
    const value = exposure(f.amount, '50000')
    for (const over of [{ tradeId: 'missing' }, { escrowId: 'missing' }, { sellerId: 'missing' }, { paymentAccountId: 'missing' }, { policyVersionId: 'missing' }]) {
      await expect(db.query(RESERVE, reservation(f, q.id, value, over))).rejects.toMatchObject({ code: '23000' })
    }
    await expect(db.query(RESERVE, reservation(f, 'BTC:0', value))).rejects.toMatchObject({ code: '23000' })
    await rolledBack(async (c) => {
      await c.query(`ALTER TABLE exposure_reservations DISABLE TRIGGER exposure_reservations_insert_guard`)
      for (const over of [{ tradeId: 'missing' }, { escrowId: 'missing' }, { sellerId: 'missing' }, { paymentAccountId: 'missing' }, { policyVersionId: 'missing' }]) {
        await refused(c, '23503', RESERVE, reservation(f, q.id, value, over))
      }
      await refused(c, '23503', RESERVE, reservation(f, 'BTC:0', value))
      await c.query(`ALTER TABLE price_observations DISABLE TRIGGER price_observations_insert_guard`)
      await refused(c, '23503', `INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "collectedAt", "payloadSha256") VALUES ('o', 'BTC:0', 'KRAKEN', 1, now(), $1)`, [sha('z')])
    })
    expect(await count(`SELECT count(*) AS n FROM exposure_reservations WHERE "tradeId" = $1`, [f.tradeId])).toBe(0)
    await purge()
  })

  it('C5: quote shopping, stale quotes, a non-current policy and funded/closed escrows cannot be authorized by direct SQL', async () => {
    pg.requirePostgres('C5')
    // A historical quote (two windows ago) planted as state.
    const oldAsOf = new Date(Date.now() - 65_000)
    const cheap = await plantHistorical(oldAsOf, [{ operator: 'KRAKEN', price: '40000' }, { operator: 'COINBASE', price: '40000' }])
    const f = await committed((c) => fixture(c))
    // Only quote in existence and > 30 s but < 120 s old: usable.
    await rolledBack(async (c) => {
      await c.query(RESERVE, reservation(f, cheap.id, exposure(f.amount, '40000')))
    })
    // Once a newer quote exists, the cheaper older one cannot be chosen.
    await currentQuote()
    await expect(db.query(RESERVE, reservation(f, cheap.id, exposure(f.amount, '40000')))).rejects.toMatchObject({ code: '23000' })
    await purge()

    // A stale (> 120 s) quote, even the newest one, authorizes nothing.
    const stale = await plantHistorical(new Date(Date.now() - 150_000), AGREEING)
    await expect(db.query(RESERVE, reservation(f, stale.id, exposure(f.amount, '50000')))).rejects.toMatchObject({ code: '23000' })
    await purge()

    const fresh = await currentQuote()
    // Funded, completed or cancelled-trade escrows can never receive a reservation (no backfill, no late authorization).
    for (const o of [{ escrowStatus: 'FUNDS_LOCKED', txLockId: 'ef'.repeat(32) }, { escrowStatus: 'CREATED', txLockId: 'ef'.repeat(32) }, { escrowStatus: 'COMPLETED', txLockId: 'ef'.repeat(32) }, { tradeStatus: 'CANCELLED' }, { tradeStatus: 'COMPLETED' }]) {
      const h = await committed((c) => fixture(c, o))
      await expect(db.query(RESERVE, reservation(h, fresh.id, exposure(h.amount, '50000')))).rejects.toMatchObject({ code: '23000' })
    }
    // A reservation under a version that is not in force (a newer one activated in the same transaction) is refused.
    await rolledBack(async (c) => {
      const [text, params] = V2()
      await c.query(text, [...params])
      await refused(c, '23000', RESERVE, reservation(f, fresh.id, exposure(f.amount, '50000')))
    })
    await purge()
  })

  // ─── legacy ───────────────────────────────────────────────────────────────────────────────────────────────

  it('15 / C2: legacy escrows stay valid and unreserved — no default, no new column on existing tables, NULL is never zero', async () => {
    pg.requirePostgres('15')
    const legacy = await committed((c) => fixture(c, { escrowStatus: 'FUNDS_LOCKED', txLockId: '12'.repeat(32) }))
    await db.query(`UPDATE escrows SET status = 'COMPLETED', "txReleaseId" = $2 WHERE id = $1`, [legacy.escrowId, '34'.repeat(32)])
    await db.query(`UPDATE trades SET status = 'COMPLETED' WHERE id = $1`, [legacy.tradeId])
    const row = (await db.query(`SELECT e.status::text AS status, r."exposureUsd" FROM escrows e LEFT JOIN exposure_reservations r ON r."escrowId" = e.id WHERE e.id = $1`, [legacy.escrowId])).rows[0]
    expect(row).toEqual({ status: 'COMPLETED', exposureUsd: null })
    // Absence is representable only as absence: the economic columns have no defaults.
    const defaults = (await db.query(`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'exposure_reservations' AND column_name IN ('exposureUsd', 'assetAmount', 'quoteId', 'policyVersionId')`)).rows
    expect(defaults.every((d: { column_default: string | null }) => d.column_default === null)).toBe(true)
    // E1 adds no column to any existing table.
    const added = (await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('trades', 'escrows', 'users', 'payment_accounts', 'offers') AND column_name ~* 'exposure|reservation|quote|valuation'`)).rows
    expect(added).toEqual([])
  })

  it('16: the migration applies on a real database holding representative legacy rows, changes none of them, backfills nothing', async () => {
    pg.requirePostgres('16')
    const target = new URL(url())
    const scratch = `${target.pathname.slice(1)}_r7he1_${randomBytes(3).toString('hex')}`
    await db.query(`CREATE DATABASE "${scratch}"`)
    target.pathname = `/${scratch}`
    try {
      const c = await connect(target.toString())
      const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
      const prior = dirs.filter((d) => d < E1_MIGRATION)
      expect(dirs).toContain(E1_MIGRATION) // later migrations (e.g. R7H-E2 roles) are not part of this proof
      for (const d of prior) await c.query(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'))

      // Legacy: an open MULTISIG escrow, a funded one, a completed one, a non-MULTISIG one, an unbound trade.
      await c.query(`INSERT INTO users (id, "publicKey", "updatedAt") VALUES ('s', 'pk-s', now()), ('b', 'pk-b', now())`)
      await c.query(`INSERT INTO payment_accounts (id, "ownerId", "accountHash", "paymentMethod", "updatedAt") VALUES ('pa', 's', 'h', 'PIX', now())`)
      await c.query(`INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "updatedAt") VALUES ('o', 's', 'BTC', 'SELL', 60000, 0.0001, 1, 'PIX', now()), ('o2', 's', 'USDT_ERC20', 'SELL', 1, 1, 100, 'OTHER', now())`)
      for (const [id, offer, asset, status, account] of [['t1', 'o', 'BTC', 'ACTIVE', 'pa'], ['t2', 'o', 'BTC', 'ACTIVE', 'pa'], ['t3', 'o', 'BTC', 'COMPLETED', null], ['t4', 'o2', 'USDT_ERC20', 'ACTIVE', null]]) {
        await c.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt") VALUES ($1, $2, 'b', 's', $3, 0.001, 60000, 60, $4, $5, now())`, [id, offer, asset, status, account])
      }
      for (const [id, trade, type, asset, status, lock] of [['e1', 't1', 'MULTISIG', 'BTC', 'CREATED', null], ['e2', 't2', 'MULTISIG', 'BTC', 'FUNDS_LOCKED', 'aa'.repeat(32)], ['e3', 't3', 'MULTISIG', 'BTC', 'COMPLETED', 'bb'.repeat(32)], ['e4', 't4', 'MOCK', 'USDT_ERC20', 'CREATED', null]]) {
        await c.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "txLockId", "updatedAt") VALUES ($1, $2, $3, $4, 0.001, $5, $6, now())`, [id, trade, type, status, asset, lock])
      }
      const digest = async () => (await c.query(`SELECT ${['users', 'offers', 'trades', 'escrows', 'payment_accounts'].map((t) => `(SELECT md5(string_agg(x::text, '|' ORDER BY x.id)) FROM ${t} x) AS ${t}`).join(', ')}`)).rows[0]
      const before = await digest()

      await c.query(readFileSync(join(MIGRATIONS, E1_MIGRATION, 'migration.sql'), 'utf8'))

      expect(await digest()).toEqual(before)
      expect((await c.query(`SELECT count(*)::int AS n FROM exposure_reservations`)).rows[0].n).toBe(0)
      expect((await c.query(`SELECT count(*)::int AS n FROM valuation_quotes`)).rows[0].n).toBe(0)
      expect((await c.query(`SELECT id, version FROM trade_limit_policy_versions`)).rows).toEqual([{ id: POLICY_V1, version: 1 }])
      // Every legacy escrow is classifiable as "no reservation" — and none can be given one after the fact except a
      // still-open, unfunded MULTISIG escrow of a bound PIX trade (which still needs a fresh quote).
      expect((await c.query(`SELECT e.id FROM escrows e LEFT JOIN exposure_reservations r ON r."escrowId" = e.id WHERE r.id IS NULL ORDER BY e.id`)).rows.map((r) => r.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
      for (const [trade, escrow] of [['t2', 'e2'], ['t3', 'e3'], ['t4', 'e4'], ['t1', 'e1']]) {
        await expect(c.query(`INSERT INTO exposure_reservations (id, "tradeId", "escrowId", "sellerId", "paymentAccountId", "policyVersionId", "quoteId", "paymentMethod", "escrowType", asset, "assetAmount", "exposureUsd") VALUES ($1, $2, $3, 's', 'pa', $4, 'BTC:0', 'PIX', 'MULTISIG', 'BTC', 0.001, 60)`, [`r-${trade}`, trade, escrow, POLICY_V1]))
          .rejects.toMatchObject({ code: '23000' })
      }
      // Ordinary lifecycle writes on legacy rows are unaffected by the new guards.
      await c.query(`UPDATE escrows SET status = 'FUNDS_LOCKED', "txLockId" = $1 WHERE id = 'e1'`, ['cc'.repeat(32)])
      await c.query(`UPDATE trades SET status = 'CANCELLED', amount = 0.002 WHERE id = 't4'`)
      await c.query(`UPDATE payment_accounts SET signed = true, "paymentMethod" = 'TED' WHERE id = 'pa'`)
      await release(c)
    } finally {
      await db.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`)
    }
  })
})
