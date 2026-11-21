/**
 * M-1b slice 1 (CTO 28 Despachos 026-029): the aggregate capacity of ONE logical Offer and its atomic reservation, proven with real
 * Postgres sessions. The reservation trigger is attached to commitment_pairs by migration 20261122131000_offer_capacity_wire.
 */
import { spawn } from 'child_process'
import path from 'path'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

const SIG = 'ab'.repeat(64)
const DECL = JSON.stringify({ tag: 'sails-offer-capacity-v1' })

describe('M-1b offer capacity: atomic reservation (real PG sessions)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any
  let db: Client

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  })
  afterAll(async () => {
    if (db) await db.end().catch(() => undefined)
    if (prisma) await prisma.$disconnect()
  })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })

  /** A fixture whose Offer has `n` admitted trades, each with a PARTIALLY_SIGNED pair awaiting the maker's COMMITTED transition. */
  async function offerWithPairs(n: number, seed: number) {
    const fx = await createCommitmentFixture(prisma, { amount: '0.00500000', seed })
    const owner = fx.envelopeRow.ownerPublicKey as string
    const pairs = []
    for (let i = 0; i < n; i++) { const { anchorRef } = await fx.admitTrade('PENDING'); pairs.push({ anchorRef, ...(await fx.proposePartialPair(anchorRef)) }) }
    return { fx, owner, offer: fx.logicalOfferId as string, pairs }
  }
  const declare = (owner: string, offer: string, total: string | null, rev = 1) => db.query(
    `INSERT INTO offer_capacity ("ownerPublicKey","logicalOfferId","capacityTotal","capacityRevision","declaredAt","declaration","declarationSignature") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [owner, offer, total, rev, total === null ? null : new Date(), total === null ? null : DECL, total === null ? null : SIG])
  const settle = async (p: Promise<any>) => p.then(() => ({ ok: true as const, msg: '' }), (e: any) => ({ ok: false as const, msg: String(e?.message ?? e) }))
  const reservations = async (offer: string) => (await db.query(`SELECT * FROM offer_capacity_reservations WHERE "logicalOfferId"=$1`, [offer])).rows
  const pairState = async (id: string) => (await db.query(`SELECT state FROM commitment_pairs WHERE id=$1`, [id])).rows[0].state

  run('trigger order: the reservation runs AFTER the F3 guard (pg_trigger name order)', async () => {
    const r = await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='commitment_pairs'::regclass AND NOT tgisinternal ORDER BY tgname`)
    const names = r.rows.map((x) => x.tgname as string)
    expect(names.indexOf('commitment_pairs_reserve_capacity')).toBeGreaterThan(names.indexOf('commitment_pairs_guard_update'))
  })

  run('no capacity row, and NULL capacity: fail-closed (E2502), pair not COMMITTED, nothing reserved', async () => {
    const a = await offerWithPairs(1, 0x61)
    const none = await settle(a.pairs[0].signMaker())
    expect(none.ok).toBe(false); expect(none.msg).toContain('E25_OFFER_CAPACITY_NOT_CONFIGURED')
    await declare(a.owner, a.offer, null)
    expect((await settle(a.pairs[0].signMaker())).msg).toContain('E25_OFFER_CAPACITY_NOT_CONFIGURED')
    expect(await pairState(a.pairs[0].pairId)).toBe('PARTIALLY_SIGNED')
    expect(await reservations(a.offer)).toHaveLength(0)
  })

  run('N=5 concurrent COMMITTED over a capacity of 2 slots: exactly 2 succeed, the sum never exceeds the total', async () => {
    const a = await offerWithPairs(5, 0x62)
    await declare(a.owner, a.offer, '0.01200000') // 2 x 0.005 = 0.010 <= 0.012 < 0.015
    // DETERMINISTIC barrier (GK #736): a session holds SHARE on the reservations table, so every reservation INSERT queues. Correct code:
    // one transition holds the capacity row (FOR UPDATE) and waits on the table, the other four wait on that row. Without FOR UPDATE all five
    // read an empty sum and all five queue on the table, then all five pass: the assertions below fail by construction, not by timing.
    const barrier = new Client({ connectionString: process.env.DATABASE_URL }); await barrier.connect()
    let out: Array<{ ok: boolean; msg: string }>
    try {
      await barrier.query('BEGIN'); await barrier.query('LOCK TABLE offer_capacity_reservations IN SHARE MODE')
      const fired = a.pairs.map((p) => settle(p.signMaker()))
      let waiting = 0
      for (let i = 0; i < 600 && waiting < 5; i++) { // 30 s, explicit
        waiting = Number((await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> $1 AND wait_event_type = 'Lock'`, [(await barrier.query('SELECT pg_backend_pid() AS p')).rows[0].p])).rows[0].n)
        if (waiting < 5) await new Promise((r) => setTimeout(r, 50))
      }
      if (waiting < 5) throw new Error(`barrier not real: only ${waiting} of 5 backends waiting on a lock after 30 s`)
      await barrier.query('COMMIT')
      out = await Promise.all(fired)
    } finally { await barrier.query('ROLLBACK').catch(() => undefined); await barrier.end().catch(() => undefined) }
    expect(out.filter((o) => o.ok)).toHaveLength(2)
    for (const o of out.filter((x) => !x.ok)) expect(o.msg).toContain('E25_OFFER_CAPACITY_EXCEEDED')
    const res = await reservations(a.offer)
    expect(res).toHaveLength(2)
    expect(res.reduce((s, r) => s + Number(r.amount), 0)).toBeLessThanOrEqual(0.012)
    const states = await Promise.all(a.pairs.map((p) => pairState(p.pairId)))
    expect(states.filter((s) => s === 'COMMITTED')).toHaveLength(2)
  })

  run('capacity is per LOGICAL Offer: a row for another Offer gives nothing; a second row for the same Offer is refused (PK)', async () => {
    const a = await offerWithPairs(1, 0x63)
    await declare(a.owner, 'some-other-offer', '10')
    expect((await settle(a.pairs[0].signMaker())).msg).toContain('E25_OFFER_CAPACITY_NOT_CONFIGURED')
    await declare(a.owner, a.offer, '1')
    expect((await settle(declare(a.owner, a.offer, '5', 2))).ok).toBe(false)
  })

  run('blocked capacity refuses a new COMMITTED (E2503); a block is not cleared without a proof', async () => {
    const a = await offerWithPairs(1, 0x64)
    await declare(a.owner, a.offer, '1')
    await db.query(`UPDATE offer_capacity SET "blockedAt"=now(), "blockReason"='REORG', "blockEvidence"='ev' WHERE "logicalOfferId"=$1`, [a.offer])
    expect((await settle(a.pairs[0].signMaker())).msg).toContain('E25_OFFER_CAPACITY_BLOCKED')
    const clear = await settle(db.query(`UPDATE offer_capacity SET "blockedAt"=NULL, "blockReason"=NULL WHERE "logicalOfferId"=$1`, [a.offer]))
    expect(clear.msg).toContain('removed only with a new unblockProof')
  })

  run('declaration guard: revision strictly increases, declaration changes only with it, delete refused, identity immutable', async () => {
    const a = await offerWithPairs(0, 0x65)
    await declare(a.owner, a.offer, '1', 1)
    const k = [a.offer]
    expect((await settle(db.query(`UPDATE offer_capacity SET "capacityTotal"=5 WHERE "logicalOfferId"=$1`, k))).msg).toContain('strictly higher capacityRevision')
    expect((await settle(db.query(`UPDATE offer_capacity SET "capacityRevision"=2, "capacityTotal"=5 WHERE "logicalOfferId"=$1`, k))).msg).toContain('carries a new declaration')
    expect((await settle(db.query(`UPDATE offer_capacity SET "capacityRevision"=2, "capacityTotal"=5, "declaration"='{"x":1}' WHERE "logicalOfferId"=$1`, k))).ok).toBe(true)
    expect((await settle(db.query(`UPDATE offer_capacity SET "capacityRevision"=1 WHERE "logicalOfferId"=$1`, k))).msg).toContain('strictly higher')
    expect((await settle(db.query(`DELETE FROM offer_capacity WHERE "logicalOfferId"=$1`, k))).msg).toContain('never deleted')
    expect((await settle(db.query(`UPDATE offer_capacity SET "logicalOfferId"='x' WHERE "logicalOfferId"=$1`, k))).msg).toContain('identity is immutable')
    expect((await settle(db.query(`UPDATE offer_capacity SET "capacityTotal"=NULL, "capacityRevision"=3, "declaration"='{"y":1}' WHERE "logicalOfferId"=$1`, k))).ok).toBe(true) // NULL = unconfigured is a legal declaration (CHECK allows it)
  })

  run('SIGKILL of the session between the reservation and COMMIT: no COMMITTED pair, no reservation, capacity intact', async () => {
    const a = await offerWithPairs(1, 0x66)
    await declare(a.owner, a.offer, '1')
    const p = a.pairs[0]
    const script = `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');
      await c.query('UPDATE commitment_pairs SET "makerTradeSig"=$2,"makerArbitrationSig"=$3,"makerReceivedAt"=clock_timestamp(),"state"=$5,"committedAnchorRef"=$4 WHERE id=$1',[process.env.PAIR,process.env.TSIG,process.env.ASIG,process.env.ANCHOR,'COMMITTED']);
      const r=await c.query('SELECT count(*)::int AS n FROM offer_capacity_reservations WHERE "commitmentPairId"=$1',[process.env.PAIR]);console.log('RESERVED_IN_TX='+r.rows[0].n);setInterval(()=>{},1000)})()`
    const child = spawn(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PAIR: p.pairId, TSIG: p.makerSignatures.trade, ASIG: p.makerSignatures.arbitration, ANCHOR: p.anchorRef }, stdio: ['ignore', 'pipe', 'inherit'],
    })
    const seen = await new Promise<string>((resolve, reject) => {
      let buf = ''; const t = setTimeout(() => reject(new Error('child timed out: ' + buf)), 60_000)
      child.stdout!.on('data', (d) => { buf += d; if (buf.includes('RESERVED_IN_TX=')) { clearTimeout(t); resolve(buf) } })
      child.once('exit', () => reject(new Error('child exited early: ' + buf)))
    })
    expect(seen).toContain('RESERVED_IN_TX=1') // the reservation existed inside the transaction that is about to be killed
    child.removeAllListeners('exit')
    const gone = new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await gone
    // the server notices the dead connection and rolls the open transaction back; our own COMMIT of the same pair waits on its row lock until then
    expect((await settle(p.signMaker())).ok).toBe(true)
    expect(await pairState(p.pairId)).toBe('COMMITTED')
    expect(await reservations(a.offer)).toHaveLength(1) // exactly the survivor's own reservation, none left by the killed session
  })
})
