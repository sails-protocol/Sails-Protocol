// tests/integration/codex570Findings.test.ts
//
// The four Codex findings on PR #570, reproduced against real PostgreSQL with the production code paths:
//   F1 a ruling is reverted after the settlement already executed externally;
//   F2 rulings finalized before the 'dispute.ruling-finalized' claim existed are finalized again;
//   F3 a local signature failure is recorded as an unknown submission and blocks every retry;
//   F4 a provisional terminal escrow status is projected onto the Trade while the provider call is in flight.
// Escrows are MOCK or fixtures: no funds move. Provider calls are stubbed only where the test needs to hold or fail them.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const ARBITER = 'k6-test-arbiter'
const BASELINE_MIGRATION = path.resolve(__dirname, '../../prisma/migrations/20261102120000_dispute_ruling_finalization_baseline/migration.sql')

describe('Codex findings on PR #570 (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let tradeRepository: typeof import('../../src/modules/open-p2p/trade-repository').tradeRepository
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let reconcileIncompleteProjections: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let lightningHodlProvider: typeof import('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
  let safeGuardEvmProvider: typeof import('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ tradeRepository } = require('../../src/modules/open-p2p/trade-repository'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ safeGuardEvmProvider } = require('../../src/modules/open-settlement/safe-guard-evm.provider'))
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

  const user = (data: Record<string, unknown> = {}) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), ...data } })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function waitFor(cond: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return; await sleep(50) }
    throw new Error(`timed out waiting for ${what}`)
  }

  async function makeEscrow(type: string, status: string, extra: Record<string, unknown> = {}, tradeStatus = 'ACTIVE') {
    const seller = await user()
    const buyer = await user()
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: type as never, status: status as never, lockedAmount: '0.001', asset: 'BTC', ...extra } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: tradeStatus as never } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }

  describe('F1: a ruling survives a local failure after external execution', () => {
    async function applyFailingLocally(ruling: 'RELEASE' | 'REFUND') {
      const ctx = await makeEscrow('MOCK', 'DISPUTED', {}, 'DISPUTED')
      await payoutAddressService.setPayoutAddress(ctx.buyerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
      await payoutAddressService.setPayoutAddress(ctx.sellerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
      const dispute = await prisma.dispute.create({ data: { tradeId: ctx.tradeId, escrowId: ctx.escrowId, openedBy: ctx.buyerId, reason: 'f1', status: 'OPENED', arbiterId: ARBITER } })
      const emit = jest.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event store unavailable'))
      const service = new DisputeService(marketArbitrationProvider) as any
      await expect(service.applyRuling(dispute, ruling, ARBITER)).rejects.toThrow(/executed externally/)
      emit.mockRestore()
      return { ctx, dispute }
    }

    it('RELEASE: the dispute stays RESOLVED, and recovery scores the asymmetric outcome', async () => {
      pg.requirePostgres('F1 release')
      const { ctx, dispute } = await applyFailingLocally('RELEASE')

      const after = (await prisma.dispute.findUnique({ where: { id: dispute.id } }))!
      expect({ status: after.status, ruling: after.ruling }).toEqual({ status: 'RESOLVED', ruling: 'RELEASE' })
      expect((await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!.status).toBe('COMPLETED')

      await reconcileIncompleteProjections({ projectionsRecovered: [], failed: [] } as never, 0)
      const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'COMPLETED' } }))!
      await waitFor(async () => (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) === 1, 'the transition to be projected')
      const [buyer, seller] = await Promise.all([ctx.buyerId, ctx.sellerId].map((id) => prisma.user.findUnique({ where: { id } })))
      expect({ buyer: buyer!.reputationScore, seller: seller!.reputationScore }).toEqual({ buyer: 2, seller: -5 })
    })

    it('REFUND: the dispute stays RESOLVED', async () => {
      pg.requirePostgres('F1 refund')
      const { dispute } = await applyFailingLocally('REFUND')
      const after = (await prisma.dispute.findUnique({ where: { id: dispute.id } }))!
      expect({ status: after.status, ruling: after.ruling }).toEqual({ status: 'RESOLVED', ruling: 'REFUND' })
    })

    it('a provider that fails still reverts the ruling: nothing executed externally', async () => {
      pg.requirePostgres('F1 provider failure')
      const ctx = await makeEscrow('MOCK', 'DISPUTED', {}, 'DISPUTED')
      await payoutAddressService.setPayoutAddress(ctx.buyerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
      const dispute = await prisma.dispute.create({ data: { tradeId: ctx.tradeId, escrowId: ctx.escrowId, openedBy: ctx.buyerId, reason: 'f1', status: 'OPENED', arbiterId: ARBITER } })
      const providers = require('../../src/modules/open-settlement/escrow-providers')
      jest.spyOn(providers, 'getSettlementProvider').mockReturnValueOnce({ releaseFunds: async () => { throw new Error('rpc down') } } as never)
      const service = new DisputeService(marketArbitrationProvider) as any
      await expect(service.applyRuling(dispute, 'RELEASE', ARBITER)).rejects.toThrow(/rpc down/)
      const after = (await prisma.dispute.findUnique({ where: { id: dispute.id } }))!
      expect({ status: after.status, ruling: after.ruling }).toEqual({ status: 'OPENED', ruling: null })
    })
  })

  describe('F2: rulings finalized before the claim existed', () => {
    async function makeHistoricalDispute(ruling: 'RELEASE' | 'REFUND', appeal?: { previousRuling: 'RELEASE' | 'REFUND'; previousArbiterId: string }) {
      const arbiter = await user()
      await prisma.arbiterProfile.create({ data: { participantId: arbiter.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50, rulingsTotal: 1 } })
      const ctx = await makeEscrow('MOCK', 'COMPLETED', { txReleaseId: randomBytes(32).toString('hex') }, 'COMPLETED')
      const dispute = await prisma.dispute.create({
        data: { tradeId: ctx.tradeId, escrowId: ctx.escrowId, openedBy: ctx.buyerId, reason: 'f2', arbiterId: arbiter.id, status: 'RESOLVED', ruling, resolvedAt: new Date(), appealRound: appeal ? 1 : 0, previousRuling: appeal?.previousRuling ?? null, previousArbiterId: appeal?.previousArbiterId ?? null },
      })
      return { arbiterId: arbiter.id, dispute }
    }
    const profileOf = (id: string) => prisma.arbiterProfile.findUnique({ where: { participantId: id } })
    // The upgrade step for rows that exist when the code that introduced the claim arrives.
    const applyBaseline = async () => {
      if (!existsSync(BASELINE_MIGRATION)) return
      await prisma.$executeRawUnsafe(readFileSync(BASELINE_MIGRATION, 'utf8'))
    }

    it('after the upgrade step, a ruling already finalized is not counted or slashed again', async () => {
      pg.requirePostgres('F2 baseline')
      const original = await user()
      await prisma.arbiterProfile.create({ data: { participantId: original.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50, rulingsOverturned: 1 } })
      const plain = await makeHistoricalDispute('RELEASE')
      const appealed = await makeHistoricalDispute('REFUND', { previousRuling: 'RELEASE', previousArbiterId: original.id })
      const before = (await profileOf(original.id))!

      await applyBaseline()
      const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
      await service.recoverMissingRulingFinalization(100_000)

      expect((await profileOf(plain.arbiterId))!.rulingsTotal).toBe(1)
      expect((await profileOf(appealed.arbiterId))!.rulingsTotal).toBe(1)
      const after = (await profileOf(original.id))!
      expect({ overturned: after.rulingsOverturned, collateral: String(after.monetaryCollateral) }).toEqual({ overturned: before.rulingsOverturned, collateral: String(before.monetaryCollateral) })
    })

    it('a ruling resolved after the upgrade step is still recovered', async () => {
      pg.requirePostgres('F2 recovery preserved')
      await applyBaseline()
      const fresh = await makeHistoricalDispute('RELEASE')
      const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
      const { recovered } = await service.recoverMissingRulingFinalization(100_000)
      expect(recovered).toContain(fresh.dispute.id)
      expect((await profileOf(fresh.arbiterId))!.rulingsTotal).toBe(2)
    })
  })

  describe('F3: a local signature failure is not an unknown submission', () => {
    const attemptOf = (escrowId: string) => prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId } })
    async function makePending(type: string) {
      const ctx = await makeEscrow(type, 'PAYMENT_PENDING')
      const pending = await prisma.escrowPendingTransaction.create({
        data: { escrowId: ctx.escrowId, kind: 'release', toAddress: 'dest', requiredSigners: ['buyer-1', 'seller-1'], triggeredBy: ctx.sellerId, unsignedPsbtBase64: 'unsigned' },
      })
      return { ...ctx, pendingId: pending.id }
    }

    it('LIGHTNING_HODL: a malformed bundle records no attempt, and the corrected retry is not blocked', async () => {
      pg.requirePostgres('F3 lightning')
      const c = await makePending('LIGHTNING_HODL')
      const escrow = { id: c.escrowId, tradeId: c.tradeId } as never
      await expect(lightningHodlProvider.finalizeRelease(escrow, 'not-a-bundle', ['not-a-bundle'], c.pendingId)).rejects.toThrow(/failed to combine/)
      expect(await attemptOf(c.escrowId)).toBeNull()
      await expect(lightningHodlProvider.finalizeRelease(escrow, 'not-a-bundle', ['not-a-bundle'], c.pendingId)).rejects.not.toThrow(/Manual review required/)
    })

    it('SAFE_GUARD_EVM: an invalid signature records no attempt, and the corrected retry is not blocked', async () => {
      pg.requirePostgres('F3 safe')
      const c = await makePending('SAFE_GUARD_EVM')
      const escrow = { id: c.escrowId, tradeId: c.tradeId } as never
      const bundle = JSON.stringify({ userOpHash: '0x' + '11'.repeat(32), userOp: {} })
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, ['0xdead'], c.pendingId)).rejects.toThrow()
      expect(await attemptOf(c.escrowId)).toBeNull()
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, ['0xdead'], c.pendingId)).rejects.not.toThrow(/Manual review required/)
    })
  })

  describe('F4: a terminal claim is not a settlement result', () => {
    async function holdRelease(tradeStatus: string) {
      const ctx = await makeEscrow('MOCK', 'PAYMENT_PENDING', {}, tradeStatus)
      await payoutAddressService.setPayoutAddress(ctx.buyerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
      let fail!: () => void
      const held = new Promise<void>((resolve) => { fail = resolve })
      const providers = require('../../src/modules/open-settlement/escrow-providers')
      jest.spyOn(providers, 'getSettlementProvider').mockReturnValueOnce({ releaseFunds: async () => { await held; throw new Error('rpc down') } } as never)
      const release = escrowService.releaseFunds(ctx.escrowId, undefined, ctx.sellerId)
      await waitFor(async () => (await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!.status === 'COMPLETED', 'the provisional claim')
      return { ctx, release, fail }
    }

    it('a projection in the window leaves the Trade active, and a failed provider call leaves it consistent', async () => {
      pg.requirePostgres('F4 direct')
      const { ctx, release, fail } = await holdRelease('ACTIVE')
      await tradeRepository.projectEscrowStatus(ctx.tradeId, ctx.escrowId).catch(() => undefined)
      expect((await prisma.trade.findUnique({ where: { id: ctx.tradeId } }))!.status).toBe('ACTIVE')
      fail()
      await expect(release).rejects.toThrow(/rpc down/)
      expect((await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!.status).toBe('PAYMENT_PENDING')
      await tradeRepository.projectEscrowStatus(ctx.tradeId, ctx.escrowId)
      expect((await prisma.trade.findUnique({ where: { id: ctx.tradeId } }))!.status).toBe('ACTIVE')
    })

    it('a delayed event in the window keeps its projection owed, and its redelivery converges', async () => {
      pg.requirePostgres('F4 delayed event')
      const { ctx, release, fail } = await holdRelease('PENDING')
      const delivered = new Promise<string>((resolve) => { eventBus.onDurable('settlement.escrow.locked', async (e) => { if (e.payload.escrowId === ctx.escrowId) resolve(e.eventId) }) })
      await eventBus.emit('settlement.escrow.locked', { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId } as never, ctx.tradeId)
      const eventId = await delivered
      await sleep(300)
      expect((await prisma.trade.findUnique({ where: { id: ctx.tradeId } }))!.status).toBe('PENDING')

      fail()
      await expect(release).rejects.toThrow(/rpc down/)
      await eventBus.redeliver(eventId)
      await waitFor(async () => (await prisma.trade.findUnique({ where: { id: ctx.tradeId } }))!.status === 'ACTIVE', 'the owed projection')
    })

    it('a terminal status with its settlement result is projected', async () => {
      pg.requirePostgres('F4 result present')
      const ctx = await makeEscrow('MOCK', 'COMPLETED', { txReleaseId: randomBytes(32).toString('hex') })
      expect((await tradeRepository.projectEscrowStatus(ctx.tradeId, ctx.escrowId)).applied).toBe(true)
      expect((await prisma.trade.findUnique({ where: { id: ctx.tradeId } }))!.status).toBe('COMPLETED')
    })
  })
})
