// tests/integration/durableProjectionCompletion.test.ts
//
// Issue #253 - Durable Downstream Projection Completion / Exactly-Once Effects.
// Real PostgreSQL proof for the two additive projections that discovery found were NOT already covered
// by #298's applyEventProjectionOnce()/PASS 3 machinery:
//
//   A. disputeCount (User.disputeCount, both sides) - previously incremented from a SEPARATE, non-durable
//      `eventBus.on('openp2p.trade.disputed', ...)` consumer with no claim of its own. Moved inline to the
//      settlement.escrow.disputed onDurable() handler (handlers.ts) under an applyEventProjectionOnce()
//      claim keyed on (eventId, 'dispute.count', tradeId) - now covered by the SAME PASS 3
//      (reconcileIncompleteProjections()) recovery every other projection of that transition already uses.
//
//   B. Arbiter ruling finalization (ArbiterProfile.rulingsTotal/rulingsOverturned/monetaryCollateral/
//      arbiterReputation, DisputeAppealFee.outcome) - previously a plain sequence of independent,
//      non-idempotent writes in dispute.service.ts's finalizeResolveDispute(), with NO retry path at all
//      (resolveDispute()'s own top-of-method guard rejects an already-RESOLVED dispute, so nothing could
//      ever call this bookkeeping again after a crash). Now one atomic claim+effect transaction keyed on
//      (disputeId, 'dispute.ruling-finalized', String(appealRound)) - a real, immutable "one ruling occurred
//      for this dispute at this generation" identity - with recoverMissingRulingFinalization() as the
//      discovery/recovery mechanism (the same "claimed but not yet applied" shape PASS 3 established).
//
// Section B directly exercises DisputeService's private finalizeResolveDispute() (via an `as any` cast) to
// prove the projection-claim/crash-recovery mechanism in isolation from escrow-settlement/signature-
// verification machinery already covered by tests/disputeFlow.test.ts and the WDK/MULTISIG restart-
// convergence integration suites - this mission's own objective is exactly-once projection completion,
// not re-proving fund movement.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #253 - durable downstream projection completion (real PostgreSQL)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition
  let reconcileIncompleteProjections: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections
  let applyEventProjectionOnce: typeof import('../../src/common/events/event-projection').applyEventProjectionOnce
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let instanceB: { eventBus: typeof eventBus; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

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
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()

    jest.isolateModules(() => {
      const b = require('../../src/common/events/event-bus')
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = { eventBus: b.eventBus, prisma: require('../../src/common/database').prisma, redis: require('../../src/common/redis').redis }
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

  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }
  const projected = (transitionId: string) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0
  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })

  // ─── Section A fixtures — disputeCount ──────────────────────────────────────────────────────────

  async function makeFundsLockedEscrow() {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'FUNDS_LOCKED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }

  async function emitDisputed(ctx: { tradeId: string; escrowId: string; sellerId: string }) {
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'FUNDS_LOCKED', 'DISPUTED', ctx.sellerId, 'settlement.escrow.disputed', {})
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'DISPUTED' } }))!
    await waitFor(projected(transition.id))
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.disputed' } }))!
    return { transitionId: transition.id, eventId: durable.id }
  }

  async function expectDisputeCountAppliedOnce(ctx: { buyerId: string; sellerId: string }) {
    const [buyer, seller] = await Promise.all([userOf(ctx.buyerId), userOf(ctx.sellerId)])
    expect(buyer!.disputeCount).toBe(1)
    expect(seller!.disputeCount).toBe(1)
  }

  it('A1: settlement.escrow.disputed increments disputeCount for both sides exactly once', async () => {
    requirePostgres('A1 single disputed event')
    const ctx = await makeFundsLockedEscrow()
    const { eventId } = await emitDisputed(ctx)
    await expectDisputeCountAppliedOnce(ctx)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: 'dispute.count' } })).toBe(1)
  })

  it('A2: the SAME disputed event redelivered 10 times concurrently -> disputeCount incremented once, not 10 times', async () => {
    requirePostgres('A2 concurrent redelivery')
    const ctx = await makeFundsLockedEscrow()
    const { eventId } = await emitDisputed(ctx)
    await expectDisputeCountAppliedOnce(ctx)

    const results = await Promise.all(Array.from({ length: 10 }, () => eventBus.redeliver(eventId)))
    expect(results.every(Boolean)).toBe(true)
    await sleep(800)

    await expectDisputeCountAppliedOnce(ctx) // still exactly 1, not 11
    expect(await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: 'dispute.count' } })).toBe(1)
  })

  it('A3: CRASH RECOVERY - a claimed-but-unprojected disputed transition is re-driven by PASS 3 and disputeCount converges exactly once', async () => {
    requirePostgres('A3 PASS 3 recovery for dispute.count')
    const ctx = await makeFundsLockedEscrow()
    const transition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'FUNDS_LOCKED', toStatus: 'DISPUTED', triggeredBy: ctx.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    const eventId = randomUUID()
    await prisma.durableEventRecord.create({
      data: {
        id: eventId, eventName: 'settlement.escrow.disputed', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'FUNDS_LOCKED', to: 'DISPUTED', triggeredBy: ctx.sellerId, transitionId: transition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e' + eventId, prevHash: 'genesis',
      },
    })
    // crash: nothing has run yet - disputeCount still 0 on both sides
    expect((await userOf(ctx.buyerId))!.disputeCount).toBe(0)

    const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(report, 0)
    expect(report.failed).toEqual([])
    expect(report.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([{ escrowId: ctx.escrowId, transitionId: transition.id, action: 'REDELIVERED' }])
    await waitFor(projected(transition.id))

    await expectDisputeCountAppliedOnce(ctx)

    // repeated reconciliation is a no-op
    const again = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(again, 0)
    expect(again.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([])
    await sleep(300)
    await expectDisputeCountAppliedOnce(ctx)
  })

  it('A4: MULTI-INSTANCE - two independent module graphs redelivering the same disputed event concurrently converge to one disputeCount increment per side', async () => {
    requirePostgres('A4 multi-instance dispute.count')
    expect(instanceB).toBeDefined()
    const ctx = await makeFundsLockedEscrow()
    const { eventId } = await emitDisputed(ctx)

    await Promise.all([
      ...Array.from({ length: 5 }, () => eventBus.redeliver(eventId)),
      ...Array.from({ length: 5 }, () => instanceB!.eventBus.redeliver(eventId)),
    ])
    await sleep(1000)

    await expectDisputeCountAppliedOnce(ctx)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: 'dispute.count' } })).toBe(1)
  })

  // ─── Section B fixtures — arbiter ruling finalization ───────────────────────────────────────────

  async function makeArbiter(collateral = '10') {
    const user = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const profile = await prisma.arbiterProfile.create({ data: { participantId: user.id, monetaryCollateral: collateral, collateralAsset: 'BTC', arbiterReputation: 50 } })
    return { userId: user.id, profile }
  }

  async function makeResolvedDispute(opts: {
    arbiterId: string
    ruling: 'RELEASE' | 'REFUND' | 'SPLIT'
    appealRound?: number
    previousRuling?: 'RELEASE' | 'REFUND' | 'SPLIT' | null
    previousArbiterId?: string | null
    feeCharged?: string | null
  }) {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MOCK', status: 'COMPLETED', lockedAmount: '0.001', asset: 'BTC', feeCharged: opts.feeCharged ?? null },
    })
    const dispute = await prisma.dispute.create({
      data: {
        tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'test',
        arbiterId: opts.arbiterId, status: 'RESOLVED', ruling: opts.ruling, resolvedAt: new Date(),
        appealRound: opts.appealRound ?? 0,
        previousRuling: opts.previousRuling ?? null,
        previousArbiterId: opts.previousArbiterId ?? null,
      },
    })
    if ((opts.appealRound ?? 0) > 0) {
      await prisma.disputeAppealFee.create({ data: { disputeId: dispute.id, appealRound: opts.appealRound!, requestedBy: buyer.id, amount: '2', asset: 'BTC' } })
    }
    return { dispute, tradeId: trade.id, escrowId: escrow.id, buyerId: buyer.id, sellerId: seller.id }
  }

  function finalizeOf(service: InstanceType<typeof DisputeService>) {
    // Directly exercises the private method under test — see this file's own header comment for why.
    return (dispute: { id: string; escrowId: string; appealRound: number; previousRuling: string | null; previousArbiterId: string | null }, arbiterId: string, ruling: string) =>
      (service as any).finalizeResolveDispute(dispute, arbiterId, ruling)
  }

  const claimCountFor = (disputeId: string, round: number) =>
    prisma.eventProjectionClaim.count({ where: { eventId: disputeId, projectionKey: 'dispute.ruling-finalized', subjectId: String(round) } })

  it('B1: two CONCURRENT duplicate finalize calls for the SAME (disputeId, appealRound) -> rulingsTotal incremented exactly once', async () => {
    requirePostgres('B1 concurrent duplicate finalize')
    const { userId: arbiterId } = await makeArbiter()
    const { dispute } = await makeResolvedDispute({ arbiterId, ruling: 'RELEASE' })
    const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    const finalize = finalizeOf(service)

    await Promise.all([
      finalize(dispute, arbiterId, 'RELEASE'),
      finalize(dispute, arbiterId, 'RELEASE'),
      finalize(dispute, arbiterId, 'RELEASE'),
    ])

    const profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(1)
    expect(await claimCountFor(dispute.id, 0)).toBe(1)
  })

  it('B2: CRASH RECOVERY - a RESOLVED dispute with no finalization claim is discovered and finalized exactly once by recoverMissingRulingFinalization()', async () => {
    requirePostgres('B2 recoverMissingRulingFinalization')
    const { userId: arbiterId } = await makeArbiter()
    const { dispute } = await makeResolvedDispute({ arbiterId, ruling: 'REFUND', feeCharged: '0.5' })
    const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>

    // crash simulated: the Dispute row is RESOLVED (as if resolveDispute()'s own write already committed)
    // but finalizeResolveDispute() never ran - exactly the window this mission's #253 report calls out.
    expect(await claimCountFor(dispute.id, 0)).toBe(0)
    let profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(0)

    // Scoped to THIS test's own fixture, not a global "nothing else in the shared dev DB ever fails"
    // assertion: recoverMissingRulingFinalization() scans every RESOLVED dispute system-wide (the same
    // "operates over the whole system, safely no-ops per-row" shape PASS 3's reconcileIncompleteProjections()
    // already has), including disputes from OTHER, unrelated suites resolved under trusted-list mode with no
    // ArbiterProfile at all - a real, expected mismatch for THIS test's raw market-provider DisputeService
    // instance (no resolver, matching disputeFlow.test.ts's own injection pattern), not a defect in the
    // reconciler itself. Each row's own try/catch (this method's own implementation) already isolates one
    // bad row from every other - proven here by THIS dispute still converging correctly regardless.
    // A large explicit limit — not the 200 default — so this fixture (ordered oldest-resolvedAt-first,
    // same as production) is reached regardless of how many older RESOLVED rows already exist in the
    // shared dev database from other suites.
    const first = await service.recoverMissingRulingFinalization(5000)
    expect(first.failed.find((f) => f.disputeId === dispute.id)).toBeUndefined()
    expect(first.recovered).toContain(dispute.id)

    profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(1)
    expect(Number(profile!.cumulativeFeesObserved)).toBeCloseTo(0.5, 8)
    expect(await claimCountFor(dispute.id, 0)).toBe(1)

    // repeated reconciliation is a no-op - the dispute is no longer a candidate (claim already exists)
    const second = await service.recoverMissingRulingFinalization()
    expect(second.recovered).not.toContain(dispute.id)
    profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(1) // unchanged
  })

  it('B3: SLASH under concurrent duplicate finalize calls - rulingsOverturned/collateral/reputation move exactly once, arbiter.slashed emitted exactly once', async () => {
    requirePostgres('B3 concurrent slash')
    const { userId: originalArbiterId, profile: originalProfile } = await makeArbiter('4')
    const { userId: newArbiterId } = await makeArbiter()
    const { dispute } = await makeResolvedDispute({
      arbiterId: newArbiterId, ruling: 'REFUND', appealRound: 1,
      previousRuling: 'RELEASE', previousArbiterId: originalArbiterId,
    })
    const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    const finalize = finalizeOf(service)
    const emitted: unknown[] = []
    eventBus.on('arbiter.slashed', (payload) => { emitted.push(payload) })

    await Promise.all([
      finalize(dispute, newArbiterId, 'REFUND'),
      finalize(dispute, newArbiterId, 'REFUND'),
      finalize(dispute, newArbiterId, 'REFUND'),
    ])
    await sleep(300)

    const slashed = await prisma.arbiterProfile.findUnique({ where: { participantId: originalArbiterId } })
    expect(slashed!.rulingsOverturned).toBe(1)
    expect(Number(slashed!.monetaryCollateral)).toBeCloseTo(Number(originalProfile.monetaryCollateral) * 0.5, 8) // SLASH_COLLATERAL_FRACTION
    expect(slashed!.arbiterReputation).toBe(40) // 50 + OVERTURNED_PENALTY(-10)

    const appealFee = await prisma.disputeAppealFee.findUnique({ where: { disputeId_appealRound: { disputeId: dispute.id, appealRound: 1 } } })
    expect(appealFee!.outcome).toBe('REFUNDED') // ruling differs from previousRuling -> appellant was right

    expect(await claimCountFor(dispute.id, 1)).toBe(1)
    expect(emitted.length).toBe(1) // exactly one arbiter.slashed emission across 3 concurrent duplicate calls
  })

  it('B4: two DIFFERENT appeal-round generations of the SAME dispute finalize independently (real, immutable generation identity)', async () => {
    requirePostgres('B4 generation identity across appeal rounds')
    const { userId: arbiterId } = await makeArbiter()
    const { dispute } = await makeResolvedDispute({ arbiterId, ruling: 'RELEASE', appealRound: 0 })
    const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    const finalize = finalizeOf(service)

    await finalize(dispute, arbiterId, 'RELEASE') // round 0
    let profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(1)

    // A later appeal moved the SAME dispute row to round 1, resolved again by the same arbiter (a fresh
    // ruling generation - a real, immutable identity distinct from round 0's own claim).
    const roundOne = { ...dispute, appealRound: 1 }
    await finalize(roundOne, arbiterId, 'RELEASE')
    profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(2) // round 0 and round 1 are two independent, real rulings

    expect(await claimCountFor(dispute.id, 0)).toBe(1)
    expect(await claimCountFor(dispute.id, 1)).toBe(1)

    // redelivering round 0's own finalize again (e.g. a stale retry) still only ever applies once
    await finalize(dispute, arbiterId, 'RELEASE')
    profile = await prisma.arbiterProfile.findUnique({ where: { participantId: arbiterId } })
    expect(profile!.rulingsTotal).toBe(2) // unchanged
  })

  it('B5: the projection claim primitive underlying finalization is ATOMIC - a failing effect rolls the claim back so a retry still applies it', async () => {
    requirePostgres('B5 atomic claim+effect for dispute.ruling-finalized')
    const disputeId = randomUUID()
    await expect(
      applyEventProjectionOnce(disputeId, 'dispute.ruling-finalized', '0', async () => { throw new Error('crash before commit') })
    ).rejects.toThrow('crash before commit')
    expect(await claimCountFor(disputeId, 0)).toBe(0)
    expect(await applyEventProjectionOnce(disputeId, 'dispute.ruling-finalized', '0', async () => {})).toBe(true)
    expect(await applyEventProjectionOnce(disputeId, 'dispute.ruling-finalized', '0', async () => {})).toBe(false)
  })
})
