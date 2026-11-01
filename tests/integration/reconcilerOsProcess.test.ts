// tests/integration/reconcilerOsProcess.test.ts
//
// Issue #253 - the residual limitation the independent audit named: recovery proven only inside ONE OS process.
// Here every reconciler is a separate OS process with no Redis fanout, killed abruptly (SIGKILL) at effect boundaries,
// against real PostgreSQL. The authoritative economic counters must equal the arithmetic of the seeded trades exactly:
// one shared buyer makes any lost or doubled effect visible in a single number.
//
// Notifications are at-least-once by design, so they are asserted separately from the economic state: a kill inside
// the claim transaction may repeat one, and must never repeat the effect it reports.

import { spawn } from 'child_process'
import path from 'path'
import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const ROOT = path.resolve(__dirname, '..', '..')
const WORKER = path.join(__dirname, 'reconcilerProcess.worker.ts')
const CLOSED_REDIS_PORT = 'redis://127.0.0.1:1'
const AMOUNT = 0.001
const FEE = 0.00001

type Kind = 'RELEASE_RULED' | 'REFUND_CLEAN' | 'SPLIT'
const CYCLE: Kind[] = ['RELEASE_RULED', 'REFUND_CLEAN', 'SPLIT']
const SPEC = {
  RELEASE_RULED: { from: 'DISPUTED', to: 'COMPLETED', eventName: 'settlement.escrow.released' },
  REFUND_CLEAN: { from: 'FUNDS_LOCKED', to: 'REFUNDED', eventName: 'settlement.escrow.refunded' },
  SPLIT: { from: 'DISPUTED', to: 'SPLIT', eventName: 'settlement.escrow.split' },
} as const

interface Seeded { kind: Kind; tradeId: string; escrowId: string; sellerId: string; voucherId: string | null; transitionId: string; published: boolean }
interface WorkerResult { code: number | null; signal: NodeJS.Signals | null; stderr: string; txTimeouts: number }

describe('Issue #253 - independent OS-process reconcilers, Redis off, SIGKILL (real PostgreSQL)', () => {
  jest.setTimeout(420_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: any
  let liquidityRouter: any
  let tradeService: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    // Deliberately no registerEventHandlers(): the only consumers of these transitions live in the workers.
  })

  afterAll(async () => {
    if (dbAvailable) {
      // A killed worker can leave an Intent publication owed; pay it so no other suite inherits it.
      const { recoverUnpublishedIntentEvents } = require('../../src/core/intent-publication-recovery')
      expect((await recoverUnpublishedIntentEvents({ graceMs: 0 })).failed).toEqual([])
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const user = (data: Record<string, unknown> = {}) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), ...data } })

  /** Half of the transitions were never published (crash after the claim), half were published and never projected. */
  async function seed(buyerId: string, n: number): Promise<Seeded[]> {
    const seeded: Seeded[] = []
    for (let i = 0; i < n; i++) {
      const kind = CYCLE[i % CYCLE.length]
      const spec = SPEC[kind]
      const seller = await user()
      const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: String(AMOUNT), maxAmount: String(AMOUNT), paymentMethod: 'OTHER' })
      const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyerId, amount: String(AMOUNT) })
      const escrow = await prisma.escrow.create({
        data: { tradeId: trade.id, type: 'MOCK', status: spec.to as never, lockedAmount: String(AMOUNT), asset: 'BTC', txReleaseId: randomBytes(32).toString('hex'), ...(kind === 'RELEASE_RULED' ? { feeCharged: String(FEE) } : {}) },
      })
      await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
      let voucherId: string | null = null
      if (kind === 'RELEASE_RULED') {
        const voucher = await user({ reputationScore: 10, totalTrades: 5 })
        voucherId = voucher.id
        await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyerId, reason: 'os-process', status: 'RESOLVED', ruling: 'RELEASE', arbiterId: 'k6-test-arbiter', resolvedAt: new Date() } })
        await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: seller.id } })
      }
      const transition = await prisma.escrowEvent.create({
        data: { escrowId: escrow.id, fromStatus: spec.from as never, toStatus: spec.to as never, triggeredBy: seller.id, entryHash: randomBytes(16).toString('hex'), prevHash: 'genesis' },
      })
      await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: escrow.id, appliedAt: new Date(Date.now() - 600_000) } })
      const published = i % 2 === 1
      if (published) {
        // Twice: a live publish overlapping PASS 3 leaves two durable eventIds for one source transition.
        for (let copy = 0; copy < 2; copy++) await eventBus.emit(spec.eventName, { escrowId: escrow.id, tradeId: trade.id, from: spec.from, to: spec.to, triggeredBy: seller.id, transitionId: transition.id }, trade.id)
      }
      seeded.push({ kind, tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, voucherId, transitionId: transition.id, published })
    }
    return seeded
  }

  function worker(transitionIds: string[], env: Record<string, string> = {}): Promise<WorkerResult> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      cwd: ROOT,
      env: { ...process.env, REDIS_URL: CLOSED_REDIS_PORT, TRANSITION_IDS: JSON.stringify(transitionIds), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000) })
    let txTimeouts = 0
    child.stdout.on('data', (d: Buffer) => { txTimeouts += d.toString().match(/Transaction API error|P2028|Transaction not found|Unable to start a transaction/g)?.length ?? 0 })
    return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr, txTimeouts })))
  }
  const wasKilled = (r: WorkerResult) => r.stderr.includes('SIGKILL_MARKER') && r.code !== 0

  async function expectExactEconomicState(buyerId: string, seeded: Seeded[], label: string) {
    const counted = seeded.filter((s) => s.kind !== 'REFUND_CLEAN')
    const fees = seeded.filter((s) => s.kind === 'RELEASE_RULED')
    const expectedBuyerScore = fees.length * 2 // RELEASE ruling won (+2); REFUND/SPLIT are neutral
    const buyer = (await prisma.user.findUnique({ where: { id: buyerId } }))!
    const durable = await prisma.durableEventRecord.groupBy({ by: ['eventName'], where: { correlationId: { in: seeded.map((s) => s.tradeId) } }, _count: { _all: true } })
    const summary = { label, trades: buyer.totalTrades, volume: Number(buyer.totalVolumeBtc), fees: Number(buyer.cumulativeFeesObserved), rep: buyer.reputationScore, durable: Object.fromEntries(durable.map((d) => [d.eventName, d._count._all])) }
    process.stdout.write(`[evidence] ${JSON.stringify(summary)}\n`)

    expect(buyer.totalTrades).toBe(counted.length)
    expect(Number(buyer.totalVolumeBtc)).toBeCloseTo(counted.length * AMOUNT, 8)
    expect(Number(buyer.cumulativeFeesObserved)).toBeCloseTo(fees.length * FEE, 8)
    expect(buyer.reputationScore).toBe(expectedBuyerScore)

    for (const s of seeded) {
      const seller = (await prisma.user.findUnique({ where: { id: s.sellerId } }))!
      const trade = (await prisma.trade.findUnique({ where: { id: s.tradeId } }))!
      expect(trade.status).toBe(s.kind === 'REFUND_CLEAN' ? 'CANCELLED' : 'COMPLETED')
      expect(seller.totalTrades).toBe(s.kind === 'REFUND_CLEAN' ? 0 : 1)
      expect(seller.reputationScore).toBe(s.kind === 'RELEASE_RULED' ? -5 : 0)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: s.transitionId, projectionKey: 'trade.status' } })).toBe(1)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: s.transitionId, projectionKey: 'transition.projected' } })).toBe(1)
      if (s.voucherId) {
        const voucher = (await prisma.user.findUnique({ where: { id: s.voucherId } }))!
        const vouches = await prisma.vouch.findMany({ where: { voucherId: s.voucherId } })
        expect(voucher.reputationScore).toBe(5)
        expect(vouches.every((v) => v.burnedAt !== null)).toBe(true)
      }
    }
  }

  async function scenario(label: string, n: number, runs: (ids: string[]) => Promise<WorkerResult[]>) {
    const buyer = await user()
    const seeded = await seed(buyer.id, n)
    const results = await runs(seeded.map((s) => s.transitionId))
    await expectExactEconomicState(buyer.id, seeded, label)
    return { buyer, seeded, results }
  }

  it('O1 two independent processes reconcile the same backlog at once with Redis unreachable: one exact economic state', async () => {
    pg.requirePostgres('O1')
    const { results } = await scenario('O1', 12, (ids) => Promise.all([worker(ids), worker(ids)]))
    for (const r of results) expect(r).toMatchObject({ code: 0 })
  })

  it('O2 one process is SIGKILLed mid-backlog with an effect transaction open while another keeps running; a restart changes nothing', async () => {
    pg.requirePostgres('O2')
    const { results } = await scenario('O2', 12, async (ids) => {
      const [victim, survivor] = await Promise.all([worker(ids, { KILL_AT: 'trade.completion-counters:1:inside', KILL_HOLD_MS: '3000' }), worker(ids, { WORKER_START_DELAY_MS: '1500' })])
      return [victim, survivor, await worker(ids)]
    })
    expect(wasKilled(results[0])).toBe(true)
    expect(results[1]).toMatchObject({ code: 0 })
    expect(results[2]).toMatchObject({ code: 0 })
  })

  for (const [key, phase] of [['reputation.outcome', 'inside'], ['reputation.vouch-burn', 'inside'], ['trade.completion-counters', 'after'], ['fee-floor', 'after'], ['transition.projected', 'before']] as const) {
    it(`O3 sole process SIGKILLed at ${key}/${phase}: a fresh process recovers the exact economic state`, async () => {
      pg.requirePostgres(`O3 ${key}`)
      const { results } = await scenario(`O3 ${key}/${phase}`, 3, async (ids) => [await worker(ids, { KILL_AT: `${key}:1:${phase}` }), await worker(ids)])
      expect(wasKilled(results[0])).toBe(true)
      expect(results[1]).toMatchObject({ code: 0 })
    })
  }

  it('O4 a kill inside the notification window may repeat the notification, never the score it reports', async () => {
    pg.requirePostgres('O4')
    const { buyer, seeded, results } = await scenario('O4', 1, async (ids) => [await worker(ids, { KILL_AT: 'reputation.outcome:1:inside' }), await worker(ids)])
    expect(wasKilled(results[0])).toBe(true)
    const updates = await prisma.durableEventRecord.findMany({ where: { correlationId: seeded[0].tradeId, eventName: 'reputation.score.updated' } })
    const forBuyer = updates.filter((u) => (u.payload as { userId?: string }).userId === buyer.id)
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O4 notifications for one effect', count: forBuyer.length })}\n`)
    expect(forBuyer.length).toBeGreaterThanOrEqual(1)
    expect(new Set(forBuyer.map((u) => (u.payload as { newScore?: number }).newScore)).size).toBe(1)
  })

  it('O5 a starved connection pool may stall recovery, but never doubles an effect, and a healthy process then converges exactly', async () => {
    pg.requirePostgres('O5')
    // An effect transaction holds one connection and needs another to publish its notification inside it, so a pool
    // of 2 can stall. Whether these two finish in time is not the property: the state they leave behind is.
    const { results } = await scenario('O5', 15, async (ids) => {
      const starved = await Promise.all([worker(ids, { POOL_MAX: '2', WORKER_DEADLINE_MS: '30000' }), worker(ids, { POOL_MAX: '2', WORKER_DEADLINE_MS: '30000' })])
      return [...starved, await worker(ids)]
    })
    for (const r of results.slice(0, 2)) expect(r.stderr).toContain('POOL_MAX_APPLIED 2')
    expect(results[2]).toMatchObject({ code: 0 })
  })
})
