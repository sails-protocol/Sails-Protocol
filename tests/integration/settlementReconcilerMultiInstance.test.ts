// tests/integration/settlementReconcilerMultiInstance.test.ts
//
// Issue #291/#294/#298 final closure - the WHOLE reconciler entry point
// (reconcilePendingSettlements) run by two independent Sails instances at the
// same time against one real PostgreSQL. Each instance is its own module graph
// (own Prisma pool, own event bus, own handlers, own process-local state).
// Correctness must come from PostgreSQL (advisory locks, CAS, write-once,
// projection-claim identity) - never from the process-local overlap flag.
//
// Paths exercised concurrently:
//   PASS 2  - settled escrow (result persisted) whose completion effects never ran
//   PASS 3a - transition claimed but the durable event never published (re-publish)
//   PASS 3b - durable event published but its projection never applied (redeliver)
//   PASS 1  - terminal WDK escrow with NO persisted result (must stay fail-closed)

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Final closure - reconcilePendingSettlements() is convergent under multi-instance concurrency (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  type Reconcile = typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let reconcileA: Reconcile
  let instanceB: { reconcile: Reconcile; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ reconcilePendingSettlements: reconcileA } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = {
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
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

  async function makeEscrow(type: 'MOCK' | 'WDK_USDT_EVM') {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'COMPLETED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }
  type Ctx = Awaited<ReturnType<typeof makeEscrow>>

  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })
  const escrowOf = (id: string) => prisma.escrow.findUnique({ where: { id } })
  async function waitFor(cond: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return; await sleep(100) }
    throw new Error('timed out waiting for condition')
  }
  const projectedFor = (escrowId: string) => async () => {
    const t = await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus: 'COMPLETED' } })
    return !!t && (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: t.id } })) === 1
  }

  async function expectCompletedExactlyOnce(c: Ctx) {
    const [buyer, seller, trade, events, durable] = await Promise.all([
      userOf(c.buyerId), userOf(c.sellerId), prisma.trade.findUnique({ where: { id: c.tradeId } }),
      prisma.escrowEvent.findMany({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } }),
      prisma.durableEventRecord.findMany({ where: { correlationId: c.tradeId, eventName: 'settlement.escrow.released' } }),
    ])
    expect(events).toHaveLength(1)   // one canonical transition identity
    expect(durable).toHaveLength(1)  // one canonical durable event identity
    expect(trade!.status).toBe('COMPLETED')
    expect(trade!.completedAt).not.toBeNull()
    expect(buyer!.totalTrades).toBe(1)
    expect(seller!.totalTrades).toBe(1)
    expect(Number(buyer!.totalVolumeBtc)).toBeCloseTo(0.001, 8)
    expect(Number(seller!.totalVolumeBtc)).toBeCloseTo(0.001, 8)
    expect(buyer!.reputationScore).toBe(2)
    expect(seller!.reputationScore).toBe(2)
    expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'trade.status', subjectId: c.tradeId } })).toBe(1)
  }

  it('two instances run reconcilePendingSettlements() simultaneously over PASS 1/2/3: both converge on ONE persisted economic state; nothing is duplicated, overwritten, or re-executed', async () => {
    pg.requirePostgres('multi-instance reconciler')

    // PASS 2: result persisted, completion effects never ran
    const settled = await makeEscrow('MOCK')
    const settledTx = `s${randomUUID().replace(/-/g, '')}`.padEnd(64, 's')
    await prisma.escrow.update({ where: { id: settled.escrowId }, data: { txReleaseId: settledTx, releasedAt: new Date('2026-01-01T00:00:00.000Z') } })

    // PASS 3a: claimed, durable event never published
    const unpublished = await makeEscrow('MOCK')
    const tUnpub = await prisma.escrowEvent.create({ data: { escrowId: unpublished.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: unpublished.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' } })
    await prisma.eventProjectionClaim.create({ data: { eventId: tUnpub.id, projectionKey: 'transition.claimed', subjectId: unpublished.escrowId, appliedAt: new Date(Date.now() - 600_000) } })

    // PASS 3b: durable event published, projection never applied
    const published = await makeEscrow('MOCK')
    const tPub = await prisma.escrowEvent.create({ data: { escrowId: published.escrowId, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: published.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' } })
    await prisma.eventProjectionClaim.create({ data: { eventId: tPub.id, projectionKey: 'transition.claimed', subjectId: published.escrowId, appliedAt: new Date(Date.now() - 600_000) } })
    await prisma.durableEventRecord.create({
      data: {
        id: randomUUID(), eventName: 'settlement.escrow.released', correlationId: published.tradeId,
        payload: { escrowId: published.escrowId, tradeId: published.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: published.sellerId, transitionId: tPub.id },
        publishedAt: new Date().toISOString(), entryHash: 'e', prevHash: 'genesis',
      },
    })

    // PASS 1: terminal WDK escrow, NO persisted result - must stay fail-closed
    const wdk = await makeEscrow('WDK_USDT_EVM')

    const [ra, rb] = await Promise.all([
      reconcileA({ projectionGraceMs: 0 }),
      instanceB!.reconcile({ projectionGraceMs: 0 }),
    ])

    const mine = new Set([settled.escrowId, unpublished.escrowId, published.escrowId, wdk.escrowId])
    for (const r of [ra, rb]) expect(r.failed.filter((f) => mine.has(f.escrowId))).toEqual([])

    await waitFor(projectedFor(settled.escrowId))
    await waitFor(projectedFor(unpublished.escrowId))
    await waitFor(projectedFor(published.escrowId))
    await sleep(500)

    for (const c of [settled, unpublished, published]) await expectCompletedExactlyOnce(c)

    // one authoritative result, never overwritten
    const settledAfter = (await escrowOf(settled.escrowId))!
    expect(settledAfter.txReleaseId).toBe(settledTx)
    expect(settledAfter.releasedAt!.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(settledAfter.status).toBe('COMPLETED')

    // the pre-existing transition identity was reused, not replaced
    expect((await prisma.escrowEvent.findMany({ where: { escrowId: unpublished.escrowId } })).map((e) => e.id)).toEqual([tUnpub.id])
    expect((await prisma.escrowEvent.findMany({ where: { escrowId: published.escrowId } })).map((e) => e.id)).toEqual([tPub.id])

    // PASS 1 / WDK: fail-closed, visible to BOTH instances, no guessed result, no transfer ever started
    for (const r of [ra, rb]) expect(r.requiresManualReview.some((m) => m.escrowId === wdk.escrowId)).toBe(true)
    const wdkAfter = (await escrowOf(wdk.escrowId))!
    expect(wdkAfter.txReleaseId).toBeNull()
    expect(wdkAfter.status).toBe('COMPLETED')
    expect(await prisma.wdkTransferAttempt.count({ where: { escrowId: { in: [wdk.escrowId, settled.escrowId, unpublished.escrowId, published.escrowId] } } })).toBe(0)

    // a second concurrent round is a no-op: same persisted state
    const before = await Promise.all([settled, unpublished, published].map((c) => escrowOf(c.escrowId)))
    await Promise.all([reconcileA({ projectionGraceMs: 0 }), instanceB!.reconcile({ projectionGraceMs: 0 })])
    await sleep(500)
    for (const c of [settled, unpublished, published]) await expectCompletedExactlyOnce(c)
    const after = await Promise.all([settled, unpublished, published].map((c) => escrowOf(c.escrowId)))
    expect(after.map((e) => [e!.status, e!.txReleaseId])).toEqual(before.map((e) => [e!.status, e!.txReleaseId]))
    expect((await escrowOf(wdk.escrowId))!.txReleaseId).toBeNull()
  })
})
