/**
 * F4 / invariant 3b, S1 - the MIGRATION itself (20261122122000) against real PostgreSQL, in a scratch database built from every
 * migration BEFORE it (applied file by file). Proves: the cut marks existing rows from ONE instant, atomicity (a session killed
 * mid-migration leaves nothing), the bounded lock (lock_timeout fails clean, nothing changes), the transaction guard (LOCK TABLE
 * outside a transaction block fails closed), and that a concurrent INSERT waits and then runs under the triggers.
 */
import { randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const MIG_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations')
const F4 = '20261122122000_f4_escrow_commitment_binding'

describe('F4 S1 - migration process (scratch database)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  const NAME = `sails_f4_mig_${randomUUID().slice(0, 8)}`
  let admin: Client
  let url = ''
  const conns: Client[] = []
  const connect = async () => { const c = new Client({ connectionString: url }); await c.connect(); conns.push(c); return c }
  const f4sql = () => readFileSync(path.join(MIG_DIR, F4, 'migration.sql'), 'utf8')

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    const base = new URL(process.env.DATABASE_URL as string)
    admin = new Client({ connectionString: base.toString().replace(/\/[^/?]*(\?|$)/, '/postgres$1') })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${NAME}`)
    base.pathname = '/' + NAME
    url = base.toString()
    const c = await connect()
    const dirs = readdirSync(MIG_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name < F4).map((d) => d.name).sort()
    for (const d of dirs) await c.query(readFileSync(path.join(MIG_DIR, d, 'migration.sql'), 'utf8'))
  }, 240_000)

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => undefined)
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => undefined); await admin.end() }
  })

  const hasCol = async (c: Client, col: string) => (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='escrows' AND column_name=$1`, [col])).rowCount === 1
  const hasTrigger = async (c: Client, n: string) => (await c.query(`SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal`, [n])).rowCount === 1

  async function seedEscrow(c: Client, withAddress: boolean) {
    const u = (await c.query(`INSERT INTO users (id,"publicKey","updatedAt") VALUES ($1,$2,now()) RETURNING id`, [randomUUID(), randomUUID()])).rows[0].id
    const o = (await c.query(`INSERT INTO offers (id,"userId",asset,side,"priceUsd","minAmount","maxAmount","paymentMethod","updatedAt") VALUES ($1,$2,'BTC','SELL',1,0.001,0.01,'PIX',now()) RETURNING id`, [randomUUID(), u])).rows[0].id
    const t = (await c.query(`INSERT INTO trades (id,"offerId","buyerId","sellerId",asset,amount,"priceUsd","totalUsd","updatedAt") VALUES ($1,$2,$3,$3,'BTC',0.005,1,1,now()) RETURNING id`, [randomUUID(), o, u])).rows[0].id
    return (await c.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"multisigAddr","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now()) RETURNING id`, [randomUUID(), t, withAddress ? 'bc1qlegacy' : null])).rows[0].id
  }

  it('1. the transaction guard: the REAL file run statement by statement WITHOUT a wrapping transaction fails closed at its lock, before any DDL', async () => {
    const c = await connect()
    const body = f4sql().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    const stmts = body.split(/;[ \t]*\n/).map((x) => x.trim()).filter(Boolean).slice(0, 4) // SET LOCAL x2, LOCK TABLE, first ALTER
    let failedAt = -1
    for (let i = 0; i < stmts.length; i++) {
      try { await c.query(stmts[i]) } catch (e: any) { expect(e.code).toBe('25P01'); failedAt = i; break } // no_active_sql_transaction (messages are localized)
    }
    expect(stmts[failedAt]).toMatch(/^LOCK TABLE/)
    expect(await hasCol(c, 'legacyPreCommitmentAt')).toBe(false)
  })

  it('2. atomicity: a session killed mid-migration (after the DDL, before COMMIT) leaves NOTHING behind', async () => {
    const victim = await connect()
    victim.on('error', () => undefined) // the server terminates this session on purpose
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await victim.query('BEGIN')
    await victim.query(`SET LOCAL lock_timeout='5s'`)
    await victim.query(`LOCK TABLE "escrows" IN SHARE ROW EXCLUSIVE MODE`)
    await victim.query(`ALTER TABLE "escrows" ADD COLUMN "commitmentPairId" TEXT, ADD COLUMN "legacyPreCommitmentAt" TIMESTAMPTZ(3), ADD COLUMN "addressPresentAtCutAt" TIMESTAMPTZ(3)`)
    const killer = await connect()
    await killer.query('SELECT pg_terminate_backend($1)', [pid])
    await expect(victim.query('SELECT 1')).rejects.toBeTruthy()
    const probe = await connect()
    expect(await hasCol(probe, 'commitmentPairId')).toBe(false)
    expect(await hasCol(probe, 'legacyPreCommitmentAt')).toBe(false)
    expect(await hasTrigger(probe, 'escrows_f4_guard_insert')).toBe(false)
  })

  it('3. bounded lock: a writer holding the table makes the migration fail with lock_timeout, and NOTHING changes', async () => {
    const holder = await connect()
    await seedEscrow(holder, true) // committed legacy-ish row first
    await holder.query('BEGIN')
    await holder.query(`UPDATE escrows SET "updatedAt" = now()`) // ROW EXCLUSIVE held, conflicts with SHARE ROW EXCLUSIVE
    const mig = await connect()
    await mig.query('BEGIN')
    await mig.query(`SET LOCAL lock_timeout='1s'`)
    const t0 = Date.now()
    await expect(mig.query(`LOCK TABLE "escrows" IN SHARE ROW EXCLUSIVE MODE`)).rejects.toMatchObject({ code: '55P03' }) // lock_not_available
    expect(Date.now() - t0).toBeLessThan(5000)
    await mig.query('ROLLBACK')
    await holder.query('ROLLBACK')
    expect(await hasCol(mig, 'legacyPreCommitmentAt')).toBe(false)
    expect(f4sql()).toMatch(/SET LOCAL lock_timeout = '5s'/) // the shipped file carries a bound
    expect(f4sql()).toMatch(/SET LOCAL statement_timeout = '120s'/)
  })

  it('4. the real file in ONE transaction: every existing row is marked legacy from ONE instant; the address mark only where an address existed; a concurrent INSERT waits, then runs under the triggers', async () => {
    const c = await connect()
    const withAddr = await seedEscrow(c, true), withoutAddr = await seedEscrow(c, false)
    const mig = await connect()
    await mig.query('BEGIN')
    await mig.query(f4sql())
    // while the migration transaction is open, a concurrent INSERT must WAIT (it cannot slip in unmarked)
    const writer = await connect()
    let writerDone = false
    const writing = writer.query(`INSERT INTO users (id,"publicKey","updatedAt") VALUES ($1,$2,now())`, [randomUUID(), randomUUID()])
      .then(async () => { // a fresh trade+escrow insert path touches escrows: use a minimal row
        const u = (await writer.query(`SELECT id FROM users LIMIT 1`)).rows[0].id
        const o = (await writer.query(`INSERT INTO offers (id,"userId",asset,side,"priceUsd","minAmount","maxAmount","paymentMethod","updatedAt") VALUES ($1,$2,'BTC','SELL',1,0.001,0.01,'PIX',now()) RETURNING id`, [randomUUID(), u])).rows[0].id
        const t = (await writer.query(`INSERT INTO trades (id,"offerId","buyerId","sellerId",asset,amount,"priceUsd","totalUsd","updatedAt") VALUES ($1,$2,$3,$3,'BTC',0.005,1,1,now()) RETURNING id`, [randomUUID(), o, u])).rows[0].id
        try { await writer.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now())`, [randomUUID(), t]) } catch (e: any) { return String(e.message) } finally { writerDone = true }
        return 'inserted'
      })
    await new Promise((r) => setTimeout(r, 1500))
    expect(writerDone).toBe(false) // blocked behind the migration's table lock
    await mig.query('COMMIT')
    const outcome = await writing
    expect(outcome).toMatch(/needs a COMMITTED commitment pair/) // it ran AFTER the commit, under the new trigger
    const rows = (await c.query(`SELECT id, "legacyPreCommitmentAt" AS l, "addressPresentAtCutAt" AS a, "multisigAddr" FROM escrows`)).rows
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) expect(r.l).not.toBeNull()
    expect(new Set(rows.map((r) => r.l.getTime())).size).toBe(1) // ONE instant
    const a = rows.find((r) => r.id === withAddr), b = rows.find((r) => r.id === withoutAddr)
    expect(a.a).not.toBeNull()
    expect(a.a.getTime()).toBe(a.l.getTime())
    expect(b.a).toBeNull()
    expect((await c.query(`SELECT count(*)::int AS n FROM deployment_mode`)).rows[0].n).toBe(0) // gate 3: the migration inserts NOTHING (no row = production)
    await expect(c.query(`INSERT INTO deployment_mode (mode) VALUES ('production')`)).rejects.toMatchObject({ code: '23514' }) // there is no production value
  })

  it('5. after the migration the legacy rows keep their cycle (group B) but a legacy escrow without an address cannot be funded or addressed', async () => {
    const c = await connect()
    const id = (await c.query(`SELECT id FROM escrows WHERE "multisigAddr" IS NULL LIMIT 1`)).rows[0].id
    await expect(c.query(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [id])).rejects.toThrow(/funding is registered only under a COMMITTED/)
    await expect(c.query(`UPDATE escrows SET "multisigAddr"='bc1qnew' WHERE id=$1`, [id])).rejects.toThrow(/stored only under a COMMITTED/)
    const idWith = (await c.query(`SELECT id FROM escrows WHERE "multisigAddr" IS NOT NULL LIMIT 1`)).rows[0].id
    expect((await c.query(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [idWith])).rowCount).toBe(1) // legacy with address at the cut
  })
})

describe('F4 S1 - three sessions across the cut (own scratch database)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  const NAME = `sails_f4_3s_${randomUUID().slice(0, 8)}`
  let admin: Client
  const conns: Client[] = []
  let url = ''
  const open = async () => { const c = new Client({ connectionString: url }); await c.connect(); conns.push(c); return c }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    const base = new URL(process.env.DATABASE_URL as string)
    const au = new URL(base.toString()); au.pathname = '/postgres'
    admin = new Client({ connectionString: au.toString() }); await admin.connect()
    await admin.query(`CREATE DATABASE ${NAME}`)
    base.pathname = '/' + NAME; url = base.toString()
    const c = await open()
    for (const d of readdirSync(MIG_DIR, { withFileTypes: true }).filter((x) => x.isDirectory() && x.name < F4).map((x) => x.name).sort()) await c.query(readFileSync(path.join(MIG_DIR, d, 'migration.sql'), 'utf8'))
  }, 240_000)
  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => undefined)
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => undefined); await admin.end() }
  })

  it('A runs the migration; B (new escrow) and C (funds a legacy escrow without address) both WAIT, then both run under the triggers and are refused; nothing is left unmarked', async () => {
    const A = await open(), B = await open(), C = await open()
    const u = (await A.query(`INSERT INTO users (id,"publicKey","updatedAt") VALUES ($1,$2,now()) RETURNING id`, [randomUUID(), randomUUID()])).rows[0].id
    const o = (await A.query(`INSERT INTO offers (id,"userId",asset,side,"priceUsd","minAmount","maxAmount","paymentMethod","updatedAt") VALUES ($1,$2,'BTC','SELL',1,0.001,0.01,'PIX',now()) RETURNING id`, [randomUUID(), u])).rows[0].id
    const mkTrade = async () => (await A.query(`INSERT INTO trades (id,"offerId","buyerId","sellerId",asset,amount,"priceUsd","totalUsd","updatedAt") VALUES ($1,$2,$3,$3,'BTC',0.005,1,1,now()) RETURNING id`, [randomUUID(), o, u])).rows[0].id
    const legacyTrade = await mkTrade(), newTrade = await mkTrade()
    const legacyId = (await A.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now()) RETURNING id`, [randomUUID(), legacyTrade])).rows[0].id

    await A.query('BEGIN')
    await A.query(f4sqlText())
    const done = { b: false, c: false }
    const pb = B.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now())`, [randomUUID(), newTrade]).then(() => 'inserted', (e) => String(e.message)).finally(() => { done.b = true })
    const pc = C.query(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [legacyId]).then(() => 'funded', (e) => String(e.message)).finally(() => { done.c = true })
    await new Promise((r) => setTimeout(r, 1500))
    expect(done).toEqual({ b: false, c: false }) // both queued behind A's table lock
    await A.query('COMMIT')
    expect(await pb).toMatch(/needs a COMMITTED commitment pair/)
    expect(await pc).toMatch(/funding is registered only under a COMMITTED/)
    const unmarked = await A.query(`SELECT count(*)::int AS n FROM escrows WHERE "legacyPreCommitmentAt" IS NULL`)
    expect(unmarked.rows[0].n).toBe(0)
    expect((await A.query(`SELECT status FROM escrows WHERE id=$1`, [legacyId])).rows[0].status).toBe('CREATED')
  })
})

function f4sqlText(): string { return readFileSync(path.join(MIG_DIR, F4, 'migration.sql'), 'utf8') }
