// tests/integration/settlementProvenanceFailClosed.test.ts
//
// Gatekeeper NO-GO on #576: a settlement event with no immutable provenance on an escrow that has a Dispute
// must not be classified from the Dispute row's current state. MULTISIG is the case that matters: it is the
// production rail, and a legacy event may carry none of the three immutable sources.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HELD_KEY = 'settlement.provenance-held'

describe('settlement provenance fails closed on an event with no immutable evidence (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }
  const userOf = async (id: string) => (await prisma.user.findUnique({ where: { id } }))!
  const makeUser = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })

  type Kind = 'RELEASE' | 'REFUND'
  const terminal = (kind: Kind) => (kind === 'RELEASE' ? 'COMPLETED' : 'REFUNDED')
  const eventOf = (kind: Kind) => (kind === 'RELEASE' ? 'settlement.escrow.released' : 'settlement.escrow.refunded')

  // A settled MULTISIG escrow with none of the immutable sources: no semantic record, no authorization.
  async function makeLegacyMultisig(kind: Kind, disputeStatus: 'RESOLVED' | 'APPEALED' | null) {
    const [buyer, seller, arbiter] = await Promise.all([makeUser(), makeUser(), makeUser()])
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', status: terminal(kind), lockedAmount: '0.001', asset: 'BTC', txReleaseId: `tx-${randomUUID()}` } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    if (disputeStatus) {
      await prisma.dispute.create({
        data: disputeStatus === 'RESOLVED'
          ? { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'legacy', arbiterId: arbiter.id, status: 'RESOLVED', ruling: kind, resolvedAt: new Date() }
          : { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'legacy', arbiterId: arbiter.id, status: 'APPEALED', appealRound: 1, previousRuling: kind, previousArbiterId: arbiter.id },
      })
    }
    return { buyer, seller, trade, escrow }
  }

  async function deliver(fixture: Awaited<ReturnType<typeof makeLegacyMultisig>>, kind: Kind) {
    const { escrow, trade, seller } = fixture
    await emitEscrowTransition(escrow.id, trade.id, 'DISPUTED', terminal(kind), seller.id, eventOf(kind) as never, { txId: escrow.txReleaseId })
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: terminal(kind) } }))!
    await waitFor(async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) > 0)
    return transition.id
  }

  const outcomeClaims = (transitionId: string) => prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: 'reputation.outcome' } })

  it.each([
    ['RELEASE', 'RESOLVED'], ['RELEASE', 'APPEALED'],
    ['REFUND', 'RESOLVED'], ['REFUND', 'APPEALED'],
  ] as const)('MULTISIG %s, dispute %s, no immutable provenance: no reputation effect, the rest of the settlement projects, the case is held', async (kind, status) => {
    pg.requirePostgres(`legacy ${kind} ${status}`)
    const fixture = await makeLegacyMultisig(kind, status)

    const transitionId = await deliver(fixture, kind)

    expect((await userOf(fixture.buyer.id)).reputationScore).toBe(0)
    expect((await userOf(fixture.seller.id)).reputationScore).toBe(0)
    expect(await outcomeClaims(transitionId)).toBe(0)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: HELD_KEY } })).toBe(1)
    expect((await prisma.trade.findUnique({ where: { id: fixture.trade.id } }))!.status).toBe(kind === 'RELEASE' ? 'COMPLETED' : 'CANCELLED')
  })

  it('replay, concurrent redelivery and an appeal after delivery do not change a held case', async () => {
    pg.requirePostgres('held replay')
    const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
    const transitionId = await deliver(fixture, 'RELEASE')
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: 'settlement.escrow.released' } }))!

    await prisma.dispute.updateMany({ where: { escrowId: fixture.escrow.id }, data: { status: 'APPEALED', appealRound: 1, ruling: null } })
    await Promise.all([eventBus.redeliver(durable.id), eventBus.redeliver(durable.id), eventBus.redeliver(durable.id)])
    await sleep(500)

    expect((await userOf(fixture.seller.id)).reputationScore).toBe(0)
    expect(await outcomeClaims(transitionId)).toBe(0)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: HELD_KEY } })).toBe(1)
  })

  it('an escrow that was never disputed stays cooperative and is not held', async () => {
    pg.requirePostgres('never disputed')
    const fixture = await makeLegacyMultisig('RELEASE', null)

    const transitionId = await deliver(fixture, 'RELEASE')

    expect((await userOf(fixture.buyer.id)).reputationScore).toBe(2)
    expect((await userOf(fixture.seller.id)).reputationScore).toBe(2)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: HELD_KEY } })).toBe(0)
  })
})
