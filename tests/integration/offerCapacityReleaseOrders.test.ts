/**
 * M-1b slice 3, GK B6 / CTO Despacho 054 ("three orders"), real PostgreSQL with REAL barriers (separate connections, each step seen
 * WAITING on a lock before the holder is let go). The three actors on ONE trade are:
 *   C = the cancel (UPDATE trades SET status='CANCELLED'), E = the escrow INSERT (F4 guard reads the trade FOR SHARE, migration 134000),
 *   R = offer_capacity_try_release (trade FOR UPDATE, then the escrow).
 * The forbidden outcome in every order is "the reservation is RELEASED while an escrow exists for the trade" (the capacity would be
 * freed for funds that are still committed) and "an escrow exists for a trade whose cancel committed first".
 *   order 1 (E first):  E holds the trade FOR SHARE -> C is seen WAITING -> E commits -> C commits -> R keeps (escrow exists).
 *   order 2 (C first):  C holds the trade row -> E is seen WAITING on the guard's FOR SHARE -> C commits -> E is refused -> R releases whole.
 *   order 3 (R between): the cancel is committed; R holds the trade FOR UPDATE -> E is seen WAITING -> R commits released -> E is refused.
 * Without the FOR SHARE in 134000 (a plain read) order 2 lets E read ACTIVE and commit after C: the mutant is recorded in the PR.
 */
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

describe('M-1b release: cancel x escrow x release in three orders with real barriers (real PG)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, db: Client
  const clients: Client[] = []
  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); clients.push(db)
  })
  afterAll(async () => { for (const c of clients) await c.end().catch(() => undefined); if (prisma) await prisma.$disconnect() })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })

  async function session(name: string): Promise<{ c: Client; app: string }> {
    const app = `b6-${name}-${randomUUID().slice(0, 8)}`
    const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: app }); await c.connect(); clients.push(c)
    return { c, app }
  }
  /** Seen waiting on a lock held by another session (pg_stat_activity), never a sleep that merely hopes. */
  async function waitingOnLock(app: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const n = Number((await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app])).rows[0].n)
      if (n > 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`${app} never waited on a lock: the barrier is not real`)
  }
  const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: e as { code?: string; message?: string } }))
  const insertEscrow = (c: Client, tradeId: string, pairId: string) => c.query(
    `INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), tradeId, pairId])
  const cancel = (c: Client, tradeId: string) => c.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [tradeId])
  const release = async (c: Client, anchor: string) => (await c.query(`SELECT offer_capacity_try_release($1) AS r`, [anchor])).rows[0].r as string
  const reservation = async (anchor: string) => (await db.query(`SELECT state FROM offer_capacity_reservations WHERE "tradeIntentId"=$1`, [anchor])).rows[0].state as string
  const escrows = async (tradeId: string) => Number((await db.query(`SELECT count(*)::int AS n FROM escrows WHERE "tradeId"=$1`, [tradeId])).rows[0].n)
  const tradeStatus = async (tradeId: string) => (await db.query(`SELECT status::text AS s FROM trades WHERE id=$1`, [tradeId])).rows[0].s as string
  const open = async (offer: string) => Number((await db.query(`SELECT coalesce(sum(amount),0)::text AS s FROM offer_capacity_reservations WHERE "logicalOfferId"=$1 AND state='RESERVED'`, [offer])).rows[0].s)

  run('order 1 (escrow first): the cancel waits on the escrow INSERT; both commit; the release KEEPS the reservation (an escrow exists)', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0xc1 })
    const s = await fx.committedPair('ACTIVE')
    const E = await session('E'), C = await session('C')
    await E.c.query('BEGIN'); await insertEscrow(E.c, s.tradeId, s.pairId) // holds the trade FOR SHARE (guard) and the new escrow row
    await C.c.query('BEGIN')
    const cancelled = settle(cancel(C.c, s.tradeId))
    await waitingOnLock(C.app)
    await E.c.query('COMMIT')
    expect((await cancelled).ok).toBe(true)
    await C.c.query('COMMIT')
    expect(await tradeStatus(s.tradeId)).toBe('CANCELLED')
    expect(await escrows(s.tradeId)).toBe(1)
    const r = await release(db, s.anchorRef)
    expect(r.startsWith('RELEASED:')).toBe(false)
    expect(await reservation(s.anchorRef)).toBe('RESERVED')
    expect(await open(fx.logicalOfferId)).toBeGreaterThan(0)
  })

  run('order 2 (cancel first): the escrow INSERT waits on the cancel (guard FOR SHARE), then is REFUSED; the release frees the reservation whole', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0xc2 })
    const s = await fx.committedPair('ACTIVE')
    const C = await session('C'), E = await session('E')
    await C.c.query('BEGIN'); await cancel(C.c, s.tradeId) // holds the trade row, uncommitted
    await E.c.query('BEGIN')
    const inserted = settle(insertEscrow(E.c, s.tradeId, s.pairId))
    await waitingOnLock(E.app) // the guard's FOR SHARE read of the trade queues behind the cancel
    await C.c.query('COMMIT')
    const e = await inserted
    expect(e.ok).toBe(false)
    await E.c.query('ROLLBACK')
    expect(await escrows(s.tradeId)).toBe(0)
    expect((await release(db, s.anchorRef)).startsWith('RELEASED:')).toBe(true)
    expect(await reservation(s.anchorRef)).toBe('RELEASED')
    expect(await open(fx.logicalOfferId)).toBe(0)
  })

  run('order 3 (release between): the cancel is committed; the release holds the trade FOR UPDATE; the escrow INSERT waits, then is REFUSED; the release stands', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0xc3 })
    const s = await fx.committedPair('ACTIVE')
    await cancel(db, s.tradeId)
    const R = await session('R'), E = await session('E')
    await R.c.query('BEGIN')
    expect((await release(R.c, s.anchorRef)).startsWith('RELEASED:')).toBe(true) // holds trade FOR UPDATE + the reservation row, uncommitted
    await E.c.query('BEGIN')
    const inserted = settle(insertEscrow(E.c, s.tradeId, s.pairId))
    await waitingOnLock(E.app)
    await R.c.query('COMMIT')
    expect((await inserted).ok).toBe(false)
    await E.c.query('ROLLBACK')
    expect(await escrows(s.tradeId)).toBe(0)
    expect(await reservation(s.anchorRef)).toBe('RELEASED')
    expect(await open(fx.logicalOfferId)).toBe(0)
  })
})
