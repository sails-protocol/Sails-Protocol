// tests/integration/m9rDispatchRecovery.test.ts
//
// Sails Core Implementation Program M9-R (Recovery Closure), Part 1 (R1)
// + Part 2 — real-Postgres reproduction of crash window C4 (found during
// the M9 analytical gate: a dispute ruling's Outcome commits durably,
// but the process dies before `initiateRelease/Refund/Split()` ever
// persists the unsigned PSBT) and proof that
// `reconcileMissingDispatch()` resumes it safely, without re-running
// discretionary authority or reinterpreting the ruling.
//
// C4 is reproduced by calling `commitAuthoritativeDisputeRuling()`
// directly and STOPPING there — exactly the same technique
// `disputeOutcomeMultisigLive.test.ts`'s own "P15/replay-resistance"
// test already uses to isolate the record-commit layer from the
// business-workflow layer, applied here to isolate "the commit
// succeeded, dispatch never ran" instead of "two appeal rounds."

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import nacl from 'tweetnacl'

bitcoin.initEccLib(ecc)

function testnetAddress(label: string): string {
  const scalar = createHash('sha256').update(label).digest()
  const pubkey = Buffer.from(ecc.pointFromScalar(scalar, true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.testnet }).address!
}

describe('M9-R — C4 recovery: authorized dispatch that never persisted (real Postgres)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let OpenP2PTradeIntentHandler: any
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let commitAuthoritativeDisputeRuling: typeof import('../../src/modules/open-settlement/dispute-outcome').commitAuthoritativeDisputeRuling
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch

  const ARBITER_ID = 'm9r-c4-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')

  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

  let realFetch: typeof fetch

  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-c4-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID

    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-R C4 Test Arbiter' },
    })
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

  beforeEach(() => {
    realFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  async function makeUndispatchedDisputedEscrow(suffix: string, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER',
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const txid = createHash('sha256').update(`m9r-txid-${suffix}-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(txid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `M9-R C4 test — ${suffix}`)
    expect(dispute.arbiterId).toBe(ARBITER_ID)

    if (ruling === 'RELEASE' || ruling === 'SPLIT') {
      await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`m9r-c4-${suffix}-buyer`))
    }
    if (ruling === 'REFUND' || ruling === 'SPLIT') {
      await payoutAddressService.setPayoutAddress(seller.id, 'BTC', testnetAddress(`m9r-c4-${suffix}-seller`))
    }

    // Reproduces C4 exactly: the atomic Outcome-commit transaction runs
    // and COMMITS (Dispute.status -> RESOLVED, SemanticTransitionRecord
    // inserted) — and nothing else. In the real
    // applyRulingCoreAuthoritative(), the very next lines would call
    // assertDisputeDispatchEligible() then initiateRelease/Refund/Split();
    // this test stops right after the commit, exactly reproducing "the
    // process died before dispatch ever persisted the unsigned PSBT."
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: ruling, buyerBps, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    const disputeRow = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    const commitResult = await commitAuthoritativeDisputeRuling(
      { id: dispute.id, escrowId: escrow.id, status: disputeRow!.status, appealRound: 0 },
      payload, signature, arbiterPublicKeyHex, '100000', 'BTC', buyer.id, seller.id,
    )
    expect(commitResult.committed).toBe(true)

    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id }
  }

  it('R1: reproduces C4 — Outcome committed, Dispute RESOLVED, escrow non-terminal, NO pending transaction exists', async () => {
    requirePostgres('R1 reproduction')
    const { escrowId, disputeId } = await makeUndispatchedDisputedEscrow('r1', 'RELEASE')

    const escrowRow = await prisma.escrow.findUnique({ where: { id: escrowId } })
    expect(escrowRow!.status).not.toMatch(/COMPLETED|REFUNDED|SPLIT/)
    const disputeRow = await prisma.dispute.findUnique({ where: { id: disputeId } })
    expect(disputeRow!.status).toBe('RESOLVED')
    const record = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    expect(record).not.toBeNull()
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).toBeNull()

    // The client cannot simply retry — resolveDispute()'s own top-level
    // guard rejects a RESOLVED dispute unconditionally.
    await expect(
      getDisputeService().resolveDispute(disputeId, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, 'irrelevant', new Date().toISOString())
    ).rejects.toThrow(/already resolved/)
  })

  it('RESUME_AUTHORIZED_DISPATCH: RELEASE — resumes using the historical destination, never re-consults current PayoutAddress', async () => {
    requirePostgres('C4 RELEASE recovery')
    const { escrowId, buyerId } = await makeUndispatchedDisputedEscrow('release', 'RELEASE')
    const historicalRecord = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    const historicalDestination = (historicalRecord!.outcomeDestinationBinding as any[])[0].destination

    // Rotate the buyer's CURRENT payout address AFTER the Outcome
    // committed — the resumed dispatch must still use the historical one.
    await payoutAddressService.setPayoutAddress(buyerId, 'BTC', testnetAddress('m9r-release-rotated-after'))

    const report = await reconcileMissingDispatch()

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'RELEASE' }])
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.toAddress).toBe(historicalDestination)
    expect(pending!.toAddress).not.toBe('m9r-release-rotated-after')
  })

  // Sails Core Implementation Program M8-RF (Destination Consistency,
  // 2026-08-31) — REPLACES the prior version of this test, which
  // documented a real, pre-existing M8-R defect (buildUnsignedRefund()
  // always derived the seller's multisig-pubkey P2WPKH address, ignoring
  // the historical Outcome's own committed seller PayoutAddress
  // destinationBinding entirely) discovered as a byproduct of building
  // C4 recovery. That defect is now fixed at its actual source
  // (dispute.service.ts's applyRulingCoreAuthoritative() now threads the
  // historical sellerDestination into initiateRefund(); multisig.provider.ts's
  // buildUnsignedRefund() now REQUIRES and translates an authorized
  // destination instead of deriving one) — see M8-RF's own final report
  // for the full architectural justification
  // (docs/DESTINATION_AUTHORITY_ARCHITECTURE.md's F′ model already
  // required this; it was simply never applied to REFUND). This is now
  // the PRIMARY regression proof that fix didn't just move the bug: a
  // REFUND ruling's C4 crash (Outcome committed, dispatch never
  // persisted) now RESUMES successfully, using the historical seller
  // destination — never the seller's multisig-key-derived address, and
  // never a live re-read of current PayoutAddress state.
  it('RF-15: RESUME_AUTHORIZED_DISPATCH — REFUND now resumes successfully using the historical seller destination (M8-RF regression proof)', async () => {
    requirePostgres('C4 REFUND recovery — fixed')
    const { escrowId, sellerId } = await makeUndispatchedDisputedEscrow('refund', 'REFUND')
    const historicalRecord = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    const historicalDestination = (historicalRecord!.outcomeDestinationBinding as any[])[0].destination

    // RF-3 — rotate the seller's CURRENT payout address AFTER the
    // Outcome committed; the resumed REFUND must still use the OLD one.
    await payoutAddressService.setPayoutAddress(sellerId, 'BTC', testnetAddress('m8rf-refund-rotated-after'))

    const report = await reconcileMissingDispatch()

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'REFUND' }])
    expect(report.guardFailed.find((r) => r.escrowId === escrowId)).toBeUndefined()
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.kind).toBe('refund')
    expect(pending!.toAddress).toBe(historicalDestination)
    expect(pending!.toAddress).not.toBe('m8rf-refund-rotated-after')

    // RF-20 — the seller's own multisig-key-derived address (what the
    // OLD, buggy translation would have paid) must NEVER be what the
    // resumed dispatch actually used.
    const sellerKeyDerivedAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(SELLER_PUBKEY, 'hex'), network: bitcoin.networks.testnet }).address
    expect(pending!.toAddress).not.toBe(sellerKeyDerivedAddress)
  })

  it('RESUME_AUTHORIZED_DISPATCH: SPLIT — resumes with the historical buyerBps, never a re-derived one', async () => {
    requirePostgres('C4 SPLIT recovery')
    const { escrowId } = await makeUndispatchedDisputedEscrow('split', 'SPLIT', 6500)

    const report = await reconcileMissingDispatch()

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'SPLIT' }])
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.buyerBps).toBe(6500)
  })

  it('duplicate workers: two concurrent recovery runs never create two competing pending transactions for the same C4 escrow', async () => {
    requirePostgres('C4 duplicate workers')
    const { escrowId } = await makeUndispatchedDisputedEscrow('concurrent', 'RELEASE')

    const [reportA, reportB] = await Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()])

    const resumedTotal = reportA.resumed.length + reportB.resumed.length
    const concurrentTotal = reportA.alreadyResumedConcurrently.length + reportB.alreadyResumedConcurrently.length
    // Exactly one of the two runs actually created the pending row for
    // this escrow; the other observed either "already exists" (lost the
    // pre-check) or "concurrent initiate" (lost the P2002 race inside the
    // lock) — never two successful creations.
    expect(resumedTotal + concurrentTotal).toBeGreaterThanOrEqual(1)
    const pendingRows = await prisma.escrowPendingTransaction.findMany({ where: { escrowId } })
    expect(pendingRows).toHaveLength(1)
  })

  it('a dispute whose ruling took the LEGACY (non-Core-authoritative) path is not a candidate at all — no durable Outcome exists for it', async () => {
    requirePostgres('legacy dispute is not a C4 candidate')
    // A RESOLVED dispute with no SemanticTransitionRecord at all (never
    // went through commitAuthoritativeDisputeRuling()) must be silently
    // excluded — this module's candidate query itself checks
    // `row.outcomeContent`, not just `Dispute.status === 'RESOLVED'`.
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'legacy', arbiterId: seller.id, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() },
    })

    const report = await reconcileMissingDispatch()
    expect(report.resumed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.notEligible.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.failed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
  })
})
