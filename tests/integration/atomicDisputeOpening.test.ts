// tests/integration/atomicDisputeOpening.test.ts
//
// Issue #238 - real PostgreSQL proof that `Escrow -> DISPUTED` holds iff the canonical Dispute row exists:
//   - a failure at any step of the opening rolls back the status claim, the hash-chained transition, its
//     pending-publication marker and the Dispute row together;
//   - buyer and seller opening concurrently produce one Dispute and one transition;
//   - a process that dies after the commit leaves a dispute no one can rule on or move funds for, until
//     recoverUnassignedDisputes() assigns its arbiter exactly once (the script-committed one when it exists);
//   - a lost 'settlement.escrow.disputed' publication is re-driven by PASS 3, unchanged.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import type { ArbitrationProvider } from '../../src/modules/open-settlement/arbitration-provider'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #238 - dispute opening is atomic with the escrow freeze (real PostgreSQL)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let lifecycle: typeof import('../../src/modules/open-settlement/escrow-lifecycle')
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let reconcileIncompleteProjections: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    lifecycle = require('../../src/modules/open-settlement/escrow-lifecycle')
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  afterEach(() => jest.restoreAllMocks())

  const provider = (arbiterId: string): ArbitrationProvider & { assign: jest.Mock } =>
    ({ name: 'test-provider', arbitrators: [arbiterId], assign: jest.fn(async () => arbiterId) }) as any
  // A provider that cannot staff the dispute: stands in for a process dying before assignment, a provider
  // outage, or market mode with no eligible arbiter (the same refusal MarketArbitrationProvider.assign() raises).
  const unstaffable = (): ArbitrationProvider & { assign: jest.Mock } =>
    ({ name: 'test-unstaffable', arbitrators: [], assign: jest.fn(async () => { throw new Error('no registered arbiter clears the eligibility threshold') }) }) as any

  async function makeLockedTrade(type: 'MOCK' | 'MULTISIG' = 'MOCK') {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'FUNDS_LOCKED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }

  async function openingState(escrowId: string, tradeId: string) {
    const [escrow, disputes, transitions] = await Promise.all([
      prisma.escrow.findUnique({ where: { id: escrowId } }),
      prisma.dispute.findMany({ where: { tradeId } }),
      prisma.escrowEvent.findMany({ where: { escrowId, toStatus: 'DISPUTED' } }),
    ])
    const markers = await prisma.eventProjectionClaim.count({ where: { eventId: { in: transitions.map((t) => t.id) }, projectionKey: 'transition.claimed' } })
    return { status: escrow!.status, disputes, transitions: transitions.length, markers }
  }

  const disputedEvents = (tradeId: string) =>
    prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.disputed' } })

  it('opens atomically: DISPUTED, one transition, its pending marker and the Dispute row, with the assigned arbiter', async () => {
    pg.requirePostgres('atomic opening')
    const ctx = await makeLockedTrade()

    const dispute = await new DisputeService(provider('arb-1')).raiseDispute(ctx.tradeId, ctx.buyerId, 'paid, not received')

    const state = await openingState(ctx.escrowId, ctx.tradeId)
    expect(state).toEqual({ status: 'DISPUTED', disputes: [expect.objectContaining({ id: dispute.id, arbiterId: 'arb-1', openedBy: ctx.buyerId })], transitions: 1, markers: 1 })
    expect(dispute.arbiterId).toBe('arb-1')
    expect(await disputedEvents(ctx.tradeId)).toBe(1)
  })

  it('ROLLBACK: a failure creating the Dispute row leaves the escrow, its hash chain and its markers untouched', async () => {
    pg.requirePostgres('rollback at dispute insert')
    const ctx = await makeLockedTrade()

    await expect(
      escrowService.openDispute(ctx.escrowId, ctx.buyerId, 'reason', async () => { throw new Error('crash before the Dispute insert') })
    ).rejects.toThrow('crash before the Dispute insert')

    expect(await openingState(ctx.escrowId, ctx.tradeId)).toEqual({ status: 'FUNDS_LOCKED', disputes: [], transitions: 0, markers: 0 })
    expect(await disputedEvents(ctx.tradeId)).toBe(0)
  })

  it('ROLLBACK: a failure right after the transition and its marker are written rolls the status claim back too', async () => {
    pg.requirePostgres('rollback after transition write')
    const ctx = await makeLockedTrade()
    const real = lifecycle.recordEscrowTransition
    jest.spyOn(lifecycle, 'recordEscrowTransition').mockImplementationOnce(async (...args) => {
      await real(...args)
      throw new Error('crash after the transition write')
    })

    await expect(new DisputeService(provider('arb-1')).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')).rejects.toThrow('crash after the transition write')

    expect(await openingState(ctx.escrowId, ctx.tradeId)).toEqual({ status: 'FUNDS_LOCKED', disputes: [], transitions: 0, markers: 0 })
  })

  it('ROLLBACK: an existing Dispute row for the trade (unique tradeId) refuses cleanly and freezes nothing', async () => {
    pg.requirePostgres('unique dispute guard')
    const ctx = await makeLockedTrade()
    await prisma.dispute.create({ data: { tradeId: ctx.tradeId, escrowId: ctx.escrowId, openedBy: ctx.sellerId, reason: 'legacy row', status: 'OPENED' } })

    await expect(new DisputeService(provider('arb-1')).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')).rejects.toThrow(/already been raised/)

    const state = await openingState(ctx.escrowId, ctx.tradeId)
    expect({ status: state.status, disputes: state.disputes.length, transitions: state.transitions, markers: state.markers }).toEqual({ status: 'FUNDS_LOCKED', disputes: 1, transitions: 0, markers: 0 })
  })

  it('CONCURRENCY: buyer and seller opening at once produce exactly one Dispute and one transition', async () => {
    pg.requirePostgres('buyer/seller race')
    const ctx = await makeLockedTrade()
    const service = new DisputeService(provider('arb-1'))

    const results = await Promise.allSettled([
      service.raiseDispute(ctx.tradeId, ctx.buyerId, 'buyer reason'),
      service.raiseDispute(ctx.tradeId, ctx.sellerId, 'seller reason'),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const state = await openingState(ctx.escrowId, ctx.tradeId)
    expect({ status: state.status, disputes: state.disputes.length, transitions: state.transitions, markers: state.markers }).toEqual({ status: 'DISPUTED', disputes: 1, transitions: 1, markers: 1 })
    expect(await disputedEvents(ctx.tradeId)).toBe(1)
  })

  it('AUTHORIZATION: a non-party cannot open a dispute, and nothing is written', async () => {
    pg.requirePostgres('non-party')
    const ctx = await makeLockedTrade()
    const stranger = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })

    await expect(new DisputeService(provider('arb-1')).raiseDispute(ctx.tradeId, stranger.id, 'reason')).rejects.toThrow(/not a party/)

    expect(await openingState(ctx.escrowId, ctx.tradeId)).toEqual({ status: 'FUNDS_LOCKED', disputes: [], transitions: 0, markers: 0 })
  })

  it('POST-COMMIT FAILURE: an unassigned dispute is fail-closed until recovery assigns its arbiter exactly once', async () => {
    pg.requirePostgres('post-commit arbiter recovery')
    const ctx = await makeLockedTrade()

    await expect(new DisputeService(unstaffable()).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')).rejects.toThrow(/eligibility threshold/)
    const [opened] = (await openingState(ctx.escrowId, ctx.tradeId)).disputes
    expect(opened.arbiterId).toBeNull()
    expect((await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!.status).toBe('DISPUTED')

    // Fail-closed: no ruling by anyone, and the seller's ordinary disposition authority is suspended.
    await expect(new DisputeService(provider('arb-1')).resolveDispute(opened.id, 'arb-1', 'RELEASE', undefined, undefined, undefined, 'sig', new Date().toISOString()))
      .rejects.toThrow(/not the arbiter assigned/)
    await expect(escrowService.releaseFunds(ctx.escrowId, undefined, ctx.sellerId)).rejects.toThrow(/not the current assigned arbiter/)

    // A provider that still cannot staff it reports a failure and changes nothing; the escrow is not released.
    const stillUnstaffable = await new DisputeService(unstaffable()).recoverUnassignedDisputes(0)
    expect(stillUnstaffable.failed.find((f) => f.disputeId === opened.id)?.error).toMatch(/eligibility threshold/)
    expect((await prisma.dispute.findUnique({ where: { id: opened.id } }))!.arbiterId).toBeNull()
    expect((await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!.status).toBe('DISPUTED')

    // Recovery with a provider that can staff it assigns once and announces it.
    const emit = jest.spyOn(eventBus, 'emit')
    const first = await new DisputeService(provider('arb-recovered')).recoverUnassignedDisputes(0)
    expect(first.recovered).toContain(opened.id)
    expect((await prisma.dispute.findUnique({ where: { id: opened.id } }))!.arbiterId).toBe('arb-recovered')
    expect(emit).toHaveBeenCalledWith('dispute.opened', expect.objectContaining({ disputeId: opened.id, arbiterId: 'arb-recovered', triggeredBy: ctx.buyerId }), ctx.tradeId)

    // Idempotent: a later tick, even under a provider that would pick someone else, replaces nothing.
    const again = await new DisputeService(provider('arb-other')).recoverUnassignedDisputes(0)
    expect(again.recovered).not.toContain(opened.id)
    expect((await prisma.dispute.findUnique({ where: { id: opened.id } }))!.arbiterId).toBe('arb-recovered')
  })

  it('RECOVERY RACE: two concurrent recoverers with different picks persist exactly one arbiter and announce once', async () => {
    pg.requirePostgres('concurrent recovery')
    const ctx = await makeLockedTrade()
    await expect(new DisputeService(unstaffable()).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')).rejects.toThrow()
    const [opened] = (await openingState(ctx.escrowId, ctx.tradeId)).disputes

    const [a, b] = await Promise.all([
      new DisputeService(provider('arb-a')).recoverUnassignedDisputes(0),
      new DisputeService(provider('arb-b')).recoverUnassignedDisputes(0),
    ])

    const winners = [...a.recovered, ...b.recovered].filter((id) => id === opened.id)
    expect(winners).toHaveLength(1)
    const persisted = (await prisma.dispute.findUnique({ where: { id: opened.id } }))!.arbiterId
    expect(persisted).toBe(a.recovered.includes(opened.id) ? 'arb-a' : 'arb-b')
  })

  it('RECOVERY never touches an assigned or appealed dispute, or one younger than its grace period', async () => {
    pg.requirePostgres('recovery scope')
    const assigned = await makeLockedTrade()
    const d1 = await new DisputeService(provider('arb-1')).raiseDispute(assigned.tradeId, assigned.buyerId, 'reason')
    const young = await makeLockedTrade()
    await expect(new DisputeService(unstaffable()).raiseDispute(young.tradeId, young.buyerId, 'reason')).rejects.toThrow()
    const [d2] = (await openingState(young.escrowId, young.tradeId)).disputes

    const result = await new DisputeService(provider('arb-other')).recoverUnassignedDisputes(60_000)

    expect(result.recovered).not.toContain(d1.id)
    expect(result.recovered).not.toContain(d2.id) // still inside the grace period: a live opening may be finishing
    expect((await prisma.dispute.findUnique({ where: { id: d1.id } }))!.arbiterId).toBe('arb-1')
    expect((await prisma.dispute.findUnique({ where: { id: d2.id } }))!.arbiterId).toBeNull()
  })

  it('MULTISIG: the script-committed arbiter is written in the opening transaction, and recovery only ever uses it', async () => {
    pg.requirePostgres('committed arbiter')
    const ctx = await makeLockedTrade('MULTISIG')
    await prisma.escrowParticipantKey.create({ data: { escrowId: ctx.escrowId, role: 'arbiter', participantId: 'arb-committed', pubkey: `02${'11'.repeat(32)}` } })
    const wouldPickOther = unstaffable()

    const dispute = await new DisputeService(wouldPickOther).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')

    expect(dispute.arbiterId).toBe('arb-committed')
    expect(wouldPickOther.assign).not.toHaveBeenCalled()

    // A pre-#238 crash could have left a committed rail unassigned; recovery restores the commitment, never a pick.
    const legacy = await makeLockedTrade('MULTISIG')
    await prisma.escrowParticipantKey.create({ data: { escrowId: legacy.escrowId, role: 'arbiter', participantId: 'arb-legacy-committed', pubkey: `02${'22'.repeat(32)}` } })
    await prisma.escrow.update({ where: { id: legacy.escrowId }, data: { status: 'DISPUTED' } })
    const unassigned = await prisma.dispute.create({ data: { tradeId: legacy.tradeId, escrowId: legacy.escrowId, openedBy: legacy.buyerId, reason: 'legacy', status: 'OPENED' } })
    const picker = provider('arb-picked-instead')

    const result = await new DisputeService(picker).recoverUnassignedDisputes(0)

    expect(result.recovered).toContain(unassigned.id)
    expect(picker.assign).not.toHaveBeenCalledWith(unassigned.id, expect.anything()) // the sweep also staffs other files' leftovers
    expect((await prisma.dispute.findUnique({ where: { id: unassigned.id } }))!.arbiterId).toBe('arb-legacy-committed')
  })

  it('RESTART: a publication lost after the commit is re-driven by PASS 3, applying the dispute count once', async () => {
    pg.requirePostgres('lost publication')
    const ctx = await makeLockedTrade()
    jest.spyOn(lifecycle, 'publishEscrowTransition').mockImplementationOnce(async () => { throw new Error('process died before publishing') })

    await expect(new DisputeService(provider('arb-1')).raiseDispute(ctx.tradeId, ctx.buyerId, 'reason')).rejects.toThrow('process died before publishing')

    const state = await openingState(ctx.escrowId, ctx.tradeId)
    expect({ status: state.status, disputes: state.disputes.length, transitions: state.transitions, markers: state.markers }).toEqual({ status: 'DISPUTED', disputes: 1, transitions: 1, markers: 1 })
    expect(await disputedEvents(ctx.tradeId)).toBe(0)

    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'DISPUTED' } }))!
    const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(report, 0)
    expect(report.projectionsRecovered.filter((r: any) => r.transitionId === transition.id)).toEqual([{ escrowId: ctx.escrowId, transitionId: transition.id, action: 'REPUBLISHED' }])
    for (let i = 0; i < 100 && !(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })); i++) await sleep(50)

    expect(await disputedEvents(ctx.tradeId)).toBe(1)
    const [buyer, seller] = await Promise.all([prisma.user.findUnique({ where: { id: ctx.buyerId } }), prisma.user.findUnique({ where: { id: ctx.sellerId } })])
    expect([buyer!.disputeCount, seller!.disputeCount]).toEqual([1, 1])

    // The arbiter the lost process never assigned is then finished by the arbiter recovery, independently.
    expect((await new DisputeService(provider('arb-1')).recoverUnassignedDisputes(0)).recovered).toContain(state.disputes[0].id)
  })
})
