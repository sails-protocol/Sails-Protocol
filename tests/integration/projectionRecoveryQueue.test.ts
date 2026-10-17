// tests/integration/projectionRecoveryQueue.test.ts
//
// Settlement reconciliation PASS 3 (incomplete projections of a claimed escrow transition) — real
// PostgreSQL proof that one run does bounded work from a durable round-robin queue, that repeated runs
// reach every queued transition fairly across restarts, nodes, stale workers, crashes and poison rows,
// and that the queue changes only WHICH transitions a run re-drives, never what re-driving one does
// (one durable event per transition, each projection applied once).
//
// Queue: 'transition.claimed' markers with transitionProjectedAt null, ordered by a row's last visit
// (projectionRecoveryAttemptedAt), or its claim time if never visited.
//
// A "node" is an independent module graph (jest.isolateModules): its own event bus, handlers and
// module-level state (the old PASS 3 cursor lived there), i.e. another application instance or this
// one after a restart. The PrismaClient itself is shared across module graphs (src/common/database
// caches it on global.__prisma outside production; Prisma 7 cannot run two clients in one jest
// worker), so nodes share one connection POOL, not one connection: each claim is its own statement
// on its own pooled connection. Barriers are placed on a node's own module objects or held as real
// PostgreSQL locks, so interleavings are forced, not raced.
//
// The shared test database keeps other suites' queued rows. Fixtures are claimed at QUEUE_HEAD, ahead
// of all of them; bounds that depend on the whole queue are computed from its real size.

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const QUEUE_HEAD = Date.parse('2000-01-01T00:00:00.000Z')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

type Report = { requiresManualReview: Array<{ escrowId: string; reason: string }>; failed: Array<{ escrowId: string; error: string }>; projectionsRecovered: Array<{ escrowId: string; transitionId: string; action: string }> }
const newReport = (): Report => ({ requiresManualReview: [], failed: [], projectionsRecovered: [] })

describe('Settlement reconciliation PASS 3 — durable, bounded, fair projection recovery (real PostgreSQL)', () => {
  jest.setTimeout(600_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let BATCH: number
  const nodes: Node[] = []
  let buyerId: string
  let sellerId: string
  let offerId: string
  let headOffset = 0

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ PROJECTION_RECOVERY_BATCH: BATCH } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    buyerId = (await prisma.user.create({ data: { publicKey: `pk-p3q-buyer-${suffix}` } })).id
    sellerId = (await prisma.user.create({ data: { publicKey: `pk-p3q-seller-${suffix}` } })).id
    offerId = (await prisma.offer.create({ data: { userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })).id
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  afterEach(async () => {
    while (nodes.length) await nodes.pop()!.shutdown()
    jest.restoreAllMocks()
    if (dbAvailable) await prisma.eventProjectionClaim.deleteMany({ where: { projectionKey: 'transition.claimed', subjectId: { startsWith: 'p3q-orphan-' } } })
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    run: (opts?: { limit?: number; graceMs?: number }) => Promise<Report>
    projection: any
    tradeRepository: any
    shutdown: () => Promise<void>
  }

  /** An independent application instance. `handlers: false` = a process that dies before its handlers run. */
  function startNode({ handlers = true } = {}): Node {
    let node!: Node
    jest.isolateModules(() => {
      const redisModule = require('../../src/common/redis')
      if (handlers) require('../../src/common/events/handlers').registerEventHandlers()
      const { reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      node = {
        run: async (opts = {}) => {
          const report = newReport()
          await reconcileIncompleteProjections(report, opts.graceMs ?? 0, { limit: opts.limit })
          return report
        },
        projection: require('../../src/common/events/event-projection'),
        tradeRepository: require('../../src/modules/open-p2p/trade-repository').tradeRepository,
        shutdown: async () => { await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  /** Strictly increasing claim times at the head of the queue, ahead of every shared row. */
  function nextHeadTime(): Date {
    headOffset += 1000
    return new Date(QUEUE_HEAD + headOffset)
  }

  interface Fixture { transitionId: string; escrowId: string; tradeId: string }

  /**
   * A FUNDS_LOCKED escrow whose lock transition was claimed ('transition.claimed' written with its
   * EscrowEvent, as emitEscrowTransition() does) and whose projection never completed.
   * published=false: crash between claim and publish (no durable event). published=true: the durable
   * event exists but its handlers never finished.
   */
  async function claimedLock({ published = false, appliedAt = nextHeadTime() } = {}): Promise<Fixture> {
    const trade = await prisma.trade.create({ data: { offerId, buyerId, sellerId, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65', status: 'PENDING' } })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'FUNDS_LOCKED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: escrow.id, fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED', triggeredBy: sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: escrow.id, appliedAt } })
    if (published) {
      await prisma.durableEventRecord.create({
        data: {
          id: randomUUID(), eventName: 'settlement.escrow.locked', correlationId: trade.id,
          payload: { escrowId: escrow.id, tradeId: trade.id, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: sellerId, transitionId: transition.id },
          publishedAt: new Date().toISOString(), entryHash: 'e' + randomUUID(), prevHash: 'genesis',
        },
      })
    }
    return { transitionId: transition.id, escrowId: escrow.id, tradeId: trade.id }
  }

  async function claimedLocks(n: number, opts: Parameters<typeof claimedLock>[0] = {}): Promise<Fixture[]> {
    const out: Fixture[] = []
    for (let i = 0; i < n; i++) out.push(await claimedLock(opts))
    return out
  }

  /** A claimed marker whose EscrowEvent does not exist: nothing can ever be re-driven. */
  async function orphans(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => randomUUID())
    for (const id of ids) await prisma.eventProjectionClaim.create({ data: { eventId: id, projectionKey: 'transition.claimed', subjectId: 'p3q-orphan-' + id, appliedAt: nextHeadTime() } })
    return ids
  }

  // ─── observations ─────────────────────────────────────────────────────────────────────────────────────

  const queueRow = async (transitionId: string) =>
    (await prisma.eventProjectionClaim.findFirst({ where: { eventId: transitionId, projectionKey: 'transition.claimed' } }))!
  const queueSize = () => prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.claimed', transitionProjectedAt: null } })
  const durableEvents = (transitionId: string) => prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM durable_events WHERE payload->>'transitionId' = ${transitionId}`
  const redriven = (r: Report) => r.projectionsRecovered.map((x) => x.transitionId)
  const ids = (fs: Fixture[]) => fs.map((f) => f.transitionId)

  async function waitFor(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }
  const allLeftQueue = (transitionIds: string[]) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.claimed', eventId: { in: transitionIds }, transitionProjectedAt: null } })) === 0
  /**
   * Production runs are a tick apart (60 s), far longer than a re-drive's handlers take; runs here are
   * milliseconds apart. Let the fixtures this run re-drove finish projecting (leave the queue) before the
   * next run, as they would between ticks. Without it, a short queue hands the same still-in-flight rows to
   * the next run again - correct (a redundant REDELIVER is a no-op) but not what these scenarios measure.
   */
  async function settle(r: Report, among: Fixture[]): Promise<void> {
    await waitFor(allLeftQueue(redriven(r).filter((t) => ids(among).includes(t))))
  }

  /** Every fixture converged exactly once: one durable event, one trade projection, one projected marker, out of the queue. */
  async function expectConvergedOnce(fs: Fixture[]): Promise<void> {
    await waitFor(allLeftQueue(ids(fs)))
    await sleep(200)
    for (const f of fs) {
      const events = await durableEvents(f.transitionId)
      expect(events).toHaveLength(1)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: events[0].id, projectionKey: 'trade.status' } })).toBe(1)
      expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: f.transitionId } })).toBe(1)
      expect((await prisma.trade.findUnique({ where: { id: f.tradeId } }))!.status).toBe('ACTIVE')
      expect((await queueRow(f.transitionId)).transitionProjectedAt).not.toBeNull()
    }
  }

  // ═══ structure ═══════════════════════════════════════════════════════════════════════════════════════

  it('the queue has its own partial index, and the claim is served from it in queue order (never from the projected history)', async () => {
    requirePostgres('index catalog')
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'event_projection_claims' AND indexname = 'event_projection_claims_transition_recovery_queue_idx'`
    expect(index.indexdef).toMatch(/COALESCE\("projectionRecoveryAttemptedAt", "appliedAt"\)/)
    expect(index.indexdef).toMatch(/WHERE .*'transition\.claimed'.*"transitionProjectedAt" IS NULL/)

    // With sequential and bitmap scans priced out, the only remaining path is an ordered index scan. A
    // plan that still reads the table, or still sorts, would mean the claim's predicate does not imply
    // the index's or the index cannot yield queue order, i.e. it could never serve the claim at any size.
    // (On a small table the planner may legitimately prefer a bitmap scan plus a sort.)
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off')
      return tx.$queryRawUnsafe<unknown[]>(`EXPLAIN (FORMAT JSON)
        SELECT c.id FROM event_projection_claims c
        WHERE c."projectionKey" = 'transition.claimed' AND c."transitionProjectedAt" IS NULL AND c."appliedAt" < now()
        ORDER BY COALESCE(c."projectionRecoveryAttemptedAt", c."appliedAt"), c.id LIMIT 200 FOR UPDATE SKIP LOCKED`)
    })
    const text = JSON.stringify(plan)
    expect(text).toContain('event_projection_claims_transition_recovery_queue_idx')
    expect(text).not.toContain('"Sort"')
  })

  // ═══ A–E: bounded runs drain a backlog ═══════════════════════════════════════════════════════════════

  it('A. backlog < batch: one run re-drives all of it; each transition converges once and leaves the queue; the next run leaves it alone', async () => {
    requirePostgres('A')
    const node = startNode()
    const fs = await claimedLocks(7)
    const r1 = await node.run({ limit: 10 })
    expect(redriven(r1).filter((t) => ids(fs).includes(t)).sort()).toEqual(ids(fs).sort())
    expect(r1.projectionsRecovered.filter((x) => ids(fs).includes(x.transitionId)).every((x) => x.action === 'REPUBLISHED')).toBe(true)
    await expectConvergedOnce(fs)
    const r2 = await node.run({ limit: 10 })
    expect(redriven(r2).filter((t) => ids(fs).includes(t))).toEqual([])
  })

  it('B. backlog = batch: exactly one run re-drives the whole backlog', async () => {
    requirePostgres('B')
    const node = startNode()
    const fs = await claimedLocks(10)
    const r1 = await node.run({ limit: 10 })
    expect(redriven(r1).sort()).toEqual(ids(fs).sort())
    await expectConvergedOnce(fs)
  })

  it('C. backlog > batch: run 1 re-drives exactly the oldest batch, run 2 the rest', async () => {
    requirePostgres('C')
    const node = startNode()
    const fs = await claimedLocks(13)
    const r1 = await node.run({ limit: 10 })
    expect(redriven(r1).sort()).toEqual(ids(fs.slice(0, 10)).sort())
    await settle(r1, fs)
    const r2 = await node.run({ limit: 10 })
    expect(redriven(r2).filter((t) => ids(fs).includes(t)).sort()).toEqual(ids(fs.slice(10)).sort())
    await expectConvergedOnce(fs)
  })

  it('D/E. backlog several times the batch: consecutive runs re-drive disjoint batches in queue order and drain it in ceil(backlog / batch) runs', async () => {
    requirePostgres('D/E')
    const node = startNode()
    const fs = await claimedLocks(35)
    const seen: string[][] = []
    for (let i = 0; i < 4; i++) {
      const r = await node.run({ limit: 10 })
      seen.push(redriven(r).filter((t) => ids(fs).includes(t)))
      await settle(r, fs)
    }
    expect(seen.map((s) => s.length)).toEqual([10, 10, 10, 5])
    for (let i = 0; i < 4; i++) expect(seen[i].sort()).toEqual(ids(fs.slice(i * 10, i * 10 + 10)).sort())
    expect(new Set(seen.flat()).size).toBe(35)
    await expectConvergedOnce(fs)
  })

  // ═══ F–H: restart, two nodes, stale worker ═══════════════════════════════════════════════════════════

  it('F. restart every run, with transitions that never converge queued AHEAD of recoverable ones (the old cursor\'s failure): each fresh node continues from the durable queue position and every recoverable transition is reached within ceil(backlog / batch) restarts', async () => {
    requirePostgres('F')
    const stuck = await orphans(15) // never leave the queue: only a durable position gets a restarted node past them
    const fs = await claimedLocks(20)
    const seen: string[] = []
    const stuckSeen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const node = startNode() // a new process: no memory of any earlier run
      const r = await node.run({ limit: 10 })
      seen.push(...redriven(r).filter((t) => ids(fs).includes(t)))
      for (const m of r.requiresManualReview) stuckSeen.add(m.escrowId)
      await settle(r, fs)
      await node.shutdown(); nodes.splice(nodes.indexOf(node), 1)
    }
    expect(stuck.every((id) => stuckSeen.has('p3q-orphan-' + id))).toBe(true)
    expect(seen.sort()).toEqual(ids(fs).sort()) // every recoverable one exactly once, in 4 restarts
    await expectConvergedOnce(fs)
  })

  it('G. two nodes: a claim skips rows another node\'s in-flight claim holds, and concurrent runs re-drive disjoint batches that together cover the backlog', async () => {
    requirePostgres('G')
    const fs = await claimedLocks(20)
    const a = startNode(); const b = startNode()

    // Barrier = a real row lock: an in-flight claim of node A holding the 10 oldest rows.
    const holding = deferred(); const release = deferred()
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM event_projection_claims WHERE "eventId" = ANY(${ids(fs.slice(0, 10))}) FOR UPDATE`
      holding.resolve()
      await release.promise
    }, { timeout: 60_000 })
    await holding.promise
    const rb = await b.run({ limit: 10 }) // does not wait for A's lock: skips those rows
    release.resolve(); await held
    expect(redriven(rb).sort()).toEqual(ids(fs.slice(10)).sort())
    // the held rows were skipped, not lost: they are simply next in line
    const rest = await a.run({ limit: 10 })
    expect(redriven(rest).sort()).toEqual(ids(fs.slice(0, 10)).sort())

    // and truly concurrent runs of both nodes over a fresh backlog
    const gs = await claimedLocks(20)
    const [ra, rb2] = await Promise.all([a.run({ limit: 10 }), b.run({ limit: 10 })])
    const inA = redriven(ra).filter((t) => ids(gs).includes(t)); const inB = redriven(rb2).filter((t) => ids(gs).includes(t))
    expect(inA.filter((t) => inB.includes(t))).toEqual([])
    expect([...inA, ...inB].sort()).toEqual(ids(gs).sort())
    await expectConvergedOnce([...fs, ...gs])
  })

  it('H. stale worker: a node that stalls after its claim and resumes after another node already re-drove the same transition mints no second durable event, applies nothing twice, and cannot move the queue position back', async () => {
    requirePostgres('H')
    const [x] = await claimedLocks(1)
    const stale = startNode(); const fresh = startNode()

    // Barrier on the stale node's own module: its claim commits, then the node stalls before re-driving.
    const claimed = deferred(); const resume = deferred()
    const realClaim = stale.projection.claimTransitionRecoveryBatch
    jest.spyOn(stale.projection, 'claimTransitionRecoveryBatch').mockImplementationOnce(async (...args: unknown[]) => {
      const batch = await realClaim(...args)
      claimed.resolve(); await resume.promise
      return batch
    })
    const staleRun = stale.run({ limit: 1 })
    await claimed.promise
    const staleStamp = (await queueRow(x.transitionId)).projectionRecoveryAttemptedAt!

    // The queue moves on; the fresh node reaches X again only after every row queued ahead of it.
    const bound = Math.ceil((await queueSize()) / BATCH) + 1
    let freshReport: Report | undefined
    for (let i = 0; i < bound && !freshReport; i++) {
      const r = await fresh.run()
      if (redriven(r).includes(x.transitionId)) freshReport = r
    }
    expect(freshReport!.projectionsRecovered.find((p) => p.transitionId === x.transitionId)!.action).toBe('REPUBLISHED')
    await waitFor(allLeftQueue([x.transitionId]))
    const freshStamp = (await queueRow(x.transitionId)).projectionRecoveryAttemptedAt!
    expect(freshStamp.getTime()).toBeGreaterThan(staleStamp.getTime())

    resume.resolve()
    const staleReport = await staleRun
    // the stale batch still holds X: it re-drives it once more, finds the durable event, redelivers
    expect(staleReport.projectionsRecovered.find((p) => p.transitionId === x.transitionId)!.action).toBe('REDELIVERED')
    await sleep(500)
    await expectConvergedOnce([x])
    expect((await queueRow(x.transitionId)).projectionRecoveryAttemptedAt!.getTime()).toBe(freshStamp.getTime()) // not moved back
  })

  it('H2. two workers re-driving the SAME unpublished transition at the same moment are serialized by the publish lock: one publishes, the other redelivers, one durable event', async () => {
    requirePostgres('H2')
    const [x] = await claimedLocks(1)
    const a = startNode(); const b = startNode()
    const batch = [{ id: (await queueRow(x.transitionId)).id, eventId: x.transitionId, subjectId: x.escrowId }]
    // Both workers hold X in a claimed batch (as after a full lap past a stale worker, scenario H).
    jest.spyOn(a.projection, 'claimTransitionRecoveryBatch').mockResolvedValueOnce(batch)
    jest.spyOn(b.projection, 'claimTransitionRecoveryBatch').mockResolvedValueOnce(batch)

    // Barrier = the publish lock itself, held by the test until both workers are blocked on it.
    const holding = deferred(); const release = deferred()
    const lock = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'transition-publish:' + x.transitionId})::bigint)`
      holding.resolve()
      await release.promise
    }, { timeout: 60_000 })
    await holding.promise
    const runs = Promise.all([a.run(), b.run()])
    await waitFor(async () => {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      return Number(n) >= 2
    })
    release.resolve(); await lock
    const [ra, rb] = await runs
    const actions = [...ra.projectionsRecovered, ...rb.projectionsRecovered].filter((p) => p.transitionId === x.transitionId).map((p) => p.action).sort()
    expect(actions).toEqual(['REDELIVERED', 'REPUBLISHED'])
    await expectConvergedOnce([x])
  })

  // ═══ I–K: poison rows and continuously arriving work ═════════════════════════════════════════════════

  it('I. poison rows (a transition whose projection fails on every delivery, and one that no longer exists) take one slot per lap: work queued behind them drains, and they stay queued and retryable', async () => {
    requirePostgres('I')
    const node = startNode()
    const [poison] = await claimedLocks(1)
    const [orphan] = await orphans(1)
    const fs = await claimedLocks(25)
    // this node's trade projection fails for the poison escrow on every delivery (a projection bug or bad data)
    const project = node.tradeRepository.projectEscrowStatus.bind(node.tradeRepository)
    jest.spyOn(node.tradeRepository, 'projectEscrowStatus').mockImplementation(async (...args: any[]) => {
      if (args[1] === poison.escrowId) throw new Error('projection keeps failing')
      return project(...args)
    })

    const r1 = await node.run({ limit: 10 })
    expect(r1.projectionsRecovered.find((p) => p.transitionId === poison.transitionId)!.action).toBe('REPUBLISHED')
    expect(r1.requiresManualReview.find((m) => m.escrowId === 'p3q-orphan-' + orphan)!.reason).toMatch(/EscrowEvent does not exist/)
    await settle(r1, fs)
    const r2 = await node.run({ limit: 10 })
    await settle(r2, fs)
    const r3 = await node.run({ limit: 10 })
    // r2 is filled by fixtures still queued ahead of the two poison rows (17 left, batch 10)
    expect(redriven(r2)).not.toContain(poison.transitionId)
    expect(r2.requiresManualReview.map((m) => m.escrowId)).not.toContain('p3q-orphan-' + orphan)
    expect([...redriven(r1), ...redriven(r2), ...redriven(r3)].filter((t) => ids(fs).includes(t)).sort()).toEqual(ids(fs).sort())
    // a poison row comes back only once everything queued ahead of it has had its turn (in a short queue,
    // that can already be r3)
    if (redriven(r3).includes(poison.transitionId)) expect([...redriven(r2), ...redriven(r3)].filter((t) => ids(fs.slice(8)).includes(t)).sort()).toEqual(ids(fs.slice(8)).sort())
    await expectConvergedOnce(fs)

    // still queued, and retried within one lap of the whole queue
    await sleep(300)
    expect((await queueRow(poison.transitionId)).transitionProjectedAt).toBeNull()
    const firstVisit = (await queueRow(poison.transitionId)).projectionRecoveryAttemptedAt!
    const bound = Math.ceil((await queueSize()) / BATCH) + 1
    let action: string | undefined
    for (let i = 0; i < bound && !action; i++) action = (await node.run()).projectionsRecovered.find((p) => p.transitionId === poison.transitionId)?.action
    expect(action).toBe('REDELIVERED')
    expect((await queueRow(poison.transitionId)).projectionRecoveryAttemptedAt!.getTime()).toBeGreaterThan(firstVisit.getTime())
    expect(await durableEvents(poison.transitionId)).toHaveLength(1) // redelivered, never re-published
  })

  it('J/K. work arriving every run while an old backlog is being retried: new work is re-driven no later than its rank in the queue allows, and every old row is revisited every lap - neither starves the other', async () => {
    requirePostgres('J/K')
    const node = startNode()
    const old = await orphans(30) // a backlog that never converges
    const visits = new Map<string, number[]>(old.map((id) => ['p3q-orphan-' + id, []]))
    type Arrival = { f: Fixture; arrivedAt: number; bound: number; doneAt?: number }
    const arrivals: Arrival[] = []
    const RUNS = 12
    for (let run = 0; run < RUNS; run++) {
      // new work claimed "now" (past a zero grace): queued behind everything touched before it
      for (const f of await claimedLocks(5, { appliedAt: new Date(Date.now() - 1) })) {
        const [{ ahead }] = await prisma.$queryRaw<Array<{ ahead: bigint }>>`
          SELECT count(*)::bigint AS ahead FROM event_projection_claims c, event_projection_claims me
          WHERE me."eventId" = ${f.transitionId} AND me."projectionKey" = 'transition.claimed'
            AND c."projectionKey" = 'transition.claimed' AND c."transitionProjectedAt" IS NULL
            AND (COALESCE(c."projectionRecoveryAttemptedAt", c."appliedAt"), c.id) < (COALESCE(me."projectionRecoveryAttemptedAt", me."appliedAt"), me.id)`
        // rows ahead of it only ever leave the queue or move behind it, so it is claimed by run floor(ahead / BATCH)
        arrivals.push({ f, arrivedAt: run, bound: Math.floor(Number(ahead) / BATCH) })
      }
      const r = await node.run()
      for (const a of arrivals) if (a.doneAt === undefined && redriven(r).includes(a.f.transitionId)) a.doneAt = run
      for (const m of r.requiresManualReview) visits.get(m.escrowId)?.push(run)
    }
    const due = arrivals.filter((a) => a.arrivedAt + a.bound < RUNS)
    expect(due.length).toBeGreaterThan(0)
    for (const a of due) expect(a.doneAt! - a.arrivedAt).toBeLessThanOrEqual(a.bound)

    // old backlog: every row visited in the first run (oldest keys), then at least once per lap
    const lap = Math.ceil((await queueSize()) / BATCH) + 1
    for (const v of visits.values()) {
      expect(v[0]).toBe(0)
      const gaps = [...v, RUNS - 1].map((x, i, all) => (i === 0 ? 0 : x - all[i - 1]))
      expect(Math.max(...gaps)).toBeLessThanOrEqual(lap)
    }
    await expectConvergedOnce(arrivals.filter((a) => a.doneAt !== undefined).map((a) => a.f))
  })

  it('K2. the fairness rule itself: a claim takes the rows with the oldest round-robin key (last visit, else claim time) - a row visited long ago comes BEFORE never-visited rows claimed after that visit, so a steady stream of new work cannot push it back forever', async () => {
    requirePostgres('K2')
    const node = startNode()
    const [visitedLongAgo] = await orphans(1)
    const fresh = await orphans(4) // claimed after that visit, never visited
    // it was last visited at QUEUE_HEAD + 1 s, before any of the fresh rows was even claimed
    await prisma.eventProjectionClaim.updateMany({ where: { eventId: visitedLongAgo, projectionKey: 'transition.claimed' }, data: { appliedAt: new Date(QUEUE_HEAD), projectionRecoveryAttemptedAt: new Date(QUEUE_HEAD + 1) } })
    const claimed = await node.projection.claimTransitionRecoveryBatch(3, new Date())
    expect(claimed.map((c: { eventId: string }) => c.eventId).sort()).toEqual([visitedLongAgo, fresh[0], fresh[1]].sort())
  })

  // ═══ L–M: crash windows ══════════════════════════════════════════════════════════════════════════════

  it('L. crash right after the claim (nothing re-driven): the transition keeps its place one lap back and is re-driven by a later run', async () => {
    requirePostgres('L')
    const [x] = await claimedLocks(1)
    const crashed = startNode()
    jest.spyOn(crashed.projection, 'markProjectedTransitions').mockRejectedValueOnce(new Error('process died after the claim'))
    await expect(crashed.run({ limit: 1 })).rejects.toThrow('process died after the claim')
    expect((await queueRow(x.transitionId)).projectionRecoveryAttemptedAt).not.toBeNull()
    expect(await durableEvents(x.transitionId)).toHaveLength(0)

    const node = startNode()
    const bound = Math.ceil((await queueSize()) / BATCH) + 1
    let done = false
    for (let i = 0; i < bound && !done; i++) done = redriven(await node.run()).includes(x.transitionId)
    expect(done).toBe(true)
    await expectConvergedOnce([x])
  })

  it('M. crash after the durable repair (event re-published, handlers never ran): the transition stays queued and the next visit REDELIVERS the same event instead of minting another', async () => {
    requirePostgres('M')
    const [x] = await claimedLocks(1)
    const dead = startNode({ handlers: false }) // publishes, then dies before any projection runs
    const r1 = await dead.run({ limit: 1 })
    expect(r1.projectionsRecovered.find((p) => p.transitionId === x.transitionId)!.action).toBe('REPUBLISHED')
    await sleep(300)
    expect(await durableEvents(x.transitionId)).toHaveLength(1)
    expect((await queueRow(x.transitionId)).transitionProjectedAt).toBeNull()

    const node = startNode()
    const bound = Math.ceil((await queueSize()) / BATCH) + 1
    let report: Report | undefined
    for (let i = 0; i < bound && !report; i++) {
      const r = await node.run()
      if (redriven(r).includes(x.transitionId)) report = r
    }
    expect(report!.projectionsRecovered.find((p) => p.transitionId === x.transitionId)!.action).toBe('REDELIVERED')
    await expectConvergedOnce([x])
  })

  // ═══ N–Q ═════════════════════════════════════════════════════════════════════════════════════════════

  it('N. converged transitions leave the queue: the live handler path removes them in the marker\'s own transaction, and a projected marker without the queue flag (older node) is taken out without any re-drive', async () => {
    requirePostgres('N')
    const node = startNode()
    // live path: re-driven once, then out of the queue for good
    const [live] = await claimedLocks(1)
    await node.run({ limit: 1 })
    await expectConvergedOnce([live])

    // legacy: projected by a node that did not know the column yet
    const [legacy] = await claimedLocks(1, { published: true })
    const [event] = await durableEvents(legacy.transitionId)
    await prisma.eventProjectionClaim.create({ data: { eventId: event.id, projectionKey: 'transition.projected', subjectId: legacy.transitionId } })
    const r = await node.run({ limit: 1 })
    expect(redriven(r)).not.toContain(legacy.transitionId)
    expect((await queueRow(legacy.transitionId)).transitionProjectedAt).not.toBeNull()
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: event.id, projectionKey: 'trade.status' } })).toBe(0) // nothing re-driven
  })

  it('O. grace period: a transition claimed less than graceMs ago is never claimed; once older, it is', async () => {
    requirePostgres('O')
    const node = startNode()
    const graceMs = 60 * 60 * 1000
    const [young] = await claimedLocks(1, { appliedAt: new Date(Date.now() - graceMs + 60_000) })
    const [old] = await claimedLocks(1, { appliedAt: new Date(Date.now() - graceMs - 60_000) })

    const bound = Math.ceil((await queueSize()) / BATCH) + 1
    const seen: string[] = []
    for (let i = 0; i < bound; i++) seen.push(...redriven(await node.run({ graceMs })))
    expect(seen).toContain(old.transitionId)
    expect(seen).not.toContain(young.transitionId)
    expect((await queueRow(young.transitionId)).projectionRecoveryAttemptedAt).toBeNull()

    // past the grace period it is eligible (a shorter grace is the same as waiting)
    let done = false
    for (let i = 0; i < bound && !done; i++) done = redriven(await node.run({ graceMs: 30_000 })).includes(young.transitionId)
    expect(done).toBe(true)
    await expectConvergedOnce([old, young])
  })

  it('P. duplicate invocation on one node: two overlapping runs claim disjoint batches; every transition is published once', async () => {
    requirePostgres('P')
    const node = startNode()
    const fs = await claimedLocks(16)
    const [r1, r2] = await Promise.all([node.run({ limit: 8 }), node.run({ limit: 8 })])
    const a = redriven(r1).filter((t) => ids(fs).includes(t)); const b = redriven(r2).filter((t) => ids(fs).includes(t))
    expect(a.filter((t) => b.includes(t))).toEqual([])
    expect([...a, ...b].sort()).toEqual(ids(fs).sort())
    await expectConvergedOnce(fs)
  })

  it('Q. drained backlog, restart, new work: the restarted node never revisits converged transitions and re-drives the new one', async () => {
    requirePostgres('Q')
    const first = startNode()
    const fs = await claimedLocks(5)
    await first.run({ limit: 10 })
    await expectConvergedOnce(fs)
    const stamps = await Promise.all(fs.map(async (f) => (await queueRow(f.transitionId)).projectionRecoveryAttemptedAt!.getTime()))
    await first.shutdown(); nodes.splice(nodes.indexOf(first), 1)

    const restarted = startNode()
    const [late] = await claimedLocks(1)
    const r = await restarted.run({ limit: 10 })
    expect(redriven(r)).toContain(late.transitionId)
    expect(redriven(r).filter((t) => ids(fs).includes(t))).toEqual([])
    expect(await Promise.all(fs.map(async (f) => (await queueRow(f.transitionId)).projectionRecoveryAttemptedAt!.getTime()))).toEqual(stamps)
    await expectConvergedOnce([late])
  })
})
