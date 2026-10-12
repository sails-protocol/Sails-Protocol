// tests/integration/feeReleaseReorgIdempotency.test.ts
//
// Fee reorg + release reorg sweeps — real PostgreSQL proof that the durable
// generation, not whichever worker happens to write, decides every reorg
// observation, and that one pass does bounded work.
//
// Each "node" is an independent module graph (jest.isolateModules): its own
// Prisma client and connection pool, its own sweep and service singletons —
// what two application instances, or one instance after a restart, look
// like to the database. Only the chain explorer is simulated, at the
// provider boundary (global fetch): an observation is computed when the
// request is made and can be held before it is delivered, which is how a
// slow or stale worker is forced deterministically. None of this proves
// real Bitcoin reorg behaviour (REQUIRES_LIVE_ECONOMIC_REHEARSAL); it
// proves what the application records for a given sequence of explorer
// answers.
//
// The shared test database keeps other suites' rows. Tip heights here sit
// far above any other suite's heights, explorer answers for txids this file
// did not create never trigger a write (confirmed for the fee sweep,
// mempool-only for the release sweep), and every assertion is scoped to this
// file's own fixtures.

import { PrismaClient, Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

type TxState = { confirmedAt: number } | 'mempool' | 'missing' | 'error'

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

interface Hold { match: string; remaining: number; reached: Deferred; gate: Deferred }

// The simulated explorer. `unknown` is what it answers for a txid this file did not register. A fee
// reorg is modelled as the confirming transaction back in the mempool (`confirmed: false`), which is
// what the fee sweep detects; a release reorg as the release transaction unknown to the explorer (404).
const chain = {
  tip: 0,
  unknown: 'confirmed' as 'confirmed' | 'mempool',
  tx: new Map<string, TxState>(),
  outspend: new Map<string, { spent: boolean; txid?: string }>(),
  statusCalls: [] as string[],
  holds: [] as Hold[],
}

/** The next `count` explorer requests whose URL contains `match` are answered as observed now, but delivered only after release(). */
function holdExplorer(match: string, count = 1): { reached: Promise<void>; release: () => void } {
  const h: Hold = { match, remaining: count, reached: deferred(), gate: deferred() }
  chain.holds.push(h)
  return { reached: h.reached.promise, release: () => h.gate.resolve() }
}

function explorerResponse(url: string): any {
  if (url.includes('/blocks/tip/height')) return { ok: true, status: 200, text: async () => String(chain.tip) }
  const outspend = url.match(/\/tx\/([0-9a-f]+)\/outspend\/(\d+)/)
  if (outspend) {
    const answer = chain.outspend.get(`${outspend[1]}:${outspend[2]}`) ?? { spent: false }
    return { ok: true, status: 200, json: async () => answer }
  }
  const status = url.match(/\/tx\/([0-9a-f]+)\/status/)
  if (status) {
    const txid = status[1]
    chain.statusCalls.push(txid)
    const state: TxState = chain.tx.get(txid) ?? (chain.unknown === 'confirmed' ? { confirmedAt: chain.tip } : 'mempool')
    if (state === 'missing') return { ok: false, status: 404 }
    if (state === 'error') return { ok: false, status: 503 }
    if (state === 'mempool') return { ok: true, status: 200, json: async () => ({ confirmed: false }) }
    return { ok: true, status: 200, json: async () => ({ confirmed: true, block_height: state.confirmedAt }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

async function simulatedFetch(input: unknown): Promise<any> {
  const url = String(input)
  const response = explorerResponse(url) // the observation is made now...
  const hold = chain.holds.find((h) => h.remaining > 0 && url.includes(h.match))
  if (hold) {
    hold.remaining -= 1
    if (hold.remaining === 0) hold.reached.resolve()
    await hold.gate.promise // ...and delivered later
  }
  return response
}

function hex(label: string): string {
  return createHash('sha256').update(`${label}-${Date.now()}-${Math.random()}`).digest('hex')
}

/** Resolves when `reached` does; fails fast if `work` settles first (the barrier was never hit). */
async function reachedOrSettled(reached: Promise<void>, work: Promise<unknown>, what: string): Promise<void> {
  const settled = work.then(() => 'settled', () => 'settled')
  const first = await Promise.race([reached.then(() => 'reached'), settled])
  if (first !== 'reached') throw new Error(`${what}: finished without reaching the barrier`)
}

describe('Fee reorg + release reorg — economic idempotency and boundedness (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let window: number
  let feeRecognition: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let feeEvidence: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository
  let BASELINE_BATCH_SIZE: number
  let realFetch: typeof fetch
  const nodes: Array<{ shutdown: () => Promise<void> }> = []

  // Heights far above every other suite's (they stay below 1,000,000), so their rows are buried here.
  let nextTip = 50_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000) * 20
  function freshTip(): number {
    nextTip += 10_000
    return nextTip
  }

  let buyerId: string
  let sellerId: string
  let offerId: string
  let sellerAccount: { id: string; accountHash: string }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ feeCollectionRecognitionService: feeRecognition } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ feeCollectionEvidenceRepository: feeEvidence } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
    ;({ BASELINE_BATCH_SIZE } = require('../../src/modules/open-settlement/multisig-release-reorg-sweep'))
    window = require('../../src/config').config.trade.multisigReorgSafetyWindowBlocks

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    buyerId = (await prisma.user.create({ data: { publicKey: `pk-reorg-buyer-${suffix}` } })).id
    sellerId = (await prisma.user.create({ data: { publicKey: `pk-reorg-seller-${suffix}` } })).id
    sellerAccount = await sellerPixAccount(prisma, sellerId)
    offerId = (await prisma.offer.create({ data: { userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(sellerAccount) } })).id
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  beforeEach(() => {
    realFetch = global.fetch
    global.fetch = simulatedFetch as any
    chain.tip = freshTip()
    chain.unknown = 'confirmed'
    chain.tx.clear()
    chain.outspend.clear()
    chain.statusCalls = []
    chain.holds = []
  })

  afterEach(async () => {
    for (const h of chain.holds) h.gate.resolve()
    while (nodes.length) await nodes.pop()!.shutdown()
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    feeSweep: () => Promise<any>
    releaseSweep: () => Promise<any>
    recordReorgAndRevert: (id: string, txid: string, observed?: string) => Promise<any>
    recognizeConfirmation: (id: string, txid: string, height: number) => Promise<void>
    feeEvidenceRepo: any
    releaseEvidenceRepo: any
    lifecycle: any
    shutdown: () => Promise<void>
  }

  /** An independent application instance: own module graph, own Prisma client and pool. */
  function startNode(): Node {
    let node!: Node
    jest.isolateModules(() => {
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      const recognition = require('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
      const { sweepMultisigFeeReorgs } = require('../../src/modules/open-settlement/multisig-fee-reorg-sweep')
      const { sweepMultisigReleaseReorgs } = require('../../src/modules/open-settlement/multisig-release-reorg-sweep')
      node = {
        feeSweep: () => sweepMultisigFeeReorgs(),
        releaseSweep: () => sweepMultisigReleaseReorgs(),
        recordReorgAndRevert: (id, txid, observed) => recognition.recordReorgAndRevert(id, txid, observed),
        recognizeConfirmation: (id, txid, height) => recognition.recognizeConfirmation(id, txid, height),
        feeEvidenceRepo: require('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository,
        releaseEvidenceRepo: require('../../src/modules/open-settlement/escrow-release-evidence-repository').escrowReleaseEvidenceRepository,
        lifecycle: require('../../src/modules/open-settlement/escrow-lifecycle'),
        shutdown: async () => {
          await db.prisma.$disconnect()
          await redisModule.redis?.quit?.().catch(() => undefined)
        },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fee fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  interface FeeFixture { obligationId: string; txid: string; confirmationId: string }

  /** A MULTISIG fee obligation taken through the real recognition flow: BROADCAST, then CONFIRMED at `height`. */
  async function collectedFee(label: string, height: number, opts: { distributed?: boolean; broadcastOnly?: boolean } = {}): Promise<FeeFixture> {
    const s = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(sellerAccount), offerId, buyerId, sellerId, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const policy = await prisma.feePolicyVersion.create({
      data: {
        label: `reorg-${s}`, railScope: `MULTISIG-reorg-${s}`, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10',
        requiredConfirmations: 2, createdBy: 'fee-release-reorg-integration-test',
      },
    })
    const escrow = await prisma.escrow.create({
      data: {
        tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING',
        txLockId: hex(`fee-lock-${s}`), txLockVout: 0, // #235 R7G F8A: past FUNDS_LOCKED a MULTISIG escrow carries its funding outpoint
        feePolicyVersionId: policy.id, snapshotProtocolFeeRate: '0.004', snapshotPayerModel: 'SELLER_PAYS', snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE',
        snapshotFeeCollectionAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', snapshotFeeCollectionWaivedPreFunding: false,
      },
    })
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: policy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.000004', asset: 'BTC' },
    })
    const txid = hex(`fee-${s}`)
    await feeRecognition.recordBroadcastAndAdvance(obligation.id, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 400 })
    if (opts.broadcastOnly) return { obligationId: obligation.id, txid, confirmationId: '' }
    await feeRecognition.recognizeConfirmation(obligation.id, txid, height)
    if (opts.distributed) await prisma.feeObligation.update({ where: { id: obligation.id }, data: { collectionStatus: 'DISTRIBUTED' } })
    chain.tx.set(txid, { confirmedAt: height })
    return { obligationId: obligation.id, txid, confirmationId: await latestConfirmationId(obligation.id) }
  }

  /** Reconfirmation of an IN_PROGRESS obligation with a new transaction — a new confirmation generation. */
  async function reconfirm(obligationId: string, height: number): Promise<{ txid: string; confirmationId: string }> {
    const txid = hex(`reconfirm-${obligationId}`)
    await feeEvidence.record({ feeObligationId: obligationId, kind: 'BROADCAST', txid, vout: 1, scriptPubKey: 'deadbeef', amount: new Prisma.Decimal(400).dividedBy(1e8) })
    await feeRecognition.recognizeConfirmation(obligationId, txid, height)
    chain.tx.set(txid, { confirmedAt: height })
    return { txid, confirmationId: await latestConfirmationId(obligationId) }
  }

  async function latestConfirmationId(obligationId: string): Promise<string> {
    const row = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] })
    return row.id
  }

  async function feeState(obligationId: string) {
    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligationId } })
    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
    return {
      status: obligation.collectionStatus,
      reorgs: evidence.filter((e) => e.kind === 'REORGED_OUT'),
      confirmations: evidence.filter((e) => e.kind === 'CONFIRMED'),
    }
  }

  // ─── release fixtures ─────────────────────────────────────────────────────────────────────────────────────

  interface ReleaseFixture { escrowId: string; txReleaseId: string; txLockId: string }

  // Strictly increasing settlement times, so "newest first" never depends on two creates sharing a millisecond.
  let lastSettledAt = 0
  function nextSettledAt(): Date {
    lastSettledAt = Math.max(Date.now(), lastSettledAt + 1)
    return new Date(lastSettledAt)
  }

  /** A terminal MULTISIG escrow with a release txid and, optionally, release evidence already recorded (oldest first). */
  async function settledEscrow(
    label: string,
    opts: { status?: 'COMPLETED' | 'REFUNDED' | 'SPLIT' | 'DISPUTED'; evidence?: Array<{ kind: 'OBSERVED_CONFIRMED' | 'RECONFIRMED' | 'REORGED_INVALIDATED' | 'AMBIGUOUS'; observedAtHeight?: number; txid?: string }> } = {}
  ): Promise<ReleaseFixture> {
    const status = opts.status ?? 'COMPLETED'
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(sellerAccount), offerId, buyerId, sellerId, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const txReleaseId = hex(`release-${label}`)
    const txLockId = hex(`lock-${label}`)
    const escrow = await prisma.escrow.create({
      data: {
        tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status,
        txLockId, txLockVout: 0, txReleaseId, releasedAt: status === 'REFUNDED' ? null : nextSettledAt(),
      },
    })
    let at = Date.now() - 60_000
    for (const e of opts.evidence ?? []) {
      at += 1_000
      await prisma.escrowReleaseEvidence.create({
        data: { escrowId: escrow.id, kind: e.kind, txid: e.txid ?? txReleaseId, observedAtHeight: e.observedAtHeight ?? null, tipHeightAtObservation: chain.tip, recordedAt: new Date(at) },
      })
    }
    return { escrowId: escrow.id, txReleaseId, txLockId }
  }

  async function durableEventCount(): Promise<number> {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM durable_events`
    return row.n
  }

  async function releaseEvidence(escrowId: string) {
    return prisma.escrowReleaseEvidence.findMany({ where: { escrowId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
  }

  async function baselineStamp(escrowId: string): Promise<Date | null> {
    const [row] = await prisma.$queryRaw<Array<{ at: Date | null }>>`SELECT "releaseBaselineAttemptedAt" AS at FROM escrows WHERE id = ${escrowId}`
    return row.at
  }

  async function baselineQueueLength(): Promise<{ total: number; neverAttempted: number }> {
    const [row] = await prisma.$queryRaw<Array<{ total: number; neverAttempted: number }>>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE e."releaseBaselineAttemptedAt" IS NULL)::int AS "neverAttempted"
      FROM escrows e
      WHERE e.type = 'MULTISIG' AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM escrow_release_evidence r WHERE r."escrowId" = e.id)`
    return row
  }

  /**
   * Other suites leave terminal MULTISIG escrows with no release evidence behind. Observing each of them
   * once (mempool-only answers, so nothing is recorded) puts them behind any escrow created afterwards,
   * which makes this file's queue positions deterministic.
   */
  async function observeLeftoverBaselines(node: Node): Promise<boolean> {
    chain.unknown = 'mempool'
    const { total } = await baselineQueueLength()
    for (let pass = 0; pass <= Math.ceil(total / BASELINE_BATCH_SIZE); pass++) {
      if ((await baselineQueueLength()).neverAttempted === 0) return true
      await node.releaseSweep()
    }
    return (await baselineQueueLength()).neverAttempted === 0
  }

  // ═══ Fee reorg ════════════════════════════════════════════════════════════════════════════════════════════

  describe('fee reorg', () => {
    it('A — two nodes observing the same confirmation: one CONFIRMED generation, one COLLECTED; both reorg sweeps see it still confirmed and write nothing', async () => {
      requirePostgres('fee A')
      const f = await collectedFee('A', chain.tip - 5, { broadcastOnly: true })
      const a = startNode()
      const b = startNode()

      // Recognition: both nodes' fee-confirmation jobs recognize the same confirmation at once. The CAS on the
      // obligation row lets exactly one commit; the other rolls its CONFIRMED row back with it.
      const recognized = await Promise.allSettled([a.recognizeConfirmation(f.obligationId, f.txid, chain.tip - 5), b.recognizeConfirmation(f.obligationId, f.txid, chain.tip - 5)])
      expect(recognized.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      // A replay after the fact is refused before it writes anything.
      await expect(a.recognizeConfirmation(f.obligationId, f.txid, chain.tip - 5)).rejects.toThrow(/not IN_PROGRESS/)

      const held = holdExplorer(f.txid, 2)
      const both = Promise.all([a.feeSweep(), b.feeSweep()])
      await reachedOrSettled(held.reached, both, 'both fee sweeps observing the confirmation')
      held.release()
      const [ra, rb] = await both

      expect(ra.stillGood).toContain(f.obligationId)
      expect(rb.stillGood).toContain(f.obligationId)
      const state = await feeState(f.obligationId)
      expect(state.status).toBe('COLLECTED')
      expect(state.confirmations).toHaveLength(1)
      expect(state.reorgs).toHaveLength(0)
    })

    it('B — two nodes observing the same reorg of a COLLECTED fee: one REORGED_OUT, one revert, the other node records nothing', async () => {
      requirePostgres('fee B collected')
      const f = await collectedFee('B-collected', chain.tip - 5)
      chain.tx.set(f.txid, 'mempool')
      const a = startNode()
      const b = startNode()

      const held = holdExplorer(f.txid, 2) // both nodes have selected the obligation and asked the explorer
      const both = Promise.all([a.feeSweep(), b.feeSweep()])
      await reachedOrSettled(held.reached, both, 'both fee sweeps observing the reorg')
      held.release()
      const [ra, rb] = await both

      const outcomes = [ra, rb].map((r) => (r.reverted.includes(f.obligationId) ? 'reverted' : r.alreadyRecorded?.includes(f.obligationId) ? 'alreadyRecorded' : 'other'))
      expect(outcomes.sort()).toEqual(['alreadyRecorded', 'reverted'])
      expect([...ra.failed, ...rb.failed].filter((x: any) => x.feeObligationId === f.obligationId)).toEqual([])
      const state = await feeState(f.obligationId)
      expect(state.status).toBe('IN_PROGRESS')
      expect(state.reorgs).toHaveLength(1)
    })

    it('B — two nodes observing the same reorg of a DISTRIBUTED fee: flagged once, one REORGED_OUT, never reverted', async () => {
      requirePostgres('fee B distributed')
      const f = await collectedFee('B-distributed', chain.tip - 5, { distributed: true })
      chain.tx.set(f.txid, 'mempool')
      const a = startNode()
      const b = startNode()

      const held = holdExplorer(f.txid, 2)
      const both = Promise.all([a.feeSweep(), b.feeSweep()])
      await reachedOrSettled(held.reached, both, 'both fee sweeps observing the reorg')
      held.release()
      const [ra, rb] = await both

      const flagged = [ra, rb].filter((r) => r.flaggedDistributed.includes(f.obligationId))
      expect(flagged).toHaveLength(1)
      const state = await feeState(f.obligationId)
      expect(state.status).toBe('DISTRIBUTED')
      expect(state.reorgs).toHaveLength(1)
    })

    it('B — the second node blocks on the obligation row lock while the first decides, then finds the reorg already recorded', async () => {
      requirePostgres('fee B row lock')
      const f = await collectedFee('B-lock', chain.tip - 5)
      const a = startNode()
      const b = startNode()

      // Hold node A inside its locked transaction, right after it re-reads the evidence.
      const inside = deferred()
      const proceed = deferred()
      const original = a.feeEvidenceRepo.listForObligation.bind(a.feeEvidenceRepo)
      jest.spyOn(a.feeEvidenceRepo, 'listForObligation').mockImplementationOnce(async (...args: unknown[]) => {
        const rows = await original(...args)
        inside.resolve()
        await proceed.promise
        return rows
      })

      const first = a.recordReorgAndRevert(f.obligationId, f.txid, f.confirmationId)
      await reachedOrSettled(inside.promise, first, 'node A inside the reorg transaction')
      const second = b.recordReorgAndRevert(f.obligationId, f.txid, f.confirmationId)

      // Node B is provably waiting on the row lock, not racing past it.
      const deadline = Date.now() + 10_000
      for (;;) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%fee_obligations%FOR UPDATE%'`
        if (n >= 1) break
        if (Date.now() > deadline) throw new Error('node B never waited on the obligation row lock')
        await new Promise((r) => setTimeout(r, 25))
      }

      proceed.resolve()
      expect((await first).outcome).toBe('REVERTED')
      expect((await second).outcome).toBe('ALREADY_RECORDED')
      const state = await feeState(f.obligationId)
      expect(state.status).toBe('IN_PROGRESS')
      expect(state.reorgs).toHaveLength(1)
    })

    it('C — confirmation → reorg → reconfirmation → reorg: one REORGED_OUT per generation, each naming its own generation, and the final state follows the latest generation', async () => {
      requirePostgres('fee C')
      const f = await collectedFee('C', chain.tip - 5)
      const node = startNode()

      chain.tx.set(f.txid, 'mempool')
      expect((await node.feeSweep()).reverted).toContain(f.obligationId)
      expect((await feeState(f.obligationId)).status).toBe('IN_PROGRESS')

      const g2 = await reconfirm(f.obligationId, chain.tip - 2)
      // The first generation's transaction is still gone; the second is confirmed.
      const afterReconfirm = await node.feeSweep()
      expect(afterReconfirm.stillGood).toContain(f.obligationId)
      let state = await feeState(f.obligationId)
      expect(state.status).toBe('COLLECTED')
      expect(state.confirmations).toHaveLength(2)
      expect(state.reorgs).toHaveLength(1)
      expect(state.reorgs[0].txid).toBe(f.txid)

      // A reorg of the second generation is a new fact, not a duplicate of the first.
      chain.tx.set(g2.txid, 'mempool')
      expect((await node.feeSweep()).reverted).toContain(f.obligationId)
      state = await feeState(f.obligationId)
      expect(state.status).toBe('IN_PROGRESS')
      expect(state.reorgs.map((r) => r.txid)).toEqual([f.txid, g2.txid])
      // Each REORGED_OUT names the generation it invalidated.
      expect(state.reorgs[0].note).toContain(f.confirmationId)
      expect(state.reorgs[1].note).toContain(g2.confirmationId)
    })

    it('D — restart after the durable mutation: a node that dies right after its commit leaves nothing for the restarted node to repeat', async () => {
      requirePostgres('fee D')
      const collected = await collectedFee('D-collected', chain.tip - 5)
      const distributed = await collectedFee('D-distributed', chain.tip - 5, { distributed: true })
      chain.tx.set(collected.txid, 'mempool')
      chain.tx.set(distributed.txid, 'mempool')

      // Node A commits both reorg decisions, then dies: nothing it did after the commit is durable.
      const a = startNode()
      const aSweep = await a.feeSweep()
      expect((await feeState(collected.obligationId)).reorgs).toHaveLength(1)
      expect((await feeState(distributed.obligationId)).reorgs).toHaveLength(1)
      expect(aSweep.reverted).toContain(collected.obligationId)
      expect(aSweep.flaggedDistributed).toContain(distributed.obligationId)
      await a.shutdown()
      nodes.splice(nodes.indexOf(a), 1)

      // The restarted node: the reverted obligation is no longer a candidate; the DISTRIBUTED one is not re-flagged.
      const b = startNode()
      const bSweep = await b.feeSweep()
      expect(bSweep.reverted).not.toContain(collected.obligationId)
      expect(bSweep.flaggedDistributed).not.toContain(distributed.obligationId)
      expect(bSweep.alreadyRecorded).toContain(distributed.obligationId)
      expect((await feeState(collected.obligationId)).reorgs).toHaveLength(1)
      expect((await feeState(collected.obligationId)).status).toBe('IN_PROGRESS')
      expect((await feeState(distributed.obligationId)).reorgs).toHaveLength(1)
      expect((await feeState(distributed.obligationId)).status).toBe('DISTRIBUTED')
    })

    it('E — a stale worker that observed the first generation resumes after the reorg and a newer confirmation: its observation is discarded, the newer generation stays COLLECTED', async () => {
      requirePostgres('fee E')
      const f = await collectedFee('E', chain.tip - 5)
      chain.tx.set(f.txid, 'mempool')
      const stale = startNode()
      const current = startNode()

      // The stale node sees generation 1 gone, and is delayed before acting on it.
      const held = holdExplorer(f.txid, 1)
      const staleSweep = stale.feeSweep()
      await reachedOrSettled(held.reached, staleSweep, 'stale node observing generation 1')

      // Meanwhile the current node reverts generation 1, and the fee is confirmed again (generation 2).
      expect((await current.feeSweep()).reverted).toContain(f.obligationId)
      const g2 = await reconfirm(f.obligationId, chain.tip - 1)
      expect((await feeState(f.obligationId)).status).toBe('COLLECTED')

      held.release()
      const result = await staleSweep

      const state = await feeState(f.obligationId)
      expect(state.status).toBe('COLLECTED') // generation 2 was never reverted by the stale observation
      expect(state.reorgs).toHaveLength(1)
      expect(await latestConfirmationId(f.obligationId)).toBe(g2.confirmationId)
      expect(result.reverted).not.toContain(f.obligationId)
      expect(result.superseded).toContain(f.obligationId)
    })

    it('F — duplicate and replayed invocations: a DISTRIBUTED reorg is recorded and flagged once however often the sweep or the service is invoked', async () => {
      requirePostgres('fee F')
      const f = await collectedFee('F', chain.tip - 5, { distributed: true })
      chain.tx.set(f.txid, 'mempool')
      const node = startNode()

      const first = await node.feeSweep()
      const second = await node.feeSweep()
      const third = await node.feeSweep()
      const replay = await node.recordReorgAndRevert(f.obligationId, f.txid, f.confirmationId)
      const replayByTxid = await node.recordReorgAndRevert(f.obligationId, f.txid)

      expect(first.flaggedDistributed).toContain(f.obligationId)
      expect(second.flaggedDistributed).not.toContain(f.obligationId)
      expect(second.alreadyRecorded).toContain(f.obligationId)
      expect(third.alreadyRecorded).toContain(f.obligationId)
      expect(replay.outcome).toBe('ALREADY_RECORDED')
      expect(replayByTxid.outcome).toBe('ALREADY_RECORDED')
      const state = await feeState(f.obligationId)
      expect(state.reorgs).toHaveLength(1)
      expect(state.status).toBe('DISTRIBUTED')
    })

    it('G — a history larger than any batch: buried obligations are never loaded or sent to the explorer; only the in-window ones are', async () => {
      requirePostgres('fee G')
      const buried: FeeFixture[] = []
      for (let i = 0; i < 60; i++) buried.push(await collectedFee(`G-buried-${i}`, chain.tip - window - 50 - i))
      const inWindowGood = await collectedFee('G-in-window-good', chain.tip - 3)
      const inWindowReorged = await collectedFee('G-in-window-reorged', chain.tip - 4)
      chain.tx.set(inWindowReorged.txid, 'mempool')
      for (const b of buried) chain.tx.set(b.txid, 'mempool') // would be reverted if the sweep ever looked at them

      const node = startNode()
      const listSpy = jest.spyOn(node.feeEvidenceRepo, 'listForObligation')
      const result = await node.feeSweep()

      expect(chain.statusCalls.filter((txid) => buried.some((b) => b.txid === txid))).toEqual([])
      // Evidence is read only inside the lock of the one obligation that needed a decision — never per obligation of the history.
      expect(listSpy.mock.calls.map((call) => call[0])).toEqual([inWindowReorged.obligationId])
      for (const b of buried.slice(0, 5)) expect((await feeState(b.obligationId)).status).toBe('COLLECTED')
      expect(result.stillGood).toContain(inWindowGood.obligationId)
      expect(result.reverted).toContain(inWindowReorged.obligationId)
      const buriedIds = new Set(buried.map((b) => b.obligationId))
      const touched = [...result.reverted, ...result.flaggedDistributed, ...result.alreadyRecorded, ...result.superseded, ...result.stillGood, ...result.failed.map((x: any) => x.feeObligationId)]
      expect(touched.filter((id: string) => buriedIds.has(id))).toEqual([])
    })

    it('H — a poison obligation (explorer failing for its transaction) fails alone; every other obligation in the window is still handled, in this pass and the next', async () => {
      requirePostgres('fee H')
      const poison = await collectedFee('H-poison', chain.tip - 2)
      const reorged = await collectedFee('H-reorged', chain.tip - 3)
      const good = await collectedFee('H-good', chain.tip - 4)
      chain.tx.set(poison.txid, 'error')
      chain.tx.set(reorged.txid, 'mempool')
      const node = startNode()

      const first = await node.feeSweep()
      expect(first.failed.map((x: any) => x.feeObligationId)).toContain(poison.obligationId)
      expect(first.reverted).toContain(reorged.obligationId)
      expect(first.stillGood).toContain(good.obligationId)

      const late = await collectedFee('H-late', chain.tip - 1)
      chain.tx.set(late.txid, 'mempool')
      const second = await node.feeSweep()
      expect(second.failed.map((x: any) => x.feeObligationId)).toContain(poison.obligationId)
      expect(second.reverted).toContain(late.obligationId)
      expect(second.stillGood).toContain(good.obligationId)
      expect((await feeState(poison.obligationId)).status).toBe('COLLECTED')
      expect((await feeState(poison.obligationId)).reorgs).toHaveLength(0)
    })
  })

  // ═══ Release reorg ════════════════════════════════════════════════════════════════════════════════════════

  describe('release reorg', () => {
    beforeEach(() => {
      chain.unknown = 'mempool' // other suites' release txids are never confirmed here, so nothing is recorded for them
    })

    it('I — two nodes observing the same reconfirmation record one RECONFIRMED; a slow node\'s first-ever observation is discarded once another node recorded it', async () => {
      requirePostgres('release I')
      // Same reconfirmation, two nodes at once.
      const flagged = await settledEscrow('I-reconfirm', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }, { kind: 'REORGED_INVALIDATED' }] })
      chain.tx.set(flagged.txReleaseId, { confirmedAt: chain.tip - 1 })
      const a = startNode()
      const b = startNode()
      const heldBoth = holdExplorer(flagged.txReleaseId, 2)
      const both = Promise.all([a.releaseSweep(), b.releaseSweep()])
      await reachedOrSettled(heldBoth.reached, both, 'both release sweeps observing the reconfirmation')
      heldBoth.release()
      const [ra, rb] = await both
      expect([ra, rb].filter((r) => r.reconfirmed.includes(flagged.escrowId))).toHaveLength(1)
      expect([ra, rb].filter((r) => r.superseded.includes(flagged.escrowId))).toHaveLength(1)
      expect((await releaseEvidence(flagged.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED', 'RECONFIRMED'])

      // First-ever observation: node A claims the escrow and is delayed; node B keeps sweeping until it claims it too.
      expect(await observeLeftoverBaselines(b)).toBe(true)
      const fresh = await settledEscrow('I-baseline')
      chain.tx.set(fresh.txReleaseId, { confirmedAt: chain.tip - 1 })
      const heldA = holdExplorer(fresh.txReleaseId, 1)
      const slow = a.releaseSweep()
      await reachedOrSettled(heldA.reached, slow, 'node A observing the release for the first time')
      const stampedByA = await baselineStamp(fresh.escrowId)
      expect(stampedByA).not.toBeNull()

      const { total } = await baselineQueueLength()
      let observedByB = false
      for (let pass = 0; pass <= Math.ceil(total / BASELINE_BATCH_SIZE) && !observedByB; pass++) {
        observedByB = (await b.releaseSweep()).observedBaseline.includes(fresh.escrowId)
      }
      expect(observedByB).toBe(true)

      heldA.release()
      const aResult = await slow
      expect(aResult.superseded).toContain(fresh.escrowId)
      expect(aResult.observedBaseline).not.toContain(fresh.escrowId)
      expect((await releaseEvidence(fresh.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED'])
    })

    it('J — two nodes observing the same reorg of a confirmed release record one REORGED_INVALIDATED and flag it once', async () => {
      requirePostgres('release J')
      const f = await settledEscrow('J', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }] })
      chain.tx.set(f.txReleaseId, 'missing')
      const a = startNode()
      const b = startNode()

      const held = holdExplorer(`/tx/${f.txLockId}/outspend/`, 2) // both have seen the release gone and asked about the funding outpoint
      const both = Promise.all([a.releaseSweep(), b.releaseSweep()])
      await reachedOrSettled(held.reached, both, 'both release sweeps observing the reorg')
      held.release()
      const [ra, rb] = await both

      const flagged = [ra, rb].filter((r) => r.requiresManualReview.some((x: any) => x.escrowId === f.escrowId))
      expect(flagged).toHaveLength(1)
      expect([ra, rb].filter((r) => r.superseded.includes(f.escrowId))).toHaveLength(1)
      expect((await releaseEvidence(f.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED'])
      const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })
      expect(escrow.status).toBe('COMPLETED')
      expect(escrow.txReleaseId).toBe(f.txReleaseId)
    })

    it('K — a stale worker that saw the release gone resumes after it was flagged and then reconfirmed: its observation is discarded, RECONFIRMED stays the latest fact', async () => {
      requirePostgres('release K')
      const f = await settledEscrow('K', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }] })
      chain.tx.set(f.txReleaseId, 'missing')
      const stale = startNode()
      const current = startNode()

      const held = holdExplorer(`/tx/${f.txLockId}/outspend/`, 1) // observed "unspent" now, delivered later
      const staleSweep = stale.releaseSweep()
      await reachedOrSettled(held.reached, staleSweep, 'stale node observing the reorg')

      expect((await current.releaseSweep()).requiresManualReview.some((x: any) => x.escrowId === f.escrowId)).toBe(true)
      chain.tx.set(f.txReleaseId, { confirmedAt: chain.tip - 1 })
      chain.outspend.set(`${f.txLockId}:0`, { spent: true, txid: f.txReleaseId })
      expect((await current.releaseSweep()).reconfirmed).toContain(f.escrowId)

      held.release()
      const result = await staleSweep
      expect((await releaseEvidence(f.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED', 'RECONFIRMED'])
      expect(result.requiresManualReview.some((x: any) => x.escrowId === f.escrowId)).toBe(false)
      expect(result.superseded).toContain(f.escrowId)
    })

    it('L — restart after a durable write, and after a claim whose observation never landed: the restarted node neither repeats the write nor loses the escrow', async () => {
      requirePostgres('release L')
      // After a durable write: the reorg is recorded, the node dies, the restarted node finds it already flagged.
      const reorged = await settledEscrow('L-reorged', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }] })
      chain.tx.set(reorged.txReleaseId, 'missing')
      const a = startNode()
      expect((await a.releaseSweep()).requiresManualReview.some((x: any) => x.escrowId === reorged.escrowId)).toBe(true)
      await a.shutdown()
      nodes.splice(nodes.indexOf(a), 1)

      const b = startNode()
      const afterRestart = await b.releaseSweep()
      expect((await releaseEvidence(reorged.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED'])
      expect(afterRestart.requiresManualReview.some((x: any) => x.escrowId === reorged.escrowId)).toBe(false)
      expect(afterRestart.alreadyFlagged).toContain(reorged.escrowId)

      // After a claim: node C claims a fresh escrow, then dies inside its write (the lock transaction rolls back).
      expect(await observeLeftoverBaselines(b)).toBe(true)
      const fresh = await settledEscrow('L-fresh')
      chain.tx.set(fresh.txReleaseId, { confirmedAt: chain.tip - 1 })
      const c = startNode()
      jest.spyOn(c.lifecycle, 'withEscrowFundingLock').mockImplementation(async () => { throw new Error('process died') })
      const crashed = await c.releaseSweep()
      expect(crashed.failed.some((x: any) => x.escrowId === fresh.escrowId)).toBe(true)
      expect(await baselineStamp(fresh.escrowId)).not.toBeNull()
      expect(await releaseEvidence(fresh.escrowId)).toHaveLength(0)
      await c.shutdown()
      nodes.splice(nodes.indexOf(c), 1)

      // The restarted node reaches it again within the queue's own bound and records it exactly once.
      const d = startNode()
      const { total } = await baselineQueueLength()
      let observed = false
      for (let pass = 0; pass <= Math.ceil(total / BASELINE_BATCH_SIZE) && !observed; pass++) {
        observed = (await d.releaseSweep()).observedBaseline.includes(fresh.escrowId)
      }
      expect(observed).toBe(true)
      expect((await releaseEvidence(fresh.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED'])
    })

    it('M — an escrow still under settlement recovery (release txid written, status not terminal) is never observed or stamped; once recovery completes it is observed, then a reorg is recorded as evidence only', async () => {
      requirePostgres('release M')
      const b = startNode()
      const drained = await observeLeftoverBaselines(b)
      const recovering = await settledEscrow('M', { status: 'DISPUTED' })
      chain.tx.set(recovering.txReleaseId, { confirmedAt: chain.tip - 2 })
      const eventsBefore = await durableEventCount()

      const during = await b.releaseSweep()
      expect([...during.observedBaseline, ...during.stillPending, ...during.stillGood]).not.toContain(recovering.escrowId)
      expect(await baselineStamp(recovering.escrowId)).toBeNull()
      expect(await releaseEvidence(recovering.escrowId)).toHaveLength(0)

      // Recovery completes the settlement (the only writer of status); the sweep then treats it like any release.
      await prisma.escrow.update({ where: { id: recovering.escrowId }, data: { status: 'COMPLETED' } })
      expect((await b.releaseSweep()).observedBaseline).toContain(recovering.escrowId)

      chain.tx.set(recovering.txReleaseId, 'missing')
      expect((await b.releaseSweep()).requiresManualReview.some((x: any) => x.escrowId === recovering.escrowId)).toBe(true)
      const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: recovering.escrowId } })
      expect(escrow.status).toBe('COMPLETED')
      expect(escrow.txReleaseId).toBe(recovering.txReleaseId)
      expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: recovering.escrowId } })).toBeNull()
      expect(await durableEventCount()).toBe(eventsBefore) // the sweep emits nothing
      expect((await releaseEvidence(recovering.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED'])
      expect(drained).toBe(true)
    })

    it('N — duplicate and replayed invocations: one baseline, one REORGED_INVALIDATED, one AMBIGUOUS per conflicting spend, however often the sweep runs', async () => {
      requirePostgres('release N')
      const node = startNode()
      const worldC = await settledEscrow('N-c', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }] })
      const worldD = await settledEscrow('N-d', { evidence: [{ kind: 'OBSERVED_CONFIRMED', observedAtHeight: chain.tip - 5 }] })
      const conflict = hex('N-conflict')
      chain.tx.set(worldC.txReleaseId, 'missing')
      chain.tx.set(worldD.txReleaseId, 'missing')
      chain.outspend.set(`${worldD.txLockId}:0`, { spent: true, txid: conflict })

      const runs = [await node.releaseSweep(), await node.releaseSweep(), await node.releaseSweep()]

      expect(runs.map((r) => r.requiresManualReview.filter((x: any) => x.escrowId === worldC.escrowId || x.escrowId === worldD.escrowId).length)).toEqual([2, 0, 0])
      expect(runs.slice(1).every((r) => r.alreadyFlagged.includes(worldC.escrowId) && r.alreadyFlagged.includes(worldD.escrowId))).toBe(true)
      expect((await releaseEvidence(worldC.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED'])
      expect((await releaseEvidence(worldD.escrowId)).map((e) => [e.kind, e.txid])).toEqual([['OBSERVED_CONFIRMED', worldD.txReleaseId], ['AMBIGUOUS', conflict]])

      // A different conflicting spend later is a new fact, recorded once.
      const second = hex('N-conflict-2')
      chain.outspend.set(`${worldD.txLockId}:0`, { spent: true, txid: second })
      await node.releaseSweep()
      await node.releaseSweep()
      expect((await releaseEvidence(worldD.escrowId)).map((e) => e.txid)).toEqual([worldD.txReleaseId, conflict, second])
    })

    it('O — a backlog larger than one batch: each pass observes at most BASELINE_BATCH_SIZE, newest first, and every escrow is observed exactly once', async () => {
      requirePostgres('release O')
      const node = startNode()
      const drained = await observeLeftoverBaselines(node)
      const backlog: ReleaseFixture[] = []
      for (let i = 0; i < BASELINE_BATCH_SIZE + 10; i++) {
        const f = await settledEscrow(`O-${i}`)
        chain.tx.set(f.txReleaseId, { confirmedAt: chain.tip - 1 })
        backlog.push(f)
      }
      const statusCallsBefore = chain.statusCalls.length

      const first = await node.releaseSweep()
      const mine = new Set(backlog.map((f) => f.escrowId))
      const firstObserved = first.observedBaseline.filter((id: string) => mine.has(id))
      expect(firstObserved).toHaveLength(BASELINE_BATCH_SIZE)
      expect(new Set(firstObserved)).toEqual(new Set(backlog.slice(-BASELINE_BATCH_SIZE).map((f) => f.escrowId))) // newest first
      // Explorer work for the backlog is bounded by the batch: two status calls per observed escrow.
      expect(chain.statusCalls.slice(statusCallsBefore).filter((txid) => backlog.some((f) => f.txReleaseId === txid))).toHaveLength(2 * BASELINE_BATCH_SIZE)

      const second = await node.releaseSweep()
      expect(second.observedBaseline.filter((id: string) => mine.has(id))).toHaveLength(10)
      for (const f of backlog) expect((await releaseEvidence(f.escrowId)).map((e) => e.kind)).toEqual(['OBSERVED_CONFIRMED'])

      const third = await node.releaseSweep()
      expect(third.observedBaseline.filter((id: string) => mine.has(id))).toEqual([])
      expect(drained).toBe(true)
    })

    it('P — a poison escrow (explorer failing for its release) fails alone, moves behind fresh work, keeps its place across a restart, and is still retried within the queue\'s bound', async () => {
      requirePostgres('release P')
      const a = startNode()
      const drained = await observeLeftoverBaselines(a)
      const poison = await settledEscrow('P-poison')
      const neighbours: ReleaseFixture[] = []
      for (let i = 0; i < 3; i++) {
        const f = await settledEscrow(`P-neighbour-${i}`)
        chain.tx.set(f.txReleaseId, { confirmedAt: chain.tip - 1 })
        neighbours.push(f)
      }
      chain.tx.set(poison.txReleaseId, 'error')

      const first = await a.releaseSweep()
      expect(first.failed.some((x: any) => x.escrowId === poison.escrowId)).toBe(true)
      for (const n of neighbours) expect(first.observedBaseline).toContain(n.escrowId)
      const poisonStamp = await baselineStamp(poison.escrowId)

      // A full batch of fresh releases arrives; a restarted node serves all of them before the poison row.
      await a.shutdown()
      nodes.splice(nodes.indexOf(a), 1)
      const fresh: ReleaseFixture[] = []
      for (let i = 0; i < BASELINE_BATCH_SIZE; i++) {
        const f = await settledEscrow(`P-fresh-${i}`)
        chain.tx.set(f.txReleaseId, { confirmedAt: chain.tip - 1 })
        fresh.push(f)
      }
      const b = startNode()
      const second = await b.releaseSweep()
      for (const f of fresh) expect(second.observedBaseline).toContain(f.escrowId)
      expect(second.failed.some((x: any) => x.escrowId === poison.escrowId)).toBe(false)
      expect(poisonStamp).not.toBeNull()
      expect((await baselineStamp(poison.escrowId))!.getTime()).toBe(poisonStamp!.getTime())

      // ...and the poison row itself is retried within ceil(queue / batch) passes, not starved.
      const { total } = await baselineQueueLength()
      let retried = false
      for (let pass = 0; pass <= Math.ceil(total / BASELINE_BATCH_SIZE) && !retried; pass++) {
        retried = (await b.releaseSweep()).failed.some((x: any) => x.escrowId === poison.escrowId)
      }
      expect(retried).toBe(true)
      expect((await baselineStamp(poison.escrowId))!.getTime()).toBeGreaterThan(poisonStamp!.getTime())
      expect(await releaseEvidence(poison.escrowId)).toHaveLength(0)
      expect(drained).toBe(true)
    })
  })
})
