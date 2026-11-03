// tests/integration/settlementProvenanceFailClosed.test.ts
//
// Gatekeeper NO-GO on #576: a settlement event with no immutable provenance on an escrow that has a Dispute
// must not be classified from the Dispute row's current state. MULTISIG is the case that matters: it is the
// production rail, and a legacy event may carry none of the three immutable sources.

import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import path from 'path'
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

  async function deliver(fixture: Awaited<ReturnType<typeof makeLegacyMultisig>>, kind: Kind, from = 'DISPUTED') {
    const { escrow, trade, seller } = fixture
    await emitEscrowTransition(escrow.id, trade.id, from, terminal(kind), seller.id, eventOf(kind) as never, { txId: escrow.txReleaseId })
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

  describe('a held case stays visible and has one way out', () => {
    let resolve: typeof import('../../src/common/events/settlement-provenance').resolveHeldSettlementProvenance
    let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
    let reputationService: typeof import('../../src/modules/open-reputation/reputation.service').reputationService

    beforeAll(() => {
      if (!dbAvailable) return
      ;({ resolveHeldSettlementProvenance: resolve } = require('../../src/common/events/settlement-provenance'))
      ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
      ;({ reputationService } = require('../../src/modules/open-reputation/reputation.service'))
    })

    const decision = (effectId: string, value: 'DISPUTED' | 'COOPERATIVE') => ({ effectId, decision: value, decidedBy: 'operator', evidence: 'ticket-1' })
    const reviewed = async (escrowId: string) => (await reconcilePendingSettlements({ projectionGraceMs: 60_000 })).requiresManualReview.filter((r) => r.escrowId === escrowId)

    it('the reconciler reports it on every tick until it is decided, and the decision is durable', async () => {
      pg.requirePostgres('held visibility')
      const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
      const effectId = await deliver(fixture, 'RELEASE')

      expect(await reviewed(fixture.escrow.id)).toHaveLength(1)
      expect(await reviewed(fixture.escrow.id)).toHaveLength(1)

      await resolve(decision(effectId, 'DISPUTED'))

      expect(await reviewed(fixture.escrow.id)).toHaveLength(0)
      expect((await userOf(fixture.buyer.id)).reputationScore).toBe(2)
      expect((await userOf(fixture.seller.id)).reputationScore).toBe(-5)
      const audit = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: 'settlement.provenance.resolved' } }))!
      expect(audit.payload).toMatchObject({ transitionId: effectId, decision: 'DISPUTED', decidedBy: 'operator', evidence: 'ticket-1' })
    })

    it.each([['RELEASE', 2, 2], ['REFUND', 0, 0]] as const)('a COOPERATIVE decision on a %s applies the cooperative outcome once, also on replay', async (kind, buyer, seller) => {
      pg.requirePostgres(`cooperative decision ${kind}`)
      const fixture = await makeLegacyMultisig(kind, 'APPEALED')
      const effectId = await deliver(fixture, kind)
      const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: eventOf(kind) } }))!

      await resolve(decision(effectId, 'COOPERATIVE'))
      await resolve(decision(effectId, 'COOPERATIVE'))
      await eventBus.redeliver(durable.id)
      await sleep(300)

      expect((await userOf(fixture.buyer.id)).reputationScore).toBe(buyer)
      expect((await userOf(fixture.seller.id)).reputationScore).toBe(seller)
      expect(await outcomeClaims(effectId)).toBe(2)
    })

    it('two concurrent, conflicting decisions: one wins, and only its outcome is applied', async () => {
      pg.requirePostgres('conflicting decisions')
      const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
      const effectId = await deliver(fixture, 'RELEASE')

      const results = await Promise.allSettled([resolve(decision(effectId, 'DISPUTED')), resolve(decision(effectId, 'COOPERATIVE'))])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const won = (await prisma.eventProjectionClaim.findFirstOrThrow({ where: { eventId: effectId, projectionKey: 'settlement.provenance-decision' } })).subjectId
      expect((await userOf(fixture.seller.id)).reputationScore).toBe(won === 'DISPUTED' ? -5 : 2)
      expect(await outcomeClaims(effectId)).toBe(2)
    })

    it('a crash after the decision: the case stays listed, the same decision finishes, a different one is refused', async () => {
      pg.requirePostgres('crash after decision')
      const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
      const effectId = await deliver(fixture, 'RELEASE')
      jest.spyOn(reputationService, 'recordOutcomeOnce').mockRejectedValueOnce(new Error('crash'))

      await expect(resolve(decision(effectId, 'DISPUTED'))).rejects.toThrow('crash')
      expect(await reviewed(fixture.escrow.id)).toHaveLength(1)

      await expect(resolve(decision(effectId, 'COOPERATIVE'))).rejects.toThrow(/already decided/)
      await resolve(decision(effectId, 'DISPUTED'))

      expect((await userOf(fixture.seller.id)).reputationScore).toBe(-5)
      expect(await reviewed(fixture.escrow.id)).toHaveLength(0)
    })

    it('a decision cannot contradict durable evidence, needs a stated reason, and only applies to a held case', async () => {
      pg.requirePostgres('decision guards')
      const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
      const effectId = await deliver(fixture, 'RELEASE')
      const dispute = (await prisma.dispute.findFirst({ where: { escrowId: fixture.escrow.id } }))!
      await prisma.economicDispositionAuthorization.create({
        data: { pendingOperationId: randomUUID(), escrowId: fixture.escrow.id, disputeId: dispute.id, appealRound: 0, arbiterId: dispute.arbiterId!, ruling: 'RELEASE', operationDigest: 'digest' },
      })

      await expect(resolve(decision(effectId, 'COOPERATIVE'))).rejects.toThrow(/contradicts durable evidence/)
      await expect(resolve({ ...decision(effectId, 'DISPUTED'), evidence: ' ' })).rejects.toThrow(/requires decidedBy and evidence/)
      await expect(resolve(decision(randomUUID(), 'DISPUTED'))).rejects.toThrow()
      expect(await outcomeClaims(effectId)).toBe(0)
    })

    it('the operator CLI only lists without arguments and writes nothing without --apply', async () => {
      pg.requirePostgres('operator CLI')
      const fixture = await makeLegacyMultisig('RELEASE', 'RESOLVED')
      const effectId = await deliver(fixture, 'RELEASE')
      const cli = (...args: string[]) => spawnSync('npx', ['ts-node', '--transpile-only', 'scripts/resolve-held-settlement-provenance.ts', ...args], {
        cwd: path.resolve(__dirname, '../..'), shell: true, encoding: 'utf8', maxBuffer: 1 << 26,
      })

      const listed = cli()
      expect(listed.status).toBe(0)
      expect(listed.stdout).toContain(effectId)

      const dry = cli('--effect', effectId, '--decision', 'DISPUTED', '--decided-by', 'operator', '--evidence', 'ticket-1')
      expect(dry.stdout).toContain('Dry run')
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: effectId, projectionKey: 'settlement.provenance-decision' } })).toBe(0)

      const applied = cli('--effect', effectId, '--decision', 'DISPUTED', '--decided-by', 'operator', '--evidence', 'ticket-1', '--apply')
      expect(applied.status).toBe(0)
      expect((await userOf(fixture.seller.id)).reputationScore).toBe(-5)
    })
  })

  // Gatekeeper NO-GO on 85870e85: the absence of a Dispute row is not proof a settlement was cooperative.
  const heldCount = (transitionId: string) => prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: HELD_KEY } })
  async function openedDisputeThenDeleted(kind: Kind) {
    const fixture = await makeLegacyMultisig(kind, 'RESOLVED')
    await emitEscrowTransition(fixture.escrow.id, fixture.trade.id, 'CREATED', 'FUNDS_LOCKED', fixture.seller.id, 'settlement.escrow.locked' as never, {})
    await emitEscrowTransition(fixture.escrow.id, fixture.trade.id, 'FUNDS_LOCKED', 'DISPUTED', fixture.buyer.id, 'settlement.escrow.disputed' as never, {})
    await prisma.dispute.deleteMany({ where: { escrowId: fixture.escrow.id } })
    return fixture
  }

  it.each(['RELEASE', 'REFUND'] as const)('MULTISIG %s after its dispute row was deleted: held, also on replay, never cooperative', async (kind) => {
    pg.requirePostgres(`deleted dispute ${kind}`)
    const fixture = await openedDisputeThenDeleted(kind)

    const transitionId = await deliver(fixture, kind)
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: eventOf(kind) } }))!
    await Promise.all([eventBus.redeliver(durable.id), eventBus.redeliver(durable.id)])
    await sleep(300)

    expect((await userOf(fixture.buyer.id)).reputationScore).toBe(0)
    expect((await userOf(fixture.seller.id)).reputationScore).toBe(0)
    expect(await outcomeClaims(transitionId)).toBe(0)
    expect(await heldCount(transitionId)).toBe(1)
  })

  it('a deleted dispute whose DISPUTED transition was deleted too breaks the chain: held', async () => {
    pg.requirePostgres('deleted dispute and transition')
    const fixture = await openedDisputeThenDeleted('RELEASE')
    const transitionId = await deliver(fixture, 'RELEASE')
    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: transitionId } })
    await prisma.escrowEvent.deleteMany({ where: { escrowId: fixture.escrow.id, toStatus: 'DISPUTED' } })
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: 'settlement.escrow.released' } }))!

    await eventBus.redeliver(durable.id)
    await waitFor(async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0)

    expect((await userOf(fixture.seller.id)).reputationScore).toBe(0)
    expect(await heldCount(transitionId)).toBe(1)
  })

  it('a DISPUTED transition rewritten in place to look undisputed no longer matches its hash: held', async () => {
    pg.requirePostgres('rewritten transition')
    const fixture = await openedDisputeThenDeleted('RELEASE')
    await prisma.escrowEvent.updateMany({ where: { escrowId: fixture.escrow.id, toStatus: 'DISPUTED' }, data: { toStatus: 'PAYMENT_PENDING' } })

    const transitionId = await deliver(fixture, 'RELEASE', 'PAYMENT_PENDING')

    expect((await userOf(fixture.seller.id)).reputationScore).toBe(0)
    expect(await heldCount(transitionId)).toBe(1)
  })

  it('a legacy history with an unhashed transition proves nothing: held', async () => {
    pg.requirePostgres('legacy unhashed history')
    const fixture = await makeLegacyMultisig('REFUND', null)
    await prisma.escrowEvent.create({ data: { escrowId: fixture.escrow.id, fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED', triggeredBy: fixture.seller.id } })

    const transitionId = await deliver(fixture, 'REFUND', 'FUNDS_LOCKED')

    expect(await outcomeClaims(transitionId)).toBe(0)
    expect(await heldCount(transitionId)).toBe(1)
  })

  it.each(['RELEASE', 'REFUND'] as const)('a %s whose hash chain proves it never entered DISPUTED stays cooperative, once, also on replay', async (kind) => {
    pg.requirePostgres(`never disputed ${kind}`)
    const fixture = await makeLegacyMultisig(kind, null)
    await emitEscrowTransition(fixture.escrow.id, fixture.trade.id, 'CREATED', 'FUNDS_LOCKED', fixture.seller.id, 'settlement.escrow.locked' as never, {})

    const transitionId = await deliver(fixture, kind, kind === 'RELEASE' ? 'PAYMENT_PENDING' : 'FUNDS_LOCKED')
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: fixture.trade.id, eventName: eventOf(kind) } }))!
    await eventBus.redeliver(durable.id)
    await sleep(300)

    const expected = kind === 'RELEASE' ? 2 : 0
    expect((await userOf(fixture.buyer.id)).reputationScore).toBe(expected)
    expect((await userOf(fixture.seller.id)).reputationScore).toBe(expected)
    expect(await outcomeClaims(transitionId)).toBe(2)
    expect(await heldCount(transitionId)).toBe(0)
  })

  it('an escrow that was never disputed stays cooperative and is not held', async () => {
    pg.requirePostgres('never disputed')
    const fixture = await makeLegacyMultisig('RELEASE', null)

    const transitionId = await deliver(fixture, 'RELEASE', 'PAYMENT_PENDING')

    expect((await userOf(fixture.buyer.id)).reputationScore).toBe(2)
    expect((await userOf(fixture.seller.id)).reputationScore).toBe(2)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: HELD_KEY } })).toBe(0)
  })
})
