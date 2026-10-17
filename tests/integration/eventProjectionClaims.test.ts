// tests/integration/eventProjectionClaims.test.ts
//
// Issue #298 - real PostgreSQL proof that a durable settlement event converges
// each downstream projection exactly once, and that an incomplete projection is
// recoverable from authoritative persisted facts:
//   - the same durable event delivered N times / concurrently / by another
//     instance produces ONE effect per projection subject;
//   - a crash after the Trade projection but before counters/reputation is
//     completed by redelivery without redoing what already committed;
//   - a stale event (N arrives after N+1) regresses nothing and duplicates nothing;
//   - claim (EscrowEvent) != publish (durable event) != projection applied:
//     "claimed but never published" and "published but not projected" are both
//     recovered, and concurrent recovery workers cannot mint two delivery
//     identities for one transition.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #298 - durable event projections are replay-safe (real PostgreSQL)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition
  let reconcileIncompleteProjections: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections
  let applyEventProjectionOnce: typeof import('../../src/common/events/event-projection').applyEventProjectionOnce
  let tradeRepository: typeof import('../../src/modules/open-p2p/trade-repository').tradeRepository
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  // A second, independent "instance": its own module registry => own Prisma pool, own event bus, own handlers.
  let instanceB: { eventBus: typeof eventBus; prisma: PrismaClient; redis: { quit(): Promise<unknown> }; reconcileIncompleteProjections: typeof reconcileIncompleteProjections } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ applyEventProjectionOnce } = require('../../src/common/events/event-projection'))
    ;({ tradeRepository } = require('../../src/modules/open-p2p/trade-repository'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()

    jest.isolateModules(() => {
      const b = require('../../src/common/events/event-bus')
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = { eventBus: b.eventBus, prisma: require('../../src/common/database').prisma, redis: require('../../src/common/redis').redis, reconcileIncompleteProjections: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections }
    })
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      if (instanceB) {
        await instanceB.prisma.$disconnect()
        await instanceB.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function makeCompletedEscrow(status: 'COMPLETED' | 'REFUNDED' | 'SPLIT' | 'FUNDS_LOCKED' = 'COMPLETED') {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status, lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }

  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })
  const tradeOf = (id: string) => prisma.trade.findUnique({ where: { id } })
  const claimCount = (eventId: string, key: string) => prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: key } })

  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }
  const projectedCount = (transitionId: string) => prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })
  const projected = (transitionId: string) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0

  // Real emitEscrowTransition(): claims the EscrowEvent + 'transition.claimed' marker, then publishes.
  async function emitReleased(ctx: { tradeId: string; escrowId: string; sellerId: string }) {
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: `tx-${randomUUID()}` })
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'COMPLETED' } }))!
    await waitFor(projected(transition.id))
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }))!
    return { transitionId: transition.id, eventId: durable.id }
  }

  async function expectEffectsAppliedOnce(ctx: { buyerId: string; sellerId: string; tradeId: string }) {
    const [buyer, seller, trade] = await Promise.all([userOf(ctx.buyerId), userOf(ctx.sellerId), tradeOf(ctx.tradeId)])
    expect(trade!.status).toBe('COMPLETED')
    expect(buyer!.totalTrades).toBe(1)
    expect(seller!.totalTrades).toBe(1)
    expect(Number(buyer!.totalVolumeBtc)).toBeCloseTo(0.001, 8)
    expect(Number(seller!.totalVolumeBtc)).toBeCloseTo(0.001, 8)
    expect(buyer!.reputationScore).toBe(2)
    expect(seller!.reputationScore).toBe(2)
  }

  it('x10: the SAME durable event delivered 10 times concurrently -> Trade effect once, counters once, reputation once', async () => {
    requirePostgres('x10 same event')
    const ctx = await makeCompletedEscrow()
    const { eventId, transitionId } = await emitReleased(ctx)
    await expectEffectsAppliedOnce(ctx)

    const results = await Promise.all(Array.from({ length: 10 }, () => eventBus.redeliver(eventId)))
    expect(results.every(Boolean)).toBe(true)
    await sleep(800)

    await expectEffectsAppliedOnce(ctx) // unchanged after 10 more deliveries
    expect(await claimCount(eventId, 'trade.status')).toBe(1)
    expect(await claimCount(eventId, 'trade.completion-counters')).toBe(1)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: 'reputation.outcome' } })).toBe(2) // one per participant
    expect(await claimCount(eventId, 'transition.projected')).toBe(1)
    void transitionId
  })

  it('a lost acknowledgement / repeated sequential delivery is harmless', async () => {
    requirePostgres('redelivery')
    const ctx = await makeCompletedEscrow()
    const { eventId } = await emitReleased(ctx)
    for (let i = 0; i < 3; i++) {
      await eventBus.redeliver(eventId)
      await sleep(250)
    }
    await expectEffectsAppliedOnce(ctx)
  })

  it('MULTI-INSTANCE: two independent instances (own pool, bus, handlers) receiving the same durable event converge to one effect', async () => {
    requirePostgres('multi-instance')
    expect(instanceB).toBeDefined()
    const ctx = await makeCompletedEscrow()
    const { eventId } = await emitReleased(ctx)

    await Promise.all([
      ...Array.from({ length: 5 }, () => eventBus.redeliver(eventId)),
      ...Array.from({ length: 5 }, () => instanceB!.eventBus.redeliver(eventId)),
    ])
    await sleep(1000)

    await expectEffectsAppliedOnce(ctx)
    expect(await claimCount(eventId, 'trade.completion-counters')).toBe(1)
  })

  it('PARTIAL projection crash: Trade projection committed, crash before counters/reputation -> redelivery completes ONLY what is missing, never redoes the Trade', async () => {
    requirePostgres('partial projection')
    const ctx = await makeCompletedEscrow()
    // The durable event exists (published) and a projection is owed, but only the Trade projection ran.
    const eventId = randomUUID()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h', prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    await prisma.durableEventRecord.create({
      data: {
        id: eventId, eventName: 'settlement.escrow.released', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e', prevHash: 'genesis',
      },
    })
    await applyEventProjectionOnce(eventId, 'trade.status', ctx.tradeId, async (tx) => { await tradeRepository.projectEscrowStatus(ctx.tradeId, ctx.escrowId, { tx }) })
    const completedAt = (await tradeOf(ctx.tradeId))!.completedAt!.getTime()
    expect((await userOf(ctx.buyerId))!.totalTrades).toBe(0) // crash: counters/reputation never ran

    await eventBus.redeliver(eventId)
    await waitFor(projected(transition.id))

    await expectEffectsAppliedOnce(ctx)
    expect((await tradeOf(ctx.tradeId))!.completedAt!.getTime()).toBe(completedAt) // Trade not redone / re-stamped
    expect(await claimCount(eventId, 'trade.status')).toBe(1)
  })

  it('STALE event: N+1 applied, then N arrives (a delayed locked/disputed) -> no state regression, no duplicated effect', async () => {
    requirePostgres('stale events')
    const ctx = await makeCompletedEscrow()
    await emitReleased(ctx)
    await expectEffectsAppliedOnce(ctx)

    await eventBus.emit('settlement.escrow.locked', { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId }, ctx.tradeId)
    await eventBus.emit('settlement.escrow.disputed', { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'DISPUTED', triggeredBy: ctx.buyerId }, ctx.tradeId)
    await sleep(1000)

    await expectEffectsAppliedOnce(ctx) // Trade still COMPLETED, counters/reputation unchanged
  })

  it('CLAIM WITHOUT DURABLE PUBLISH: EscrowEvent + marker exist but no durable event (crash between claim and publish) -> recovery re-publishes; projections apply once; a second pass is a no-op', async () => {
    requirePostgres('claim without publish')
    const ctx = await makeCompletedEscrow()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h', prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    expect(await prisma.durableEventRecord.count({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(0)

    const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(report, 0)
    expect(report.failed).toEqual([])
    expect(report.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([{ escrowId: ctx.escrowId, transitionId: transition.id, action: 'REPUBLISHED' }])
    await waitFor(projected(transition.id))

    await expectEffectsAppliedOnce(ctx)
    expect(await prisma.durableEventRecord.count({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1)

    const again = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(again, 0)
    expect(again.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([]) // already projected
    expect(await prisma.durableEventRecord.count({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1)
  })

  it('DURABLE EVENT WITHOUT COMPLETED PROJECTION: the event was published but the handler never finished -> recovery redelivers it; effects apply once', async () => {
    requirePostgres('event without projection')
    const ctx = await makeCompletedEscrow()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h', prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    const eventId = randomUUID()
    await prisma.durableEventRecord.create({
      data: {
        id: eventId, eventName: 'settlement.escrow.released', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e', prevHash: 'genesis',
      },
    })

    const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(report, 0)
    expect(report.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([{ escrowId: ctx.escrowId, transitionId: transition.id, action: 'REDELIVERED' }])
    await waitFor(projected(transition.id))
    await expectEffectsAppliedOnce(ctx)
    expect(await prisma.durableEventRecord.count({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1) // redelivered, NOT re-published
  })

  it('5 CONCURRENT recovery workers on a claimed-but-unpublished transition mint exactly ONE durable event (one delivery identity) and one effect', async () => {
    requirePostgres('concurrent recovery workers')
    const ctx = await makeCompletedEscrow()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h', prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })

    const reports = Array.from({ length: 5 }, () => ({ requiresManualReview: [], failed: [], projectionsRecovered: [] } as any))
    await Promise.all(reports.map((r) => reconcileIncompleteProjections(r, 0)))
    await waitFor(projected(transition.id))
    await sleep(500)

    expect(reports.flatMap((r) => r.failed)).toEqual([])
    expect(await prisma.durableEventRecord.count({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1)
    await expectEffectsAppliedOnce(ctx)
  })

  it('the projection claim primitive itself: claim + mutation are ATOMIC - a failing mutation rolls the claim back so the redelivery still applies it', async () => {
    requirePostgres('atomic claim')
    const eventId = randomUUID()
    await expect(
      applyEventProjectionOnce(eventId, 'probe', 'subject-1', async () => { throw new Error('crash before commit') })
    ).rejects.toThrow('crash before commit')
    expect(await claimCount(eventId, 'probe')).toBe(0)
    expect(await applyEventProjectionOnce(eventId, 'probe', 'subject-1', async () => {})).toBe(true)
    expect(await applyEventProjectionOnce(eventId, 'probe', 'subject-1', async () => {})).toBe(false)
    // independent subjects / keys never collide
    expect(await applyEventProjectionOnce(eventId, 'probe', 'subject-2', async () => {})).toBe(true)
    expect(await applyEventProjectionOnce(eventId, 'other-key', 'subject-1', async () => {})).toBe(true)
  })

  it('DB uniqueness: the identity (eventId, projectionKey, subjectId) is enforced by PostgreSQL itself, not by application code', async () => {
    requirePostgres('unique identity')
    const eventId = randomUUID()
    await prisma.eventProjectionClaim.create({ data: { eventId, projectionKey: 'k', subjectId: 's' } })
    await expect(prisma.eventProjectionClaim.create({ data: { eventId, projectionKey: 'k', subjectId: 's' } })).rejects.toThrow(/Unique constraint/)
  })

  // ── Hardening (PR #320 adversarial pass) ────────────────────────────────────────────────────────

  it('ORDERING: an unresolvable Trade projection FAILS the handler - no projection claim, no counters, and transition.projected is NEVER recorded; redelivery does not consume the event either', async () => {
    requirePostgres('projected marker requires committed projection')
    const ctx = await makeCompletedEscrow()
    const other = await makeCompletedEscrow('FUNDS_LOCKED') // a real trade that does NOT own ctx's escrow
    const eventId = randomUUID()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h', prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    await prisma.durableEventRecord.create({
      data: {
        id: eventId, eventName: 'settlement.escrow.released', correlationId: other.tradeId,
        // TRADE_MISMATCH: the payload pairs a trade with an escrow it does not own
        payload: { escrowId: ctx.escrowId, tradeId: other.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e', prevHash: 'genesis',
      },
    })
    for (let i = 0; i < 2; i++) {
      await eventBus.redeliver(eventId).catch(() => {})
      await sleep(400)
    }
    expect(await claimCount(eventId, 'trade.status')).toBe(0)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId } })).toBe(0)
    expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })).toBe(0)
    expect((await userOf(other.buyerId))!.totalTrades).toBe(0)
    expect((await tradeOf(other.tradeId))!.status).toBe('ACTIVE')
    // this deliberately-unprojectable fixture must not linger as a permanently stuck transition in the shared DB
    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: transition.id } })
  })

  it('MONOTONIC under reversal: delivering the events of one escrow lifecycle in REVERSE order (released, then disputed, then locked) never regresses the Trade', async () => {
    requirePostgres('reverse-order delivery')
    const ctx = await makeCompletedEscrow() // persisted Escrow is already COMPLETED
    const mk = async (name: string, toStatus: string) => {
      const transition = await prisma.escrowEvent.create({
        data: { escrowId: ctx.escrowId, fromStatus: 'CREATED', toStatus: toStatus as any, triggeredBy: ctx.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
      })
      await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
      const id = randomUUID()
      await prisma.durableEventRecord.create({
        data: {
          id, eventName: name, correlationId: ctx.tradeId,
          payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'CREATED', to: toStatus, triggeredBy: ctx.sellerId, transitionId: transition.id, txId: 'tx-' + id },
          publishedAt: new Date().toISOString(), entryHash: 'e' + id, prevHash: 'genesis',
        },
      })
      return { id, transitionId: transition.id }
    }
    const released = await mk('settlement.escrow.released', 'COMPLETED')
    const disputed = await mk('settlement.escrow.disputed', 'DISPUTED')
    const locked = await mk('settlement.escrow.locked', 'FUNDS_LOCKED')
    for (const e of [released, disputed, locked]) {
      await eventBus.redeliver(e.id)
      await waitFor(projected(e.transitionId))
      expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')
    }
    expect((await userOf(ctx.buyerId))!.totalTrades).toBe(1)
  })

  it('RESTART: a fresh module graph re-running a fully projected durable event applies nothing a second time', async () => {
    requirePostgres('restart replay')
    const ctx = await makeCompletedEscrow()
    const { eventId, transitionId } = await emitReleased(ctx)
    await expectEffectsAppliedOnce(ctx)
    // instance B is an independent module graph over the same database (a "restarted" process)
    await instanceB!.eventBus.redeliver(eventId)
    await sleep(600)
    expect(await projectedCount(transitionId)).toBe(1)
    await expectEffectsAppliedOnce(ctx)
  })

  // ── Final closure: PASS 3 pagination across the REAL 200 boundary ───────────────────────────────

  // 205 permanently-unresolvable claimed transitions (a 'transition.claimed' marker whose EscrowEvent does not
  // exist: nothing to re-drive, so they stay incomplete forever) all OLDER than one genuinely recoverable
  // transition (claimed, durable event published, projection never applied). The recoverable one is therefore
  // strictly after row 200 of the oldest-first incomplete ordering.
  async function stuckAheadOfRecoverable() {
    const ctx = await makeCompletedEscrow()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: ctx.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    const now = Date.now()
    const stuckIds = Array.from({ length: 205 }, () => randomUUID())
    await prisma.eventProjectionClaim.createMany({
      data: stuckIds.map((id, i) => ({ eventId: id, projectionKey: 'transition.claimed', subjectId: 'orphan-' + id, appliedAt: new Date(now - 3_600_000 - (205 - i) * 1000) })),
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId, appliedAt: new Date(now - 1_800_000) } })
    const eventId = randomUUID()
    await prisma.durableEventRecord.create({
      data: {
        id: eventId, eventName: 'settlement.escrow.released', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e', prevHash: 'genesis',
      },
    })
    const cleanup = () => prisma.eventProjectionClaim.deleteMany({ where: { eventId: { in: stuckIds } } })
    return { ctx, transition, eventId, stuckIds, cleanup }
  }
  const newReport = () => ({ requiresManualReview: [], failed: [], projectionsRecovered: [] }) as any

  it('PASS 3 PAGINATION (real 200 boundary): 205 stuck transitions ahead of a recoverable one do not hide it; it is reached, projected once, and a second run is idempotent', async () => {
    requirePostgres('pass 3 pagination across 200')
    const f = await stuckAheadOfRecoverable()
    try {
      // the recoverable transition really is beyond the first 200-row batch of the incomplete ordering
      const olderIncomplete = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM event_projection_claims c
        WHERE c."projectionKey" = 'transition.claimed' AND c."appliedAt" < (SELECT "appliedAt" FROM event_projection_claims WHERE "eventId" = ${f.transition.id} AND "projectionKey" = 'transition.claimed')
          AND NOT EXISTS (SELECT 1 FROM event_projection_claims p WHERE p."projectionKey" = 'transition.projected' AND p."subjectId" = c."eventId")`
      expect(Number(olderIncomplete[0].n)).toBeGreaterThan(200)

      const first = newReport()
      await reconcileIncompleteProjections(first, 0)
      expect(first.projectionsRecovered.filter((r: any) => r.transitionId === f.transition.id)).toEqual([{ escrowId: f.ctx.escrowId, transitionId: f.transition.id, action: 'REDELIVERED' }])
      await waitFor(projected(f.transition.id))
      await expectEffectsAppliedOnce(f.ctx)

      const second = newReport()
      await reconcileIncompleteProjections(second, 0)
      expect(second.projectionsRecovered.filter((r: any) => r.transitionId === f.transition.id)).toEqual([])
      await sleep(300)
      await expectEffectsAppliedOnce(f.ctx)
      expect(await prisma.durableEventRecord.count({ where: { correlationId: f.ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1)
      expect(await claimCount(f.eventId, 'trade.status')).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it('PASS 3 BOUND (max-pages): when the per-invocation page budget is exhausted the NEXT invocation resumes after it - a backlog beyond the bound is worked through across ticks, never starved', async () => {
    requirePostgres('pass 3 max pages resume')
    const f = await stuckAheadOfRecoverable()
    try {
      // instanceB is an independent module graph = an independent process cursor. Budget: ONE page (200 rows).
      const budget = { maxPages: 1 }
      const r1 = newReport()
      await instanceB!.reconcileIncompleteProjections(r1, 0, budget)
      expect(r1.projectionsRecovered.filter((r: any) => r.transitionId === f.transition.id)).toEqual([]) // beyond the first page of this invocation
      let recoveredAtTick = 0
      for (let tick = 2; tick <= 12 && !recoveredAtTick; tick++) {
        const r = newReport()
        await instanceB!.reconcileIncompleteProjections(r, 0, budget)
        if (r.projectionsRecovered.some((x: any) => x.transitionId === f.transition.id)) recoveredAtTick = tick
      }
      expect(recoveredAtTick).toBeGreaterThanOrEqual(2) // reached by a LATER tick although the stuck rows are never removed
      await waitFor(projected(f.transition.id))
      await expectEffectsAppliedOnce(f.ctx)
      expect(await prisma.durableEventRecord.count({ where: { correlationId: f.ctx.tradeId, eventName: 'settlement.escrow.released' } })).toBe(1)
    } finally {
      await f.cleanup()
    }
  })
})
