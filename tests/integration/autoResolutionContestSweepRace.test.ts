// tests/integration/autoResolutionContestSweepRace.test.ts
//
// #308 / CSC-F02 — real-Postgres evidence that contestAutoResolution() and
// sweepExpiredAutoResolutions() can never BOTH apply the AUTO_PROPOSED ->
// EVIDENCE_SUBMITTED transition to the same dispute. Before the fix both
// paths did a plain read, an application-level deadline check, then an
// unconditional `prisma.dispute.update()`, so a contest that passed its
// fail-fast read just before the deadline and a sweep that ran just after
// it would both write and both emit `dispute.auto_resolution_contested`.
//
// Fixture rows (User/Offer/Trade/Escrow/Dispute) are created directly; no
// settlement provider is exercised.

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('#308 contest vs sweep — exactly one transition, exactly one event (real Postgres)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  afterEach(() => jest.restoreAllMocks())

  const noProvider = {
    name: 'test-none',
    arbitrators: [] as string[],
    async assign(): Promise<string> { throw new Error('not used by this fixture') },
    async assignAppealPanel(): Promise<string> { throw new Error('not used by this fixture') },
  }

  let seq = 0
  async function makeAutoProposed(suffix: string, deadline: Date) {
    seq += 1
    const uniq = `${suffix}-${Date.now()}-${seq}`
    const seller = await prisma.user.create({ data: { id: `seller-${uniq}`, publicKey: `pk-seller-${uniq}` } })
    const buyer = await prisma.user.create({ data: { id: `buyer-${uniq}`, publicKey: `pk-buyer-${uniq}` } })
    const arbiter = await prisma.user.create({ data: { id: `arbiter-${uniq}`, publicKey: `pk-arbiter-${uniq}` } })
    const offer = await prisma.offer.create({
      data: {
        id: `offer-${uniq}`, userId: seller.id, asset: 'BTC', side: 'SELL',
        priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE',
      },
    })
    const trade = await prisma.trade.create({
      data: {
        id: `trade-${uniq}`, offerId: offer.id, buyerId: buyer.id, sellerId: seller.id,
        amount: '0.001', asset: 'BTC', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED',
      },
    })
    const escrow = await prisma.escrow.create({
      data: {
        id: `escrow-${uniq}`, tradeId: trade.id, type: 'MOCK', status: 'DISPUTED',
        lockedAmount: '0.001', asset: 'BTC', feeCharged: '0',
      },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: {
        id: `dispute-${uniq}`, tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: '#308 race',
        arbiterId: arbiter.id, status: 'AUTO_PROPOSED', appealRound: 0,
        autoResolutionRecommendation: 'RELEASE', autoResolutionConfidence: 0.9,
        autoResolutionReasoning: 'fixture', autoResolutionDeadline: deadline,
      },
    })
    return { dispute, trade, buyer, seller, service: new DisputeService(noProvider) }
  }

  function contestedEventsFor(spy: jest.SpyInstance, disputeId: string): number {
    return spy.mock.calls.filter(
      (c) => c[0] === 'dispute.auto_resolution_contested' && (c[1] as { disputeId: string }).disputeId === disputeId,
    ).length
  }

  it('deterministic interleaving: contest passes its fail-fast read, the deadline expires, the sweep wins — the late contest must NOT also transition or emit', async () => {
    pg.requirePostgres('deterministic interleaving')
    const { dispute, buyer, service } = await makeAutoProposed('interleave', new Date(Date.now() + 400))
    const emitSpy = jest.spyOn(eventBus, 'emit')

    // Pause contestAutoResolution() right after its first (fail-fast) read
    // of the dispute row — the exact window the pre-fix code was exposed in.
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const realFindUnique = prisma.dispute.findUnique.bind(prisma.dispute)
    let firstCall = true
    jest.spyOn(prisma.dispute, 'findUnique').mockImplementation(((args: unknown) => {
      const result = realFindUnique(args as never)
      if (firstCall) {
        firstCall = false
        return result.then(async (row: unknown) => { await barrier; return row })
      }
      return result
    }) as never)

    const contest = service.contestAutoResolution(dispute.id, buyer.id).then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, message: err.message }),
    )

    await new Promise((r) => setTimeout(r, 700)) // deadline (400ms) is now in the past
    const sweep = await service.sweepExpiredAutoResolutions()
    expect(sweep.revertedToHuman).toContain(dispute.id)

    release()
    const contestResult = await contest

    expect(contestResult.ok).toBe(false)
    expect(contestedEventsFor(emitSpy, dispute.id)).toBe(1) // only the sweep's event

    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    expect(row?.status).toBe('EVIDENCE_SUBMITTED')
  })

  it('idempotence: re-running the sweep, or contesting after it, changes nothing and emits nothing more', async () => {
    pg.requirePostgres('idempotence')
    const { dispute, buyer, service } = await makeAutoProposed('idem', new Date(Date.now() - 1000))
    const emitSpy = jest.spyOn(eventBus, 'emit')

    const first = await service.sweepExpiredAutoResolutions()
    expect(first.revertedToHuman).toContain(dispute.id)
    const second = await service.sweepExpiredAutoResolutions()
    expect(second.revertedToHuman).not.toContain(dispute.id)
    await expect(service.contestAutoResolution(dispute.id, buyer.id)).rejects.toThrow(/no pending automated resolution/)

    expect(contestedEventsFor(emitSpy, dispute.id)).toBe(1)
    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    expect(row?.status).toBe('EVIDENCE_SUBMITTED')
  })

  it('stress: both trade parties contest at the same instant, many rounds — exactly one wins, exactly one event, never two', async () => {
    pg.requirePostgres('two concurrent contests')
    const emitSpy = jest.spyOn(eventBus, 'emit')
    for (let i = 0; i < 12; i++) {
      const { dispute, buyer, seller, service } = await makeAutoProposed(`dual-${i}`, new Date(Date.now() + 60_000))
      const outcomes = await Promise.allSettled([
        service.contestAutoResolution(dispute.id, buyer.id),
        service.contestAutoResolution(dispute.id, seller.id),
      ])
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      expect(contestedEventsFor(emitSpy, dispute.id)).toBe(1)
      const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
      expect(row?.status).toBe('EVIDENCE_SUBMITTED')
    }
  })

  it('stress: contest racing the sweep around the deadline, many rounds — at most one transition per dispute, final state always EVIDENCE_SUBMITTED', async () => {
    pg.requirePostgres('contest vs sweep near deadline')
    const emitSpy = jest.spyOn(eventBus, 'emit')
    for (let i = 0; i < 12; i++) {
      const { dispute, buyer, service } = await makeAutoProposed(`edge-${i}`, new Date(Date.now() + 120 + i * 5))
      await new Promise((r) => setTimeout(r, 110 + i * 5))
      await Promise.allSettled([
        service.contestAutoResolution(dispute.id, buyer.id),
        service.sweepExpiredAutoResolutions(),
        service.sweepExpiredAutoResolutions(),
      ])
      // Let a still-eligible dispute (deadline not yet past in this round) expire and be swept.
      await new Promise((r) => setTimeout(r, 120))
      await service.sweepExpiredAutoResolutions()
      expect(contestedEventsFor(emitSpy, dispute.id)).toBe(1)
      const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
      expect(row?.status).toBe('EVIDENCE_SUBMITTED')
    }
  })
})
