// tests/integration/timelockExpiryBoundedness.test.ts
//
// One timelock-expiry sweep pass does bounded work: it claims at most EXPIRY_SWEEP_BATCH expired
// FUNDS_LOCKED escrows (claimExpiryCandidates()), in a durable round-robin order shared by every instance,
// and a larger backlog drains over the following passes. The order is queue position only: whether an
// escrow expires is still decided by the expiry authority, the status CAS and #379's atomic transition
// claim, so every scenario must still end with at most one EXPIRED transition, one claimed transition and
// eventually one canonical 'settlement.escrow.expired' event per escrow.
//
// Real PostgreSQL. A "node" is an independent module graph (jest.isolateModules) on the shared PrismaClient,
// as in transitionPublishAuthority.test.ts: separate application state, one database; not separate OS
// processes. Fixtures expire in 2001, ahead of every other row in the shared queue, so other suites' rows
// never take a slot here. Crashes and races are failpoints and barriers, never timing.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const QUEUE_HEAD = new Date('2000-01-01T00:00:00.000Z')
const EXPIRED_EVENT = 'settlement.escrow.expired'

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('Timelock expiry sweep: bounded passes, durable round-robin, #379 invariant intact (real PostgreSQL)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let BATCH: number
  const nodes: Node[] = []
  let seedClock = Date.UTC(2001, 0, 1) // each seeded escrow expires 1 ms after the previous one

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ EXPIRY_SWEEP_BATCH: BATCH } = require('../../src/modules/open-settlement/escrow.service'))
  })

  afterAll(async () => {
    if (pg.isAvailable()) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    while (nodes.length) await nodes.pop()!.shutdown()
    // Poison this suite seeded stays FUNDS_LOCKED and due forever; left in the shared queue it would take
    // slots from other suites' single-pass sweeps. Remove it (only rows this suite owns, still untouched:
    // FUNDS_LOCKED, no transition, no record).
    if (poisonToRemove.length) {
      const ids = poisonToRemove.splice(0)
      await prisma.$transaction(async (tx) => {
        const trades = await tx.$queryRaw<Array<{ tradeId: string }>>`
          DELETE FROM escrows e WHERE e.id = ANY(${ids}) AND e.status = 'FUNDS_LOCKED'
            AND NOT EXISTS (SELECT 1 FROM escrow_events v WHERE v."escrowId" = e.id)
            AND NOT EXISTS (SELECT 1 FROM semantic_transition_records r WHERE r."interactionId" = e.id)
          RETURNING e."tradeId"`
        await tx.$executeRaw`DELETE FROM trades WHERE id = ANY(${trades.map((t) => t.tradeId)})`
      })
    }
  })
  const poisonToRemove: string[] = []

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    escrowService: any
    str: typeof import('../../src/modules/open-settlement/semantic-transition-record')
    /** ids each claim of this node returned, in order */
    claims: string[][]
    sweep: () => Promise<{ refunded: string[]; requiresManualRecovery: string[]; failed: Array<{ escrowId: string; error: string }> }>
    reconcile: () => Promise<unknown>
    shutdown: () => Promise<void>
  }

  /** An application instance (or this one after a restart): fresh module graph, nothing in memory. */
  function startNode(): Node {
    let node!: Node
    jest.isolateModules(() => {
      const redisModule = require('../../src/common/redis')
      require('../../src/common/events/handlers').registerEventHandlers()
      const recon = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      const escrowService = require('../../src/modules/open-settlement/escrow.service').escrowService
      const claims: string[][] = []
      const repo = escrowService.repo
      const realClaim = repo.claimExpiryCandidates.bind(repo)
      jest.spyOn(repo, 'claimExpiryCandidates').mockImplementation(async (...a: any[]) => {
        const rows = await realClaim(...a)
        claims.push(rows.map((r: { id: string }) => r.id))
        return rows
      })
      node = {
        escrowService,
        str: require('../../src/modules/open-settlement/semantic-transition-record'),
        claims,
        sweep: () => escrowService.sweepExpiredEscrows(),
        reconcile: () => recon.reconcilePendingSettlements({ projectionGraceMs: 0 }),
        shutdown: async () => { await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fixtures and reads ───────────────────────────────────────────────────────────────────────────────

  /** `n` expired FUNDS_LOCKED escrows of `type`, one trade each, expiring in seeding order (all in 2001). */
  async function seed(n: number, type: 'MULTISIG' | 'WDK_USDT_EVM' = 'MULTISIG'): Promise<string[]> {
    const tag = randomBytes(6).toString('hex')
    const first = new Date(seedClock)
    seedClock += n
    // #235 R7H-E3: the seller's PIX account, bound to the offer and to every seeded trade (tests/integration/economicFixtures.ts).
    const [{ seller, buyer, offer, account }] = await prisma.$queryRawUnsafe<Array<{ seller: string; buyer: string; offer: string; account: string }>>(`
      WITH s AS (INSERT INTO users (id, "publicKey", "updatedAt") VALUES (gen_random_uuid()::text, 'expiry-bound-s-${tag}', now()) RETURNING id),
           b AS (INSERT INTO users (id, "publicKey", "updatedAt") VALUES (gen_random_uuid()::text, 'expiry-bound-b-${tag}', now()) RETURNING id),
           a AS (INSERT INTO payment_accounts (id, "ownerId", "accountHash", "paymentMethod", "updatedAt")
                 SELECT gen_random_uuid()::text, s.id, 'expiry-bound-pix-${tag}', 'PIX', now() FROM s RETURNING id),
           o AS (INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "paymentAccountId", "updatedAt")
                 SELECT gen_random_uuid()::text, s.id, 'BTC', 'SELL', 65000, 0.001, 1, 'PIX', a.id, now() FROM s, a RETURNING id)
      SELECT s.id AS seller, b.id AS buyer, o.id AS offer, a.id AS account FROM s, b, o, a`)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
      WITH t AS (
        INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", "sellerPaymentAccountId", "updatedAt")
        SELECT gen_random_uuid()::text, '${offer}', '${buyer}', '${seller}', 'BTC', 0.001, 65000, 65, '${account}', now() FROM generate_series(1, ${n})
        RETURNING id)
      INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "timelockHours", "expiresAt", "txLockId", "txLockVout", "updatedAt")
      SELECT gen_random_uuid()::text, t.id, '${type}', 'FUNDS_LOCKED', 0.001, 'BTC', 1, $1::timestamptz + (ROW_NUMBER() OVER () - 1) * interval '1 millisecond',
             -- as escrow.service.ts's lockFunds() writes it: expiresAt only ever lands together with the funding outpoint
             -- (#235 R7G F8A: a MULTISIG escrow never reaches EXPIRED without one)
             encode(sha256(convert_to(t.id, 'UTF8')), 'hex'), 0, now() FROM t
      RETURNING id`, first)
    return rows.map((r) => r.id)
  }

  const statusCounts = async (ids: string[]) => {
    const rows = await prisma.$queryRaw<Array<{ status: string; n: number }>>`
      SELECT status::text, count(*)::int AS n FROM escrows WHERE id = ANY(${ids}) GROUP BY status`
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>
  }
  const expiredCount = async (ids: string[]) => (await statusCounts(ids)).EXPIRED ?? 0

  /** #379's invariant over a set of escrows: each EXPIRED one has exactly one record, one claimed transition and (once projected) one canonical event; nothing else has any. */
  async function expectExpiryInvariant(ids: string[]): Promise<void> {
    const [row] = await prisma.$queryRaw<Array<{ expired: number; records: number; transitions: number; maxPerEscrow: number }>>`
      SELECT
        (SELECT count(*)::int FROM escrows WHERE id = ANY(${ids}) AND status = 'EXPIRED') AS expired,
        (SELECT count(*)::int FROM semantic_transition_records WHERE "interactionId" = ANY(${ids}) AND "transitionType" = 'escrow.timelock.expire') AS records,
        (SELECT count(*)::int FROM escrow_events WHERE "escrowId" = ANY(${ids}) AND "toStatus" = 'EXPIRED') AS transitions,
        (SELECT COALESCE(max(n), 0)::int FROM (SELECT count(*) AS n FROM escrow_events WHERE "escrowId" = ANY(${ids}) AND "toStatus" = 'EXPIRED' GROUP BY "escrowId") x) AS "maxPerEscrow"`
    expect(row.records).toBe(row.expired)
    expect(row.transitions).toBe(row.expired)
    expect(row.maxPerEscrow).toBeLessThanOrEqual(1)
    const eventCount = () => prisma.$queryRaw<Array<{ events: number; distinct: number }>>`
      SELECT count(*)::int AS events, count(DISTINCT payload->>'escrowId')::int AS distinct FROM durable_events
      WHERE "eventName" = ${EXPIRED_EVENT} AND payload->>'escrowId' = ANY(${ids})`
    const end = Date.now() + 60_000
    let ev = (await eventCount())[0]
    while (ev.distinct < row.expired && Date.now() < end) { await sleep(100); ev = (await eventCount())[0] }
    expect(ev).toEqual({ events: row.expired, distinct: row.expired })
  }

  /** Passes until every id has left FUNDS_LOCKED or `max` passes ran; returns the passes used. Each pass on a fresh node when `restart`. */
  async function drain(ids: string[], max: number, { restart = false, node = undefined as Node | undefined } = {}): Promise<number> {
    let n = node ?? startNode()
    for (let pass = 1; pass <= max; pass++) {
      if (restart && pass > 1) n = startNode()
      await n.sweep()
      if (((await statusCounts(ids)).FUNDS_LOCKED ?? 0) === 0) return pass
    }
    return Infinity
  }

  // ═══ bound ═══════════════════════════════════════════════════════════════════════════════════════════

  it('the claim queue order is served by escrows_expiry_sweep_queue_idx (the index exists with its definition and gives that order with no sort)', async () => {
    pg.requirePostgres('index')
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'escrows' AND indexname = 'escrows_expiry_sweep_queue_idx'`
    expect(index.indexdef).toBe(`CREATE INDEX escrows_expiry_sweep_queue_idx ON public.escrows USING btree (COALESCE("expirySweepAttemptedAt", "expiresAt"), id) WHERE (status = 'FUNDS_LOCKED'::"EscrowStatus")`)
    // The index serves the claim's order with no sort: proven with the alternatives disabled, so the result
    // does not depend on this database's size (on a near-empty table the planner rightly prefers a sort).
    // At scale the planner chooses it on its own: 20,032 due rows, 100 read, 0.21 ms (see the PR).
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_sort = off`
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`
      return (await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT e.id FROM escrows e WHERE e.status = 'FUNDS_LOCKED' AND e."expiresAt" <= now()
        ORDER BY COALESCE(e."expirySweepAttemptedAt", e."expiresAt"), e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`).map((r) => r['QUERY PLAN']).join('\n')
    })
    expect(plan).toMatch(/Index Scan using escrows_expiry_sweep_queue_idx/)
    expect(plan).not.toMatch(/Sort/)
  })

  it('1. backlog below the batch: one pass expires all of it', async () => {
    pg.requirePostgres('backlog < batch')
    const ids = await seed(5)
    const node = startNode()
    await node.sweep()
    expect(await expiredCount(ids)).toBe(5)
    expect(node.claims[0].length).toBeLessThanOrEqual(BATCH)
    await expectExpiryInvariant(ids)
  })

  it('2/3. backlog = batch drains in one pass; batch + 1 takes exactly two, the first claiming only the batch', async () => {
    pg.requirePostgres('batch boundary')
    const exact = await seed(BATCH)
    const a = startNode()
    await a.sweep()
    expect(a.claims[0]).toHaveLength(BATCH)
    expect(await expiredCount(exact)).toBe(BATCH)

    const plusOne = await seed(BATCH + 1)
    const b = startNode()
    await b.sweep()
    expect(b.claims[0]).toHaveLength(BATCH)
    expect(await expiredCount(plusOne)).toBe(BATCH)
    await b.sweep()
    expect(await expiredCount(plusOne)).toBe(BATCH + 1)
    await expectExpiryInvariant([...exact, ...plusOne])
  })

  it('4/5. a large backlog (10 batches) drains in exactly ceil(N / batch) passes; no pass claims or materializes more than the batch', async () => {
    pg.requirePostgres('large backlog')
    const ids = await seed(BATCH * 10)
    const node = startNode()
    const passes = await drain(ids, 20, { node })
    expect(passes).toBe(10)
    for (const claim of node.claims) expect(claim.length).toBeLessThanOrEqual(BATCH)
    await expectExpiryInvariant(ids)
  })

  // ═══ fairness ════════════════════════════════════════════════════════════════════════════════════════

  it('6. one poison candidate (a refund the provider refuses) is retried without holding up anything behind it', async () => {
    pg.requirePostgres('one poison')
    const [poison] = await seed(1, 'WDK_USDT_EVM')
    poisonToRemove.push(poison)
    const good = await seed(BATCH + 20)
    const node = startNode()
    const first = await node.sweep()
    expect(first.failed.map((f) => f.escrowId)).toContain(poison)
    expect(await drain(good, 5, { node })).toBeLessThanOrEqual(2)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: poison } })).status).toBe('FUNDS_LOCKED') // still failing, still queued
    await expectExpiryInvariant(good)
  })

  it('7/10/11. more poison than one batch, ahead of good candidates: the good ones are reached within ceil(rows ahead / batch) passes, across restarts', async () => {
    pg.requirePostgres('poison > batch')
    const poison = await seed(BATCH + 50, 'WDK_USDT_EVM')
    poisonToRemove.push(...poison)
    const good = await seed(20)
    // ORDER BY expiresAt LIMIT batch would claim the same poison rows forever; the durable round robin
    // moves each claimed row behind, so a fresh process (restart) after every pass still progresses.
    const passes = await drain(good, 5, { restart: true })
    expect(passes).toBe(2)
    expect((await statusCounts(poison)).FUNDS_LOCKED).toBe(BATCH + 50)
    await expectExpiryInvariant(good)
  })

  it('8. a candidate that failed transiently (a DB error at its commit) is retried on a later pass and succeeds', async () => {
    pg.requirePostgres('retry succeeds')
    const ids = await seed(3)
    const a = startNode()
    const real = a.str.commitAuthoritativeEscrowTimelockExpiry
    let failedOnce = false
    jest.spyOn(a.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      if (!failedOnce && args[0] === ids[0]) { failedOnce = true; throw new Error('could not serialize access (transient)') }
      return (real as any)(...args)
    })
    const first = await a.sweep()
    expect(first.failed.map((f) => f.escrowId)).toEqual(expect.arrayContaining([ids[0]]))
    expect(await expiredCount(ids)).toBe(2)
    expect(await drain(ids, 3, { node: a })).toBeLessThanOrEqual(2)
    await expectExpiryInvariant(ids)
  })

  it('9. continuous arrivals: an old backlog and candidates expiring while it drains all progress (none waits more than a bounded number of passes)', async () => {
    pg.requirePostgres('continuous arrivals')
    const node = startNode()
    const all: string[] = await seed(BATCH * 2 + 50)
    for (let pass = 0; pass < 4; pass++) {
      all.push(...(await seed(60))) // new expiries every pass, later than the backlog
      await node.sweep()
    }
    // 250 + 4 x 60 = 490 rows: ceil(490 / batch) = 5 passes suffice for every row, old or new
    expect(await drain(all, 3, { node })).toBeLessThanOrEqual(1)
    expect(await expiredCount(all)).toBe(all.length)
    await expectExpiryInvariant(all)
  })

  // ═══ instances ═══════════════════════════════════════════════════════════════════════════════════════

  it('12. two nodes sweep at once: disjoint claims, each within the batch, one transition and one event per escrow', async () => {
    pg.requirePostgres('two nodes')
    const ids = await seed(BATCH * 3)
    const [a, b] = [startNode(), startNode()]
    const committedBy = new Map<string, number>()
    for (const n of [a, b]) {
      const real = n.str.commitAuthoritativeEscrowTimelockExpiry
      jest.spyOn(n.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
        committedBy.set(args[0], (committedBy.get(args[0]) ?? 0) + 1)
        return (real as any)(...args)
      })
    }
    await Promise.all([a.sweep(), b.sweep()])
    const [ca, cb] = [a.claims[0], b.claims[0]]
    expect(ca.length).toBeLessThanOrEqual(BATCH)
    expect(cb.length).toBeLessThanOrEqual(BATCH)
    expect(ca.filter((id) => cb.includes(id))).toEqual([]) // SKIP LOCKED: disjoint batches
    expect([...committedBy.values()].every((n) => n === 1)).toBe(true) // no escrow attempted twice
    expect(await expiredCount(ids)).toBe(ca.filter((id) => ids.includes(id)).length + cb.filter((id) => ids.includes(id)).length)
    await expectExpiryInvariant(ids)
    expect(await drain(ids, 2, { node: a })).toBe(1) // the third batch: nothing of this test is left in the queue
  })

  /** Holds `node`'s commit of `escrowId` until released (the worker has claimed its batch and decided the escrow is due). */
  function holdCommit(node: Node, escrowId: string) {
    const reached = deferred(); const resume = deferred()
    const real = node.str.commitAuthoritativeEscrowTimelockExpiry
    jest.spyOn(node.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      if (args[0] === escrowId) { reached.resolve(); await resume.promise }
      return (real as any)(...args)
    })
    return { reached: reached.promise, resume: resume.resolve }
  }

  it('13. a stale worker resumes its claimed batch after another node expired all of it: it loses every CAS and adds nothing', async () => {
    pg.requirePostgres('stale worker')
    const ids = await seed(3)
    const stale = startNode()
    const held = holdCommit(stale, ids[0])
    const staleRun = stale.sweep()
    await Promise.race([held.reached, staleRun.then(() => { throw new Error('the stale worker finished without reaching the held escrow') })])
    expect(stale.claims[0]).toEqual(expect.arrayContaining(ids))
    // the claim is queue position only, not ownership: another node's passes reach the same escrows
    expect(await drain(ids, 5, { restart: true })).toBeLessThanOrEqual(3)
    held.resume()
    const result = await staleRun
    expect(result.requiresManualRecovery.filter((id) => ids.includes(id))).toEqual([])
    expect(result.failed.filter((f) => ids.includes(f.escrowId))).toEqual([])
    await expectExpiryInvariant(ids)
  })

  it('18. an escrow that changes state after it was claimed (a payment is marked) is not expired: the CAS refuses it, no record, no transition', async () => {
    pg.requirePostgres('changed after claim')
    const [id] = await seed(1)
    const node = startNode()
    const held = holdCommit(node, id)
    const run = node.sweep()
    await Promise.race([held.reached, run.then(() => { throw new Error('the sweep finished without reaching the held escrow') })])
    expect((await prisma.escrow.updateMany({ where: { id, status: 'FUNDS_LOCKED' }, data: { status: 'PAYMENT_PENDING' } })).count).toBe(1)
    held.resume()
    const result = await run
    expect(result.requiresManualRecovery).not.toContain(id)
    expect(result.failed.map((f) => f.escrowId)).not.toContain(id)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id } })).status).toBe('PAYMENT_PENDING')
    await expectExpiryInvariant([id])
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: id } })).toBe(0)
  })

  // ═══ crashes ═════════════════════════════════════════════════════════════════════════════════════════

  it('14/15. a crash right after the claim (stamped, nothing done) and a crash before EXPIRED: the next pass on a fresh process expires them', async () => {
    pg.requirePostgres('crash after claim / before EXPIRED')
    const ids = await seed(4)
    const a = startNode()
    const repo = a.escrowService.repo
    const realClaim = (repo.claimExpiryCandidates as jest.Mock).getMockImplementation()!
    ;(repo.claimExpiryCandidates as jest.Mock).mockImplementationOnce(async (...args: any[]) => {
      await realClaim(...args)
      throw new Error('process died')
    })
    await expect(a.sweep()).rejects.toThrow('process died')
    expect((await statusCounts(ids)).FUNDS_LOCKED).toBe(4)
    const stamped = await prisma.escrow.count({ where: { id: { in: ids }, expirySweepAttemptedAt: { not: null } } })
    expect(stamped).toBe(4) // the claim committed: queue position moved, nothing else

    const b = startNode()
    const realCommit = b.str.commitAuthoritativeEscrowTimelockExpiry
    let died = false
    jest.spyOn(b.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      if (!died && args[0] === ids[0]) { died = true; throw new Error('process died') }
      return (realCommit as any)(...args)
    })
    await b.sweep()
    expect(await expiredCount(ids)).toBe(3)
    expect(await drain(ids, 3, { restart: true })).toBeLessThanOrEqual(2)
    await expectExpiryInvariant(ids)
  })

  it('16/17. a crash after EXPIRED, before the publish: the escrow is out of the sweep queue, and PASS 3 publishes its one canonical event', async () => {
    pg.requirePostgres('crash after EXPIRED')
    const ids = await seed(2)
    const a = startNode()
    const realCommit = a.str.commitAuthoritativeEscrowTimelockExpiry
    jest.spyOn(a.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      const result = await (realCommit as any)(...args)
      if (args[0] === ids[0]) throw new Error('process died')
      return result
    })
    await a.sweep()
    expect(await expiredCount(ids)).toBe(2)
    const b = startNode()
    await b.sweep() // the sweep never claims it again: it is no longer FUNDS_LOCKED
    expect(b.claims.flat()).not.toContain(ids[0])
    await prisma.eventProjectionClaim.updateMany({ where: { subjectId: { in: ids }, projectionKey: 'transition.claimed' }, data: { appliedAt: QUEUE_HEAD } })
    await b.reconcile()
    await expectExpiryInvariant(ids)
  })

  it('19/20. repeated ticks on a fresh module graph each time change nothing once the backlog is drained', async () => {
    pg.requirePostgres('duplicate ticks')
    const ids = await seed(7)
    await drain(ids, 2, { restart: true })
    for (let i = 0; i < 3; i++) {
      const n = startNode()
      await n.sweep()
      expect(n.claims.flat().filter((id) => ids.includes(id))).toEqual([])
    }
    await expectExpiryInvariant(ids)
  })
})
