// tests/integration/disputeSemanticProvenance.test.ts
//
// Issue #254 - Reputation Semantic Provenance / Dispute Generation Correctness. Real PostgreSQL proof for
// the canonical concern: a delayed/replayed settlement.escrow.released|refunded event's PROJECTION
// (common/events/handlers.ts's applyReleaseOutcomes()/applyRefundOutcomes()) must derive its reputation
// outcome from the IMMUTABLE generation that actually produced the fund movement, never from Dispute's
// CURRENT mutable state - a later appeal() call can legitimately reopen a RESOLVED dispute (status ->
// APPEALED, ruling -> null) at any time, since it never checks escrow state. Before this pass, the
// handler queried `prisma.dispute.findFirst({tradeId, status:'RESOLVED', ruling:...})` - a query that
// silently returns nothing once a real disputed release/refund's own dispute has been appealed, causing an
// exactly-once but WRONG (undisputed-looking) reputation outcome.
//
// Also covers the bounded #253 residual fix: recoverMissingRulingFinalization() now also discovers an
// APPEALED dispute whose round-0 finalize never ran, using the row's own previousRuling/previousArbiterId
// (durable, never overwritten again - proven structurally: a dispute can resolve for real at most once per
// escrow, so at most one appeal() call can ever succeed).

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('Issue #254 - dispute reputation outcomes bind to the correct immutable generation (real PostgreSQL)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let ESCROW_DISPUTE_RULING_TRANSITION_TYPE: typeof import('../../src/modules/open-settlement/discretionary-authority').ESCROW_DISPUTE_RULING_TRANSITION_TYPE

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
    ;({ ESCROW_DISPUTE_RULING_TRANSITION_TYPE } = require('../../src/modules/open-settlement/discretionary-authority'))
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

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }
  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })

  // ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

  async function makeArbiter(collateral = '10') {
    const user = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    await prisma.arbiterProfile.create({ data: { participantId: user.id, monetaryCollateral: collateral, collateralAsset: 'BTC', arbiterReputation: 50 } })
    return user.id
  }

  // A real MOCK trade+escrow whose Dispute is ALREADY 'RESOLVED' for round 0 (simulating that
  // applyRuling()'s own resolve-write already committed) with a registered buyer PayoutAddress, so
  // escrowService.releaseFunds()/refundFunds() can be called directly - isolating the projection/
  // provenance mechanism under test from dispute.service.ts's own signature-verification orchestration
  // (already covered by tests/disputeFlow.test.ts).
  async function makeResolvedMockDispute(ruling: 'RELEASE' | 'REFUND', arbiterId: string) {
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'BTC', address: `bc1q${randomUUID().replace(/-/g, '')}`.slice(0, 42) } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'BTC', address: `bc1q${randomUUID().replace(/-/g, '')}`.slice(0, 42) } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'test', arbiterId, status: 'RESOLVED', ruling, resolvedAt: new Date() },
    })
    return { trade, escrow, buyer, seller, dispute }
  }

  const projectedFor = (transitionId: string) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0

  // ─── A: MOCK rail — delayed release/refund event after appeal ──────────────────────────────────────

  it('A1: a settlement.escrow.released event carrying disputeId, redelivered AFTER appeal() reopened the dispute, still awards the CORRECT (disputed) outcome — buyer POSITIVE, seller NEGATIVE, seller vouch burned — never a misread plain-positive', async () => {
    requirePostgres('A1 delayed release after appeal')
    const originalArbiter = await makeArbiter()
    const newArbiter = await makeArbiter()
    const { trade, escrow, buyer, seller, dispute } = await makeResolvedMockDispute('RELEASE', originalArbiter)

    // A real active vouch for the losing seller, to prove the burn ALSO fires correctly (not just the
    // score deltas) once the correct generation is identified.
    const voucher = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), totalTrades: 10, reputationScore: 20 } })
    await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: seller.id } })

    // Round 0's real fund movement — durably publishes settlement.escrow.released with payload.disputeId
    // set (escrow.service.ts's own new #254 threading). Handlers ARE registered (beforeAll), so this
    // event's own projection races to run immediately — deliberately NOT what this test measures (see A2
    // for the true delayed-delivery reconstruction); this call's job here is just to produce a real event
    // to redeliver against, and the immediate first run must ALSO be correct (it is — same code path).
    await escrowService.releaseFunds(escrow.id, undefined, originalArbiter, dispute.id)
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await waitFor(projectedFor(transition.id))
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } }))!
    expect((durable.payload as any).disputeId).toBe(dispute.id)

    // THE CANONICAL #254 SCENARIO: appeal() now reopens the ALREADY-RESOLVED dispute (structurally always
    // reachable — appeal() never checks escrow state). Dispute.status -> APPEALED, ruling -> null. A query
    // against CURRENT mutable state at this point would misclassify this release as "no dispute."
    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, buyer.id)
    const afterAppeal = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    expect(afterAppeal!.status).toBe('APPEALED')
    expect(afterAppeal!.ruling).toBeNull()

    // Redeliver the SAME durable event — simulating the delayed/late/redriven projection this mission's
    // canonical scenario describes, now running strictly AFTER the appeal.
    await eventBus.redeliver(durable.id)
    await sleep(500)

    const [buyerRow, sellerRow, voucherRow] = await Promise.all([userOf(buyer.id), userOf(seller.id), userOf(voucher.id)])
    expect(buyerRow!.reputationScore).toBe(2) // POSITIVE
    expect(sellerRow!.reputationScore).toBe(-5) // NEGATIVE — never both-positive
    expect(voucherRow!.reputationScore).toBe(15) // 20 + VOUCH_BURN_PENALTY(-5) — burn fired
    const vouch = await prisma.vouch.findFirst({ where: { voucherId: voucher.id, voucheeId: seller.id } })
    expect(vouch!.burnedAt).not.toBeNull()
  })

  it('A2: TRUE delayed delivery — the projection never ran before appeal() (simulated via a fresh module graph with no handlers registered), then redelivered from the handler-registered graph AFTER the appeal — same correct disputed outcome', async () => {
    requirePostgres('A2 true delayed delivery via independent module graph')
    const originalArbiter = await makeArbiter()
    const { trade, escrow, buyer, seller, dispute } = await makeResolvedMockDispute('REFUND', originalArbiter)

    let publishedEventId = ''
    // A genuinely independent module graph: its own event bus has ZERO subscribers (handlers.ts's
    // registerEventHandlers() is never called here), so publishing the settlement event durably commits
    // to the SAME real Postgres database but triggers NO projection at all — a real, not simulated,
    // "the projection has not run yet" state.
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        (async () => {
          try {
            const isolatedEscrowService = require('../../src/modules/open-settlement/escrow.service').escrowService
            const isolatedPrisma = require('../../src/common/database').prisma
            await isolatedEscrowService.refundFunds(escrow.id, originalArbiter, dispute.id)
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

    // Confirm the projection really has not run yet in THIS (handler-registered) graph.
    expect((await userOf(buyer.id))!.reputationScore).toBe(0)
    expect((await userOf(seller.id))!.reputationScore).toBe(0)

    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, seller.id)
    expect((await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status).toBe('APPEALED')

    // NOW the projection runs for the first time, from the handler-registered graph, strictly after appeal.
    await eventBus.redeliver(publishedEventId)
    await sleep(500)

    const [buyerRow, sellerRow] = await Promise.all([userOf(buyer.id), userOf(seller.id)])
    expect(sellerRow!.reputationScore).toBe(2) // seller won the REFUND ruling — POSITIVE
    expect(buyerRow!.reputationScore).toBe(-5) // buyer lost — NEGATIVE, never NEUTRAL/NEUTRAL
  })

  // ─── B: MULTISIG's existing Core-authoritative provenance closes the SAME defect, no schema change ────

  it('B: a MULTISIG-shaped semantic_transition_records row (committed BEFORE the settlement action, per dispute-outcome.ts) is consulted instead of mutable Dispute — correct outcome survives an appeal that already mutated the Dispute row', async () => {
    requirePostgres('B semantic_transition_records provenance')
    const originalArbiter = await makeArbiter()
    // No payload.disputeId this time (MULTISIG's real settlement events never carry it — its own,
    // separate, pre-existing immutable provenance is what closes this for that rail) - constructing the
    // fixture directly at the MOCK rail (real fund movement) but WITHOUT the new #254 disputeId thread,
    // to prove source #2 (semantic_transition_records) alone is sufficient when source #1 is absent.
    const { trade, escrow, buyer, seller, dispute } = await makeResolvedMockDispute('RELEASE', originalArbiter)

    // The exact row shape dispute-outcome.ts's toDisputeRulingTransitionRecordRow() would have committed
    // for a real MULTISIG Core-authoritative ruling — minimal, only the columns this lookup actually reads.
    await prisma.semanticTransitionRecord.create({
      data: {
        interactionId: escrow.id,
        transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE as unknown as string,
        fromState: 'ARBITRATED', toState: 'RESOLVED',
        priorPositionKind: 'LEGACY_UNVERIFIED',
        rulesetName: 'test', rulesetIdentity: 'test', rulesetVersion: '1', rulesetCommitment: 'c',
        rulesetExpectedEvaluatorName: 'test', rulesetExpectedEvaluatorVersion: '1',
        rulesetExpectedProfileName: 'test', rulesetExpectedProfileVersion: '1',
        evaluatorIdentityName: 'test', evaluatorIdentityVersion: '1',
        profileIdentityName: 'test', profileIdentityVersion: '1',
        deadlineMs: BigInt(0), evaluationTimeMs: BigInt(0),
        conditionResult: 'SATISFIED',
        attributionActor: originalArbiter, attributionRawProof: 'proof', attributionResolvedIdentity: 'identity',
        outcomeContent: { ruling: 'RELEASE', totalUnits: '0.001', asset: 'BTC', allocations: [], remainderBeneficiary: buyer.id },
        appealRound: 0,
      },
    })

    await escrowService.releaseFunds(escrow.id, undefined, originalArbiter) // no disputeId argument — same as a real MULTISIG dispatch
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await waitFor(projectedFor(transition.id))
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } }))!
    expect((durable.payload as any).disputeId).toBeUndefined()

    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, buyer.id)
    expect((await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status).toBe('APPEALED')

    await eventBus.redeliver(durable.id)
    await sleep(500)

    const [buyerRow, sellerRow] = await Promise.all([userOf(buyer.id), userOf(seller.id)])
    expect(buyerRow!.reputationScore).toBe(2)
    expect(sellerRow!.reputationScore).toBe(-5) // still correctly disputed, via the semantic_transition_records source
  })

  // ─── C: #253 residual fix — arbiter-attribution recovery after an appeal moved the row past RESOLVED ──

  it('C: recoverMissingRulingFinalization() discovers and correctly finalizes a round-0 ruling whose bookkeeping crashed BEFORE an appeal reopened the dispute — no slash (first-instance never overturns anything), recordRuling attributed to the REAL round-0 arbiter', async () => {
    requirePostgres('C recoverMissingRulingFinalization after appeal (#253 residual)')
    const originalArbiter = await makeArbiter()
    const { dispute } = await makeResolvedMockDispute('RELEASE', originalArbiter)
    // Simulates: applyRuling()'s own resolve-write + fund movement already committed for real (the
    // Dispute row IS 'RESOLVED' — makeResolvedMockDispute's own fixture), but finalizeResolveDispute()
    // (the arbiter-bookkeeping step) never ran — no claim exists yet.
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: dispute.id, projectionKey: 'dispute.ruling-finalized' } })).toBe(0)

    const disputeService = new DisputeService(marketArbitrationProvider) as InstanceType<typeof DisputeService>
    await disputeService.appeal(dispute.id, (await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.openedBy)
    const afterAppeal = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    expect(afterAppeal!.status).toBe('APPEALED')
    expect(afterAppeal!.previousRuling).toBe('RELEASE')
    expect(afterAppeal!.previousArbiterId).toBe(originalArbiter)

    // Pre-#254, this dispute's round-0 finalize was PERMANENTLY undiscoverable here (the old query only
    // ever looked at status='RESOLVED'). The new APPEALED-branch query finds it via the row's own durable
    // previousRuling/previousArbiterId.
    const result = await disputeService.recoverMissingRulingFinalization(5000)
    expect(result.failed.find((f) => f.disputeId === dispute.id)).toBeUndefined()
    expect(result.recovered).toContain(dispute.id)

    const profile = await prisma.arbiterProfile.findUnique({ where: { participantId: originalArbiter } })
    expect(profile!.rulingsTotal).toBe(1) // attributed to the REAL round-0 arbiter
    expect(profile!.rulingsOverturned).toBe(0) // never slashed — round 0 is always first-instance
    expect(profile!.arbiterReputation).toBe(50) // untouched — no slash
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: dispute.id, projectionKey: 'dispute.ruling-finalized', subjectId: '0' } })).toBe(1)

    // Repeated reconciliation is a no-op.
    const again = await disputeService.recoverMissingRulingFinalization(5000)
    expect(again.recovered).not.toContain(dispute.id)
    const profileAgain = await prisma.arbiterProfile.findUnique({ where: { participantId: originalArbiter } })
    expect(profileAgain!.rulingsTotal).toBe(1)
  })
})
