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
import { readFileSync } from 'fs'
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
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
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
    ;({ reconcileIncompleteProjections, reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
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
    // migrate deploy already ran on this database, before these rows existed; this replays that migration over them.
    const applyBaseline = async () => {
      const sql = readFileSync(BASELINE_MIGRATION, 'utf8').replace(/^--.*$/gm, '')
      for (const statement of sql.split(';').filter((s) => s.trim())) await prisma.$executeRawUnsafe(statement)
    }
    const recover = () => (new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>).recoverMissingRulingFinalization(100_000)
    const claimsOf = (disputeId: string) => prisma.eventProjectionClaim.findMany({ where: { eventId: disputeId } }).then((rows) => rows.map((r) => `${r.projectionKey}:${r.subjectId}`).sort())
    const appealFee = (disputeId: string, buyerId: string, data: Record<string, unknown>) =>
      prisma.disputeAppealFee.create({ data: { disputeId, appealRound: 1, requestedBy: buyerId, amount: '2', asset: 'BTC', ...data } })

    async function makeAppealed() {
      const original = await user()
      await prisma.arbiterProfile.create({ data: { participantId: original.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50, rulingsOverturned: 1 } })
      const appealed = await makeHistoricalDispute('REFUND', { previousRuling: 'RELEASE', previousArbiterId: original.id })
      return { ...appealed, originalId: original.id, before: (await profileOf(original.id))! }
    }
    async function expectNothingReplayed(a: Awaited<ReturnType<typeof makeAppealed>>) {
      expect((await profileOf(a.arbiterId))!.rulingsTotal).toBe(1)
      const after = (await profileOf(a.originalId))!
      expect({ overturned: after.rulingsOverturned, collateral: String(after.monetaryCollateral) }).toEqual({ overturned: a.before.rulingsOverturned, collateral: String(a.before.monetaryCollateral) })
    }

    it('PROVEN: a settled appeal fee that agrees with the ruling marks it finalized, and nothing is replayed', async () => {
      pg.requirePostgres('F2 proven')
      const a = await makeAppealed()
      await appealFee(a.dispute.id, a.dispute.openedBy, { outcome: 'REFUNDED', settledAt: new Date() })
      await applyBaseline()
      const { recovered, held } = await recover()
      expect(await claimsOf(a.dispute.id)).toEqual(['dispute.ruling-finalized:1'])
      expect(recovered).not.toContain(a.dispute.id)
      expect(held).not.toContain(a.dispute.id)
      await expectNothingReplayed(a)
    })

    it('AMBIGUOUS, no appeal: RESOLVED alone proves nothing, so it is held, reported and never replayed', async () => {
      pg.requirePostgres('F2 ambiguous round 0')
      const plain = await makeHistoricalDispute('RELEASE')
      await applyBaseline()
      const { recovered, held } = await recover()
      expect(await claimsOf(plain.dispute.id)).toEqual(['dispute.ruling-finalization-held:0'])
      expect(recovered).not.toContain(plain.dispute.id)
      expect(held).toContain(plain.dispute.id)
      expect((await profileOf(plain.arbiterId))!.rulingsTotal).toBe(1)
    })

    it.each([
      ['an unsettled fee', { outcome: null, settledAt: null }],
      ['a fee that contradicts the ruling', { outcome: 'FORFEITED', settledAt: new Date() }],
      ['an outcome with no settlement date', { outcome: 'REFUNDED', settledAt: null }],
    ])('AMBIGUOUS, appealed with %s: held, with no repeated count or slash', async (_name, fee) => {
      pg.requirePostgres('F2 ambiguous appeal')
      const a = await makeAppealed()
      await appealFee(a.dispute.id, a.dispute.openedBy, fee)
      await applyBaseline()
      const { held } = await recover()
      expect(await claimsOf(a.dispute.id)).toEqual(['dispute.ruling-finalization-held:1'])
      expect(held).toContain(a.dispute.id)
      await expectNothingReplayed(a)
    })

    it('AMBIGUOUS, appealed with no fee row at all: held', async () => {
      pg.requirePostgres('F2 ambiguous no fee')
      const a = await makeAppealed()
      await applyBaseline()
      await recover()
      expect(await claimsOf(a.dispute.id)).toEqual(['dispute.ruling-finalization-held:1'])
      await expectNothingReplayed(a)
    })

    it('a ruling already claimed finalized is left alone, and running the migration again changes nothing', async () => {
      pg.requirePostgres('F2 repeated')
      const proven = await makeAppealed()
      await appealFee(proven.dispute.id, proven.dispute.openedBy, { outcome: 'REFUNDED', settledAt: new Date() })
      const ambiguous = await makeHistoricalDispute('RELEASE')
      const live = await makeHistoricalDispute('REFUND')
      await prisma.eventProjectionClaim.create({ data: { eventId: live.dispute.id, projectionKey: 'dispute.ruling-finalized', subjectId: '0' } })

      await applyBaseline()
      await applyBaseline()
      await recover()

      expect(await claimsOf(proven.dispute.id)).toEqual(['dispute.ruling-finalized:1'])
      expect(await claimsOf(ambiguous.dispute.id)).toEqual(['dispute.ruling-finalization-held:0'])
      expect(await claimsOf(live.dispute.id)).toEqual(['dispute.ruling-finalized:0'])
      await expectNothingReplayed(proven)
    })

    it('a ruling resolved after the migration is still recovered', async () => {
      pg.requirePostgres('F2 recovery preserved')
      await applyBaseline()
      const fresh = await makeHistoricalDispute('RELEASE')
      const { recovered } = await recover()
      expect(recovered).toContain(fresh.dispute.id)
      expect((await profileOf(fresh.arbiterId))!.rulingsTotal).toBe(2)
    })

    it('every held ruling is enumerated exactly once, past 200 and under any limit, and none is replayed', async () => {
      pg.requirePostgres('F2 exhaustive enumeration')
      const ids: string[] = []
      for (let i = 0; i < 230; i++) ids.push((await makeHistoricalDispute('RELEASE')).dispute.id)
      await applyBaseline()

      const claims = await prisma.eventProjectionClaim.findMany({ where: { projectionKey: 'dispute.ruling-finalization-held' }, select: { eventId: true } })
      const expected = claims.map((c) => c.eventId).sort()
      expect(expected.length).toBeGreaterThan(200)
      expect(expected).toEqual(expect.arrayContaining(ids))

      const service = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
      for (const limit of [1, 50, 200, 100_000]) {
        const { held, recovered } = await service.recoverMissingRulingFinalization(limit)
        expect({ limit, held: [...held].sort() }).toEqual({ limit, held: expected })
        expect(recovered.filter((id) => ids.includes(id))).toEqual([])
      }
      const { held: byDefault } = await service.recoverMissingRulingFinalization()
      expect([...byDefault].sort()).toEqual(expected)

      // One statement, one snapshot: two concurrent readers see the same complete set.
      const [a, b] = await Promise.all([service.recoverMissingRulingFinalization(), service.recoverMissingRulingFinalization()])
      expect([...a.held].sort()).toEqual(expected)
      expect(b.held).toEqual(a.held)

      const report = await reconcilePendingSettlements()
      const reported = report.requiresManualReview.map((r) => r.escrowId).filter((id) => id.startsWith('dispute:')).map((id) => id.slice('dispute:'.length))
      expect(reported.sort()).toEqual(expected)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: { in: ids }, projectionKey: 'dispute.ruling-finalized' } })).toBe(0)
    }, 300_000)
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
      const bundle = JSON.stringify({ userOpHash: '11'.repeat(32), userOp: {} })
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, ['0xdead'], c.pendingId)).rejects.toThrow()
      expect(await attemptOf(c.escrowId)).toBeNull()
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, ['0xdead'], c.pendingId)).rejects.not.toThrow(/Manual review required/)
    })

    it('LIGHTNING_HODL: a failure at the submission itself stays SUBMISSION_UNKNOWN and blocks the retry', async () => {
      pg.requirePostgres('F3 lightning boundary')
      const c = await makePending('LIGHTNING_HODL')
      const escrow = { id: c.escrowId, tradeId: c.tradeId } as never
      const provider = lightningHodlProvider as any
      jest.spyOn(provider, 'combineAndVerify').mockReturnValue({ arkTxHex: 'aa', signedCheckpoints: [] })
      jest.spyOn(provider, 'getArkProvider').mockReturnValue({ submitTx: async () => { throw new Error('asp timeout') } })
      await expect(lightningHodlProvider.finalizeRelease(escrow, 'bundle', ['signed'], c.pendingId)).rejects.toThrow(/asp timeout/)
      expect((await attemptOf(c.escrowId))!.status).toBe('SUBMISSION_UNKNOWN')
      await expect(lightningHodlProvider.finalizeRelease(escrow, 'bundle', ['signed'], c.pendingId)).rejects.toThrow(/unresolved outcome \(SUBMISSION_UNKNOWN\)/)
    })

    it('SAFE_GUARD_EVM: a failure at the broadcast itself stays SUBMISSION_UNKNOWN and blocks the retry', async () => {
      pg.requirePostgres('F3 safe boundary')
      const { ethers } = require('ethers')
      const c = await makePending('SAFE_GUARD_EVM')
      const escrow = { id: c.escrowId, tradeId: c.tradeId } as never
      const digest = '0x' + '11'.repeat(32)
      const signature = new ethers.Wallet('0x' + '22'.repeat(32)).signingKey.sign(digest).serialized
      const bundle = JSON.stringify({ userOpHash: digest.slice(2), userOp: { nonce: '0', preVerificationGas: '0' } })
      jest.spyOn(safeGuardEvmProvider as any, 'broadcast').mockRejectedValue(new Error('bundler timeout'))
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, [signature], c.pendingId)).rejects.toThrow(/bundler timeout/)
      expect((await attemptOf(c.escrowId))!.status).toBe('SUBMISSION_UNKNOWN')
      await expect(safeGuardEvmProvider.finalizeRelease(escrow, bundle, [signature], c.pendingId)).rejects.toThrow(/unresolved outcome \(SUBMISSION_UNKNOWN\)/)
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
