// tests/integration/unclaimedSignedRecoveryQueue.test.ts
//
// Settlement reconciliation PASS 0 (M9-R, crash window C8: a fully-signed MULTISIG operation whose escrow
// never claimed its transition) — real PostgreSQL proof that one run does a finite, explicit amount of
// database and explorer work, that repeated runs reach every candidate fairly across restarts, nodes,
// stale workers, crashes and candidates that never resolve, and that the queue changes only WHICH
// operations a run looks at, never what PASS 0 does with one (chain truth first, the atomic transition
// claim, the write-once result).
//
// What is real: PostgreSQL, the claim, the reconciler, reconcilePendingSettlement() and its bounded,
// retried explorer requests (boundedFetch), claimEscrowTransition(), the write-once result and the
// completion effects. What is controlled: the explorer itself (global.fetch: answer, latency, call count,
// concurrency; never the public internet) and the reconstruction of the signed transaction, stubbed to a
// fixed txid per trade (real signed-PSBT reconstruction is proven in m9rClaimRecovery.test.ts). Candidates
// are fully-signed pending rows on PAYMENT_PENDING MULTISIG escrows. None has participant keys: only an
// explorer that says "unknown transaction" would get PASS 0 far enough to need them.
//
// A "node" is an independent module graph (jest.isolateModules): its own module state, config (explorer
// timeout and reconciliation interval come from the environment at load) and provider. The PrismaClient
// is shared across module graphs (global.__prisma outside production; Prisma 7 cannot run two clients in
// one jest worker): nodes share one pool, each statement on its own pooled connection.
//
// The shared test database keeps other suites' rows. Fixtures are created at QUEUE_HEAD, ahead of every
// other candidate, and each test deletes only the pending rows it created.

import { PrismaClient } from '@prisma/client'
import { createHash, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

const QUEUE_HEAD = Date.parse('2000-01-01T00:00:00.000Z')
const HOUR = 3_600_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

type Report = { recovered: any[]; completionEffectsRecovered: any[]; requiresManualReview: Array<{ escrowId: string; reason: string }>; failed: Array<{ escrowId: string; error: string }>; resumedUnclaimed: Array<{ escrowId: string; txId: string; outcome: string }>; alreadyClaimedConcurrently: string[]; projectionsRecovered: any[]; completionVerified: string[]; locksAdvanced: any[] }
const newReport = (): Report => ({ recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], completionVerified: [], locksAdvanced: [] })

type Answer = 'exists' | 'fail' | 'hang' | 'unknown'

describe('Settlement reconciliation PASS 0 — bounded, fair, durable recovery of fully-signed unclaimed operations (real PostgreSQL)', () => {
  jest.setTimeout(600_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let BATCH: number
  let buyerId: string
  let sellerId: string
  let offerId: string
  let sellerAccount: { id: string; accountHash: string }
  let headOffset = 0
  const owned: string[] = []
  const realFetch = global.fetch
  const envBefore = { timeout: process.env.MULTISIG_EXPLORER_TIMEOUT_MS, interval: process.env.ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ UNCLAIMED_RECOVERY_BATCH: BATCH } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const suffix = randomUUID().slice(0, 8)
    buyerId = (await prisma.user.create({ data: { publicKey: `pk-p0q-buyer-${suffix}` } })).id
    sellerId = (await prisma.user.create({ data: { publicKey: `pk-p0q-seller-${suffix}` } })).id
    sellerAccount = await sellerPixAccount(prisma, sellerId)
    offerId = (await prisma.offer.create({ data: { userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(sellerAccount) } })).id
  })

  afterEach(async () => {
    global.fetch = realFetch
    jest.restoreAllMocks()
    if (dbAvailable && owned.length) await removeOwned(owned.splice(0))
  })

  /**
   * Only what this file created. Its pending rows go (signatures cascade), so none stays a PASS 0
   * candidate. A fixture that never converged goes entirely (escrow and trade too), so none stays an
   * open MULTISIG escrow that every later claim would have to read past. A converged fixture is a real
   * settlement (events, fee obligation) and stays, like every other suite's.
   */
  async function removeOwned(pendingIds: string[]): Promise<void> {
    const rows = await prisma.escrowPendingTransaction.findMany({ where: { id: { in: pendingIds } }, select: { escrowId: true } })
    await prisma.escrowPendingTransaction.deleteMany({ where: { id: { in: pendingIds } } })
    const untouched = await prisma.escrow.findMany({
      where: { id: { in: rows.map((r) => r.escrowId) }, status: 'PAYMENT_PENDING', txReleaseId: null, events: { none: {} } },
      select: { id: true, tradeId: true },
    })
    await prisma.trade.updateMany({ where: { id: { in: untouched.map((e) => e.tradeId) } }, data: { escrowId: null } })
    await prisma.escrow.deleteMany({ where: { id: { in: untouched.map((e) => e.id) } } })
    await prisma.trade.deleteMany({ where: { id: { in: untouched.map((e) => e.tradeId) } } })
  }

  afterAll(async () => {
    process.env.MULTISIG_EXPLORER_TIMEOUT_MS = envBefore.timeout
    process.env.ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS = envBefore.interval
    if (envBefore.timeout === undefined) delete process.env.MULTISIG_EXPLORER_TIMEOUT_MS
    if (envBefore.interval === undefined) delete process.env.ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    pass0: () => Promise<Report>
    reconcile: () => Promise<Report>
    repo: any
    provider: any
    budgetMs: number
  }

  const txidOf = (tradeId: string) => createHash('sha256').update('p0q-' + tradeId).digest('hex')

  /** An independent application instance; explorer timeout and reconciliation interval as its environment says. */
  function startNode({ timeoutMs = 8000, intervalMs = HOUR } = {}): Node {
    process.env.MULTISIG_EXPLORER_TIMEOUT_MS = String(timeoutMs)
    process.env.ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS = String(intervalMs)
    let node!: Node
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      const provider = require('../../src/modules/open-settlement/multisig.provider').multisigProvider
      jest.spyOn(provider, 'buildFinalizedTransaction').mockImplementation(((escrow: { tradeId: string }) => ({ getId: () => txidOf(escrow.tradeId), toHex: () => '00' })) as any) // #235 R7G-B2A: takes the escrow (its funding surface is checked)
      const recon = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      node = {
        pass0: async () => { const r = newReport(); await recon.reconcileUnclaimedFullySignedPending(r); return r },
        reconcile: () => recon.reconcilePendingSettlements({ projectionGraceMs: 50 * 365 * 24 * HOUR }),
        repo: require('../../src/modules/open-settlement/escrow-repository').escrowRepository,
        provider,
        budgetMs: recon.unclaimedRecoveryStartBudgetMs(),
      }
    })
    return node
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  interface Candidate { pendingId: string; escrowId: string; tradeId: string; txid: string }

  /** A fully-signed release on a PAYMENT_PENDING MULTISIG escrow that never claimed its transition (C8). */
  async function candidate({ createdAt = new Date(QUEUE_HEAD + (headOffset += 1000)), signed = true } = {}): Promise<Candidate> {
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(sellerAccount), offerId, buyerId, sellerId, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65', status: 'ACTIVE' } })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', status: 'PAYMENT_PENDING', lockedAmount: '0.001', asset: 'BTC', txLockId: randomUUID().replace(/-/g, '').padEnd(64, '0'), txLockVout: 0 } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const pending = await prisma.escrowPendingTransaction.create({ data: { escrowId: escrow.id, kind: 'release', toAddress: 'tb1q-p0q', unsignedPsbtBase64: 'p0q', requiredSigners: [buyerId, sellerId], triggeredBy: sellerId, createdAt } })
    await prisma.escrowTransactionSignature.createMany({ data: [
      { pendingTxId: pending.id, participantId: buyerId, signedPsbtBase64: 'b' },
      ...(signed ? [{ pendingTxId: pending.id, participantId: sellerId, signedPsbtBase64: 's' }] : []),
    ] })
    owned.push(pending.id)
    return { pendingId: pending.id, escrowId: escrow.id, tradeId: trade.id, txid: txidOf(trade.id) }
  }
  async function candidates(n: number, opts: Parameters<typeof candidate>[0] = {}): Promise<Candidate[]> {
    const out: Candidate[] = []
    for (let i = 0; i < n; i++) out.push(await candidate(opts))
    return out
  }

  /**
   * The explorer: `answer(txid)` decides what a fixture's transaction status request gets ('exists' ->
   * converges; 'fail' -> 503 on every attempt; 'hang' -> never answers, cut by the explorer timeout;
   * 'unknown' -> 404). Anything else (other suites' rows) is told "unknown" at once. Counts every request
   * per fixture txid and the most requests in flight at once.
   */
  function explorer(answer: (txid: string) => Answer = () => 'exists', latencyMs = 0) {
    const stats = { perTxid: new Map<string, number>(), inFlight: 0, maxInFlight: 0, total: 0 }
    global.fetch = (async (url: string, init?: any) => {
      const m = /\/tx\/([0-9a-f]{64})\/status/.exec(url)
      const txid = m?.[1]
      const mine = txid && fixtureTxids.has(txid)
      if (!mine) return url.includes('/utxo') ? ({ ok: true, status: 200, json: async () => [] } as any) : ({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as any)
      stats.total++; stats.perTxid.set(txid, (stats.perTxid.get(txid) ?? 0) + 1)
      stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
      try {
        const a = answer(txid)
        if (a === 'hang') await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        if (latencyMs) await sleep(latencyMs)
        if (a === 'exists') return { ok: true, status: 200, json: async () => ({ confirmed: true }) } as any
        if (a === 'unknown') return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as any
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' } as any
      } finally { stats.inFlight-- }
    }) as any
    return stats
  }
  const fixtureTxids = new Set<string>()
  function track(cs: Candidate[]): Candidate[] { for (const c of cs) fixtureTxids.add(c.txid); return cs }

  const visited = (st: ReturnType<typeof explorer>, cs: Candidate[]) => cs.filter((c) => (st.perTxid.get(c.txid) ?? 0) > 0)
  const escrowOf = (c: Candidate) => prisma.escrow.findUniqueOrThrow({ where: { id: c.escrowId } })
  const resumed = (r: Report, cs: Candidate[]) => r.resumedUnclaimed.filter((x) => cs.some((c) => c.escrowId === x.escrowId)).map((x) => x.escrowId)
  const failedFor = (r: Report, cs: Candidate[]) => r.failed.filter((x) => cs.some((c) => c.escrowId === x.escrowId)).map((x) => x.escrowId)
  const stampOf = async (c: Candidate) => (await prisma.escrowPendingTransaction.findUnique({ where: { id: c.pendingId } }))?.unclaimedRecoveryAttemptedAt ?? null

  /** Converged exactly once: terminal, the chain's txid as the one result, one completion transition. */
  async function expectConverged(cs: Candidate[]): Promise<void> {
    for (const c of cs) {
      const e = await escrowOf(c)
      expect([c.escrowId, e.status, e.txReleaseId]).toEqual([c.escrowId, 'COMPLETED', c.txid])
      expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } })).toBe(1)
    }
  }
  /** Never resolved: untouched economic state. */
  async function expectUntouched(cs: Candidate[]): Promise<void> {
    for (const c of cs) {
      const e = await escrowOf(c)
      expect([c.escrowId, e.status, e.txReleaseId]).toEqual([c.escrowId, 'PAYMENT_PENDING', null])
      expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrowId } })).toBe(0)
    }
  }

  // ═══ structure ═══════════════════════════════════════════════════════════════════════════════════════

  it('F. the claim reads only open MULTISIG escrows (partial index), never the settled history, and hands the application one row', async () => {
    requirePostgres('index catalog + plan')
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'escrows' AND indexname = 'escrows_open_multisig_idx'`
    expect(index.indexdef).toMatch(/WHERE .*type = 'MULTISIG'.*status <> ALL .*'COMPLETED'.*'REFUNDED'.*'SPLIT'/)
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRawUnsafe<unknown[]>(`EXPLAIN (FORMAT JSON)
        WITH open_escrows AS MATERIALIZED (
          SELECT id FROM escrows WHERE type = 'MULTISIG' AND status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT'))
        SELECT p.id FROM open_escrows o JOIN escrow_pending_transactions p ON p."escrowId" = o.id
        WHERE (p."unclaimedRecoveryAttemptedAt" IS NULL OR p."unclaimedRecoveryAttemptedAt" < now())
          AND NOT EXISTS (SELECT 1 FROM unnest(p."requiredSigners") AS r(id)
            WHERE NOT EXISTS (SELECT 1 FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id AND s."participantId" = r.id))
        ORDER BY COALESCE(p."unclaimedRecoveryAttemptedAt", p."createdAt"), p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`)
    })
    expect(JSON.stringify(plan)).toContain('escrows_open_multisig_idx')

    // Rows still collecting signatures are the common case: none is ever claimed, loaded, stamped or sent
    // to the explorer. The application gets exactly one row per claim (the old pass loaded every open one).
    const collecting = await candidates(40, { signed: false })
    const cs = track(await candidates(3))
    const st = explorer()
    const m = await measuredPass0(startNode())
    expect(resumed(m.report, cs).sort()).toEqual(cs.map((c) => c.escrowId).sort())
    expect(m.rowsLoaded).toBe(m.claimed.length)
    expect(m.claimed).toEqual(expect.arrayContaining(cs.map((c) => c.pendingId)))
    for (const c of collecting) {
      expect(m.claimed).not.toContain(c.pendingId)
      expect(await stampOf(c)).toBeNull()
    }
    expect(st.total).toBe(3)
  })

  /**
   * One PASS 0 run on `node`, recording what it claimed and how many pending rows it loaded. Other
   * suites' candidates may be queued in the shared database too; they count here like any other.
   */
  async function measuredPass0(node: Node): Promise<{ report: Report; claimed: string[]; rowsLoaded: number }> {
    const claim = jest.spyOn(node.repo, 'claimUnclaimedSignedPendingOperation')
    const load = jest.spyOn(prisma.escrowPendingTransaction, 'findMany')
    const report = await node.pass0()
    const claimed = (await Promise.all(claim.mock.results.map((x) => x.value))).filter((id): id is string => typeof id === 'string')
    const rowsLoaded = (await Promise.all(load.mock.results.map((x) => x.value))).reduce((a: number, rows: any[]) => a + rows.length, 0)
    claim.mockRestore(); load.mockRestore()
    return { report, claimed, rowsLoaded }
  }

  // ═══ A–E: bounded runs drain a backlog ═══════════════════════════════════════════════════════════════

  it('A. no candidate of ours, only rows still collecting signatures: none of them is claimed, loaded or sent to the explorer, and whatever the run does claim is loaded one row per claim', async () => {
    requirePostgres('A')
    const collecting = await candidates(10, { signed: false })
    const st = explorer()
    const m = await measuredPass0(startNode())
    expect(m.rowsLoaded).toBe(m.claimed.length)
    for (const c of collecting) {
      expect(m.claimed).not.toContain(c.pendingId)
      expect(await stampOf(c)).toBeNull()
    }
    expect(st.total).toBe(0) // no request for any of our operations
  })

  it('B/C. backlog below and equal to the batch: one run converges all of it, one explorer request per candidate', async () => {
    requirePostgres('B/C')
    for (const n of [5, BATCH]) {
      const cs = track(await candidates(n))
      const st = explorer()
      const r = await startNode().pass0()
      expect(resumed(r, cs)).toHaveLength(n)
      expect(cs.every((c) => st.perTxid.get(c.txid) === 1)).toBe(true)
      await expectConverged(cs)
    }
  })

  it('D/E. backlog above and several times the batch: each run converges at most BATCH candidates, disjoint, and ceil(backlog / BATCH) runs drain it', async () => {
    requirePostgres('D/E')
    const cs = track(await candidates(2 * BATCH + 7))
    const st = explorer()
    const node = startNode()
    const per: string[][] = []
    for (let i = 0; i < 3; i++) per.push(resumed(await node.pass0(), cs))
    expect(per.map((p) => p.length)).toEqual([BATCH, BATCH, 7])
    expect(new Set(per.flat()).size).toBe(2 * BATCH + 7)
    expect(cs.every((c) => st.perTxid.get(c.txid) === 1)).toBe(true)
    await expectConverged(cs)
  })

  // ═══ G–K: the explorer is slow, silent or failing ════════════════════════════════════════════════════

  it('G. slow explorer: a run starts new candidates only within its start budget, so its duration is bounded by budget + one candidate; the rest follow in later runs', async () => {
    requirePostgres('G')
    const cs = track(await candidates(20))
    const st = explorer(() => 'exists', 500)
    const node = startNode({ timeoutMs: 8000, intervalMs: 60_000 }) // production defaults: budget 2.5 s
    expect(node.budgetMs).toBe(2500)
    const t0 = Date.now()
    const first = resumed(await node.pass0(), cs)
    const ms = Date.now() - t0
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(first.length).toBeLessThan(20)
    expect(ms).toBeLessThan(node.budgetMs + 500 + 5_000) // budget + one candidate's explorer time + its database work
    const done = new Set(first)
    for (let i = 0; i < 20 && done.size < 20; i++) for (const id of resumed(await node.pass0(), cs)) done.add(id)
    expect(done.size).toBe(20)
    expect(st.maxInFlight).toBe(1)
    await expectConverged(cs)
  })

  it('H. never-answering explorer: every request is cut at the explorer timeout (3 attempts per read), the run starts no candidate past its budget, and one run fits in one reconciliation interval', async () => {
    requirePostgres('H')
    const cs = track(await candidates(4))
    const st = explorer(() => 'hang')
    // 300 ms timeout: worst case per candidate 7 x 300 + 1500 = 3600 ms; interval 5000 ms -> budget 1400 ms
    const node = startNode({ timeoutMs: 300, intervalMs: 5000 })
    expect(node.budgetMs).toBe(1400)
    const runs: Array<{ ms: number; failed: string[] }> = []
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now()
      const r = await node.pass0()
      runs.push({ ms: Date.now() - t0, failed: failedFor(r, cs) })
    }
    expect(runs.map((r) => r.failed.length)).toEqual([1, 1, 1, 1]) // one candidate per run: the first one's timeouts use up the budget
    expect(new Set(runs.flatMap((r) => r.failed)).size).toBe(4) // and a different one each run
    for (const r of runs) expect(r.ms).toBeLessThan(5000)
    for (const c of cs) expect(st.perTxid.get(c.txid)).toBe(3) // existence read: 3 timed-out attempts, then fail closed
    await expectUntouched(cs)
  })

  it('I/J/K/V. failing explorer and poison candidates: they fail closed, stay retryable, and take one slot per lap; the candidates behind them converge; once the explorer recovers they converge too', async () => {
    requirePostgres('I/J/K/V')
    const poison = track(await candidates(3))
    const good = track(await candidates(BATCH + 10))
    let recovered = false
    const st = explorer((txid) => (poison.some((p) => p.txid === txid) && !recovered ? 'fail' : 'exists'))
    const node = startNode()
    const r1 = await node.pass0()
    expect(failedFor(r1, poison)).toHaveLength(3)
    expect(resumed(r1, good)).toHaveLength(BATCH - 3)
    const r2 = await node.pass0()
    expect(resumed(r2, good)).toHaveLength(13) // the rest of the backlog comes before the poison rows' second turn
    expect(failedFor(r2, poison)).toHaveLength(3) // then each poison row once more, never more than once per run
    await expectConverged(good)
    await expectUntouched(poison) // 503 is never read as chain truth
    for (const p of poison) expect(st.perTxid.get(p.txid)).toBe(6) // 3 attempts per visit, two visits

    recovered = true
    const r3 = await node.pass0()
    expect(resumed(r3, poison).sort()).toEqual(poison.map((p) => p.escrowId).sort())
    await expectConverged(poison)
  })

  it('external truth that is not an answer (404 unknown transaction, timeout, 5xx) never converges anything and never broadcasts', async () => {
    requirePostgres('ambiguous truth')
    const unknown = track(await candidates(2))
    const st = explorer(() => 'unknown')
    const broadcast = jest.fn()
    const node = startNode()
    jest.spyOn(node.provider as any, 'broadcast').mockImplementation(broadcast as any)
    const r = await node.pass0()
    expect(failedFor(r, unknown)).toHaveLength(2) // unknown txid -> needs the outpoint -> no participant keys -> fails closed
    expect(broadcast).not.toHaveBeenCalled()
    await expectUntouched(unknown)
    expect(st.total).toBe(2)
  })

  // ═══ L–O: restarts, nodes, stale workers ═════════════════════════════════════════════════════════════

  it('L/M. restart before every run, with candidates that never resolve queued AHEAD of good ones: each fresh node continues from the durable queue position', async () => {
    requirePostgres('L/M')
    const stuck = track(await candidates(3))
    const good = track(await candidates(3))
    explorer((txid) => (stuck.some((s) => s.txid === txid) ? 'hang' : 'exists'))
    const done = new Set<string>()
    for (let i = 0; i < 6; i++) {
      const node = startNode({ timeoutMs: 300, intervalMs: 5000 }) // one stuck candidate uses up a run
      for (const id of resumed(await node.pass0(), good)) done.add(id)
    }
    expect(done.size).toBe(3) // without a durable position every fresh node would retry the first stuck row forever
    await expectConverged(good)
    await expectUntouched(stuck)
  })

  it('N. two nodes: a claim skips the rows another node\'s in-flight claim holds, and two concurrent runs never double the explorer work', async () => {
    requirePostgres('N')
    const cs = track(await candidates(12))
    const st = explorer()
    const [a, b] = [startNode(), startNode()]

    // Barrier = real row locks: node A's claim holding the first 6 rows.
    const holding = deferred(); const release = deferred()
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM escrow_pending_transactions WHERE id = ANY(${cs.slice(0, 6).map((c) => c.pendingId)}) FOR UPDATE`
      holding.resolve()
      await release.promise
    }, { timeout: 60_000 })
    await holding.promise
    const rb = await b.pass0() // does not wait: takes the other 6
    release.resolve(); await held
    expect(resumed(rb, cs).sort()).toEqual(cs.slice(6).map((c) => c.escrowId).sort())

    const more = track(await candidates(12))
    const [ra, rb2] = await Promise.all([a.pass0(), b.pass0()])
    const all = [...resumed(ra, [...cs, ...more]), ...resumed(rb2, [...cs, ...more])]
    expect(new Set(all).size).toBe(all.length) // disjoint
    expect(all.sort()).toEqual([...cs.slice(0, 6), ...more].map((c) => c.escrowId).sort())
    for (const c of [...cs, ...more]) expect(st.perTxid.get(c.txid)).toBe(1) // not 2
    await expectConverged([...cs, ...more])
  })

  it('O. stale worker: a node that stalls after its claim and resumes after another node converged the same operation writes nothing and cannot overwrite the result', async () => {
    requirePostgres('O')
    const [x] = track(await candidates(1))
    explorer()
    const stale = startNode(); const fresh = startNode()
    const claimed = deferred(); const resume = deferred()
    const realClaim = stale.repo.claimUnclaimedSignedPendingOperation.bind(stale.repo)
    jest.spyOn(stale.repo, 'claimUnclaimedSignedPendingOperation').mockImplementationOnce(async () => {
      const id = await realClaim()
      claimed.resolve(); await resume.promise
      return id
    })
    const staleRun = stale.pass0()
    await claimed.promise
    const r = await fresh.pass0() // the queue holds only x: the fresh node claims it next and converges it
    expect(resumed(r, [x])).toEqual([x.escrowId])
    const converged = await escrowOf(x)
    resume.resolve()
    const staleReport = await staleRun
    expect(resumed(staleReport, [x])).toEqual([])
    expect(failedFor(staleReport, [x])).toEqual([])
    const after = await escrowOf(x)
    expect([after.status, after.txReleaseId, after.releasedAt?.getTime()]).toEqual([converged.status, converged.txReleaseId, converged.releasedAt?.getTime()])
    await expectConverged([x])
  })

  // ═══ P–R: continuous arrivals ════════════════════════════════════════════════════════════════════════

  it('P/Q/R. new candidates on every run while an old backlog never resolves: new work converges no later than its rank allows, and every old row is revisited every lap', async () => {
    requirePostgres('P/Q/R')
    const old = track(await candidates(5))
    explorer((txid) => (old.some((o) => o.txid === txid) ? 'fail' : 'exists'))
    const node = startNode()
    const visits = new Map<string, number[]>(old.map((o) => [o.escrowId, []]))
    const arrivals: Array<{ c: Candidate; at: number; done?: number }> = []
    const RUNS = 6
    for (let run = 0; run < RUNS; run++) {
      for (const c of track(await candidates(8, { createdAt: new Date() }))) arrivals.push({ c, at: run })
      const r = await node.pass0()
      for (const a of arrivals) if (a.done === undefined && resumed(r, [a.c]).length) a.done = run
      for (const id of failedFor(r, old)) visits.get(id)!.push(run)
    }
    // runs hold BATCH candidates and each run brings 8 + 5 old: every arrival converges in the run it arrives
    for (const a of arrivals) expect(a.done).toBe(a.at)
    for (const v of visits.values()) expect(v).toEqual([0, 1, 2, 3, 4, 5])
    await expectConverged(arrivals.map((a) => a.c))
    await expectUntouched(old)
  })

  it('the fairness rule itself: the claim takes the oldest round-robin key (last visit, else creation) - an operation visited long ago comes BEFORE never-visited ones created after that visit, so a stream of new work cannot push it back forever', async () => {
    requirePostgres('fairness rule')
    const [visitedLongAgo] = await candidates(1)
    const fresh = await candidates(3) // created after that visit, never visited
    await prisma.escrowPendingTransaction.update({ where: { id: visitedLongAgo.pendingId }, data: { createdAt: new Date(QUEUE_HEAD), unclaimedRecoveryAttemptedAt: new Date(QUEUE_HEAD + 1) } })
    const repo = startNode().repo
    const now = new Date()
    expect(await repo.claimUnclaimedSignedPendingOperation(now)).toBe(visitedLongAgo.pendingId)
    expect(await repo.claimUnclaimedSignedPendingOperation(now)).toBe(fresh[0].pendingId)
  })

  // ═══ S–U: crash windows ══════════════════════════════════════════════════════════════════════════════

  it('S. crash right after the claim (no explorer request): the candidate keeps its place one lap back and a later run converges it', async () => {
    requirePostgres('S')
    const [x] = track(await candidates(1))
    const st = explorer()
    const crashed = startNode()
    jest.spyOn(crashed.provider, 'reconcilePendingSettlement').mockRejectedValueOnce(new Error('process died after the claim'))
    const r1 = await crashed.pass0()
    expect(failedFor(r1, [x])).toEqual([x.escrowId])
    expect(await stampOf(x)).not.toBeNull()
    expect(st.total).toBe(0)
    await expectUntouched([x])
    expect(resumed(await startNode().pass0(), [x])).toEqual([x.escrowId])
    await expectConverged([x])
  })

  it('T. crash after the explorer answered, before any state write: nothing was written, and the next visit converges it once', async () => {
    requirePostgres('T')
    const [x] = track(await candidates(1))
    const st = explorer()
    const crashed = startNode()
    const real = crashed.provider.reconcilePendingSettlement.bind(crashed.provider)
    jest.spyOn(crashed.provider, 'reconcilePendingSettlement').mockImplementationOnce(async (...args: unknown[]) => {
      await real(...args)
      throw new Error('process died after the chain answered')
    })
    await crashed.pass0()
    await expectUntouched([x])
    expect(resumed(await startNode().pass0(), [x])).toEqual([x.escrowId])
    await expectConverged([x])
    expect(st.perTxid.get(x.txid)).toBe(2)
  })

  it('U. crash after the durable write (transition claimed, result written, completion effects not run): PASS 0 never claims it again; PASS 2 completes it', async () => {
    requirePostgres('U')
    const [x] = track(await candidates(1))
    explorer()
    const crashed = startNode()
    const realWrite = crashed.repo.updateSignatureCollectionResult.bind(crashed.repo)
    jest.spyOn(crashed.repo, 'updateSignatureCollectionResult').mockImplementationOnce(async (...args: unknown[]) => {
      await realWrite(...args)
      throw new Error('process died after the result write')
    })
    await crashed.pass0()
    const e = await escrowOf(x)
    expect([e.status, e.txReleaseId]).toEqual(['COMPLETED', x.txid])
    expect(await prisma.escrowEvent.count({ where: { escrowId: x.escrowId, toStatus: 'COMPLETED' } })).toBe(0)

    const again = startNode()
    const claim = jest.spyOn(again.repo, 'claimUnclaimedSignedPendingOperation')
    await again.pass0()
    expect(await Promise.all(claim.mock.results.map((c) => c.value))).not.toContain(x.pendingId) // terminal: not a PASS 0 candidate

    const pass2 = startNode()
    let completed = false
    for (let i = 0; i < 30 && !completed; i++) {
      await pass2.reconcile()
      completed = (await prisma.escrowEvent.count({ where: { escrowId: x.escrowId, toStatus: 'COMPLETED' } })) === 1
    }
    expect(completed).toBe(true)
    await expectConverged([x])
  })

  // ═══ W + wiring ══════════════════════════════════════════════════════════════════════════════════════

  it('W. after convergence, repeated runs claim nothing for those operations and ask the explorer nothing', async () => {
    requirePostgres('W')
    const cs = track(await candidates(4))
    const st = explorer()
    const node = startNode()
    await node.pass0()
    await expectConverged(cs)
    const before = st.total
    for (let i = 0; i < 3; i++) expect(resumed(await node.pass0(), cs)).toEqual([])
    expect(st.total).toBe(before)
    await expectConverged(cs)
  })

  it('the production entry point (reconcilePendingSettlements) runs the same bounded PASS 0', async () => {
    requirePostgres('wiring')
    const cs = track(await candidates(BATCH + 3))
    explorer()
    const r = await startNode().reconcile()
    expect(resumed(r as Report, cs)).toHaveLength(BATCH)
  })
})
