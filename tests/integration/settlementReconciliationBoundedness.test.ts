// tests/integration/settlementReconciliationBoundedness.test.ts
//
// Settlement reconciliation PASS 1 / PASS 2 — real PostgreSQL proof that one run does bounded work,
// that repeated runs reach every queued escrow (fairly, across restarts and instances), and that the
// bounded queue changes only WHICH escrows a run looks at, never what recovering one of them does.
//
// PASS 1 queue: terminal escrows with no settlement result (txReleaseId null).
// PASS 2 queue: terminal escrows with a result whose completion is not verified yet.
//
// Each "node" is an independent module graph (jest.isolateModules): its own singletons and
// module-level state, i.e. another application instance, or this one after a restart. Barriers are
// placed on a node's own repository/service objects, so interleavings are forced, not raced.
// (Corrected 2026-09-29: this said "its own Prisma pool". The PrismaClient is shared across module
// graphs - src/common/database caches it on global.__prisma outside production, and Prisma 7 cannot
// run two clients in one jest worker - so nodes share one pool, each query on its own pooled
// connection. The claims under test are single SQL statements, so what they prove is unchanged.)
//
// The shared test database keeps other suites' rows. Each test first lets the queues observe every
// leftover escrow once (observeLeftovers()), which puts them behind anything created afterwards, and
// then asserts only on its own fixtures. PASS 3 is switched off through its own grace option (it
// selects nothing claimed after 1976), and the explorer is stubbed to fail fast, so PASS 0 leftovers
// never reach the network.

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const NO_PASS_3 = { projectionGraceMs: 50 * 365 * 24 * 3600 * 1000 }

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Resolves when `reached` does; fails fast if `work` settles first (the barrier was never hit). */
async function reachedOrSettled(reached: Promise<void>, work: Promise<unknown>, what: string): Promise<void> {
  const settled = work.then(() => 'settled', () => 'settled')
  const first = await Promise.race([reached.then(() => 'reached'), settled])
  if (first !== 'reached') throw new Error(`${what}: finished without reaching the barrier`)
}

describe('Settlement reconciliation PASS 1/2 — bounded runs, durable fair progress (real PostgreSQL)', () => {
  jest.setTimeout(600_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let BATCH: number
  let ensureFinalizationAttempt: typeof import('../../src/modules/open-settlement/signature-collection-finalization-truth').ensureFinalizationAttempt
  let recordFinalizationOutcome: typeof import('../../src/modules/open-settlement/signature-collection-finalization-truth').recordFinalizationOutcome
  let realFetch: typeof fetch
  const nodes: Node[] = []

  let buyerId: string
  let sellerId: string
  let offerId: string

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ SETTLEMENT_RECOVERY_BATCH: BATCH } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ ensureFinalizationAttempt, recordFinalizationOutcome } = require('../../src/modules/open-settlement/signature-collection-finalization-truth'))
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    buyerId = (await prisma.user.create({ data: { publicKey: `pk-recon-buyer-${suffix}` } })).id
    sellerId = (await prisma.user.create({ data: { publicKey: `pk-recon-seller-${suffix}` } })).id
    offerId = (await prisma.offer.create({ data: { userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })).id
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  beforeEach(() => {
    realFetch = global.fetch
    // Only PASS 0 leftovers from other suites would reach an explorer here; fail them fast, offline.
    global.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })) as any
  })

  afterEach(async () => {
    while (nodes.length) await nodes.pop()!.shutdown()
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    reconcile: () => Promise<any>
    repo: any
    feeObligationService: any
    shutdown: () => Promise<void>
  }

  /** An independent application instance: own module graph, own Prisma pool, own event handlers. */
  function startNode(): Node {
    let node!: Node
    jest.isolateModules(() => {
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      require('../../src/common/events/handlers').registerEventHandlers()
      const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      node = {
        reconcile: () => reconcilePendingSettlements(NO_PASS_3),
        repo: require('../../src/modules/open-settlement/escrow-repository').escrowRepository,
        feeObligationService: require('../../src/modules/open-settlement/fee-obligation.service').feeObligationService,
        shutdown: async () => {
          await db.prisma.$disconnect()
          await redisModule.redis?.quit?.().catch(() => undefined)
        },
      }
    })
    nodes.push(node)
    return node
  }

  function stop(node: Node): Promise<void> {
    nodes.splice(nodes.indexOf(node), 1)
    return node.shutdown()
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  // Strictly increasing settlement times, so "most recently settled first" never depends on a shared millisecond.
  let lastSettledAt = 0
  function nextSettledAt(): Date {
    lastSettledAt = Math.max(Date.now(), lastSettledAt + 1)
    return new Date(lastSettledAt)
  }

  async function escrowRow(type: 'MOCK' | 'LIGHTNING_HODL', txReleaseId: string | null): Promise<{ escrowId: string; tradeId: string }> {
    const trade = await prisma.trade.create({ data: { offerId, buyerId, sellerId, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65', status: 'ACTIVE' } })
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type, status: 'COMPLETED', lockedAmount: '0.001', asset: 'BTC', txReleaseId, releasedAt: txReleaseId ? new Date() : null, updatedAt: nextSettledAt() },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    return { escrowId: escrow.id, tradeId: trade.id }
  }

  const completionEvent = (escrowId: string) => prisma.escrowEvent.create({
    data: { escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
  })
  const pendingRow = (escrowId: string, kind: 'release' | 'refund') => prisma.escrowPendingTransaction.create({
    data: { escrowId, kind, toAddress: 'dest-address', requiredSigners: [buyerId, sellerId], triggeredBy: sellerId, unsignedPsbtBase64: 'unsigned-bundle-b64' },
  })

  /** PASS 1, never recoverable automatically (no primitive for the MOCK rail): reported for manual review on every visit. */
  async function resultMissingForever(): Promise<string> {
    return (await escrowRow('MOCK', null)).escrowId
  }

  /** PASS 1, recoverable from durable evidence alone: a signature-collection settlement whose finalization is durably CONFIRMED. */
  async function resultMissingRecoverable(): Promise<{ escrowId: string; tradeId: string; txHash: string }> {
    const { escrowId, tradeId } = await escrowRow('LIGHTNING_HODL', null)
    const pending = await pendingRow(escrowId, 'release')
    const txHash = `0x${randomUUID().replace(/-/g, '')}`
    await ensureFinalizationAttempt(escrowId, pending.id, 'release')
    await recordFinalizationOutcome(escrowId, 'CONFIRMED', txHash)
    return { escrowId, tradeId, txHash }
  }

  /** PASS 2, already converged (the live path completed it): verified on first visit. */
  async function completionConverged(): Promise<string> {
    const { escrowId } = await escrowRow('MOCK', `r${randomUUID().replace(/-/g, '')}`)
    await completionEvent(escrowId)
    return escrowId
  }

  /** PASS 2, completion effects never ran (crash between result and event): recovered, then verified. */
  async function completionMissing(): Promise<{ escrowId: string; tradeId: string }> {
    return escrowRow('MOCK', `r${randomUUID().replace(/-/g, '')}`)
  }

  /** PASS 2, never converges: the completion event exists but a pending row survives (nothing deletes it for a refund). */
  async function completionStuck(): Promise<string> {
    const { escrowId } = await escrowRow('MOCK', `r${randomUUID().replace(/-/g, '')}`)
    await completionEvent(escrowId)
    await pendingRow(escrowId, 'refund')
    return escrowId
  }

  // ─── queue inspection ─────────────────────────────────────────────────────────────────────────────────

  async function stamps(ids: string[]): Promise<Map<string, number | null>> {
    const rows = await prisma.$queryRaw<Array<{ id: string; at: Date | null }>>`
      SELECT id, "settlementRecoveryAttemptedAt" AS at FROM escrows WHERE id = ANY(${ids}::text[])`
    return new Map(rows.map((r) => [r.id, r.at?.getTime() ?? null]))
  }

  /** Which of `ids` the run that started at `since` claimed (stamped). */
  async function claimedSince(ids: string[], since: number): Promise<string[]> {
    return [...(await stamps(ids)).entries()].filter(([, at]) => at !== null && at >= since).map(([id]) => id)
  }

  async function queueSizes(): Promise<{ pass1: number; pass2: number; neverAttempted: number }> {
    const [row] = await prisma.$queryRaw<Array<{ pass1: number; pass2: number; neverAttempted: number }>>`
      SELECT
        count(*) FILTER (WHERE "txReleaseId" IS NULL)::int AS pass1,
        count(*) FILTER (WHERE "txReleaseId" IS NOT NULL AND "completionVerifiedAt" IS NULL)::int AS pass2,
        count(*) FILTER (WHERE "settlementRecoveryAttemptedAt" IS NULL AND ("txReleaseId" IS NULL OR "completionVerifiedAt" IS NULL))::int AS "neverAttempted"
      FROM escrows WHERE status IN ('COMPLETED', 'REFUNDED', 'SPLIT')`
    return row
  }

  /** Upper bound on runs for a queue to come back to any escrow: ceil(queue / batch) + 1. */
  async function lapBound(): Promise<number> {
    const { pass1, pass2 } = await queueSizes()
    return Math.ceil(Math.max(pass1, pass2) / BATCH) + 1
  }

  /**
   * Other suites leave queued escrows behind. Running until every one of them has been attempted once
   * puts them all behind anything created afterwards, which makes this file's queue positions exact.
   */
  async function observeLeftovers(node: Node): Promise<void> {
    const bound = await lapBound()
    for (let run = 0; run <= bound; run++) {
      if ((await queueSizes()).neverAttempted === 0) return
      await node.reconcile()
    }
    throw new Error('leftover escrows were not all observed within the queue bound')
  }

  /** Runs `node` until `done()` holds, at most `bound` runs; returns how many runs it took. */
  async function runUntil(node: Node, done: () => Promise<boolean>, bound: number, what: string): Promise<number> {
    for (let run = 1; run <= bound; run++) {
      await node.reconcile()
      if (await done()) return run
    }
    throw new Error(`${what}: not reached within ${bound} runs`)
  }

  const escrowOf = (id: string) => prisma.escrow.findUniqueOrThrow({ where: { id } })
  const verified = async (id: string) => (await prisma.$queryRaw<Array<{ at: Date | null }>>`SELECT "completionVerifiedAt" AS at FROM escrows WHERE id = ${id}`)[0].at !== null
  const completionEvents = (escrowId: string) => prisma.escrowEvent.count({ where: { escrowId, toStatus: 'COMPLETED' } })
  const durableCompletionEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.released' } })

  // ═══ database side ═══════════════════════════════════════════════════════════════════════════════════

  it('each queue has its own partial index, and the claim query can be served from it (never from the settled history)', async () => {
    requirePostgres('index catalog')
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'escrows' AND indexname IN ('escrows_settlement_result_recovery_queue_idx', 'escrows_completion_verification_queue_idx')
      ORDER BY indexname`
    expect(indexes.map((i) => i.indexname)).toEqual(['escrows_completion_verification_queue_idx', 'escrows_settlement_result_recovery_queue_idx'])
    expect(indexes[1].indexdef).toMatch(/WHERE .*"txReleaseId" IS NULL/)
    expect(indexes[0].indexdef).toMatch(/WHERE .*"txReleaseId" IS NOT NULL.*"completionVerifiedAt" IS NULL/)

    // With the alternatives priced out (sequential scan, sort, bitmap scan), a plan that does not read
    // the queue's own index in order would mean the query's predicate does not imply the index's, or
    // the index does not yield the queue's order — i.e. it could never serve the query at any size.
    // Pricing out only the sequential scan left the choice to the planner's cost estimate on whatever
    // rows earlier suites left behind (#235 R7G-F6C CI triage: on PostgreSQL 16 an unchanged schema
    // got a status-index scan + Sort for most realistic table compositions), which is not this property.
    for (const [sql, index] of [
      [`SELECT e.id FROM escrows e WHERE e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NULL
        ORDER BY e."settlementRecoveryAttemptedAt" ASC NULLS FIRST, e."updatedAt" DESC, e.id LIMIT 50`, 'escrows_settlement_result_recovery_queue_idx'],
      [`SELECT e.id FROM escrows e WHERE e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL AND e."completionVerifiedAt" IS NULL
        ORDER BY e."settlementRecoveryAttemptedAt" ASC NULLS FIRST, e."updatedAt" DESC, e.id LIMIT 50`, 'escrows_completion_verification_queue_idx'],
    ] as const) {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
        await tx.$executeRawUnsafe('SET LOCAL enable_sort = off')
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off')
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown }>>(`EXPLAIN (FORMAT JSON) ${sql}`)
      })
      const text = JSON.stringify(plan)
      expect(text).toContain(index)
      expect(text).not.toContain('"Sort"') // the index already yields queue order; no sort of the whole queue
    }
  })

  // ═══ PASS 1 ══════════════════════════════════════════════════════════════════════════════════════════

  describe('PASS 1 (result missing)', () => {
    it('A/B/C/D — backlog below, equal to, above and several times one batch: each run claims at most one batch, newest first, and every escrow is reached', async () => {
      requirePostgres('PASS 1 backlog sizes')
      const node = startNode()
      for (const size of [5, BATCH, BATCH + 10, Math.floor(BATCH * 3.5)]) {
        await observeLeftovers(node)
        const backlog: string[] = []
        for (let i = 0; i < size; i++) backlog.push(await resultMissingForever())

        const reachedInRun: string[][] = []
        const expectedRuns = Math.ceil(size / BATCH)
        for (let run = 0; run < expectedRuns; run++) {
          const since = Date.now()
          const report = await node.reconcile()
          const claimed = await claimedSince(backlog, since)
          reachedInRun.push(claimed)
          // Every claimed escrow of the backlog was actually handled (reported for manual review).
          for (const id of claimed) expect(report.requiresManualReview.some((m: any) => m.escrowId === id)).toBe(true)
        }

        expect(reachedInRun.map((ids) => ids.length)).toEqual(
          Array.from({ length: expectedRuns }, (_, run) => Math.min(BATCH, size - run * BATCH)))
        // newest first: the first run takes the most recently settled
        expect(new Set(reachedInRun[0])).toEqual(new Set(backlog.slice(-Math.min(BATCH, size))))
        // E: every escrow reached exactly once across the runs
        expect(new Set(reachedInRun.flat())).toEqual(new Set(backlog))
        expect(reachedInRun.flat()).toHaveLength(size)
      }
    })

    it('E/F — escrows that can never be recovered automatically do not hold their slots: a recoverable escrow behind more than a full batch of them is recovered, and they keep rotating', async () => {
      requirePostgres('PASS 1 poison rows')
      const node = startNode()
      await observeLeftovers(node)
      const poison: string[] = []
      for (let i = 0; i < BATCH + 20; i++) poison.push(await resultMissingForever())
      await node.reconcile() // the newest BATCH poison rows are attempted
      await node.reconcile() // the remaining 20, plus the oldest leftovers

      const recoverable = await resultMissingRecoverable()
      const runs = await runUntil(node, async () => (await escrowOf(recoverable.escrowId)).txReleaseId !== null, 1, 'recoverable escrow')
      expect(runs).toBe(1) // never attempted: served on the very next run, ahead of every poison row
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash)

      // ...and every poison row is still visited again within one lap of the queue (no starvation either way).
      const before = await stamps(poison)
      const bound = await lapBound()
      await runUntil(node, async () => {
        const now = await stamps(poison)
        return poison.every((id) => now.get(id)! > before.get(id)!)
      }, bound, 'every poison row revisited')
    })

    it('G — progress survives a restart: a restarted node continues with the escrows the previous one had not reached', async () => {
      requirePostgres('PASS 1 restart')
      const a = startNode()
      await observeLeftovers(a)
      const backlog: string[] = []
      for (let i = 0; i < BATCH * 2; i++) backlog.push(await resultMissingForever())

      const sinceA = Date.now()
      await a.reconcile()
      const byA = await claimedSince(backlog, sinceA)
      await stop(a)

      const b = startNode()
      const sinceB = Date.now()
      await b.reconcile()
      const byB = await claimedSince(backlog, sinceB)

      expect(byA).toHaveLength(BATCH)
      expect(byB).toHaveLength(BATCH)
      expect(byB.filter((id) => byA.includes(id))).toEqual([]) // the restarted node did not start over
      expect(new Set([...byA, ...byB])).toEqual(new Set(backlog))
    })

    it('H — two instances over the same backlog take disjoint batches, and a recoverable escrow is recovered exactly once', async () => {
      requirePostgres('PASS 1 two instances')
      const a = startNode()
      const b = startNode()
      await observeLeftovers(a)
      const backlog: string[] = []
      for (let i = 0; i < BATCH * 2 - 1; i++) backlog.push(await resultMissingForever())
      const recoverable = await resultMissingRecoverable()
      backlog.push(recoverable.escrowId)

      // Hold node A right after its claim committed, then let node B run its whole pass.
      const claimed = deferred()
      const proceed = deferred()
      const original = a.repo.claimSettlementResultRecoveryBatch.bind(a.repo)
      jest.spyOn(a.repo, 'claimSettlementResultRecoveryBatch').mockImplementationOnce(async (...args: unknown[]) => {
        const rows = await original(...args)
        claimed.resolve()
        await proceed.promise
        return rows
      })
      const since = Date.now()
      const runA = a.reconcile()
      await reachedOrSettled(claimed.promise, runA, 'node A claiming')
      const byA = await claimedSince(backlog, since)
      const reportB = await b.reconcile()
      const byB = (await claimedSince(backlog, since)).filter((id) => !byA.includes(id))
      proceed.resolve()
      const reportA = await runA

      expect(byA).toHaveLength(BATCH)
      expect(byB).toHaveLength(BATCH)
      expect(new Set([...byA, ...byB])).toEqual(new Set(backlog))
      const recoveredBy = [reportA, reportB].filter((r) => r.recovered.some((x: any) => x.escrowId === recoverable.escrowId))
      expect(recoveredBy).toHaveLength(1)
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash)
      expect(await completionEvents(recoverable.escrowId)).toBe(1)
      expect(await durableCompletionEvents(recoverable.tradeId)).toBe(1)
    })

    it('I — a stale worker holding a claimed escrow resumes after another instance recovered it: nothing is written twice', async () => {
      requirePostgres('PASS 1 stale worker')
      const stale = startNode()
      const current = startNode()
      await observeLeftovers(current)
      const recoverable = await resultMissingRecoverable()

      const claimed = deferred()
      const proceed = deferred()
      const original = stale.repo.claimSettlementResultRecoveryBatch.bind(stale.repo)
      jest.spyOn(stale.repo, 'claimSettlementResultRecoveryBatch').mockImplementationOnce(async (...args: unknown[]) => {
        const rows = await original(...args)
        claimed.resolve()
        await proceed.promise
        return rows // a snapshot taken before the recovery below: txReleaseId still null
      })
      const staleRun = stale.reconcile()
      await reachedOrSettled(claimed.promise, staleRun, 'stale node claiming')

      await runUntil(current, async () => (await escrowOf(recoverable.escrowId)).txReleaseId !== null, await lapBound(), 'current node recovering')
      await runUntil(current, () => verified(recoverable.escrowId), await lapBound(), 'current node verifying completion')

      proceed.resolve()
      const staleReport = await staleRun
      expect(staleReport.recovered.filter((x: any) => x.escrowId === recoverable.escrowId).length + staleReport.requiresManualReview.filter((x: any) => x.escrowId === recoverable.escrowId).length).toBeLessThanOrEqual(1)
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash)
      expect(await completionEvents(recoverable.escrowId)).toBe(1)
      expect(await durableCompletionEvents(recoverable.tradeId)).toBe(1)
      expect(await prisma.feeObligation.count({ where: { escrowId: recoverable.escrowId } })).toBeLessThanOrEqual(1)
    })

    it('J — a node that dies right after claiming leaves only stamps: its escrows are recovered by a restarted node within one lap, once', async () => {
      requirePostgres('PASS 1 crash after claim')
      const a = startNode()
      await observeLeftovers(a)
      const recoverable = await resultMissingRecoverable()

      const original = a.repo.claimSettlementResultRecoveryBatch.bind(a.repo)
      jest.spyOn(a.repo, 'claimSettlementResultRecoveryBatch').mockImplementationOnce(async (...args: unknown[]) => {
        await original(...args)
        throw new Error('process died')
      })
      await expect(a.reconcile()).rejects.toThrow('process died')
      expect((await stamps([recoverable.escrowId])).get(recoverable.escrowId)).not.toBeNull()
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBeNull()
      await stop(a)

      const b = startNode()
      await runUntil(b, async () => (await escrowOf(recoverable.escrowId)).txReleaseId !== null, await lapBound(), 'restarted node recovering')
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash)
      expect(await completionEvents(recoverable.escrowId)).toBe(1)
    })

    it('K — PASS 1 writes the result and dies before the completion effects: PASS 2 picks the escrow up and completes it once (PASS 2 needs nothing from PASS 1 but the durable result)', async () => {
      requirePostgres('PASS 1 crash after mutation')
      const a = startNode()
      await observeLeftovers(a)
      const recoverable = await resultMissingRecoverable()

      // The process dies right after PASS 1's result write commits: the completion effects fail, and
      // nothing later in this run (PASS 2) ever executes.
      jest.spyOn(a.feeObligationService, 'recordObligationForEscrowSettlement').mockRejectedValueOnce(new Error('process died'))
      jest.spyOn(a.repo, 'claimCompletionVerificationBatch').mockRejectedValueOnce(new Error('process died'))
      await expect(a.reconcile()).rejects.toThrow('process died')
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash) // durable
      expect(await completionEvents(recoverable.escrowId)).toBe(0) // the next stage never ran
      expect(await verified(recoverable.escrowId)).toBe(false)
      await stop(a)

      const b = startNode()
      await runUntil(b, () => verified(recoverable.escrowId), await lapBound(), 'PASS 2 completing the escrow')
      expect(await completionEvents(recoverable.escrowId)).toBe(1)
      expect(await durableCompletionEvents(recoverable.tradeId)).toBe(1)
      expect((await escrowOf(recoverable.escrowId)).txReleaseId).toBe(recoverable.txHash)
    })

    it('L — a new crash residue arriving while an old backlog is being worked through is handled on the next run', async () => {
      requirePostgres('PASS 1 new work during backlog')
      const node = startNode()
      await observeLeftovers(node)
      const backlog: string[] = []
      for (let i = 0; i < BATCH * 3; i++) backlog.push(await resultMissingForever())
      await node.reconcile() // one batch of the backlog; two batches still never attempted

      const fresh = await resultMissingRecoverable()
      const since = Date.now()
      await node.reconcile()
      expect((await escrowOf(fresh.escrowId)).txReleaseId).toBe(fresh.txHash)
      expect(await claimedSince(backlog, since)).toHaveLength(BATCH - 1) // the rest of the batch went to the backlog
    })
  })

  // ═══ PASS 2 ══════════════════════════════════════════════════════════════════════════════════════════

  describe('PASS 2 (completion unverified)', () => {
    it('A/B/C/D — backlog below, equal to, above and several times one batch: each run verifies at most one batch, and each converged settlement leaves the queue for good', async () => {
      requirePostgres('PASS 2 backlog sizes')
      const node = startNode()
      for (const size of [5, BATCH, BATCH + 10, Math.floor(BATCH * 3.5)]) {
        await observeLeftovers(node)
        const backlog: string[] = []
        for (let i = 0; i < size; i++) backlog.push(await completionConverged())

        const verifiedInRun: string[][] = []
        for (let run = 0; run < Math.ceil(size / BATCH); run++) {
          const report = await node.reconcile()
          verifiedInRun.push(report.completionVerified.filter((id: string) => backlog.includes(id)))
        }
        expect(verifiedInRun.map((ids) => ids.length)).toEqual(
          Array.from({ length: Math.ceil(size / BATCH) }, (_, run) => Math.min(BATCH, size - run * BATCH)))
        expect(new Set(verifiedInRun[0])).toEqual(new Set(backlog.slice(-Math.min(BATCH, size))))
        for (const id of backlog) expect(await verified(id)).toBe(true)

        // Verified settlements are never claimed again.
        const before = await stamps(backlog)
        await node.reconcile()
        expect(await stamps(backlog)).toEqual(before)
      }
    })

    it('E/F — settlements that never converge rotate instead of holding their slots: a missing completion behind more than a full batch of them is recovered, once', async () => {
      requirePostgres('PASS 2 poison rows')
      const node = startNode()
      await observeLeftovers(node)
      const stuck: string[] = []
      for (let i = 0; i < BATCH + 20; i++) stuck.push(await completionStuck())
      await node.reconcile()
      await node.reconcile()

      const missing = await completionMissing()
      const report = await node.reconcile()
      expect(report.completionEffectsRecovered.some((r: any) => r.escrowId === missing.escrowId)).toBe(true)
      expect(report.completionVerified).toContain(missing.escrowId)
      expect(await completionEvents(missing.escrowId)).toBe(1)
      expect(await durableCompletionEvents(missing.tradeId)).toBe(1)

      const before = await stamps(stuck)
      await runUntil(node, async () => {
        const now = await stamps(stuck)
        return stuck.every((id) => now.get(id)! > before.get(id)!)
      }, await lapBound(), 'every stuck settlement revisited')
      for (const id of stuck.slice(0, 5)) expect(await verified(id)).toBe(false)
    })

    // Corrected 2026-10-07 (#235 R7G-F6B CI determinism): this test asserted that two instances running at
    // once always take DISJOINT batches. The claim does not promise that and never did (escrow-repository.ts
    // claimRecoveryQueue(): SKIP LOCKED "only saves duplicate work"; dispute-dispatch-recovery.ts and
    // eventProjectionClaims.test.ts say the same): under READ COMMITTED, an instance whose claim statement
    // took its snapshot before another instance's claim committed, and reaches those rows after it did,
    // finds them unlocked, re-checks the queue predicate on the newest version (still true) and claims them
    // again. CI hit exactly that (run 37519165057 attempt 1, and 37387049657 attempt 1 at 1b8ac51: 50 of 100).
    // The product invariant is: bounded runs, progress across restarts, every queued escrow reached, and a
    // completion that happens exactly once however many instances visit it. This test FORCES the overlap and
    // proves that invariant on it, instead of depending on whether the scheduler produced the overlap.
    //
    // How the overlap is forced: instance C's claim runs the PASS 2 claim statement of escrow-repository.ts
    // verbatim (checked against the source below) plus one constant sort key that calls a barrier function.
    // The sort key is evaluated for every queued row while the statement scans - after its snapshot, before
    // it locks anything - so C is parked there on an advisory lock while instance B claims and commits.
    it('G/H — progress survives a restart; two instances can be handed the same PASS 2 work (forced READ COMMITTED overlap), and the completion still happens exactly once', async () => {
      requirePostgres('PASS 2 restart and two instances')
      const CLAIM = `WITH picked AS (
            SELECT e.id FROM escrows e
            WHERE e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL AND e."completionVerifiedAt" IS NULL
            ORDER BY e."settlementRecoveryAttemptedAt" ASC NULLS FIRST, e."updatedAt" DESC, e.id
            LIMIT ${'${limit}'}
            FOR UPDATE OF e SKIP LOCKED
          )
          UPDATE escrows e SET "settlementRecoveryAttemptedAt" = ${'${stampedAt}'}
          FROM picked WHERE e.id = picked.id
          RETURNING e.id`
      const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()
      const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/open-settlement/escrow-repository.ts'), 'utf8')
      expect(squash(source)).toContain(squash(CLAIM)) // the statement C runs is the product's, not a look-alike
      const BARRIER = 7_235_001 // advisory key owned by this test
      const parkedClaim = squash(CLAIM)
        .replace('e."updatedAt" DESC, e.id LIMIT', 'e."updatedAt" DESC, e.id, test_srb_claim_barrier() LIMIT')
        .replace('${limit}', '$1').replace('${stampedAt}', '$2')
      expect(parkedClaim).toContain('test_srb_claim_barrier()')

      const a = startNode()
      await observeLeftovers(a)
      // Queue order is never-attempted first, most recently settled first. Created oldest first: tail,
      // recoverable, head (A's batch).
      const tail: string[] = []
      for (let i = 0; i < BATCH; i++) tail.push(await completionStuck())
      const recoverable = await completionMissing()
      const head: string[] = []
      for (let i = 0; i < BATCH; i++) head.push(await completionStuck())
      const backlog = [...tail, recoverable.escrowId, ...head]

      // ── restart: A's run claims one bounded batch, then A is gone ──
      const sinceA = Date.now()
      await a.reconcile()
      const byA = await claimedSince(backlog, sinceA)
      expect(byA.sort()).toEqual([...head].sort())
      await stop(a)

      // ── two fresh instances, overlap forced ──
      const b = startNode()
      const c = startNode()
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_srb_claim_barrier() RETURNS int AS $$
        BEGIN PERFORM pg_advisory_xact_lock_shared(${BARRIER}); RETURN 0; END; $$ LANGUAGE plpgsql VOLATILE`)
      const holding = deferred()
      const releaseBarrier = deferred()
      const barrier = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BARRIER})`
        holding.resolve()
        await releaseBarrier.promise
      }, { timeout: 300_000 })
      try {
        await holding.promise
        const go = deferred()
        const [byB, byC]: [string[], string[]] = [[], []]
        const [bClaimed, cClaimed] = [deferred(), deferred()]
        // B: the product claim, untouched. Captured as it returns, then held.
        const originalB = b.repo.claimCompletionVerificationBatch.bind(b.repo)
        jest.spyOn(b.repo, 'claimCompletionVerificationBatch').mockImplementationOnce(async (...args: unknown[]) => {
          const rows = await originalB(...args)
          byB.push(...rows.map((r: { id: string }) => r.id))
          bClaimed.resolve()
          await go.promise
          return rows
        })
        // C: the same statement, parked by the barrier; then the same row load as the product claim.
        jest.spyOn(c.repo, 'claimCompletionVerificationBatch').mockImplementationOnce(async (limit: unknown) => {
          const claimed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(parkedClaim, limit, new Date())
          const rows = claimed.length === 0 ? [] : await prisma.escrow.findMany({ where: { id: { in: claimed.map((row) => row.id) } } })
          byC.push(...rows.map((r: { id: string }) => r.id))
          cClaimed.resolve()
          await go.promise
          return rows
        })

        const runC = c.reconcile()
        let settledC = false
        void runC.then(() => { settledC = true }, () => { settledC = true })
        const parked = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${BARRIER} AND NOT granted`)[0].n === 1
        while (!(await parked())) {
          if (settledC) throw new Error('instance C finished without reaching the claim barrier')
          await new Promise((r) => setImmediate(r))
        }
        // C's snapshot is taken and it holds no row lock: B claims the head of the queue and commits.
        const runB = b.reconcile()
        await reachedOrSettled(bClaimed.promise, runB, 'instance B claiming')
        // C resumes with its older snapshot and locks B's rows, unlocked by now.
        releaseBarrier.resolve()
        await barrier
        await reachedOrSettled(cClaimed.promise, runC, 'instance C claiming')

        // Bounded, and NOT disjoint: both were handed the same batch, deliberately.
        expect(byB).toHaveLength(BATCH)
        expect(byC).toHaveLength(BATCH)
        expect([...byC].sort()).toEqual([...byB].sort())
        expect(byB).toContain(recoverable.escrowId)
        expect([...byB, ...byC].filter((id) => byA.includes(id))).toEqual([]) // nothing of A's batch is redone before the rest of the queue

        // Both instances now work through the same batch at the same time.
        go.resolve()
        const [reportB, reportC] = await Promise.all([runB, runC])
        expect([...reportB.failed, ...reportC.failed].filter((f: any) => backlog.includes(f.escrowId))).toEqual([])
        // Exactly once, from durable facts (a report may list an escrow both instances visited).
        expect(await completionEvents(recoverable.escrowId)).toBe(1)
        expect(await durableCompletionEvents(recoverable.tradeId)).toBe(1)
        expect(await verified(recoverable.escrowId)).toBe(true)
        expect((await escrowOf(recoverable.escrowId)).status).toBe('COMPLETED')
        for (const id of byB.filter((id) => id !== recoverable.escrowId).slice(0, 5)) expect(await verified(id)).toBe(false) // never-converging rows stay queued
      } finally {
        releaseBarrier.resolve()
        await barrier.catch(() => undefined)
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_srb_claim_barrier()')
      }

      // Eventual progress: whatever the overlap cost this round, every queued escrow is reached.
      const reached = async () => (await claimedSince(backlog, sinceA)).length === backlog.length
      await runUntil(b, reached, await lapBound(), 'every queued escrow claimed after the overlap')
      expect(await completionEvents(recoverable.escrowId)).toBe(1)
      expect(await durableCompletionEvents(recoverable.tradeId)).toBe(1)
    })

    it('I — a stale worker that claimed a settlement with missing effects resumes after another instance completed and verified it: one completion event, never two', async () => {
      requirePostgres('PASS 2 stale worker')
      const stale = startNode()
      const current = startNode()
      await observeLeftovers(current)
      const missing = await completionMissing()

      const claimed = deferred()
      const proceed = deferred()
      const original = stale.repo.claimCompletionVerificationBatch.bind(stale.repo)
      jest.spyOn(stale.repo, 'claimCompletionVerificationBatch').mockImplementationOnce(async (...args: unknown[]) => {
        const rows = await original(...args)
        claimed.resolve()
        await proceed.promise
        return rows
      })
      const staleRun = stale.reconcile()
      await reachedOrSettled(claimed.promise, staleRun, 'stale node claiming')

      await runUntil(current, () => verified(missing.escrowId), await lapBound(), 'current node completing')
      proceed.resolve()
      const staleReport = await staleRun

      expect(await completionEvents(missing.escrowId)).toBe(1)
      expect(await durableCompletionEvents(missing.tradeId)).toBe(1)
      expect(staleReport.completionEffectsRecovered.some((r: any) => r.escrowId === missing.escrowId)).toBe(false)
      expect(staleReport.failed.filter((f: any) => f.escrowId === missing.escrowId)).toEqual([])
    })

    it('J/K — a node that dies after claiming, or after emitting the completion event but before verifying it, leaves nothing a restarted node repeats', async () => {
      requirePostgres('PASS 2 crash windows')
      const a = startNode()
      await observeLeftovers(a)
      const afterClaim = await completionMissing()

      const original = a.repo.claimCompletionVerificationBatch.bind(a.repo)
      jest.spyOn(a.repo, 'claimCompletionVerificationBatch').mockImplementationOnce(async (...args: unknown[]) => {
        await original(...args)
        throw new Error('process died')
      })
      await expect(a.reconcile()).rejects.toThrow('process died')
      expect(await completionEvents(afterClaim.escrowId)).toBe(0)

      // Dies after the completion effects committed, before the verification mark.
      const afterEffects = await completionMissing()
      const originalMark = a.repo.markCompletionVerifiedIfConverged.bind(a.repo)
      jest.spyOn(a.repo, 'markCompletionVerifiedIfConverged').mockImplementation(async (...args: unknown[]) => {
        if (args[0] === afterEffects.escrowId && (await completionEvents(afterEffects.escrowId)) === 1) throw new Error('process died')
        return originalMark(...args)
      })
      await runUntil(a, async () => (await completionEvents(afterEffects.escrowId)) === 1, await lapBound(), 'effects committed')
      expect(await verified(afterEffects.escrowId)).toBe(false)
      await stop(a)

      const b = startNode()
      await runUntil(b, async () => (await verified(afterClaim.escrowId)) && (await verified(afterEffects.escrowId)), await lapBound(), 'restarted node')
      for (const f of [afterClaim, afterEffects]) {
        expect(await completionEvents(f.escrowId)).toBe(1)
        expect(await durableCompletionEvents(f.tradeId)).toBe(1)
      }
    })

    it('L — PASS 2 does not wait for PASS 1: a missing completion is recovered on the next run while PASS 1 has more than a batch of its own backlog', async () => {
      requirePostgres('PASS 2 independent of PASS 1 backlog')
      const node = startNode()
      await observeLeftovers(node)
      for (let i = 0; i < BATCH * 2; i++) await resultMissingForever()
      for (let i = 0; i < BATCH * 2; i++) await completionConverged()
      await node.reconcile()

      const missing = await completionMissing()
      const report = await node.reconcile()
      expect(report.completionEffectsRecovered.some((r: any) => r.escrowId === missing.escrowId)).toBe(true)
      expect(await completionEvents(missing.escrowId)).toBe(1)
      expect(await verified(missing.escrowId)).toBe(true)
    })
  })
})
