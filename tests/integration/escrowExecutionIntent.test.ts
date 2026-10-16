// #247/#248 (R1 restack of #324) — real-Postgres proof that the economic intent of a direct-call
// RELEASE/REFUND/SPLIT is frozen by its first claim and survives provider failure, retry, crash and
// restart, while CURRENT execution authority still moves with the escrow state machine: once DISPUTED,
// the assigned arbiter executes (#320 dispute authority), without erasing the cooperative provenance.
//
// Every escrow is MOCK (the real direct-call test rail); provider failures are injected on the real
// provider instance. The DB trigger and CHECKs of migration 20261004130000_escrow_execution_intent are
// the ones under test — nothing is stubbed at the persistence layer.
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('#247/#248 frozen direct-call economic intent vs current execution authority — real Postgres', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let escrowRepository: typeof import('../../src/modules/open-settlement/escrow-repository').escrowRepository
  let claimEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').claimEscrowTransition
  let PROVIDERS: typeof import('../../src/modules/open-settlement/escrow-providers').PROVIDERS
  let escrowFeeSnapshotService: typeof import('../../src/modules/open-settlement/escrow-fee-snapshot.service').escrowFeeSnapshotService
  // An independent module graph (own PrismaClient, own provider instances): a restarted process.
  let restarted: {
    escrowService: typeof escrowService
    reconcile: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
    prisma: PrismaClient
    redis: { quit(): Promise<unknown> }
  } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ claimEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ PROVIDERS } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ escrowFeeSnapshotService } = require('../../src/modules/open-settlement/escrow-fee-snapshot.service'))
    jest.isolateModules(() => {
      restarted = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      if (restarted) {
        await restarted.prisma.$disconnect()
        await restarted.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  async function fixture(status: 'FUNDS_LOCKED' | 'PAYMENT_PENDING' | 'DISPUTED', opts: { withArbiter?: boolean; policyAware?: boolean } = {}) {
    const suffix = unique()
    const user = (role: string) => prisma.user.create({ data: { publicKey: `pk-${role}-intent-${suffix}` } })
    const [buyer, seller, arbiter, otherArbiter, outsider] = await Promise.all([user('buyer'), user('seller'), user('arbiter'), user('arbiter2'), user('outsider')])
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '100000', status } })
    if (opts.policyAware) {
      const policy = await prisma.feePolicyVersion.create({
        data: {
          label: `intent-${suffix}`, railScope: `FIXTURE_RAIL_INTENT-${suffix}`, status: 'PUBLISHED', protocolFeeRate: '0.004',
          payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', nodeOperatorPct: '30', treasuryPct: '25',
          walletRebatePct: '35', arbitratorReservePct: '10', createdBy: 'escrow-execution-intent-test', publishedAt: new Date(),
        },
      })
      await escrowFeeSnapshotService.snapshotEscrowFeePolicy(escrow.id, policy.railScope, '100000')
    }
    const dispute = status === 'DISPUTED' || opts.withArbiter
      ? await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: `#247-${suffix}`, arbiterId: arbiter.id } })
      : null
    return { escrow, trade, buyer, seller, arbiter, otherArbiter, outsider, dispute }
  }

  const intentOf = async (escrowId: string) => prisma.escrow.findUniqueOrThrow({
    where: { id: escrowId },
    select: { status: true, cooperativeDisposition: true, cooperativeTriggeredBy: true, arbitratedDisposition: true, arbitratedTriggeredBy: true, splitBuyerBps: true, txReleaseId: true },
  })
  const eventsTo = async (escrowId: string, toStatus: 'COMPLETED' | 'REFUNDED' | 'SPLIT') =>
    prisma.escrowEvent.findMany({ where: { escrowId, toStatus }, select: { triggeredBy: true } })
  const failProviderOnce = (method: 'releaseFunds' | 'refundFunds' | 'splitFunds') =>
    jest.spyOn(PROVIDERS.MOCK, method).mockRejectedValueOnce(new Error('provider unavailable (test)'))

  // ── D. the defect that stopped historical #324 ─────────────────────────────────────────────────────

  it('reproduces the historical #324 stuck retry (NULL-only CAS + immutable intent + status-only revert), then the restack retries the same escrow', async () => {
    pg.requirePostgres('historical #324 reproduction')
    const { escrow, seller } = await fixture('PAYMENT_PENDING')
    // #324's claim shape, on every attempt: claim only while the provenance column is still NULL.
    const historicalClaim = () => prisma.escrow.updateMany({
      where: { id: escrow.id, status: 'PAYMENT_PENDING', cooperativeTriggeredBy: null },
      data: { status: 'COMPLETED', cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id },
    })

    expect((await historicalClaim()).count).toBe(1) // 1. first claim freezes the actor
    // 2./3. the provider fails; revertEscrowStatus() restores only the status
    expect(await escrowRepository.revertStatus(escrow.id, 'COMPLETED', 'PAYMENT_PENDING')).toBe(1)
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'PAYMENT_PENDING', cooperativeTriggeredBy: seller.id })
    // 4./5. the retry's NULL-only CAS can never match again ...
    expect((await historicalClaim()).count).toBe(0)
    // 6. ... and the only way out, clearing the frozen intent, is forbidden by the database: stuck.
    await expect(prisma.escrow.update({ where: { id: escrow.id }, data: { cooperativeDisposition: null, cooperativeTriggeredBy: null } }))
      .rejects.toThrow(/immutable once frozen/)

    // The restack claims an identical retry and the escrow settles.
    await escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'COMPLETED', cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id })
  })

  // ── unknown provider outcome: no second economic dispatch ──────────────────────────────────────

  it('RELEASE: provider exception quarantines the terminal claim without fabricating settlement evidence', async () => {
    pg.requirePostgres('release unknown outcome')
    const { escrow, seller } = await fixture('PAYMENT_PENDING')
    const provider = failProviderOnce('releaseFunds')
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow(/provider unavailable/)
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'COMPLETED', cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id, txReleaseId: null,
    })
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await eventsTo(escrow.id, 'COMPLETED')).toHaveLength(0)
  })

  it('REFUND: provider exception preserves the claim and prevents a duplicate refund', async () => {
    pg.requirePostgres('refund unknown outcome')
    const { escrow, seller } = await fixture('FUNDS_LOCKED')
    const provider = failProviderOnce('refundFunds')
    await expect(escrowService.refundFunds(escrow.id, seller.id)).rejects.toThrow(/provider unavailable/)
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'REFUNDED', cooperativeDisposition: 'REFUNDED', cooperativeTriggeredBy: seller.id, txReleaseId: null,
    })
    await expect(escrowService.refundFunds(escrow.id, seller.id)).rejects.toThrow()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await eventsTo(escrow.id, 'REFUNDED')).toHaveLength(0)
  })

  it('SPLIT: unknown outcome freezes the allocation and forbids another dispatch', async () => {
    pg.requirePostgres('split unknown outcome')
    const { escrow, arbiter } = await fixture('DISPUTED')
    const provider = failProviderOnce('splitFunds')
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 3000, arbiter.id)).rejects.toThrow(/provider unavailable/)
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'SPLIT', arbitratedDisposition: 'SPLIT', splitBuyerBps: 3000, arbitratedTriggeredBy: arbiter.id, txReleaseId: null,
    })
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 4000, arbiter.id)).rejects.toThrow()
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 3000, arbiter.id)).rejects.toThrow()
    await expect(prisma.escrow.update({ where: { id: escrow.id }, data: { splitBuyerBps: 4000 } })).rejects.toThrow(/immutable once frozen/)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await eventsTo(escrow.id, 'SPLIT')).toHaveLength(0)
  })

  it('arbitrated RELEASE unknown outcome forbids divergent REFUND', async () => {
    pg.requirePostgres('arbitrated disposition switch')
    const { escrow, arbiter } = await fixture('DISPUTED')
    const release = failProviderOnce('releaseFunds')
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', arbiter.id)).rejects.toThrow(/provider unavailable/)
    const refund = jest.spyOn(PROVIDERS.MOCK, 'refundFunds')
    await expect(escrowService.refundFunds(escrow.id, arbiter.id)).rejects.toThrow()
    expect(refund).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'COMPLETED', arbitratedDisposition: 'COMPLETED', txReleaseId: null })
    expect(await eventsTo(escrow.id, 'COMPLETED')).toHaveLength(0)
  })

  it('a different cooperative actor cannot replace the frozen cooperative intent', async () => {
    pg.requirePostgres('cooperative actor divergence')
    // The assigned arbiter of a dispute row has cooperative (non-DISPUTED) authority too
    // (isSellerOrAssignedArbiter) — still not the actor of the frozen cooperative intent.
    const { escrow, seller, arbiter } = await fixture('FUNDS_LOCKED', { withArbiter: true })
    const refund = failProviderOnce('refundFunds')
    await expect(escrowService.refundFunds(escrow.id, seller.id)).rejects.toThrow(/provider unavailable/)

    await expect(escrowService.refundFunds(escrow.id, arbiter.id))
      .rejects.toThrow(new RegExp(`already froze its cooperative execution intent \\(REFUNDED by ${seller.id}\\); refusing a divergent REFUNDED by ${arbiter.id}`))
    expect(refund).toHaveBeenCalledTimes(1) // only the original failed attempt; the divergent one never reached the provider
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'FUNDS_LOCKED', cooperativeDisposition: 'REFUNDED', cooperativeTriggeredBy: seller.id })
  })

  // ── authority transfer into arbitration ───────────────────────────────────────────────────────────

  it('unknown cooperative RELEASE cannot be reinterpreted by opening a dispute', async () => {
    pg.requirePostgres('release unknown then dispute')
    const { escrow, buyer, seller, arbiter } = await fixture('PAYMENT_PENDING', { withArbiter: true })
    const release = failProviderOnce('releaseFunds')
    const refund = jest.spyOn(PROVIDERS.MOCK, 'refundFunds')
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow(/provider unavailable/)
    await expect(escrowService.openDispute(escrow.id, buyer.id, 'payment not received')).rejects.toThrow()
    await expect(escrowService.refundFunds(escrow.id, arbiter.id)).rejects.toThrow()
    expect(release).toHaveBeenCalledTimes(1)
    expect(refund).not.toHaveBeenCalled()
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'COMPLETED', cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id, txReleaseId: null,
    })
    expect(await eventsTo(escrow.id, 'COMPLETED')).toHaveLength(0)
  })

  it('unknown cooperative REFUND cannot be reinterpreted as arbitrated RELEASE', async () => {
    pg.requirePostgres('refund unknown then dispute')
    const { escrow, buyer, seller, arbiter } = await fixture('FUNDS_LOCKED', { withArbiter: true })
    const refund = failProviderOnce('refundFunds')
    const release = jest.spyOn(PROVIDERS.MOCK, 'releaseFunds')
    await expect(escrowService.refundFunds(escrow.id, seller.id)).rejects.toThrow(/provider unavailable/)
    await expect(escrowService.openDispute(escrow.id, buyer.id, 'seller tried to refund a paid trade')).rejects.toThrow()
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', arbiter.id)).rejects.toThrow()
    expect(refund).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'REFUNDED', cooperativeDisposition: 'REFUNDED', cooperativeTriggeredBy: seller.id, txReleaseId: null,
    })
    expect(await eventsTo(escrow.id, 'REFUNDED')).toHaveLength(0)
  })

  it('unauthorized parties stay rejected in both phases, and a rejected attempt freezes nothing', async () => {
    pg.requirePostgres('unauthorized')
    const { escrow, buyer, seller, outsider } = await fixture('PAYMENT_PENDING', { withArbiter: true })
    const release = jest.spyOn(PROVIDERS.MOCK, 'releaseFunds')
    const refund = jest.spyOn(PROVIDERS.MOCK, 'refundFunds')

    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', outsider.id)).rejects.toThrow(/neither the seller .* nor its assigned dispute arbiter/)
    expect(await intentOf(escrow.id)).toMatchObject({ cooperativeDisposition: null, arbitratedDisposition: null })

    await escrowService.openDispute(escrow.id, buyer.id, 'dispute')
    // Once DISPUTED, ordinary seller authority is suspended (#320) — the seller is now as unauthorized as a stranger.
    await expect(escrowService.refundFunds(escrow.id, seller.id)).rejects.toThrow(/not the current assigned arbiter/)
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', outsider.id)).rejects.toThrow(/not the current assigned arbiter/)
    expect(release).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'DISPUTED', cooperativeDisposition: null, arbitratedDisposition: null })
  })

  it('arbiter reassignment cannot redispatch a SPLIT with unknown provider outcome', async () => {
    pg.requirePostgres('arbiter reassignment')
    const { escrow, arbiter, otherArbiter, dispute } = await fixture('DISPUTED')
    const split = failProviderOnce('splitFunds')
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 3000, arbiter.id)).rejects.toThrow(/provider unavailable/)
    await prisma.dispute.update({ where: { id: dispute!.id }, data: { arbiterId: otherArbiter.id } })
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 3000, arbiter.id)).rejects.toThrow()
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 5000, otherArbiter.id)).rejects.toThrow()
    await expect(escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', 3000, otherArbiter.id)).rejects.toThrow()
    expect(split).toHaveBeenCalledTimes(1)
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'SPLIT', arbitratedDisposition: 'SPLIT', splitBuyerBps: 3000, arbitratedTriggeredBy: arbiter.id, txReleaseId: null,
    })
    expect(await eventsTo(escrow.id, 'SPLIT')).toHaveLength(0)
  })

  // ── concurrency ───────────────────────────────────────────────────────────────────────────────────

  it('concurrent identical releases: exactly one claim, one provider execution, one completion event', async () => {
    pg.requirePostgres('concurrent releases')
    const { escrow, seller } = await fixture('PAYMENT_PENDING')
    const release = jest.spyOn(PROVIDERS.MOCK, 'releaseFunds')

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)))

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await eventsTo(escrow.id, 'COMPLETED')).toHaveLength(1)
  })

  it('concurrent SPLITs with different allocations: exactly one freezes, and the frozen allocation is the one that executed', async () => {
    pg.requirePostgres('concurrent splits')
    const { escrow, arbiter } = await fixture('DISPUTED')
    const split = jest.spyOn(PROVIDERS.MOCK, 'splitFunds')
    const allocations = [1000, 2000, 3000, 4000, 5000]

    const results = await Promise.allSettled(allocations.map((bps) => escrowService.splitFunds(escrow.id, 'buyer-addr', 'seller-addr', bps, arbiter.id)))

    const winners = results.flatMap((r, i) => (r.status === 'fulfilled' ? [allocations[i]] : []))
    expect(winners).toHaveLength(1)
    expect(split).toHaveBeenCalledTimes(1)
    expect(split.mock.calls[0][3]).toBe(winners[0])
    expect(await intentOf(escrow.id)).toMatchObject({ status: 'SPLIT', splitBuyerBps: winners[0] })
  })

  // ── crash / restart ───────────────────────────────────────────────────────────────────────────────

  it('restart after unknown cooperative outcome refuses both identical and divergent redispatch', async () => {
    pg.requirePostgres('restart unknown outcome')
    const { escrow, seller, arbiter } = await fixture('PAYMENT_PENDING', { withArbiter: true })
    const release = failProviderOnce('releaseFunds')
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow(/provider unavailable/)
    const fresh = restarted!
    await expect(fresh.escrowService.releaseFunds(escrow.id, 'buyer-addr', arbiter.id)).rejects.toThrow()
    await expect(fresh.escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow()
    expect(release).toHaveBeenCalledTimes(1)
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'COMPLETED', cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id, txReleaseId: null,
    })
    expect(await eventsTo(escrow.id, 'COMPLETED')).toHaveLength(0)
  })

  it('crash after an arbitrated SPLIT executed but before its local completion: an independent process recovers it with the frozen allocation and the authorized arbiter', async () => {
    pg.requirePostgres('restart after execution')
    const { escrow, buyer, seller, arbiter } = await fixture('PAYMENT_PENDING', { withArbiter: true, policyAware: true })
    failProviderOnce('releaseFunds')
    await expect(escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id)).rejects.toThrow(/provider unavailable/)
    await escrowService.openDispute(escrow.id, buyer.id, 'dispute')

    // The live path up to "provider returned": claim (freezing the arbitrated intent) + result persisted;
    // the process dies before the obligation and the completion event.
    await claimEscrowTransition(escrow.id, 'DISPUTED', 'SPLIT', { triggeredBy: arbiter.id, splitBuyerBps: 2500 })
    await escrowRepository.updateSplitResult(escrow.id, { txReleaseId: 'mock-split-a,mock-split-b', releasedAt: new Date() })
    expect(await eventsTo(escrow.id, 'SPLIT')).toEqual([])

    const fresh = restarted!
    const [{ queued }] = await prisma.$queryRaw<Array<{ queued: number }>>`
      SELECT count(*)::int AS queued FROM escrows WHERE status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND "txReleaseId" IS NOT NULL AND "completionVerifiedAt" IS NULL`
    for (let run = 0; run <= Math.ceil(queued / 50) && (await eventsTo(escrow.id, 'SPLIT')).length === 0; run++) {
      await fresh.reconcile({ projectionGraceMs: 0 })
    }

    expect(await eventsTo(escrow.id, 'SPLIT')).toEqual([{ triggeredBy: arbiter.id }])
    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.economicDetermination).toBe('OWED')
    expect(obligation.basisAmount!.toString()).toBe('75000') // the seller's share at the FROZEN buyerBps=2500
    expect(await intentOf(escrow.id)).toMatchObject({
      status: 'SPLIT',
      cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: seller.id,
      arbitratedDisposition: 'SPLIT', arbitratedTriggeredBy: arbiter.id, splitBuyerBps: 2500,
    })
  })
})
