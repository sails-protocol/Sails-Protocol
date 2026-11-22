/**
 * M-1b step 2 (GK B1/B2/B3): the wiring of the capacity reservation to the COMMITTED transition, read from the real catalog.
 * Trigger order (by name, after the F3 guard), the narrow WHEN, the order MUTANT (a name that sorts first is detected), the
 * invariant "no COMMITTED pair without its reservation", the service mapping of the E25_OFFER_* refusals (409, never a raw 500),
 * and the SECURITY DEFINER shape. The runtime-grant assertions live in f4RuntimeGrants (scratch database, grants applied).
 */
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

describe('M-1b wiring: reservation trigger on COMMITTED (real catalog)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, db: Client
  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  })
  afterAll(async () => { if (db) await db.end().catch(() => undefined); if (prisma) await prisma.$disconnect() })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })
  const triggerNames = async () => (await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='commitment_pairs'::regclass AND NOT tgisinternal AND tgtype & 16 = 16 ORDER BY tgname`)).rows.map((r) => r.tgname as string)

  run('order: the reservation sorts AFTER the F3 guard among BEFORE UPDATE triggers; WHEN fires only INTO COMMITTED', async () => {
    const names = await triggerNames()
    expect(names).toContain('commitment_pairs_reserve_capacity')
    expect(names.indexOf('commitment_pairs_reserve_capacity')).toBeGreaterThan(names.indexOf('commitment_pairs_guard_update'))
    const def = (await db.query(`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname='commitment_pairs_reserve_capacity' AND tgrelid='commitment_pairs'::regclass`)).rows[0].d as string
    expect(def).toMatch(/BEFORE UPDATE OF state ON/)
    expect(def).toMatch(/WHEN .*new\.state = 'COMMITTED'/i) // pg_get_triggerdef prints identifiers lower-cased
    expect(def).toMatch(/FOR EACH ROW/)
  })

  run('MUTANT (order): a name that sorts BEFORE the guard is detected by the same catalog read, then rolled back', async () => {
    await db.query('BEGIN')
    try {
      await db.query(`ALTER TRIGGER commitment_pairs_reserve_capacity ON commitment_pairs RENAME TO commitment_pairs_aaa_reserve`)
      const names = await triggerNames()
      expect(names.indexOf('commitment_pairs_aaa_reserve')).toBeLessThan(names.indexOf('commitment_pairs_guard_update'))
    } finally { await db.query('ROLLBACK') }
    expect(await triggerNames()).toContain('commitment_pairs_reserve_capacity')
  })

  run('invariant (kills "no trigger"): every COMMITTED pair of a fixture has exactly one RESERVED reservation of its trade amount', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0x81 })
    const a = await fx.admitTrade('PENDING'), b = await fx.admitTrade('PENDING')
    const pa = await fx.commitExistingTrade((await prisma.trade.findFirstOrThrow({ where: { tradeIntentId: a.anchorRef } })).id)
    const pb = await fx.commitExistingTrade((await prisma.trade.findFirstOrThrow({ where: { tradeIntentId: b.anchorRef } })).id)
    const rows = (await db.query(
      `SELECT p.id, count(r.id)::int AS n, coalesce(sum(r.amount),0)::text AS amt FROM commitment_pairs p LEFT JOIN offer_capacity_reservations r ON r."commitmentPairId"=p.id
        WHERE p.id = ANY($1) AND p.state='COMMITTED' GROUP BY p.id`, [[pa, pb]])).rows
    expect(rows).toHaveLength(2)
    for (const r of rows) { expect(r.n).toBe(1); expect(Number(r.amt)).toBe(0.005) }
  })

  run('service mapping: no declared capacity => the COMMITTED transition is refused as E25_OFFER_CAPACITY_NOT_CONFIGURED (409), pair stays PARTIALLY_SIGNED', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0x82 })
    const { anchorRef } = await fx.admitTrade('PENDING')
    const p = await fx.proposePartialPair(anchorRef)
    await expect(p.signMaker()).rejects.toMatchObject({ code: 'E25_OFFER_CAPACITY_NOT_CONFIGURED', statusCode: 409 })
    expect((await db.query(`SELECT state FROM commitment_pairs WHERE id=$1`, [p.pairId])).rows[0].state).toBe('PARTIALLY_SIGNED')
    expect((await db.query(`SELECT count(*)::int AS n FROM offer_capacity_reservations WHERE "commitmentPairId"=$1`, [p.pairId])).rows[0].n).toBe(0)
  })

  run('service mapping: a trade WITHOUT acceptedEnvelopeId (legacy) is refused as E25_OFFER_NOT_RESOLVED (fail-closed, CTO 029 decision)', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0x83 })
    await fx.declareCapacity()
    // a legacy-shaped trade: admitted (own Intent) but never bound to the envelope it accepted
    const intent = await prisma.intent.create({ data: { type: 'TradeIntent', participantId: fx.takerId, moduleId: 'openp2p', payload: {}, status: 'PENDING' } })
    await prisma.trade.create({ data: { offerId: fx.legacyOfferId, sellerId: fx.makerId, buyerId: fx.takerId, asset: 'BTC', amount: '0.005', status: 'PENDING', priceUsd: '65000', totalUsd: '325', tradeIntentId: intent.id } })
    const p = await fx.proposePartialPair(intent.id)
    await expect(p.signMaker()).rejects.toMatchObject({ code: 'E25_OFFER_NOT_RESOLVED', statusCode: 409 })
  })

  const preInsert = (pairId: string, anchorRef: string, owner: string, offer: string, amount: string) => db.query(
    `INSERT INTO offer_capacity_reservations ("id","ownerPublicKey","logicalOfferId","tradeIntentId","commitmentPairId","amount","capacityRevisionObserved","capacityTotalAtReservation","offerRevision","offerEnvelopeDigest")
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,1,1000000,1,'x')`, [owner, offer, anchorRef, pairId, amount])

  run('B4 (a): the reservation function is SECURITY DEFINER with a fixed search_path (the runtime has no INSERT/UPDATE on reservations: proven as sails_runtime in f4RuntimeGrants test 7)', async () => {
    const def = (await db.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname='commitment_pairs_reserve_capacity'`)).rows[0]
    expect(def.prosecdef).toBe(true)
    expect((def.proconfig as string[]).join(',')).toContain('search_path=pg_catalog, public')
  })

  run('B4 (b) MUTANT "idempotence without checking amount": a reservation pre-seeded (superuser) with a SMALLER amount for the same pair is refused as ANCHOR_RESERVED, never accepted as "already reserved"', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0x85 })
    await fx.declareCapacity()
    const { anchorRef } = await fx.admitTrade('PENDING')
    const p = await fx.proposePartialPair(anchorRef)
    await preInsert(p.pairId, anchorRef, fx.envelopeRow.ownerPublicKey, fx.logicalOfferId, '0.00000001')
    await expect(p.signMaker()).rejects.toMatchObject({ code: 'E25_OFFER_CAPACITY_ANCHOR_RESERVED', statusCode: 409 })
    expect((await db.query(`SELECT state FROM commitment_pairs WHERE id=$1`, [p.pairId])).rows[0].state).toBe('PARTIALLY_SIGNED')
  })

  run('B8 (migration part): EXECUTE is not PUBLIC on any M-1b function; the reviewer role (required by the migration) may call execute_unblock only. The sails_runtime grants are asserted in f4RuntimeGrants test 7 (the grants file does not run in the legacy single-credential lane)', async () => {
    const fns = ['offer_capacity_try_release', 'offer_capacity_request_unblock', 'offer_capacity_settlement_proof', 'offer_capacity_execute_unblock', 'offer_capacity_block_on_evidence', 'offer_capacity_unblock_digest', 'commitment_pairs_reserve_capacity']
    for (const fn of fns) {
      const publicCan = (await db.query(`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.proname = $1 AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS ok`, [fn])).rows[0].ok as boolean
      expect([fn, publicCan]).toEqual([fn, false])
    }
    const can = async (role: string, fn: string) => (await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok as boolean
    expect(await can('sails_capacity_reviewer', 'offer_capacity_execute_unblock(text, text, text)')).toBe(true)
    expect(await can('sails_capacity_reviewer', 'offer_capacity_try_release(text)')).toBe(false)
  })

  run('B6 (three orders): the escrow guard reads the trade FOR SHARE, so a cancel cannot slip between the guard read and the FK; and the release (trade FOR UPDATE) and an escrow INSERT exclude each other', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0x86 })
    const c = await fx.committedPair()
    const db2 = new Client({ connectionString: process.env.DATABASE_URL }); await db2.connect()
    try {
      // order 1: the escrow INSERT is in flight (guard has read the trade) -> the cancel must WAIT (lock_timeout 55P03), not slip through
      await db2.query('BEGIN')
      await db2.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), c.tradeId, c.pairId])
      await db.query(`SET lock_timeout = '1s'`)
      let cancelCode: string | null = null
      try { await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [c.tradeId]) } catch (e: any) { cancelCode = e.code }
      await db.query('RESET lock_timeout')
      expect(cancelCode).toBe('55P03') // mutant "no FOR SHARE": the cancel would not wait and this would be null
      await db2.query('COMMIT')
      // after the escrow committed, the cancel goes through and the release sees the escrow: KEEP
      await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [c.tradeId])
      expect((await db.query(`SELECT offer_capacity_try_release($1) AS r`, [c.anchorRef])).rows[0].r).toBe('KEEP:escrow_not_terminal_CREATED')
      // order 3: the release holds the trade row (FOR UPDATE) -> an escrow INSERT for another trade of the same kind waits, never slips in
      const d = await fx.committedPair()
      await db2.query('BEGIN')
      await db2.query(`SELECT 1 FROM trades WHERE id=$1 FOR UPDATE`, [d.tradeId])
      await db.query(`SET lock_timeout = '1s'`)
      let insCode: string | null = null
      try { await db.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), d.tradeId, d.pairId]) } catch (e: any) { insCode = e.code }
      await db.query('RESET lock_timeout')
      await db2.query('ROLLBACK')
      expect(insCode).toBe('55P03')
      // order 2 (cancel committed first): the INSERT is refused for a CANCELLED trade
      await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [d.tradeId])
      await expect(db.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), d.tradeId, d.pairId])).rejects.toThrow(/CANCELLED/)
      expect((await db.query(`SELECT offer_capacity_try_release($1) AS r`, [d.anchorRef])).rows[0].r).toBe('RELEASED:L1_TRADE_CANCELLED_NO_ESCROW')
    } finally { await db2.query('ROLLBACK').catch(() => undefined); await db2.end() }
  })
})
