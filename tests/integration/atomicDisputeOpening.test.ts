// #238 (R2) — real-Postgres proof that opening a dispute is one commit: the escrow freeze (-> DISPUTED),
// its transition record, the Dispute row and its assigned arbiter commit together or not at all.
// Invariant under test: an escrow is DISPUTED iff its Dispute (with an arbiter) exists durably.
//
// "Restart" below means an independent module graph with its own PrismaClient (jest.isolateModules),
// i.e. state re-read through a fresh process image of the application - not an OS-level crash.
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import type { ArbitrationProvider } from '../../src/modules/open-settlement/arbitration-provider'

describe('#238 atomic dispute opening — real Postgres', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let TrustedArbitratorProvider: typeof import('../../src/modules/open-settlement/arbitration-provider').TrustedArbitratorProvider
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let restarted: { DisputeService: typeof DisputeService; TrustedArbitratorProvider: typeof TrustedArbitratorProvider; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ TrustedArbitratorProvider } = require('../../src/modules/open-settlement/arbitration-provider'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    jest.isolateModules(() => {
      restarted = {
        DisputeService: require('../../src/modules/open-settlement/dispute.service').DisputeService,
        TrustedArbitratorProvider: require('../../src/modules/open-settlement/arbitration-provider').TrustedArbitratorProvider,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
  })

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

  const newUser = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })

  async function fixture(status: 'PAYMENT_PENDING' | 'FUNDS_LOCKED' = 'PAYMENT_PENDING', lockedAmount = '100000') {
    const [buyer, seller, arbiter] = await Promise.all([newUser(), newUser(), newUser()])
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount, status } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    return { trade, escrow, buyer, seller, arbiter }
  }

  const trusted = (arbiterId: string) => new DisputeService(new TrustedArbitratorProvider([arbiterId]))
  const failingAssignment = (): ArbitrationProvider => ({
    name: 'failing-assignment', arbitrators: [],
    async assign() { throw new Error('no arbiter assignable (test)') },
  })

  /** Every durable fact a dispute opening writes, read through the given client. */
  async function durableState(escrowId: string, client: PrismaClient = prisma) {
    const escrow = await client.escrow.findUniqueOrThrow({ where: { id: escrowId }, select: { status: true } })
    const disputes = await client.dispute.findMany({ where: { escrowId }, select: { id: true, status: true, arbiterId: true, openedBy: true, tradeId: true } })
    const transitions = await client.escrowEvent.findMany({ where: { escrowId, toStatus: 'DISPUTED' }, select: { id: true, fromStatus: true, triggeredBy: true } })
    const claimMarkers = await client.eventProjectionClaim.count({ where: { subjectId: escrowId, projectionKey: 'transition.claimed', eventId: { in: transitions.map((t) => t.id) } } })
    const published = await client.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM durable_events WHERE "eventName" = 'settlement.escrow.disputed' AND payload->>'escrowId' = ${escrowId}`
    return { status: escrow.status, disputes, transitions, claimMarkers, published: published[0].n }
  }

  const expectUntouched = async (escrowId: string, originalStatus: string, client?: PrismaClient) =>
    expect(await durableState(escrowId, client)).toEqual({ status: originalStatus, disputes: [], transitions: [], claimMarkers: 0, published: 0 })

  // ── historical failure ──────────────────────────────────────────────────────────────────────────

  it('reproduces the historical split boundary: the freeze commits on its own, and a failure before the Dispute leaves DISPUTED with no Dispute', async () => {
    pg.requirePostgres('historical half-state')
    const { escrow, trade, buyer } = await fixture()
    // The pre-#238 raiseDispute() first committed escrowService.openDispute() (its own transaction) and only
    // then created the Dispute in a separate statement. Run that first step, then fail before the second.
    await escrowService.openDispute(escrow.id, buyer.id, 'historical first step')

    const state = await durableState(escrow.id)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toEqual([]) // the committed half-state the fix removes
    // ... and nothing can resolve it: no Dispute means no assigned arbiter, the only DISPUTED authority (#320).
    expect(await prisma.dispute.findFirst({ where: { tradeId: trade.id } })).toBeNull()
  })

  // ── rollback ────────────────────────────────────────────────────────────────────────────────────

  it('arbiter assignment failing inside the opening rolls everything back: original status, no Dispute, no transition, nothing published', async () => {
    pg.requirePostgres('assignment failure rollback')
    const { escrow, trade, buyer } = await fixture()

    await expect(new DisputeService(failingAssignment()).raiseDispute(trade.id, buyer.id, 'payment not received'))
      .rejects.toThrow(/no arbiter assignable/)

    await expectUntouched(escrow.id, 'PAYMENT_PENDING')
  })

  it('a failure after the Dispute row was written (assignment) rolls the Dispute back with the freeze — no reverse half-state either', async () => {
    pg.requirePostgres('dispute rollback')
    const { escrow, trade, seller } = await fixture('FUNDS_LOCKED')
    let sawUncommittedDispute = false
    const provider: ArbitrationProvider = {
      name: 'fails-after-reading', arbitrators: [],
      async assign(disputeId, _tradeId, tx) {
        // The Dispute exists inside the opening transaction ...
        sawUncommittedDispute = (await tx!.dispute.findUnique({ where: { id: disputeId } })) !== null
        throw new Error('assignment failed after the dispute row (test)')
      },
    }

    await expect(new DisputeService(provider).raiseDispute(trade.id, seller.id, 'reason')).rejects.toThrow(/assignment failed/)

    expect(sawUncommittedDispute).toBe(true)
    await expectUntouched(escrow.id, 'FUNDS_LOCKED') // ... and is gone with the rollback
  })

  // ── success ─────────────────────────────────────────────────────────────────────────────────────

  it('a successful opening commits exactly one Dispute with its arbiter, the DISPUTED escrow, one transition record and its published event', async () => {
    pg.requirePostgres('success')
    const { escrow, trade, buyer, arbiter } = await fixture()

    const dispute = await trusted(arbiter.id).raiseDispute(trade.id, buyer.id, 'payment not received')

    const state = await durableState(escrow.id)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toEqual([{ id: dispute.id, status: 'OPENED', arbiterId: arbiter.id, openedBy: buyer.id, tradeId: trade.id }])
    expect(state.transitions).toEqual([{ id: expect.any(String), fromStatus: 'PAYMENT_PENDING', triggeredBy: buyer.id }])
    expect(state.claimMarkers).toBe(1)
    expect(state.published).toBe(1)
    // The assigned arbiter now holds DISPUTED disposition authority (#320), and nobody else.
    await escrowService.refundFunds(escrow.id, arbiter.id)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('REFUNDED')
  })

  it('market arbitration assigns inside the same transaction (reads the not-yet-committed Dispute through it) and commits a registered arbiter', async () => {
    pg.requirePostgres('market assignment')
    const { escrow, trade, buyer, seller } = await fixture('PAYMENT_PENDING', '0.00000001')
    const arbiterUser = await newUser()
    await prisma.arbiterProfile.create({ data: { participantId: arbiterUser.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50 } })

    const dispute = await new DisputeService(marketArbitrationProvider).raiseDispute(trade.id, buyer.id, 'reason')

    expect(dispute.arbiterId).toEqual(expect.any(String))
    expect([buyer.id, seller.id]).not.toContain(dispute.arbiterId)
    expect(await prisma.arbiterProfile.findUnique({ where: { participantId: dispute.arbiterId! } })).not.toBeNull()
    expect((await durableState(escrow.id)).status).toBe('DISPUTED')
  })

  // ── concurrency ─────────────────────────────────────────────────────────────────────────────────

  it('ten concurrent openings by both parties: exactly one Dispute, one transition, one published event; losers get the existing rejections', async () => {
    pg.requirePostgres('concurrent openings')
    const { escrow, trade, buyer, seller, arbiter } = await fixture()
    const service = trusted(arbiter.id)

    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.raiseDispute(trade.id, i % 2 === 0 ? buyer.id : seller.id, `race-${i}`)))

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already transitioned by a concurrent request|Invalid escrow transition: DISPUTED → DISPUTED|already been raised/)
    }
    const state = await durableState(escrow.id)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toHaveLength(1)
    expect(state.disputes[0].arbiterId).toBe(arbiter.id)
    expect(state.transitions).toHaveLength(1)
    expect(state.published).toBe(1)
  })

  it('a dispute racing the cooperative release: whichever wins, DISPUTED holds iff its Dispute exists, and money moves at most once', async () => {
    pg.requirePostgres('dispute vs release')
    for (let round = 0; round < 5; round++) {
      const { escrow, trade, buyer, seller, arbiter } = await fixture()
      const [disputed, released] = await Promise.allSettled([
        trusted(arbiter.id).raiseDispute(trade.id, buyer.id, 'not paid'),
        escrowService.releaseFunds(escrow.id, 'buyer-addr', seller.id),
      ])
      const state = await durableState(escrow.id)
      expect([disputed.status, released.status].filter((s) => s === 'fulfilled')).toHaveLength(1)
      expect(state.status === 'DISPUTED').toBe(state.disputes.length === 1)
      expect(state.status).toBe(disputed.status === 'fulfilled' ? 'DISPUTED' : 'COMPLETED')
      if (disputed.status === 'rejected') expect(state.disputes).toEqual([])
    }
  })

  // ── retry / idempotency ─────────────────────────────────────────────────────────────────────────

  it('retry after a lost response: the committed opening is not repeated — existing "already disputed" rejection, still one Dispute', async () => {
    pg.requirePostgres('retry after commit')
    const { escrow, trade, buyer, arbiter } = await fixture()
    const service = trusted(arbiter.id)
    await service.raiseDispute(trade.id, buyer.id, 'first') // committed; the caller never saw the response

    await expect(service.raiseDispute(trade.id, buyer.id, 'retry')).rejects.toThrow(/Invalid escrow transition: DISPUTED → DISPUTED/)

    const state = await durableState(escrow.id)
    expect(state.disputes).toHaveLength(1)
    expect(state.transitions).toHaveLength(1)
  })

  it('retry after a rollback establishes the dispute normally', async () => {
    pg.requirePostgres('retry after rollback')
    const { escrow, trade, buyer, arbiter } = await fixture()
    await expect(new DisputeService(failingAssignment()).raiseDispute(trade.id, buyer.id, 'first')).rejects.toThrow()

    const dispute = await trusted(arbiter.id).raiseDispute(trade.id, buyer.id, 'retry')

    const state = await durableState(escrow.id)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toEqual([expect.objectContaining({ id: dispute.id, arbiterId: arbiter.id })])
    expect(state.transitions).toHaveLength(1)
  })

  // ── restart (independent module graph) ──────────────────────────────────────────────────────────

  it('restart after a failure before commit: the fresh process sees neither half, and can open the dispute', async () => {
    pg.requirePostgres('restart after rollback')
    const { escrow, trade, seller, arbiter } = await fixture()
    await expect(new DisputeService(failingAssignment()).raiseDispute(trade.id, seller.id, 'first')).rejects.toThrow()

    const fresh = restarted!
    await expectUntouched(escrow.id, 'PAYMENT_PENDING', fresh.prisma)
    await new fresh.DisputeService(new fresh.TrustedArbitratorProvider([arbiter.id])).raiseDispute(trade.id, seller.id, 'after restart')
    const state = await durableState(escrow.id, fresh.prisma)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toHaveLength(1)
  })

  it('restart after a successful commit: the fresh process sees both halves, and does not open a second dispute', async () => {
    pg.requirePostgres('restart after commit')
    const { escrow, trade, buyer, arbiter } = await fixture()
    await trusted(arbiter.id).raiseDispute(trade.id, buyer.id, 'before restart')

    const fresh = restarted!
    const state = await durableState(escrow.id, fresh.prisma)
    expect(state.status).toBe('DISPUTED')
    expect(state.disputes).toEqual([expect.objectContaining({ arbiterId: arbiter.id, status: 'OPENED' })])
    await expect(new fresh.DisputeService(new fresh.TrustedArbitratorProvider([arbiter.id])).raiseDispute(trade.id, buyer.id, 'again'))
      .rejects.toThrow(/Invalid escrow transition: DISPUTED → DISPUTED/)
    expect((await durableState(escrow.id, fresh.prisma)).disputes).toHaveLength(1)
  })
})
