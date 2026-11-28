/**
 * M-1b slice 3 (CTO 047, decision B1 = L1 + L2 + L3, FAIL-CLOSED): the release of a capacity reservation, real Postgres.
 * "offer_capacity_try_release(tradeIntentId)" takes no proof from the caller: it re-derives the facts under locks and releases the
 * WHOLE reservation or keeps it. Covered: L1 (cancelled trade, no escrow), L2 (never funded, strict), L3 (final at the policy depth),
 * the NEVER cases, idempotence, a concurrent double release, transactional rollback, and the caller-supplied-proof mutant.
 */
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

describe('M-1b release: L1/L2/L3 fail-closed (real PG)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, db: Client, db2: Client
  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
    db2 = new Client({ connectionString: process.env.DATABASE_URL }); await db2.connect()
  })
  afterAll(async () => { for (const c of [db, db2]) if (c) await c.end().catch(() => undefined); if (prisma) await prisma.$disconnect() })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })

  const release = async (c: Client, anchor: string) => (await c.query(`SELECT offer_capacity_try_release($1) AS r`, [anchor])).rows[0].r as string
  const state = async (anchor: string) => (await db.query(`SELECT state, "releaseKind" FROM offer_capacity_reservations WHERE "tradeIntentId"=$1`, [anchor])).rows[0]
  const open = async (offer: string) => Number((await db.query(`SELECT coalesce(sum(amount),0)::text AS s FROM offer_capacity_reservations WHERE "logicalOfferId"=$1 AND state='RESERVED'`, [offer])).rows[0].s)
  async function reserved(seed: number, escrow?: Record<string, unknown>) {
    const fx = await createCommitmentFixture(prisma, { seed })
    const c = await fx.committedPair()
    const e = escrow ? await fx.createTestEscrow({ type: 'MULTISIG', ...escrow }, { tradeId: c.tradeId, pairId: c.pairId }) : null
    return { fx, ...c, escrow: e }
  }
  const setEscrow = (id: string, sets: string) => db.query(`UPDATE escrows SET ${sets} WHERE id=$1`, [id])
  const funding = (escrowId: string, kind: string, at: string) => db.query(`INSERT INTO escrow_funding_evidence (id,"escrowId",kind,"recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",$4)`, [randomUUID(), escrowId, kind, at])
  const releaseEv = (escrowId: string, kind: string, h: number | null, tip: number | null, at: string) => db.query(
    `INSERT INTO escrow_release_evidence (id,"escrowId",kind,txid,"observedAtHeight","tipHeightAtObservation","recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",'tx1',$4,$5,$6)`, [randomUUID(), escrowId, kind, h, tip, at])
  const T = (s: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString()

  run('mutant: no proof, kind or amount can be supplied (the function takes ONE argument, the trade anchor)', async () => {
    const r = (await db.query(`SELECT pg_get_function_arguments(oid) AS a, prosecdef FROM pg_proc WHERE proname='offer_capacity_try_release'`)).rows[0]
    expect(r.a).toBe('p_trade_intent_id text')
    expect(r.prosecdef).toBe(true)
  })

  run('L1: a PENDING trade keeps the reservation; once CANCELLED with no escrow it is released whole, idempotently, and the capacity is free', async () => {
    const s = await reserved(0x91)
    expect(await release(db, s.anchorRef)).toBe('KEEP:no_escrow_but_trade_not_cancelled')
    expect(await open(s.fx.logicalOfferId)).toBeGreaterThan(0)
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    expect(await release(db, s.anchorRef)).toBe('RELEASED:L1_TRADE_CANCELLED_NO_ESCROW')
    expect(await state(s.anchorRef)).toEqual({ state: 'RELEASED', releaseKind: 'L1_TRADE_CANCELLED_NO_ESCROW' })
    expect(await open(s.fx.logicalOfferId)).toBe(0)
    expect(await release(db, s.anchorRef)).toBe('NOOP:already_released')
  })

  run('L1 adversarial: an escrow already exists for the cancelled trade => KEEP (and a new escrow for a CANCELLED trade is refused by F4)', async () => {
    const s = await reserved(0x92, { status: 'CREATED' })
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    expect(await release(db, s.anchorRef)).toBe('KEEP:escrow_not_terminal_CREATED')
    const t2 = await s.fx.committedPair()
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [t2.tradeId])
    await expect(s.fx.createTestEscrow({ type: 'MULTISIG' }, { tradeId: t2.tradeId, pairId: t2.pairId })).rejects.toThrow()
    expect(await release(db, t2.anchorRef)).toBe('RELEASED:L1_TRADE_CANCELLED_NO_ESCROW')
  })

  run('L1 race: a release and an escrow INSERT for the same cancelled trade serialize on the trade row lock (no escrow + released, or escrow refused)', async () => {
    const s = await reserved(0x93)
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    const results = await Promise.allSettled([release(db, s.anchorRef), s.fx.createTestEscrow({ type: 'MULTISIG' }, { tradeId: s.tradeId, pairId: s.pairId })])
    const escrows = Number((await db.query(`SELECT count(*)::int AS n FROM escrows WHERE "tradeId"=$1`, [s.tradeId])).rows[0].n)
    const st = await state(s.anchorRef)
    // the forbidden outcome is "released AND an escrow exists"
    expect(st.state === 'RELEASED' && escrows > 0).toBe(false)
    expect(results[1].status).toBe('rejected') // the F4 trigger refuses an escrow for a CANCELLED trade
  })

  run('L2: REFUNDED and NEVER funded (no address, no lock tx, no evidence, no attempts) is released; an escrow that ever had an address is NOT', async () => {
    const a = await reserved(0x94, { status: 'CREATED' })
    await setEscrow(a.escrow.id, `status='REFUNDED'`)
    expect(await release(db, a.anchorRef)).toBe('RELEASED:L2_NEVER_FUNDED_REFUND')
    const b = await reserved(0x95, { status: 'CREATED', multisigAddr: 'tb1qaddressassignedbutnotproven' })
    await setEscrow(b.escrow.id, `status='REFUNDED'`)
    expect(await release(db, b.anchorRef)).toBe('KEEP:no_funding_evidence_to_prove_final_settlement')
    expect((await state(b.anchorRef)).state).toBe('RESERVED')
  })

  run('L2 adversarial: ANY funding/release trace keeps the reservation (observed tx, replacement, ambiguity, reorg are never "absence")', async () => {
    for (const [seed, kind] of [[0x96, 'AMBIGUOUS'], [0x97, 'REPLACEMENT_OBSERVED'], [0x98, 'REORGED_INVALIDATED'], [0x99, 'OBSERVED_CONFIRMED']] as const) {
      const s = await reserved(seed, { status: 'CREATED' })
      await setEscrow(s.escrow.id, `status='REFUNDED'`)
      await funding(s.escrow.id, kind, T(1))
      expect((await release(db, s.anchorRef)).startsWith('KEEP:')).toBe(true)
      expect((await state(s.anchorRef)).state).toBe('RESERVED')
    }
  })

  run('L3: COMPLETED/SPLIT/REFUNDED after funding release ONLY with confirmed release evidence at the policy depth (2); depth, reorg, tie, dispute and nominal status all KEEP', async () => {
    // fixture fee policy requiredConfirmations = 2
    const mk = async (seed: number, status: string) => {
      const s = await reserved(seed, { status: 'CREATED', multisigAddr: 'tb1qfundedaddress', txLockId: `lock-${seed}`, txLockVout: 0 })
      await setEscrow(s.escrow.id, `status='${status}'::"EscrowStatus", "feePolicyVersionId"=(SELECT "feePolicyVersionId" FROM commitment_pairs WHERE id='${s.pairId}')`)
      await funding(s.escrow.id, 'OBSERVED_CONFIRMED', T(1))
      return s
    }
    const ok = await mk(0xa1, 'COMPLETED')
    expect(await release(db, ok.anchorRef)).toBe('KEEP:no_release_evidence')
    await releaseEv(ok.escrow.id, 'OBSERVED_CONFIRMED', 100, 100, T(2)) // depth 1 < 2
    expect(await release(db, ok.anchorRef)).toBe('KEEP:release_not_deep_enough')
    await releaseEv(ok.escrow.id, 'RECONFIRMED', 100, 101, T(3)) // depth 2
    expect(await release(db, ok.anchorRef)).toBe('RELEASED:L3_FINALIZED_SETTLEMENT')
    expect(await open(ok.fx.logicalOfferId)).toBe(0)

    const reorg = await mk(0xa2, 'SPLIT')
    await releaseEv(reorg.escrow.id, 'OBSERVED_CONFIRMED', 100, 110, T(2))
    await releaseEv(reorg.escrow.id, 'REORGED_INVALIDATED', null, null, T(3)) // a LATER reorg fact beats the earlier deep confirmation
    expect(await release(db, reorg.anchorRef)).toBe('KEEP:release_not_confirmed_or_reorged')

    const tie = await mk(0xa3, 'REFUNDED')
    await releaseEv(tie.escrow.id, 'OBSERVED_CONFIRMED', 100, 110, T(2))
    await releaseEv(tie.escrow.id, 'AMBIGUOUS', null, null, T(2)) // same instant: ambiguous order, never picked in favour of release
    expect(await release(db, tie.anchorRef)).toBe('KEEP:release_evidence_tie')

    const unc = await mk(0xa4, 'COMPLETED')
    await funding(unc.escrow.id, 'REORGED_INVALIDATED', T(5)) // funding became uncertain later
    await releaseEv(unc.escrow.id, 'OBSERVED_CONFIRMED', 100, 110, T(6))
    expect(await release(db, unc.anchorRef)).toBe('KEEP:funding_uncertain')

    const nominal = await mk(0xa5, 'COMPLETED') // nominal status alone is not proof
    expect(await release(db, nominal.anchorRef)).toBe('KEEP:no_release_evidence')

    for (const [seed, st] of [[0xa6, 'DISPUTED'], [0xa7, 'EXPIRED'], [0xa8, 'FUNDS_LOCKED'], [0xa9, 'PAYMENT_PENDING']] as const) {
      const n = await mk(seed, st)
      await releaseEv(n.escrow.id, 'OBSERVED_CONFIRMED', 100, 110, T(2))
      expect(await release(db, n.anchorRef)).toBe(`KEEP:escrow_not_terminal_${st}`)
    }
    expect(await state(reorg.anchorRef)).toMatchObject({ state: 'RESERVED' })
  })

  run('idempotence under concurrency: two sessions releasing the same trade => exactly one RELEASED, the other NOOP; the capacity is freed once', async () => {
    const s = await reserved(0xb1)
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    const rs = await Promise.all([release(db, s.anchorRef), release(db2, s.anchorRef)])
    expect(rs.filter((x) => x.startsWith('RELEASED:'))).toHaveLength(1)
    expect(rs.filter((x) => x === 'NOOP:already_released')).toHaveLength(1)
    expect(await open(s.fx.logicalOfferId)).toBe(0)
  })

  run('rollback: a release inside a transaction that rolls back leaves the reservation RESERVED', async () => {
    const s = await reserved(0xb2)
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    await db.query('BEGIN')
    expect(await release(db, s.anchorRef)).toBe('RELEASED:L1_TRADE_CANCELLED_NO_ESCROW')
    await db.query('ROLLBACK')
    expect((await state(s.anchorRef)).state).toBe('RESERVED')
    expect(await release(db, s.anchorRef)).toBe('RELEASED:L1_TRADE_CANCELLED_NO_ESCROW')
  })

  run('guard: a release without one of the three kinds and a proof is refused even for a privileged writer; RELEASED is terminal', async () => {
    const s = await reserved(0xb3)
    await expect(db.query(`UPDATE offer_capacity_reservations SET state='RELEASED', "releasedAt"=now(), "releaseKind"='ADMIN', "releaseProof"='whatever proof' WHERE "tradeIntentId"=$1`, [s.anchorRef])).rejects.toThrow(/three release kinds/)
    await db.query(`UPDATE trades SET status='CANCELLED' WHERE id=$1`, [s.tradeId])
    await release(db, s.anchorRef)
    await expect(db.query(`UPDATE offer_capacity_reservations SET state='RESERVED', "releasedAt"=NULL, "releaseKind"=NULL, "releaseProof"=NULL WHERE "tradeIntentId"=$1`, [s.anchorRef])).rejects.toThrow(/terminal/)
  })
})
