// tests/integration/signatureCollectionDisputeProvenance.test.ts
//
// Issue #254B - closes the #254 Day-0 BLOCKER for LIGHTNING_HODL/SAFE_GUARD_EVM: disputed RELEASE/REFUND
// reputation outcomes finalized through escrow-pending-tx.ts's submitTransactionSignature() must bind to
// the immutable dispute generation that authorized them, never to Dispute's current mutable state.
//
// Discovery found NO schema change was needed: EscrowPendingTransaction already carries disputeId/
// rulingAppealRound/rulingArbiterId/rulingOutcome/rulingAuthoritySignature/rulingAuthorityIssuedAt
// (ADR-005/#218's own write-time provenance for the Economic Disposition Commit Gate, captured by
// initiateSignatureCollectionCore() the moment a disputed pending operation is created - immutable
// thereafter). The only gap was that submitTransactionSignature()'s own emitEscrowTransition() call never
// threaded pending.disputeId onto the settlement event - now fixed with one conditional field.
//
// PROVENANCE/PERSISTENCE PROOF (this file's actual scope, per the mission's own explicit permission) vs
// REAL PROVIDER EXECUTION PROOF (out of reach in CI - neither provider's finalizeRelease/finalizeRefund
// can be exercised against a live Ark/bundler infrastructure here, same boundary
// tests/integration/signatureCollectionRestartConvergence.test.ts already established): this file spies on
// lightningHodlProvider/safeGuardEvmProvider's finalizeRelease()/finalizeRefund() to return a deterministic
// fake txId, so the REST of the real pipeline (claimEscrowTransition, emitEscrowTransition, the durable
// event, and every real projection handler in common/events/handlers.ts) executes for real against real
// Postgres - proving the provenance/persistence/reputation-outcome machinery, not the external broadcast.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #254B - signature-collection (LIGHTNING_HODL/SAFE_GUARD_EVM) dispute provenance (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
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
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ safeGuardEvmProvider } = require('../../src/modules/open-settlement/safe-guard-evm.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
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
  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })
  const projectedFor = (transitionId: string) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0

  // Cleanup tracking - this is a shared, long-lived local dev database (not a per-test container), so
  // every fixture this file creates is deleted at the end of its own test, matching the established
  // convention tests/integration/signatureCollectionRestartConvergence.test.ts's own afterEach already
  // uses, rather than accumulating permanent rows across every run of this suite.
  let createdEscrowIds: string[] = []
  let createdTradeIds: string[] = []
  let createdUserIds: string[] = []

  beforeEach(() => {
    createdEscrowIds = []
    createdTradeIds = []
    createdUserIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdEscrowIds.length) {
      await prisma.escrowTransactionSignature.deleteMany({ where: { pendingTxId: { in: (await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })).map((p) => p.id) } } })
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const disputeIds = (await prisma.dispute.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })).map((d) => d.id)
      if (disputeIds.length) await prisma.disputeAppealFee.deleteMany({ where: { disputeId: { in: disputeIds } } })
      await prisma.dispute.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const transitions = await prisma.escrowEvent.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })
      if (transitions.length) await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: transitions.map((t) => t.id) } } })
      await prisma.escrowEvent.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
    }
    if (createdTradeIds.length) {
      await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: createdTradeIds } } })
      await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: createdTradeIds } } })
      await prisma.trade.updateMany({ where: { id: { in: createdTradeIds } }, data: { escrowId: null } })
    }
    if (createdEscrowIds.length) await prisma.escrow.deleteMany({ where: { id: { in: createdEscrowIds } } })
    if (createdTradeIds.length) await prisma.trade.deleteMany({ where: { id: { in: createdTradeIds } } })
    if (createdUserIds.length) {
      await prisma.vouch.deleteMany({ where: { OR: [{ voucherId: { in: createdUserIds } }, { voucheeId: { in: createdUserIds } }] } })
      await prisma.arbiterProfile.deleteMany({ where: { participantId: { in: createdUserIds } } })
      await prisma.offer.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  // ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

  async function makeArbiter() {
    const user = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(user.id)
    await prisma.arbiterProfile.create({ data: { participantId: user.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50 } })
    return user.id
  }

  async function makeTradeEscrow(type: 'LIGHTNING_HODL' | 'SAFE_GUARD_EVM') {
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(buyer.id, seller.id)
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC' } })
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    return { trade, escrow, buyer, seller }
  }

  // Mirrors exactly what initiateSignatureCollectionCore() persists for a DISPUTED release/refund
  // (escrow-pending-tx.ts's own disputedRulingProvenance spread) - constructed directly so this suite
  // proves the READ side (submitTransactionSignature -> emitEscrowTransition -> handlers.ts) without
  // needing the full initiateRelease()/initiateRefund() authorization/PSBT-building machinery, which
  // tests/disputeFlow.test.ts and tests/escrowPendingReleaseDestinationBinding.test.ts already cover.
  async function makeDisputedPending(escrowId: string, kind: 'release' | 'refund', disputeId: string, arbiterId: string, ruling: 'RELEASE' | 'REFUND') {
    return prisma.escrowPendingTransaction.create({
      data: {
        escrowId, kind, toAddress: 'dest-address', requiredSigners: ['buyer-signer'], triggeredBy: arbiterId,
        unsignedPsbtBase64: 'unsigned-bundle-b64',
        disputeId, rulingAppealRound: 0, rulingArbiterId: arbiterId, rulingOutcome: ruling,
      },
    })
  }

  async function spyFinalize(provider: typeof lightningHodlProvider | typeof safeGuardEvmProvider, kind: 'release' | 'refund', txId: string) {
    const method = kind === 'release' ? 'finalizeRelease' : 'finalizeRefund'
    jest.spyOn(provider as any, method).mockResolvedValue({ txId })
  }

  // ─── 1-4: PROVENANCE for both rails, both operations (before any appeal) ───────────────────────────

  it.each([
    ['LIGHTNING_HODL', 'release', 'RELEASE'] as const,
    ['LIGHTNING_HODL', 'refund', 'REFUND'] as const,
    ['SAFE_GUARD_EVM', 'release', 'RELEASE'] as const,
    ['SAFE_GUARD_EVM', 'refund', 'REFUND'] as const,
  ])('%s disputed %s: the settlement event carries disputeId and the correct disputed reputation outcome is applied', async (type, kind, ruling) => {
    requirePostgres(`${type} ${kind} provenance`)
    const arbiterId = await makeArbiter()
    const { trade, escrow, buyer, seller } = await makeTradeEscrow(type)
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'test', arbiterId, status: 'RESOLVED', ruling, resolvedAt: new Date() },
    })
    const pending = await makeDisputedPending(escrow.id, kind, dispute.id, arbiterId, ruling)
    const provider = type === 'LIGHTNING_HODL' ? lightningHodlProvider : safeGuardEvmProvider
    const fakeTxId = `0x${randomUUID().replace(/-/g, '')}`
    await spyFinalize(provider, kind, fakeTxId)

    const submitted = await escrowService.submitTransactionSignature(escrow.id, 'buyer-signer', 'signed-bundle')
    expect(submitted.complete).toBe(true)

    const eventName = kind === 'release' ? 'settlement.escrow.released' : 'settlement.escrow.refunded'
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName } }))!
    expect((durable.payload as any).disputeId).toBe(dispute.id)
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: kind === 'release' ? 'COMPLETED' : 'REFUNDED' } }))!
    await waitFor(projectedFor(transition.id))

    const [buyerRow, sellerRow] = await Promise.all([userOf(buyer.id), userOf(seller.id)])
    if (ruling === 'RELEASE') {
      expect(buyerRow!.reputationScore).toBe(2)
      expect(sellerRow!.reputationScore).toBe(-5)
    } else {
      expect(sellerRow!.reputationScore).toBe(2)
      expect(buyerRow!.reputationScore).toBe(-5)
    }
    void pending
  })

  // ─── 5/6/7: delayed delivery / replay / duplicate AFTER appeal ─────────────────────────────────────

  it('LIGHTNING_HODL: a delayed disputed RELEASE event, processed AFTER appeal() reopened the dispute, still awards the correct disputed outcome (never a plain-positive misread of the now-mutated Dispute row)', async () => {
    requirePostgres('LIGHTNING_HODL delayed after appeal')
    const arbiterId = await makeArbiter()
    const { trade, escrow, buyer, seller } = await makeTradeEscrow('LIGHTNING_HODL')
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'test', arbiterId, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() },
    })
    await makeDisputedPending(escrow.id, 'release', dispute.id, arbiterId, 'RELEASE')

    const voucher = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), totalTrades: 10, reputationScore: 20 } })
    createdUserIds.push(voucher.id)
    await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: seller.id } })

    const fakeTxId = `0x${randomUUID().replace(/-/g, '')}`
    let publishedEventId = ''

    // Genuinely independent module graph, zero handlers registered - a real "the projection has not run
    // yet" state, same technique tests/integration/disputeSemanticProvenance.test.ts's A2 established.
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        (async () => {
          try {
            const isolatedEscrowService = require('../../src/modules/open-settlement/escrow.service').escrowService
            const isolatedProvider = require('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
            const isolatedPrisma = require('../../src/common/database').prisma
            jest.spyOn(isolatedProvider, 'finalizeRelease').mockResolvedValue({ txId: fakeTxId })
            await isolatedEscrowService.submitTransactionSignature(escrow.id, 'buyer-signer', 'signed-bundle')
            const durable = await isolatedPrisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } })
            publishedEventId = durable.id
            resolve()
          } catch (err) {
            reject(err)
          }
        })()
      })
    })
    expect(publishedEventId).not.toBe('')
    expect((await userOf(buyer.id))!.reputationScore).toBe(0) // confirmed: no projection ran yet in THIS graph

    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, buyer.id)
    expect((await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status).toBe('APPEALED')

    // First delivery, strictly after appeal.
    await eventBus.redeliver(publishedEventId)
    await sleep(500)
    // Replay + duplicate: redeliver twice more, including concurrently.
    await Promise.all([eventBus.redeliver(publishedEventId), eventBus.redeliver(publishedEventId)])
    await sleep(500)

    const [buyerRow, sellerRow, voucherRow] = await Promise.all([userOf(buyer.id), userOf(seller.id), userOf(voucher.id)])
    expect(buyerRow!.reputationScore).toBe(2) // POSITIVE - still correctly disputed
    expect(sellerRow!.reputationScore).toBe(-5) // NEGATIVE - never both-positive despite the appeal
    expect(voucherRow!.reputationScore).toBe(15) // vouch burn still fired
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: publishedEventId, projectionKey: 'reputation.outcome' } })).toBe(2) // one per participant, not doubled by the 3 total deliveries
  })

  it('SAFE_GUARD_EVM: a delayed disputed REFUND event, processed AFTER appeal() reopened the dispute, still awards the correct disputed outcome', async () => {
    requirePostgres('SAFE_GUARD_EVM delayed after appeal')
    const arbiterId = await makeArbiter()
    const { trade, escrow, buyer, seller } = await makeTradeEscrow('SAFE_GUARD_EVM')
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'test', arbiterId, status: 'RESOLVED', ruling: 'REFUND', resolvedAt: new Date() },
    })
    await makeDisputedPending(escrow.id, 'refund', dispute.id, arbiterId, 'REFUND')
    const fakeTxId = `0x${randomUUID().replace(/-/g, '')}`
    let publishedEventId = ''

    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        (async () => {
          try {
            const isolatedEscrowService = require('../../src/modules/open-settlement/escrow.service').escrowService
            const isolatedProvider = require('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider
            const isolatedPrisma = require('../../src/common/database').prisma
            jest.spyOn(isolatedProvider, 'finalizeRefund').mockResolvedValue({ txId: fakeTxId })
            await isolatedEscrowService.submitTransactionSignature(escrow.id, 'buyer-signer', 'signed-bundle')
            const durable = await isolatedPrisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.refunded' } })
            publishedEventId = durable.id
            resolve()
          } catch (err) {
            reject(err)
          }
        })()
      })
    })
    expect(publishedEventId).not.toBe('')

    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, seller.id)
    expect((await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status).toBe('APPEALED')

    await eventBus.redeliver(publishedEventId)
    await sleep(500)

    const [buyerRow, sellerRow] = await Promise.all([userOf(buyer.id), userOf(seller.id)])
    expect(sellerRow!.reputationScore).toBe(2) // seller won REFUND - POSITIVE
    expect(buyerRow!.reputationScore).toBe(-5) // buyer lost - NEGATIVE, never NEUTRAL/NEUTRAL
  })

  // ─── 12: non-disputed flow remains unaffected ──────────────────────────────────────────────────────

  it('a COOPERATIVE (non-disputed) LIGHTNING_HODL release — no disputeId on the pending row — still awards both-POSITIVE, unaffected by this change', async () => {
    requirePostgres('cooperative release unaffected')
    const { trade, escrow, buyer, seller } = await makeTradeEscrow('LIGHTNING_HODL')
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'PAYMENT_PENDING' } })
    // No disputeId/rulingOutcome — the exact shape a cooperative seller-triggered release produces.
    await prisma.escrowPendingTransaction.create({
      data: { escrowId: escrow.id, kind: 'release', toAddress: 'dest-address', requiredSigners: ['buyer-signer'], triggeredBy: seller.id, unsignedPsbtBase64: 'unsigned-bundle-b64' },
    })
    const fakeTxId = `0x${randomUUID().replace(/-/g, '')}`
    await spyFinalize(lightningHodlProvider, 'release', fakeTxId)

    await escrowService.submitTransactionSignature(escrow.id, 'buyer-signer', 'signed-bundle')
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } }))!
    expect((durable.payload as any).disputeId).toBeUndefined()
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await waitFor(projectedFor(transition.id))

    const [buyerRow, sellerRow] = await Promise.all([userOf(buyer.id), userOf(seller.id)])
    expect(buyerRow!.reputationScore).toBe(2)
    expect(sellerRow!.reputationScore).toBe(2) // both positive - a real cooperative completion, not a dispute
  })
})
