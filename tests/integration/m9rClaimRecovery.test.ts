// tests/integration/m9rClaimRecovery.test.ts
//
// Sails Core Implementation Program M9-R (Recovery Closure), Part 1 (R2)
// + Part 3 — real-Postgres reproduction of crash window C8 (all required
// signatures durably persisted, but the process died before
// claimEscrowTransition() ever ran) and proof that
// reconcilePendingSettlements()'s new PASS 0 resumes it safely, asking
// the chain BEFORE claiming anything or touching bookkeeping.
//
// C8 is reproduced with a REAL signed PSBT (bitcoinjs-lib, real ECPair
// keys the test controls) — never a mock of the signing/combining
// machinery itself (already thoroughly proven in tests/multisigProvider.test.ts)
// — inserting the resulting signature directly via Prisma rather than
// through submitTransactionSignature(), which would otherwise drive the
// escrow all the way to terminal in one call and never leave the C8
// state to observe.

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import nacl from 'tweetnacl'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NETWORK = bitcoin.networks.testnet

function testnetAddress(label: string): string {
  const scalar = createHash('sha256').update(label).digest()
  const pubkey = Buffer.from(ecc.pointFromScalar(scalar, true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address!
}

describe('M9-R — C8 recovery: all signatures persisted, transition never claimed (real Postgres)', () => {
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
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements

  const ARBITER_ID = 'm9r-c8-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')

  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('m9r-c8-buyer').digest(), { network: NETWORK })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('m9r-c8-seller').digest(), { network: NETWORK })
  const BUYER_PUBKEY = Buffer.from(buyerKey.publicKey).toString('hex')
  const SELLER_PUBKEY = Buffer.from(sellerKey.publicKey).toString('hex')

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
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-c8-test-seed'
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
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-R C8 Test Arbiter' },
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

  it('reproduces C8 and resumes it: real signature persisted, escrow non-terminal, PASS 0 asks the chain first, then claims and finalizes', async () => {
    requirePostgres('C8 reproduction + recovery')

    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const fundingTxid = createHash('sha256').update(`m9r-c8-funding-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(fundingTxid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, 'M9-R C8 test')
    expect(dispute.arbiterId).toBe(ARBITER_ID)

    const buyerDestination = testnetAddress('m9r-c8-buyer-dest')
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)

    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    // The real, live path — this durably commits the Outcome AND persists
    // the real unsigned (arbiter-pre-signed) PSBT via initiateRelease().
    await getDisputeService().resolveDispute(dispute.id, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signature, issuedAt)

    const pendingBefore = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })
    expect(pendingBefore).not.toBeNull()
    expect(pendingBefore!.requiredSigners).toEqual([buyer.id])

    // Real signature — buyer independently signs their own copy of the
    // REAL persisted unsigned PSBT, same technique
    // tests/multisigProvider.test.ts's own buildRealSignedRelease() uses.
    const buyerCopy = bitcoin.Psbt.fromBase64(pendingBefore!.unsignedPsbtBase64, { network: NETWORK })
    buyerCopy.signInput(0, buyerKey)
    const buyerSignedBase64 = buyerCopy.toBase64()

    // Reproduces C8 exactly: the signature is inserted DIRECTLY (bypassing
    // submitTransactionSignature(), which would otherwise immediately
    // detect allSubmitted=true and drive this all the way to COMPLETED in
    // the same call) — leaving every required signature durably persisted
    // while the escrow itself is still non-terminal, exactly as if the
    // process had died between "last signature persisted" and
    // claimEscrowTransition().
    await prisma.escrowTransactionSignature.create({
      data: { pendingTxId: pendingBefore!.id, participantId: buyer.id, signedPsbtBase64: buyerSignedBase64 },
    })

    const escrowBeforeRecovery = await prisma.escrow.findUnique({ where: { id: escrow.id } })
    expect(escrowBeforeRecovery!.status).not.toMatch(/COMPLETED|REFUNDED|SPLIT/)
    expect(escrowBeforeRecovery!.txReleaseId).toBeNull()

    // C8 recovery — PASS 0 of reconcilePendingSettlements().
    const report = await reconcilePendingSettlements()

    expect(report.resumedUnclaimed.find((r) => r.escrowId === escrow.id)).toBeDefined()
    const escrowAfter = await prisma.escrow.findUnique({ where: { id: escrow.id } })
    expect(escrowAfter!.status).toBe('COMPLETED')
    expect(escrowAfter!.txReleaseId).not.toBeNull()

    // The pending row and its signature are cleaned up by the same shared
    // downstream-effects path PASS 1/PASS 2 already use.
    const pendingAfter = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })
    expect(pendingAfter).toBeNull()

    // The completion event fired for real (Fase 9.7's own idempotency
    // claim), proving this isn't a partial/fake convergence.
    const completionEvent = await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } })
    expect(completionEvent).not.toBeNull()
  })

  // Gatekeeper NO-GO on 424e8969: PASS 0 ran its gates, then broadcast, and only claimed the escrow afterwards. A dispute
  // opened between the gates and the broadcast did not stop the funds from moving.
  async function makeCooperativeC8(label: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const fundingTxid = createHash('sha256').update(`${label}-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(fundingTxid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)
    // From here the release transaction is unknown to the network and the funding outpoint unspent: PASS 0 would broadcast.
    const funded = global.fetch
    global.fetch = jest.fn(async (url: string, init?: unknown) =>
      /\/tx\/[0-9a-f]{64}\/status/.test(url) && !url.includes(fundingTxid) ? ({ ok: false, status: 404 } as any) : (funded as any)(url, init)) as any
    await escrowService.markPaymentSent(escrow.id, buyer.id)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`${label}-buyer-dest`))
    await escrowService.initiateRelease(escrow.id, undefined, seller.id)

    // Both required signatures persisted directly: the process died before submitTransactionSignature() claimed.
    const pending = (await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } }))!
    expect(pending.disputeId).toBeNull()
    const keyOf: Record<string, ReturnType<typeof ECPair.fromPrivateKey>> = { [buyer.id]: buyerKey, [seller.id]: sellerKey }
    for (const signer of pending.requiredSigners) {
      const copy = bitcoin.Psbt.fromBase64(pending.unsignedPsbtBase64, { network: NETWORK })
      copy.signInput(0, keyOf[signer])
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: pending.id, participantId: signer, signedPsbtBase64: copy.toBase64() } })
    }
    return { escrow, buyer }
  }

  // Issue #238 - opening a dispute freezes the escrow and creates its canonical Dispute row in one transaction.
  const openDispute = (escrow: { id: string; tradeId: string }, buyer: { id: string }, reason: string) =>
    escrowService.openDispute(escrow.id, buyer.id, reason, (tx) =>
      tx.dispute.create({ data: { tradeId: escrow.tradeId, escrowId: escrow.id, openedBy: buyer.id, reason, status: 'OPENED' } }))

  it('cooperative C8: a dispute opened after the gates and before the broadcast cannot be opened, because the escrow is claimed first', async () => {
    requirePostgres('C8 dispute between gates and broadcast')
    const { escrow, buyer } = await makeCooperativeC8('m9r-c8-race-broadcast')
    const { multisigProvider } = require('../../src/modules/open-settlement/multisig.provider')
    let disputeAttempt: 'opened' | 'refused' | 'not attempted' = 'not attempted'
    const broadcast = jest.spyOn(multisigProvider, 'broadcast').mockImplementation(async () => {
      disputeAttempt = await openDispute(escrow, buyer, 'raced the broadcast').then(() => 'opened' as const, () => 'refused' as const)
      return 'provider-txid'
    })

    await reconcilePendingSettlements()

    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(disputeAttempt).toBe('refused')
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('COMPLETED')
    broadcast.mockRestore()
  })

  it('cooperative C8: a dispute that wins before the claim stops the broadcast', async () => {
    requirePostgres('C8 dispute wins')
    const { escrow, buyer } = await makeCooperativeC8('m9r-c8-race-dispute')
    const { multisigProvider } = require('../../src/modules/open-settlement/multisig.provider')
    const capability = require('../../src/modules/open-settlement/capability-execution-authorization')
    const realAuthorize = capability.authorizePendingExecution
    const authorize = jest.spyOn(capability, 'authorizePendingExecution').mockImplementation(async (pending: unknown) => {
      await openDispute(escrow, buyer, 'won the race')
      return realAuthorize(pending)
    })
    const broadcast = jest.spyOn(multisigProvider, 'broadcast')

    const report = await reconcilePendingSettlements()

    expect(authorize).toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('DISPUTED')
    expect(report.resumedUnclaimed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    authorize.mockRestore()
    broadcast.mockRestore()
  })

  it('cooperative C8: a broadcast that fails after the claim is UNKNOWN, not reverted, and recovery converges from chain truth', async () => {
    requirePostgres('C8 broadcast UNKNOWN')
    const { escrow, buyer } = await makeCooperativeC8('m9r-c8-unknown')
    const { multisigProvider } = require('../../src/modules/open-settlement/multisig.provider')
    let releaseTxid = ''
    const broadcast = jest.spyOn(multisigProvider, 'broadcast').mockImplementation(async (hex: unknown) => {
      releaseTxid = bitcoin.Transaction.fromHex(hex as string).getId()
      throw new Error('explorer timed out after sending')
    })

    const first = await reconcilePendingSettlements()

    expect(first.failed.find((f) => f.escrowId === escrow.id)).toBeDefined()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('COMPLETED')
    await expect(openDispute(escrow, buyer, 'after an unknown broadcast')).rejects.toThrow()

    // The broadcast did reach the network: PASS 1 finds it and converges without broadcasting again.
    const unknown = global.fetch
    global.fetch = jest.fn(async (url: string, init?: unknown) =>
      url.includes(`/tx/${releaseTxid}/status`) ? ({ ok: true, status: 200, json: async () => ({ confirmed: false }) } as any) : (unknown as any)(url, init)) as any
    broadcast.mockClear()
    await reconcilePendingSettlements()

    expect(broadcast).not.toHaveBeenCalled()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).txReleaseId).toBe(releaseTxid)
    broadcast.mockRestore()
  })

  it('duplicate workers: two concurrent recovery runs against the SAME C8 escrow never both claim the transition', async () => {
    requirePostgres('C8 duplicate workers')

    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const fundingTxid = createHash('sha256').update(`m9r-c8-dup-funding-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(fundingTxid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, 'M9-R C8 duplicate-workers test')
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress('m9r-c8-dup-buyer-dest'))

    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    await getDisputeService().resolveDispute(dispute.id, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signature, issuedAt)

    const pendingBefore = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })
    const buyerCopy = bitcoin.Psbt.fromBase64(pendingBefore!.unsignedPsbtBase64, { network: NETWORK })
    buyerCopy.signInput(0, buyerKey)
    await prisma.escrowTransactionSignature.create({
      data: { pendingTxId: pendingBefore!.id, participantId: buyer.id, signedPsbtBase64: buyerCopy.toBase64() },
    })

    const [reportA, reportB] = await Promise.all([reconcilePendingSettlements(), reconcilePendingSettlements()])

    const resumedTotal = reportA.resumedUnclaimed.filter((r) => r.escrowId === escrow.id).length + reportB.resumedUnclaimed.filter((r) => r.escrowId === escrow.id).length
    expect(resumedTotal).toBe(1) // exactly one worker actually claimed and finalized it

    const escrowAfter = await prisma.escrow.findUnique({ where: { id: escrow.id } })
    expect(escrowAfter!.status).toBe('COMPLETED')
    // No double-fire of the completion cascade — exactly one EscrowEvent.
    const completionEvents = await prisma.escrowEvent.findMany({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } })
    expect(completionEvents).toHaveLength(1)
  })
})
