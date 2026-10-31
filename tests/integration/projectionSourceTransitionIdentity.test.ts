// tests/integration/projectionSourceTransitionIdentity.test.ts
//
// Issue #253 (CTO decision, 2026-10-31) - on real PostgreSQL. One escrow transition can produce TWO durable events:
// PASS 3 republishes while a live publish is still in flight, and each gets its own eventId. An economic effect is
// therefore keyed on the SOURCE TRANSITION (plus effect and participant), not on the durable eventId, while both
// durable events stay in the stream for traceability.
//
// "Equal to an uninterrupted run, except for the one extra durable event" is what excludes a repeated effect on
// totalTrades, volume, fee floor, reputation, vouch and disputeCount, and on the derived notifications.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
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
const ALL = Object.keys(SCENARIOS) as Kind[]
const NOTIFICATIONS = new Set(['reputation.score.updated', 'reputation.vouch.burned', 'openp2p.trade.completed', 'openp2p.trade.disputed'])

describe('Issue #253 - economic effects keyed on the source transition (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: any
  let emitEscrowTransition: any
  let reconcileIncompleteProjections: any
  let liquidityRouter: any
  let tradeService: any
  let instanceB: { eventBus: any; prisma: PrismaClient; redis: any } | undefined

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
  // One live publish held open; every other emit passes through.
  const hold = { eventName: '', entered: false, release: () => {}, gate: Promise.resolve() }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    const eventProjection = require('../../src/common/events/event-projection')
    const { intentEngine } = require('../../src/core/intent-engine')
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = {
        eventBus: require('../../src/common/events/event-bus').eventBus,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })

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
      if (args[0] === hold.eventName) {
        hold.eventName = ''
        hold.entered = true
        await hold.gate
      }
      if (NOTIFICATIONS.has(String(args[0]))) cross(`notify:${String(args[0])}`)
      return realEmit(...args)
    }) as never)
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    if (dbAvailable) {
      await prisma.$disconnect()
      if (instanceB) {
        await instanceB.prisma.$disconnect()
        await instanceB.redis.quit().catch(() => {})
      }
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
      await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'duplicate', status: 'RESOLVED', ruling: spec.ruling, arbiterId: 'k6-test-arbiter', resolvedAt: new Date() } })
      await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: spec.ruling === 'RELEASE' ? seller.id : buyer.id } })
    }
    return { kind, spec, tradeId: trade.id, intentId: trade.intentId as string | null, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id, voucherId: voucher.id }
  }
  type Scenario = Awaited<ReturnType<typeof build>>

  const transitionOf = async (s: Scenario) => (await prisma.escrowEvent.findFirst({ where: { escrowId: s.escrowId, toStatus: s.spec.to as never } }))!
  const projected = (transitionId: string) => async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0
  const durableOf = (s: Scenario) => prisma.durableEventRecord.findMany({ where: { correlationId: s.tradeId, eventName: s.spec.eventName }, orderBy: { publishedAt: 'asc' } })

  // Every observable effect. The settlement event's own durable count is reported apart: it is the one thing allowed to differ.
  async function snapshot(s: Scenario) {
    const u = async (id: string) => {
      const r = (await prisma.user.findUnique({ where: { id } }))!
      return { trades: r.totalTrades, volume: Number(r.totalVolumeBtc), fees: Number(r.cumulativeFeesObserved), rep: r.reputationScore, disputes: r.disputeCount }
    }
    const trade = (await prisma.trade.findUnique({ where: { id: s.tradeId } }))!
    const intent = s.intentId ? await prisma.intent.findUnique({ where: { id: s.intentId } }) : null
    const vouches = await prisma.vouch.findMany({ where: { voucherId: s.voucherId } })
    const durable = await prisma.durableEventRecord.findMany({ where: { correlationId: { in: [s.tradeId, s.voucherId, s.sellerId, s.buyerId] } }, select: { eventName: true } })
    const derived = durable.filter((d) => d.eventName !== s.spec.eventName).map((d) => d.eventName)
    return {
      buyer: await u(s.buyerId), seller: await u(s.sellerId), voucher: await u(s.voucherId),
      trade: { status: trade.status, stamped: !!(trade.completedAt || trade.cancelledAt) },
      intent: intent?.status ?? null,
      vouchBurned: vouches.map((v) => !!v.burnedAt),
      derivedEvents: derived.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}),
    }
  }

  async function runClean(kind: Kind) {
    resetGate(-1)
    const s = await build(kind)
    await emitEscrowTransition(s.escrowId, s.tradeId, s.spec.from, s.spec.to, s.sellerId, s.spec.eventName, {})
    await waitFor(projected((await transitionOf(s)).id))
    await sleep(100)
    return { s, snap: await snapshot(s) }
  }

  describe('a second durable event of the same transition', () => {
    for (const kind of ALL) {
      it(`${kind}: replay with a NEW eventId repeats no effect`, async () => {
        pg.requirePostgres(`replay ${kind}`)
        const clean = await runClean(kind)

        const { s } = await runClean(kind)
        const [first] = await durableOf(s)
        await eventBus.emit(s.spec.eventName, first.payload, s.tradeId)
        await sleep(500)

        const events = await durableOf(s)
        expect(new Set(events.map((e) => e.id)).size).toBe(2) // both stay in the stream, traceable
        expect(new Set(events.map((e) => (e.payload as any).transitionId)).size).toBe(1)
        expect(await snapshot(s)).toEqual(clean.snap)
      })
    }

    for (const kind of ['SPLIT', 'RELEASE_CLEAN', 'RELEASE_RULED', 'REFUND_CLEAN', 'REFUND_RULED'] as Kind[]) {
      it(`${kind}: a live publish overlapping PASS 3 applies every effect once`, async () => {
        pg.requirePostgres(`overlap ${kind}`)
        const clean = await runClean(kind)

        const s = await build(kind)
        hold.eventName = s.spec.eventName
        hold.entered = false
        hold.gate = new Promise((r) => { hold.release = () => r(undefined) })
        const live = emitEscrowTransition(s.escrowId, s.tradeId, s.spec.from, s.spec.to, s.sellerId, s.spec.eventName, {})
        await waitFor(() => hold.entered)

        const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
        await reconcileIncompleteProjections(report, 0) // grace 0 stands for a publish stalled past the real grace
        expect(report.failed).toEqual([])
        expect(report.projectionsRecovered.map((p: any) => p.action)).toContain('REPUBLISHED')

        hold.release()
        await live
        await sleep(500)

        expect(await durableOf(s)).toHaveLength(2)
        expect(await snapshot(s)).toEqual(clean.snap)
      })
    }
  })

  for (const kind of ['RELEASE_RULED', 'REFUND_RULED', 'SPLIT'] as Kind[]) {
    it(`${kind}: a crash at EVERY boundary, finished by a second eventId, equals the uninterrupted run`, async () => {
      pg.requirePostgres(`crash ${kind}`)
      resetGate(-1)
      const clean = await runClean(kind)
      const probe = await build(kind)
      resetGate(-1)
      await emitEscrowTransition(probe.escrowId, probe.tradeId, probe.spec.from, probe.spec.to, probe.sellerId, probe.spec.eventName, {})
      await waitFor(projected((await transitionOf(probe)).id))
      const boundaries = gate.seen
      expect(boundaries).toBeGreaterThan(1)

      const failures: string[] = []
      for (let k = 0; k < boundaries; k++) {
        const s = await build(kind)
        resetGate(k)
        await emitEscrowTransition(s.escrowId, s.tradeId, s.spec.from, s.spec.to, s.sellerId, s.spec.eventName, {})
        await waitFor(() => gate.crashed)
        const label = gate.label
        resetGate(-1)
        const [first] = await durableOf(s)
        await eventBus.emit(s.spec.eventName, first.payload, s.tradeId)
        await waitFor(projected((await transitionOf(s)).id))
        await sleep(100)
        try {
          expect(await snapshot(s)).toEqual(clean.snap)
        } catch (err) {
          failures.push(`#${k} (${label}): ${(err as Error).message.split('\n').slice(0, 20).join('\n')}`)
        }
      }
      expect(failures).toEqual([])
    })
  }

  it('N concurrent durable events of one transition, on two instances, apply each effect once', async () => {
    pg.requirePostgres('concurrent duplicates')
    const clean = await runClean('RELEASE_RULED')

    const { s } = await runClean('RELEASE_RULED')
    const [first] = await durableOf(s)
    await Promise.all([
      eventBus.emit(s.spec.eventName, first.payload, s.tradeId),
      instanceB!.eventBus.emit(s.spec.eventName, first.payload, s.tradeId),
      eventBus.emit(s.spec.eventName, first.payload, s.tradeId),
      instanceB!.eventBus.emit(s.spec.eventName, first.payload, s.tradeId),
    ])
    await sleep(800)
    expect(await durableOf(s)).toHaveLength(5)
    expect(await snapshot(s)).toEqual(clean.snap)
  })

  it('restart: an independent module graph receiving the duplicate repeats nothing', async () => {
    pg.requirePostgres('restart duplicate')
    const clean = await runClean('SPLIT')

    const { s } = await runClean('SPLIT')
    const [first] = await durableOf(s)
    await instanceB!.eventBus.emit(s.spec.eventName, first.payload, s.tradeId)
    await sleep(500)
    expect(await snapshot(s)).toEqual(clean.snap)
  })

  it('genuinely distinct transitions still each apply their own effects', async () => {
    pg.requirePostgres('distinct transitions')
    resetGate(-1)
    const s = await build('RELEASE_RULED')
    const before = (await prisma.user.findUnique({ where: { id: s.buyerId } }))!

    await emitEscrowTransition(s.escrowId, s.tradeId, 'FUNDS_LOCKED', 'DISPUTED', s.sellerId, 'settlement.escrow.disputed', {})
    const disputed = (await prisma.escrowEvent.findFirst({ where: { escrowId: s.escrowId, toStatus: 'DISPUTED' } }))!
    await waitFor(projected(disputed.id))
    await emitEscrowTransition(s.escrowId, s.tradeId, 'DISPUTED', 'COMPLETED', s.sellerId, 'settlement.escrow.released', {})
    await waitFor(projected((await transitionOf(s)).id))

    // a second, separate trade between the same two users
    const offer = await liquidityRouter.createOffer({ userId: s.sellerId, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade2 = await tradeService.createTrade({ offerId: offer.id, counterpartyId: s.buyerId, amount: '0.001' })
    const escrow2 = await prisma.escrow.create({ data: { tradeId: trade2.id, type: 'MOCK', status: 'COMPLETED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade2.id }, data: { escrowId: escrow2.id, status: 'ACTIVE' } })
    await emitEscrowTransition(escrow2.id, trade2.id, 'PAYMENT_PENDING', 'COMPLETED', s.sellerId, 'settlement.escrow.released', {})
    await waitFor(projected((await prisma.escrowEvent.findFirst({ where: { escrowId: escrow2.id, toStatus: 'COMPLETED' } }))!.id))
    await sleep(100)

    const after = (await prisma.user.findUnique({ where: { id: s.buyerId } }))!
    expect(after.disputeCount).toBe(before.disputeCount + 1)
    expect(after.totalTrades).toBe(before.totalTrades + 2)
    expect(Number(after.totalVolumeBtc)).toBeCloseTo(Number(before.totalVolumeBtc) + 0.002, 8)
    expect(Number(after.cumulativeFeesObserved)).toBeCloseTo(Number(before.cumulativeFeesObserved) + 0.00001, 8)
  })

  it('compatibility: claims recorded per durable event are re-keyed by the migration, so redelivery repeats nothing', async () => {
    pg.requirePostgres('claim re-key migration')
    const { s, snap } = await runClean('RELEASE_CLEAN')
    const transition = await transitionOf(s)
    const [first] = await durableOf(s)
    await eventBus.emit(s.spec.eventName, first.payload, s.tradeId)
    await sleep(300)
    const second = (await durableOf(s))[1]
    // the shape the previous code left: same effect claimed under each durable event id
    const keys = ['trade.status', 'trade.completion-counters', 'fee-floor']
    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: transition.id, projectionKey: { in: keys } } })
    for (const projectionKey of keys) {
      await prisma.eventProjectionClaim.createMany({ data: [{ eventId: first.id, projectionKey, subjectId: s.tradeId }, { eventId: second.id, projectionKey, subjectId: s.tradeId }] })
    }

    const dir = join(__dirname, '../../prisma/migrations/20261031110000_projection_claims_source_transition/migration.sql')
    await prisma.$executeRawUnsafe(readFileSync(dir, 'utf8'))
    await prisma.$executeRawUnsafe(readFileSync(dir, 'utf8')) // re-running is harmless

    expect(await prisma.eventProjectionClaim.count({ where: { eventId: { in: [first.id, second.id] } } })).toBe(0)
    for (const projectionKey of keys) {
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: transition.id, projectionKey, subjectId: s.tradeId } })).toBe(1)
    }

    await eventBus.redeliver(first.id)
    await sleep(400)
    expect(await snapshot(s)).toEqual(snap)
  })
})
