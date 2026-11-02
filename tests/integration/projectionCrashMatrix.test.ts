// tests/integration/projectionCrashMatrix.test.ts
//
// Issue #253 - crash/recovery matrix for the downstream projections of a settlement transition, on real
// PostgreSQL. Three properties, each with a counterexample that is reproducible on the code as it stood:
//
//   M. CRASH AT EVERY EFFECT BOUNDARY. For RELEASE (plain / ruled + vouch burn), REFUND (plain / ruled +
//      vouch burn), SPLIT and DISPUTED, the handler is made to die at each successive boundary (before every
//      projection claim, every Intent transition and every derived notification). After PASS 3 recovery the
//      observable state - counters, fee floor, reputation, vouch burn, disputeCount, Trade, Intent, the number
//      of durable derived notifications and the projection claims - must equal an uninterrupted run EXACTLY.
//      "Equal to the clean run" is what excludes both a lost effect and a duplicated one.
//
//   G1. Ruling finalization (arbiter bookkeeping) has a recovery mechanism that something actually runs:
//       the periodic settlement reconciler must re-drive a RESOLVED dispute whose finalization never committed.
//
//   G3. Trade.escrowId is projected from a NON-durable 'settlement.escrow.created' consumer. A crash between
//       the Escrow insert and that consumer must still converge from the authoritative Escrow row.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Kind = 'RELEASE_CLEAN' | 'RELEASE_RULED' | 'REFUND_CLEAN' | 'REFUND_RULED' | 'SPLIT' | 'DISPUTED'

const SCENARIOS: Record<Kind, { from: string; to: string; eventName: string; escrowStatus: string; ruling?: 'RELEASE' | 'REFUND' }> = {
  RELEASE_CLEAN: { from: 'PAYMENT_PENDING', to: 'COMPLETED', eventName: 'settlement.escrow.released', escrowStatus: 'COMPLETED' },
  RELEASE_RULED: { from: 'DISPUTED', to: 'COMPLETED', eventName: 'settlement.escrow.released', escrowStatus: 'COMPLETED', ruling: 'RELEASE' },
  REFUND_CLEAN: { from: 'FUNDS_LOCKED', to: 'REFUNDED', eventName: 'settlement.escrow.refunded', escrowStatus: 'REFUNDED' },
  REFUND_RULED: { from: 'DISPUTED', to: 'REFUNDED', eventName: 'settlement.escrow.refunded', escrowStatus: 'REFUNDED', ruling: 'REFUND' },
  SPLIT: { from: 'DISPUTED', to: 'SPLIT', eventName: 'settlement.escrow.split', escrowStatus: 'SPLIT' },
  DISPUTED: { from: 'FUNDS_LOCKED', to: 'DISPUTED', eventName: 'settlement.escrow.disputed', escrowStatus: 'DISPUTED' },
}

// Derived notifications whose publication must be recoverable too (a lost one is a lost effect).
const NOTIFICATIONS = new Set(['reputation.score.updated', 'reputation.vouch.burned', 'openp2p.trade.completed', 'openp2p.trade.disputed', 'arbiter.slashed'])

describe('Issue #253 - projection crash/recovery matrix (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: any
  let eventProjection: any
  let intentEngine: any
  let emitEscrowTransition: any
  let reconcileIncompleteProjections: any
  let reconcilePendingSettlements: any
  let liquidityRouter: any
  let tradeService: any

  // One counter of "boundaries" crossed by the handler under test; the Nth one throws when armed.
  const gate = { armed: -1, seen: 0, crashed: false, label: '' }
  function cross(label: string): void {
    const n = gate.seen++
    if (gate.armed === n) {
      gate.crashed = true
      gate.label = label
      throw new Error(`SIMULATED_CRASH before boundary #${n} (${label})`)
    }
  }
  const resetGate = (armed: number) => { gate.armed = armed; gate.seen = 0; gate.crashed = false; gate.label = '' }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    eventProjection = require('../../src/common/events/event-projection')
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ reconcileIncompleteProjections, reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()

    const realApply = eventProjection.applyEventProjectionOnce
    jest.spyOn(eventProjection, 'applyEventProjectionOnce').mockImplementation((async (...args: unknown[]) => {
      cross(`claim:${String(args[1])}`)
      return realApply(...args)
    }) as never)
    const realTransition = intentEngine.transition.bind(intentEngine)
    jest.spyOn(intentEngine, 'transition').mockImplementation((async (...args: unknown[]) => {
      cross(`intent:${String(args[1])}`)
      return realTransition(...args)
    }) as never)
    const realEmit = eventBus.emit.bind(eventBus)
    jest.spyOn(eventBus, 'emit').mockImplementation((async (...args: unknown[]) => {
      if (NOTIFICATIONS.has(String(args[0]))) cross(`notify:${String(args[0])}`)
      return realEmit(...args)
    }) as never)
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  async function waitFor(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(25)
    }
    throw new Error('timed out waiting for condition')
  }
  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), reputationScore: 10, totalTrades: 5 } })

  async function build(kind: Kind) {
    const spec = SCENARIOS[kind]
    const [seller, buyer, voucher] = await Promise.all([user(), user(), user()])
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MOCK', status: spec.escrowStatus as never, lockedAmount: '0.001', asset: 'BTC', ...(kind === 'RELEASE_CLEAN' || kind === 'RELEASE_RULED' ? { feeCharged: '0.00001' } : {}) },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    if (spec.ruling) {
      await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'matrix', status: 'RESOLVED', ruling: spec.ruling, arbiterId: 'k6-test-arbiter', resolvedAt: new Date() } })
      // the loser of the ruling is the one whose active vouch is burned
      await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: spec.ruling === 'RELEASE' ? seller.id : buyer.id } })
    }
    return { kind, spec, tradeId: trade.id, intentId: trade.intentId as string | null, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id, voucherId: voucher.id }
  }

  async function snapshot(s: Awaited<ReturnType<typeof build>>) {
    const u = async (id: string) => {
      const r = (await prisma.user.findUnique({ where: { id } }))!
      return { trades: r.totalTrades, volume: Number(r.totalVolumeBtc), fees: Number(r.cumulativeFeesObserved), rep: r.reputationScore, disputes: r.disputeCount }
    }
    const trade = (await prisma.trade.findUnique({ where: { id: s.tradeId } }))!
    const intent = s.intentId ? await prisma.intent.findUnique({ where: { id: s.intentId } }) : null
    const vouches = await prisma.vouch.findMany({ where: { voucherId: s.voucherId } })
    const durable = await prisma.durableEventRecord.findMany({ where: { correlationId: { in: [s.tradeId, s.voucherId, s.sellerId, s.buyerId] } }, select: { id: true, eventName: true } })
    const transition = await prisma.escrowEvent.findFirst({ where: { escrowId: s.escrowId, toStatus: s.spec.to as never } })
    const claims = await prisma.eventProjectionClaim.findMany({ where: { OR: [{ eventId: { in: durable.map((d) => d.id) } }, { eventId: transition?.id ?? 'none' }] } })
    const count = (rows: string[]) => rows.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {})
    return {
      buyer: await u(s.buyerId), seller: await u(s.sellerId), voucher: await u(s.voucherId),
      trade: { status: trade.status, stamped: !!(trade.completedAt || trade.cancelledAt) },
      intent: intent?.status ?? null,
      vouchBurned: vouches.map((v) => !!v.burnedAt),
      durableEvents: count(durable.map((d) => d.eventName)),
      claims: count(claims.map((c) => c.projectionKey)),
    }
  }

  async function run(kind: Kind, armed: number) {
    const s = await build(kind)
    resetGate(armed)
    await emitEscrowTransition(s.escrowId, s.tradeId, s.spec.from, s.spec.to, s.sellerId, s.spec.eventName, {})
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: s.escrowId, toStatus: s.spec.to as never } }))!
    const projected = async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) > 0
    await waitFor(async () => gate.crashed || (await projected()))
    const boundaries = gate.seen
    const crashedAt = gate.crashed ? gate.label : null
    resetGate(-1)
    if (crashedAt) {
      // the process "restarted": PASS 3 re-drives the claimed-but-unprojected transition
      const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
      await reconcileIncompleteProjections(report, 0)
      expect(report.failed).toEqual([])
      await waitFor(projected)
      await sleep(100)
    } else {
      await sleep(100)
    }
    return { snap: await snapshot(s), boundaries, crashedAt }
  }

  for (const kind of Object.keys(SCENARIOS) as Kind[]) {
    it(`M ${kind}: a crash before EVERY boundary of the handler converges to exactly the uninterrupted state`, async () => {
      pg.requirePostgres(`matrix ${kind}`)
      const clean = await run(kind, -1)
      expect(clean.crashedAt).toBeNull()
      expect(clean.boundaries).toBeGreaterThan(1)
      expect(clean.snap.claims['transition.projected']).toBe(1)

      const failures: string[] = []
      for (let k = 0; k < clean.boundaries; k++) {
        const crashed = await run(kind, k)
        if (!crashed.crashedAt) { failures.push(`#${k}: expected a crash but none happened`); continue }
        try {
          expect(crashed.snap).toEqual(clean.snap)
        } catch (err) {
          failures.push(`crash before #${k} (${crashed.crashedAt}): ${(err as Error).message.split('\n').slice(0, 24).join('\n')}`)
        }
      }
      expect(failures).toEqual([])
    })
  }

  it('G1: the periodic settlement reconciler re-drives a RESOLVED dispute whose ruling finalization never committed', async () => {
    pg.requirePostgres('G1 wiring')
    const s = await build('RELEASE_RULED')
    const dispute = (await prisma.dispute.findFirst({ where: { tradeId: s.tradeId } }))!
    const claims = () => prisma.eventProjectionClaim.count({ where: { eventId: dispute.id, projectionKey: 'dispute.ruling-finalized', subjectId: '0' } })
    expect(await claims()).toBe(0) // crash: the RESOLVED write committed, the finalization did not

    await reconcilePendingSettlements()
    expect(await claims()).toBe(1)
    await reconcilePendingSettlements() // idempotent
    expect(await claims()).toBe(1)
  })

  it('G3: Trade.escrowId is converged from the authoritative Escrow row when the non-durable created consumer never ran', async () => {
    pg.requirePostgres('G3 escrowId')
    const s = await build('DISPUTED')
    await prisma.trade.update({ where: { id: s.tradeId }, data: { escrowId: null } }) // crash: Escrow committed, 'created' consumer never ran
    expect((await prisma.trade.findUnique({ where: { id: s.tradeId } }))!.escrowId).toBeNull()

    resetGate(-1)
    await emitEscrowTransition(s.escrowId, s.tradeId, 'FUNDS_LOCKED', 'DISPUTED', s.sellerId, 'settlement.escrow.disputed', {})
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: s.escrowId, toStatus: 'DISPUTED' } }))!
    await waitFor(async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) > 0)
    expect((await prisma.trade.findUnique({ where: { id: s.tradeId } }))!.escrowId).toBe(s.escrowId)
  })
})
