/**
 * M-1b slice 4 (CTO 048, A1 + A3; GK B7): the durable reorg BLOCK (an append-only table, no lock on the capacity row) and the two-role,
 * evidence-bound UNBLOCK, real Postgres with real LOGIN roles (an operator in sails_runtime, reviewers in sails_capacity_reviewer).
 * Covers: block written in the evidence's own transaction WITHOUT locking the capacity row (held FOR UPDATE by another session);
 * the runtime cannot touch the block tables; no reviewer role / A = B (same session, same key) / bad shape / unknown or stale request /
 * insufficient evidence / reorg still open are all refused; consumption is idempotent and atomic under a concurrent double execution;
 * the trails are append-only; EXECUTE is not PUBLIC. The Ed25519 signature is stored (the database cannot verify it: declared residual).
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
  let prisma: any, admin: Client, admin2: Client, op: Client, rev1: Client, rev2: Client
  const RUN = randomUUID().slice(0, 8)
  const roles = { op: `m1b_op_${RUN}`, rev1: `m1b_rev1_${RUN}`, rev2: `m1b_rev2_${RUN}` }
  const urlFor = (user: string, pw: string) => { const u = new URL(process.env.DATABASE_URL as string); u.username = user; u.password = pw; return u.toString() }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect()
    admin2 = new Client({ connectionString: process.env.DATABASE_URL }); await admin2.connect()
    // sails_runtime is a cluster role normally created by bootstrap-roles.js; a shard that does not run a bootstrap suite first (CI sharding) has none:
    // create it idempotently, without login and without privileges (bootstrap-roles.js upserts an existing role, so it stays compatible)
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_runtime') THEN CREATE ROLE sails_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`)
    await admin.query(`CREATE ROLE ${roles.op} LOGIN PASSWORD 'p' IN ROLE sails_runtime`)
    // the CI PG lane runs with the legacy single credential, so runtime-grants.sql is not applied: grant the runtime's one EXECUTE explicitly (as runtime-grants.sql does)
    await admin.query(`GRANT EXECUTE ON FUNCTION offer_capacity_request_unblock(text, jsonb, text) TO ${roles.op}`)
    await admin.query(`CREATE ROLE ${roles.rev1} LOGIN PASSWORD 'p' IN ROLE sails_capacity_reviewer`)
    // rev1 also files a request itself in the A = B test (one principal holding both EXECUTEs): the independence check must refuse it. In production the reviewer has no request EXECUTE.
    await admin.query(`GRANT EXECUTE ON FUNCTION offer_capacity_request_unblock(text, jsonb, text) TO ${roles.rev1}`)
    await admin.query(`CREATE ROLE ${roles.rev2} LOGIN PASSWORD 'p' IN ROLE sails_capacity_reviewer`)
    ;[op, rev1, rev2] = [roles.op, roles.rev1, roles.rev2].map((r) => new Client({ connectionString: urlFor(r, 'p') }))
    await Promise.all([op.connect(), rev1.connect(), rev2.connect()])
  })
  afterAll(async () => {
    for (const c of [op, rev1, rev2, admin2, admin]) if (c) await c.end().catch(() => undefined)
    if (pg.isAvailable()) {
      const a3 = new Client({ connectionString: process.env.DATABASE_URL }); await a3.connect()
      for (const r of Object.values(roles)) await a3.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined)
      await a3.end()
    }
    if (prisma) await prisma.$disconnect()
  })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })
  const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e: any) { return String(e?.code ?? e?.message) } }
  const rawAdmin = (sql: string, params: unknown[] = []) => admin.query(sql, params)

  /** A released L3 reservation whose release evidence is then REORGED: the evidence trigger inserts the block itself. */
  async function blocked(seed: number) {
    const fx = await createCommitmentFixture(prisma, { seed })
    const c = await fx.committedPair()
    const esc = await fx.createTestEscrow({ type: 'MULTISIG', status: 'CREATED', multisigAddr: 'tb1qfunded', txLockId: `lock-${seed}`, txLockVout: 0 }, { tradeId: c.tradeId, pairId: c.pairId })
    await rawAdmin(`UPDATE escrows SET status='COMPLETED'::"EscrowStatus", "feePolicyVersionId"=(SELECT "feePolicyVersionId" FROM commitment_pairs WHERE id=$1) WHERE id=$2`, [c.pairId, esc.id])
    const ev = (table: string, kind: string, h: number | null, tip: number | null, at: string, client: Client = admin) => client.query(
      table === 'f'
        ? `INSERT INTO escrow_funding_evidence (id,"escrowId",kind,"recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",$4)`
        : `INSERT INTO escrow_release_evidence (id,"escrowId",kind,txid,"observedAtHeight","tipHeightAtObservation","recordedAt") VALUES ($1,$2,$3::"EscrowFundingEvidenceKind",'tx1',$5,$6,$4)`,
      table === 'f' ? [randomUUID(), esc.id, kind, at] : [randomUUID(), esc.id, kind, at, h, tip])
    await ev('f', 'OBSERVED_CONFIRMED', null, null, T(1))
    await ev('r', 'OBSERVED_CONFIRMED', 100, 101, T(2))
    expect((await rawAdmin(`SELECT offer_capacity_try_release($1) AS r`, [c.anchorRef])).rows[0].r).toBe('RELEASED:L3_FINALIZED_SETTLEMENT')
    await ev('r', 'REORGED_INVALIDATED', null, null, T(3)) // the sweep's own write: the trigger inserts the block in this same transaction
    const owner = fx.envelopeRow.ownerPublicKey as string
    const openBlocks = async () => (await rawAdmin(`SELECT id, reason, "escrowId", "blockedAt" FROM offer_capacity_blocks WHERE "ownerPublicKey"=$1 AND "logicalOfferId"=$2 AND "clearedAt" IS NULL ORDER BY "blockedAt"`, [owner, fx.logicalOfferId])).rows
    return { fx, c, esc, owner, ev, openBlocks, offer: fx.logicalOfferId as string }
  }
  const request = (c: Client, blockId: string, escrowId: string, key = K('a')) =>
    c.query(`SELECT offer_capacity_request_unblock($1,$2::jsonb,$3) AS id`, [blockId, JSON.stringify({ escrowId, note: 'reconciled' }), key]).then((r) => r.rows[0].id as string)
  const execute = (c: Client, id: string, key = K('b'), sig = SIG) => c.query(`SELECT offer_capacity_execute_unblock($1,$2,$3) AS r`, [id, key, sig]).then((r) => r.rows[0].r as string)

  run('BLOCK: invalidated release evidence of an already-released reservation inserts a block in the same transaction; a new COMMITTED is refused; the runtime cannot write the block tables or call the reviewer function', async () => {
    const s = await blocked(0xc1)
    const bl = await s.openBlocks()
    expect(bl).toHaveLength(1)
    expect(bl[0].reason).toBe('EVIDENCE_REORGED_INVALIDATED')
    expect(bl[0].escrowId).toBe(s.esc.id)
    const t = await s.fx.admitTrade('PENDING'), p = await s.fx.proposePartialPair(t.anchorRef)
    await expect(p.signMaker()).rejects.toMatchObject({ code: 'E25_OFFER_CAPACITY_BLOCKED', statusCode: 409 })
    for (const tbl of ['offer_capacity_blocks', 'offer_capacity_unblock_requests']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE']) expect((await rawAdmin(`SELECT has_table_privilege('sails_runtime', $1, $2) AS ok`, [`public.${tbl}`, priv])).rows[0].ok).toBe(false)
    }
    for (const col of ['blockedAt', 'blockReason', 'blockEvidence', 'unblockProof']) {
      expect((await rawAdmin(`SELECT has_column_privilege('sails_runtime','public.offer_capacity',$1,'UPDATE') AS ok`, [col])).rows[0].ok).toBe(false)
    }
    await expect(op.query(`UPDATE offer_capacity_blocks SET "clearedAt"=now(), "clearedByRequestId"='x' WHERE id=$1`, [bl[0].id])).rejects.toThrow(/permission denied/)
    expect(await code(op.query(`SELECT offer_capacity_execute_unblock('x',$1,$2)`, [K('b'), SIG]))).toBe('42501') // EXECUTE only for the reviewer role
  })

  run('B7: the block trigger does NOT lock the capacity row (it is held FOR UPDATE by another session and the evidence INSERT still commits at once)', async () => {
    const fx = await createCommitmentFixture(prisma, { seed: 0xc6 })
    const c = await fx.committedPair()
    const esc = await fx.createTestEscrow({ type: 'MULTISIG', status: 'CREATED', multisigAddr: 'tb1qfunded', txLockId: 'lock-c6', txLockVout: 0 }, { tradeId: c.tradeId, pairId: c.pairId })
    await rawAdmin(`UPDATE escrows SET status='COMPLETED'::"EscrowStatus", "feePolicyVersionId"=(SELECT "feePolicyVersionId" FROM commitment_pairs WHERE id=$1) WHERE id=$2`, [c.pairId, esc.id])
    await rawAdmin(`INSERT INTO escrow_funding_evidence (id,"escrowId",kind,"recordedAt") VALUES ($1,$2,'OBSERVED_CONFIRMED',$3)`, [randomUUID(), esc.id, T(1)])
    await rawAdmin(`INSERT INTO escrow_release_evidence (id,"escrowId",kind,txid,"observedAtHeight","tipHeightAtObservation","recordedAt") VALUES ($1,$2,'OBSERVED_CONFIRMED','tx1',100,101,$3)`, [randomUUID(), esc.id, T(2)])
    expect((await rawAdmin(`SELECT offer_capacity_try_release($1) AS r`, [c.anchorRef])).rows[0].r).toBe('RELEASED:L3_FINALIZED_SETTLEMENT')
    await admin2.query('BEGIN')
    try {
      await admin2.query(`SELECT 1 FROM offer_capacity WHERE "ownerPublicKey"=$1 AND "logicalOfferId"=$2 FOR UPDATE`, [fx.envelopeRow.ownerPublicKey, fx.logicalOfferId])
      await rawAdmin(`SET lock_timeout = '2s'`)
      await rawAdmin(`INSERT INTO escrow_release_evidence (id,"escrowId",kind,"recordedAt") VALUES ($1,$2,'REORGED_INVALIDATED',$3)`, [randomUUID(), esc.id, T(3)]) // would time out if the trigger took the capacity lock
      await rawAdmin(`RESET lock_timeout`)
    } finally { await admin2.query('ROLLBACK') }
    expect((await rawAdmin(`SELECT count(*)::int AS n FROM offer_capacity_blocks WHERE "escrowId"=$1 AND "clearedAt" IS NULL`, [esc.id])).rows[0].n).toBe(1)
  })

  run('REFUSED: unknown/cleared block, evidence naming another escrow, no reviewer role, bad shape, unknown request, A = B (same session, same key), insufficient evidence', async () => {
    const s = await blocked(0xc2)
    const [b] = await s.openBlocks()
    expect(await code(op.query(`SELECT offer_capacity_request_unblock('no-such-block',$1::jsonb,$2)`, [JSON.stringify({ escrowId: s.esc.id }), K('a')]))).toBe('E2510')
    expect(await code(op.query(`SELECT offer_capacity_request_unblock($1,$2::jsonb,$3)`, [b.id, JSON.stringify({ escrowId: 'other' }), K('a')]))).toBe('E2511')
    const id = await request(op, b.id, s.esc.id)
    expect(await code(execute(rev1, 'no-such-request'))).toBe('E2514')
    expect(await code(execute(rev1, id, 'xyz'))).toBe('E2513')
    expect(await code(execute(rev1, id, K('b'), 'ab'.repeat(10)))).toBe('E2513')
    expect(await code(execute(rev1, id, K('b')))).toBe('E2518') // the latest release evidence is still REORGED_INVALIDATED: unreconciled
    expect(await s.openBlocks()).toHaveLength(1)
    await s.ev('r', 'RECONFIRMED', 100, 100, T(4)) // depth 1 < policy 2
    expect(await code(execute(rev1, id, K('b')))).toBe('E2518')
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5)) // depth 2: now final
    expect(await code(execute(rev1, id, K('a')))).toBe('E2515') // reviewer key == requester key
    const own = await request(rev1, b.id, s.esc.id, K('c')) // reviewer files the request itself, then tries to execute it
    expect(await code(execute(rev1, own, K('d')))).toBe('E2515')
    expect(await s.openBlocks()).toHaveLength(1) // every refusal left the block in force
  })

  run('SUCCESS and idempotence: an independent reviewer clears the block; a second execution is a NOOP; a concurrent double execution consumes once; a new COMMITTED is accepted again', async () => {
    const s = await blocked(0xc3)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5))
    const [b] = await s.openBlocks()
    const id = await request(op, b.id, s.esc.id)
    const results = await Promise.all([execute(rev1, id, K('b')), execute(rev2, id, K('d'), 'cd'.repeat(64))])
    expect(results.filter((r) => r === 'EXECUTED')).toHaveLength(1)
    expect(results.filter((r) => r === 'NOOP:already_executed')).toHaveLength(1)
    expect(await s.openBlocks()).toHaveLength(0)
    const cleared = (await rawAdmin(`SELECT "clearedByRequestId" FROM offer_capacity_blocks WHERE id=$1`, [b.id])).rows[0]
    expect(cleared.clearedByRequestId).toBe(id)
    expect(await execute(rev1, id, K('b'))).toBe('NOOP:already_executed')
    const trail = (await rawAdmin(`SELECT "reviewerSession","executedAt" FROM offer_capacity_unblock_requests WHERE id=$1`, [id])).rows[0]
    expect(trail.executedAt).not.toBeNull()
    expect([roles.rev1, roles.rev2]).toContain(trail.reviewerSession)
    const t = await s.fx.admitTrade('PENDING'), p = await s.fx.proposePartialPair(t.anchorRef)
    expect((await p.signMaker()).state).toBe('COMMITTED')
    expect(await code(request(op, b.id, s.esc.id))).toBe('E2510') // a request against a cleared block is refused
  })

  run('STALE and new reorg: a second REORGED_INVALIDATED after an unblock opens a NEW block; the consumed request cannot clear it', async () => {
    const s = await blocked(0xc4)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5))
    const [first] = await s.openBlocks()
    const req = await request(op, first.id, s.esc.id)
    expect(await execute(rev1, req, K('b'))).toBe('EXECUTED')
    await s.ev('r', 'REORGED_INVALIDATED', null, null, T(8)) // second reorg => a NEW open block
    const open = await s.openBlocks()
    expect(open).toHaveLength(1)
    expect(open[0].id).not.toBe(first.id)
    expect(await execute(rev2, req, K('d'), 'cd'.repeat(64))).toBe('NOOP:already_executed') // the old request is consumed
    const req2 = await request(op, open[0].id, s.esc.id, K('e'))
    expect(await code(execute(rev1, req2, K('b')))).toBe('E2518') // the new block is unreconciled: refused
    expect(await s.openBlocks()).toHaveLength(1)
  })

  run('TRAIL: blocks and requests are immutable and cannot be deleted or truncated; the requester session cannot execute whatever it sends', async () => {
    const s = await blocked(0xc5)
    const [b] = await s.openBlocks()
    const id = await request(op, b.id, s.esc.id)
    await expect(rawAdmin(`UPDATE offer_capacity_unblock_requests SET digest=$1 WHERE id=$2`, ['0'.repeat(64), id])).rejects.toThrow(/immutable and consumed once/)
    await expect(rawAdmin(`UPDATE offer_capacity_unblock_requests SET evidence='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/immutable/)
    await expect(rawAdmin(`DELETE FROM offer_capacity_unblock_requests WHERE id=$1`, [id])).rejects.toThrow(/append-only/)
    await expect(rawAdmin(`TRUNCATE offer_capacity_unblock_requests`)).rejects.toThrow(/append-only/)
    await expect(rawAdmin(`UPDATE offer_capacity_blocks SET reason='X' WHERE id=$1`, [b.id])).rejects.toThrow(/immutable/)
    await expect(rawAdmin(`DELETE FROM offer_capacity_blocks WHERE id=$1`, [b.id])).rejects.toThrow(/append-only/)
    expect(await code(execute(op, id, K('b')))).toBe('42501')
    expect(await s.openBlocks()).toHaveLength(1)
  })

  // GK M9: a request filed BEFORE another request cleared the same block is refused as STALE (E2517), never re-executed.
  run('STALE (E2517): two requests on the same open block; the first clears it; the second (still unexecuted) is refused and nothing is re-consumed', async () => {
    const s = await blocked(0xc8)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5))
    const [b] = await s.openBlocks()
    const r1 = await request(op, b.id, s.esc.id, K('a'))
    const r2 = await request(op, b.id, s.esc.id, K('e'))
    expect(await execute(rev1, r1, K('b'))).toBe('EXECUTED')
    expect(await code(execute(rev2, r2, K('d'), 'cd'.repeat(64)))).toBe('E2517')
    const row = (await rawAdmin(`SELECT "executedAt" FROM offer_capacity_unblock_requests WHERE id=$1`, [r2])).rows[0]
    expect(row.executedAt).toBeNull() // the stale request was not consumed
  })

  // GK M10: the function's own reviewer-role check is defence in depth behind the EXECUTE grant; it must hold on its own.
  run('DEFENCE IN DEPTH (E2512): a role that was GRANTED execute but is NOT a reviewer member is refused by the function itself', async () => {
    const nonRev = `m1b_nonrev_${RUN}`
    await admin.query(`CREATE ROLE ${nonRev} LOGIN PASSWORD 'p'`)
    await admin.query(`GRANT EXECUTE ON FUNCTION offer_capacity_execute_unblock(text, text, text) TO ${nonRev}`)
    const c = new Client({ connectionString: urlFor(nonRev, 'p') })
    try {
      await c.connect()
      expect(await code(execute(c, 'any-request'))).toBe('E2512')
    } finally {
      await c.end().catch(() => undefined)
      await admin.query(`REVOKE EXECUTE ON FUNCTION offer_capacity_execute_unblock(text, text, text) FROM ${nonRev}`)
      await admin.query(`DROP ROLE IF EXISTS ${nonRev}`)
    }
  })

  // GK M11: the stored digest is re-verified at execution; only a superuser bypassing the immutability trigger can break it.
  run('DIGEST (E2516): a request whose stored digest was tampered (immutability trigger disabled for one statement) is refused and the block stays in force', async () => {
    const s = await blocked(0xc7)
    await s.ev('r', 'RECONFIRMED', 100, 101, T(5)) // evidence is final: only the digest can stop the reviewer
    const [b] = await s.openBlocks()
    const id = await request(op, b.id, s.esc.id)
    // the replica role is reserved by tests/replicaRoleOnlyInHelper.test.ts: the immutability trigger is switched off for ONE statement inside a
    // transaction instead (DDL is transactional, the trigger is back before COMMIT, never production)
    await admin.query('BEGIN')
    try {
      await admin.query(`ALTER TABLE offer_capacity_unblock_requests DISABLE TRIGGER offer_capacity_unblock_requests_guard`)
      await admin.query(`UPDATE offer_capacity_unblock_requests SET digest=$1 WHERE id=$2`, ['0'.repeat(64), id])
      await admin.query(`ALTER TABLE offer_capacity_unblock_requests ENABLE TRIGGER offer_capacity_unblock_requests_guard`)
      await admin.query('COMMIT')
    } catch (e) { await admin.query('ROLLBACK'); throw e }
    expect(await code(execute(rev1, id, K('b')))).toBe('E2516')
    expect(await s.openBlocks()).toHaveLength(1)
  })
})
