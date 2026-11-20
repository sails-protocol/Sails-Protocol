/**
 * M-1b slice 4 (CTO 048, A1 + A3): the durable reorg BLOCK and the two-role, evidence-bound UNBLOCK, real Postgres with real LOGIN
 * roles (an operator in sails_runtime, reviewers in sails_capacity_reviewer). Covers: block written in the evidence's own
 * transaction; the runtime cannot touch the block columns; no reviewer role / A = B (same session, same key) / bad shape / unknown or
 * stale request / insufficient evidence / reorg still open are all refused; consumption is idempotent and atomic under a concurrent
 * double execution; the trail is append-only. The Ed25519 signature is stored (the database cannot verify it: declared residual).
 */
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

const K = (c: string) => c.repeat(64)
const SIG = 'ab'.repeat(64)
const T = (s: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString()

describe('M-1b reorg block + two-role unblock (real PG, real login roles)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, admin: Client, op: Client, rev1: Client, rev2: Client
  const RUN = randomUUID().slice(0, 8)
  const roles = { op: `m1b_op_${RUN}`, rev1: `m1b_rev1_${RUN}`, rev2: `m1b_rev2_${RUN}` }
  const urlFor = (user: string, pw: string) => { const u = new URL(process.env.DATABASE_URL as string); u.username = user; u.password = pw; return u.toString() }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect()
    await admin.query(`CREATE ROLE ${roles.op} LOGIN PASSWORD 'p' IN ROLE sails_runtime`)
    await admin.query(`CREATE ROLE ${roles.rev1} LOGIN PASSWORD 'p' IN ROLE sails_capacity_reviewer`)
    await admin.query(`CREATE ROLE ${roles.rev2} LOGIN PASSWORD 'p' IN ROLE sails_capacity_reviewer`)
    ;[op, rev1, rev2] = [roles.op, roles.rev1, roles.rev2].map((r) => new Client({ connectionString: urlFor(r, 'p') }))
    await Promise.all([op.connect(), rev1.connect(), rev2.connect()])
  })
  afterAll(async () => {
    for (const c of [op, rev1, rev2, admin]) if (c) await c.end().catch(() => undefined)
    if (admin === undefined || !pg.isAvailable()) { if (prisma) await prisma.$disconnect(); return }
    const a2 = new Client({ connectionString: process.env.DATABASE_URL }); await a2.connect()
    for (const r of Object.values(roles)) await a2.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined)
    await a2.end()
    if (prisma) await prisma.$disconnect()
  })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })
  const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e: any) { return String(e?.code ?? e?.message) } }
  const rawAdmin = (sql: string, params: unknown[] = []) => admin.query(sql, params)

  /** A released L3 reservation whose release evidence is then REORGED: the capacity gets blocked by the evidence trigger itself. */
  async function blocked(seed: number) {
    const fx = await createCommitmentFixture(prisma, { seed })
    const c = await fx.committedPair()
    const esc = await fx.createTestEscrow({ type: 'MULTISIG', status: 'CREATED', multisigAddr: 'tb1qfunded', txLockId: `lock-${seed}`, txLockVout: 0 }, { tradeId: c.tradeId, pairId: c.pairId })
    await rawAdmin(`UPDATE escrows SET status='COMPLETED'::"EscrowStatus", "feePolicyVersionId"=(SELECT "feePolicyVersionId" FROM commitment_pairs WHERE id=$1) WHERE id=$2`, [c.pairId, esc.id])
    const ev = (table: string, kind: string, h: number | null, tip: number | null, at: string) => rawAdmin(
      table === 'f'
        ? `INSERT INTO escrow_funding_evidence (id,"escrowId",kind,"recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",$4)`
        : `INSERT INTO escrow_release_evidence (id,"escrowId",kind,txid,"observedAtHeight","tipHeightAtObservation","recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",'tx1',$5,$6,$4)`,
      table === 'f' ? [randomUUID(), esc.id, kind, at] : [randomUUID(), esc.id, kind, at, h, tip])
    await ev('f', 'OBSERVED_CONFIRMED', null, null, T(1))
    await ev('r', 'OBSERVED_CONFIRMED', 100, 101, T(2))
    expect((await rawAdmin(`SELECT offer_capacity_try_release($1) AS r`, [c.anchorRef])).rows[0].r).toBe('RELEASED:L3_FINALIZED_SETTLEMENT')
    await ev('r', 'REORGED_INVALIDATED', null, null, T(3)) // the sweep's own write: the trigger blocks in this same statement's transaction
    const owner = fx.envelopeRow.ownerPublicKey as string
    const cap = async () => (await rawAdmin(`SELECT "blockedAt", "blockReason", "blockEvidence", "unblockProof" FROM offer_capacity WHERE "ownerPublicKey"=$1 AND "logicalOfferId"=$2`, [owner, fx.logicalOfferId])).rows[0]
    return { fx, c, esc, owner, ev, cap, offer: fx.logicalOfferId as string }
  }
  const request = (c: Client, s: { owner: string; offer: string; esc: { id: string } }, key = K('a')) =>
    c.query(`SELECT offer_capacity_request_unblock($1,$2,$3::jsonb,$4) AS id`, [s.owner, s.offer, JSON.stringify({ escrowId: s.esc.id, note: 'reconciled' }), key]).then((r) => r.rows[0].id as string)
  const execute = (c: Client, id: string, key = K('b'), sig = SIG) => c.query(`SELECT offer_capacity_execute_unblock($1,$2,$3) AS r`, [id, key, sig]).then((r) => r.rows[0].r as string)

  run('BLOCK: invalidated release evidence of an already-released reservation blocks the capacity in the same transaction; the runtime cannot write or clear the block', async () => {
    const s = await blocked(0xc1)
    const cap = await s.cap()
    expect(cap.blockedAt).not.toBeNull()
    expect(cap.blockReason).toBe('EVIDENCE_REORGED_INVALIDATED')
    expect(cap.blockEvidence).toBe(s.esc.id)
    // a NEW COMMITTED reservation is refused while blocked
    const t = await s.fx.admitTrade('PENDING'), p = await s.fx.proposePartialPair(t.anchorRef)
    await expect(p.signMaker()).rejects.toMatchObject({ code: 'E25_OFFER_CAPACITY_BLOCKED', statusCode: 409 })
    for (const col of ['blockedAt', 'blockReason', 'blockEvidence', 'unblockProof']) {
      expect((await rawAdmin(`SELECT has_column_privilege('sails_runtime','public.offer_capacity',$1,'UPDATE') AS ok`, [col])).rows[0].ok).toBe(false)
    }
    await expect(op.query(`UPDATE offer_capacity SET "blockedAt"=NULL, "blockReason"=NULL WHERE "logicalOfferId"=$1`, [s.offer])).rejects.toThrow(/permission denied/)
    expect(await code(op.query(`SELECT offer_capacity_execute_unblock('x',$1,$2)`, [K('b'), SIG]))).toBe('42501') // EXECUTE only for the reviewer role
  })

  run('REFUSED: not blocked, evidence naming another escrow, no reviewer role, bad shape, unknown request, A = B (same session, same key), insufficient evidence', async () => {
    const s = await blocked(0xc2)
    expect(await code(op.query(`SELECT offer_capacity_request_unblock($1,$2,$3::jsonb,$4)`, [s.owner, s.offer, JSON.stringify({ escrowId: 'other' }), K('a')]))).toBe('E2511')
    const id = await request(op, s)
    expect(await code(execute(rev1, 'no-such-request'))).toBe('E2514')
    expect(await code(execute(rev1, id, 'xyz'))).toBe('E2513')
    expect(await code(execute(rev1, id, K('b'), 'ab'.repeat(10)))).toBe('E2513')
    expect(await code(execute(rev1, id, K('b')))).toBe('E2518') // the latest release evidence is still REORGED_INVALIDATED: unreconciled
    expect((await s.cap()).blockedAt).not.toBeNull()
    await s.ev('r', 'RECONFIRMED', 100, 100, T(4)) // depth 1 < policy 2
    expect(await code(execute(rev1, id, K('b')))).toBe('E2518')
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5)) // depth 2: now final
    expect(await code(execute(rev1, id, K('a')))).toBe('E2515') // reviewer key == requester key
    const own = await request(rev1, s, K('c')) // reviewer files the request itself, then tries to execute it
    expect(await code(execute(rev1, own, K('d')))).toBe('E2515')
    expect((await s.cap()).blockedAt).not.toBeNull() // every refusal left the block in force
  })

  run('SUCCESS and idempotence: an independent reviewer clears the block with an unblockProof; a second execution is a NOOP; a concurrent double execution consumes once', async () => {
    const s = await blocked(0xc3)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5))
    const id = await request(op, s)
    const results = await Promise.all([execute(rev1, id, K('b')), execute(rev2, id, K('d'), 'cd'.repeat(64))])
    expect(results.filter((r) => r === 'EXECUTED')).toHaveLength(1)
    expect(results.filter((r) => r === 'NOOP:already_executed')).toHaveLength(1)
    const cap = await s.cap()
    expect(cap.blockedAt).toBeNull()
    expect(cap.unblockProof).toMatch(/^[0-9a-f]{64}:[0-9a-f]{128}$/)
    expect(await execute(rev1, id, K('b'))).toBe('NOOP:already_executed')
    const trail = (await rawAdmin(`SELECT "reviewerSession","executedAt" FROM offer_capacity_unblock_requests WHERE id=$1`, [id])).rows[0]
    expect(trail.executedAt).not.toBeNull()
    expect([roles.rev1, roles.rev2]).toContain(trail.reviewerSession)
    // the capacity accepts a new COMMITTED reservation again
    const t = await s.fx.admitTrade('PENDING'), p = await s.fx.proposePartialPair(t.anchorRef)
    expect((await p.signMaker()).state).toBe('COMMITTED')
    // and a request against an unblocked capacity is refused
    expect(await code(request(op, s).then(() => null))).toBe('E2510')
  })

  run('STALE: a request made for an earlier block is void once the capacity was unblocked and blocked AGAIN (a newer block)', async () => {
    const s = await blocked(0xc4)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5))
    const first = await request(op, s)
    expect(await execute(rev1, first, K('b'))).toBe('EXECUTED')
    await s.ev('r', 'REORGED_INVALIDATED', null, null, T(8)) // second reorg => a NEW block instant
    const stale = await request(op, s, K('e')).catch((e) => String(e.code))
    expect(await s.cap().then((c) => c.blockedAt !== null)).toBe(true)
    // the first request is consumed (NOOP); a fresh request for the new block is refused while unreconciled
    expect(await execute(rev2, first, K('d'), 'cd'.repeat(64))).toBe('NOOP:already_executed')
    if (typeof stale === 'string' && stale.length === 36) expect(await code(execute(rev1, stale, K('b')))).toBe('E2518')
  })

  run('TRAIL: a request is immutable and cannot be deleted or truncated (append-only); no function clears a block by time or by the requester alone', async () => {
    const s = await blocked(0xc5)
    const id = await request(op, s)
    await expect(rawAdmin(`UPDATE offer_capacity_unblock_requests SET digest=$1 WHERE id=$2`, ['0'.repeat(64), id])).rejects.toThrow(/immutable and consumed once/)
    await expect(rawAdmin(`UPDATE offer_capacity_unblock_requests SET evidence='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/immutable/)
    await expect(rawAdmin(`DELETE FROM offer_capacity_unblock_requests WHERE id=$1`, [id])).rejects.toThrow(/append-only/)
    await expect(rawAdmin(`TRUNCATE offer_capacity_unblock_requests`)).rejects.toThrow(/append-only/)
    // the only function that clears a block takes a reviewer-role session: the requester session cannot, whatever it sends
    expect(await code(execute(op, id, K('b')))).toBe('42501')
    expect((await s.cap()).blockedAt).not.toBeNull()
  })
})
