/**
 * M-1b step 2 (GK B1/B2/B3): the wiring of the capacity reservation to the COMMITTED transition, read from the real catalog.
 * Trigger order (by name, after the F3 guard), the narrow WHEN, the order MUTANT (a name that sorts first is detected), the
 * invariant "no COMMITTED pair without its reservation", the service mapping of the E25_OFFER_* refusals (409, never a raw 500),
 * and the SECURITY DEFINER shape. The runtime-grant assertions live in f4RuntimeGrants (scratch database, grants applied).
 */
import { Client } from 'pg'
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
})
