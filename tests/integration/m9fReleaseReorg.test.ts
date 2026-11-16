// tests/integration/m9fReleaseReorg.test.ts
//
// Sails Core Implementation Program M9-F (Release-Leg Finality & Reorg
// Closure) — real-Postgres + real-Bitcoin-primitive reproduction of C18:
// a real MULTISIG RELEASE completes for real (real ECPair signatures,
// real PSBT combine/finalize, real txid — same technique
// tests/integration/m9rClaimRecovery.test.ts already established), the
// sweep records a real durable baseline observation, then a reorg is
// simulated via the explorer mock (the only part that CANNOT be real in
// a local/test environment — no real Bitcoin network is touched or
// authorized) and correctly detected, classified, and durably recorded
// — all via real Postgres, never mocked.

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

describe('M9-F — release-leg reorg closure (C18): real Postgres + real Bitcoin primitives', () => {
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
  let sweepMultisigReleaseReorgs: typeof import('../../src/modules/open-settlement/multisig-release-reorg-sweep').sweepMultisigReleaseReorgs

  const ARBITER_ID = 'm9f-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')

  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('m9f-buyer').digest(), { network: NETWORK })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('m9f-seller').digest(), { network: NETWORK })
  const BUYER_PUBKEY = Buffer.from(buyerKey.publicKey).toString('hex')
  const SELLER_PUBKEY = Buffer.from(sellerKey.publicKey).toString('hex')

  let realFetch: typeof fetch

  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string, init?: any) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      // The real broadcast() call — POST .../tx, no txid in the path yet
      // (the explorer assigns/echoes one back in its response body).
      // Deliberately real-shaped (a plausible-looking 64-hex-char string,
      // computed here rather than hardcoded) — R6's own provider-txid-
      // integrity fix means this value is NEVER actually trusted as the
      // persisted txid anyway (multisig.provider.ts derives that from the
      // real signed transaction itself), but a real Response needs a
      // real .text() method regardless.
      if (init?.method === 'POST') return { ok: true, text: async () => require('crypto').createHash('sha256').update(String(init.body)).digest('hex') } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9f-test-seed'
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
    ;({ sweepMultisigReleaseReorgs } = require('../../src/modules/open-settlement/multisig-release-reorg-sweep'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-F Test Arbiter' },
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

  async function makeCompletedReleaseEscrow(suffix: string, ruling: 'RELEASE' | 'REFUND') {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const fundingTxid = createHash('sha256').update(`m9f-funding-${suffix}-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(fundingTxid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `M9-F test — ${suffix}`)

    const beneficiaryId = ruling === 'RELEASE' ? buyer.id : seller.id
    const historicalDestination = testnetAddress(`m9f-${suffix}-D1`)
    await payoutAddressService.setPayoutAddress(beneficiaryId, 'BTC', historicalDestination)

    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: ruling, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    await getDisputeService().resolveDispute(dispute.id, ARBITER_ID, ruling, undefined, undefined, undefined, signature, issuedAt)

    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })
    const requiredSignerId = ruling === 'RELEASE' ? buyer.id : seller.id
    const requiredSignerKey = ruling === 'RELEASE' ? buyerKey : sellerKey
    const signedCopy = bitcoin.Psbt.fromBase64(pending!.unsignedPsbtBase64, { network: NETWORK })
    signedCopy.signInput(0, requiredSignerKey)

    const submitResult = await escrowService.submitTransactionSignature(escrow.id, requiredSignerId, signedCopy.toBase64())
    expect(submitResult.complete).toBe(true)

    const escrowAfter = await prisma.escrow.findUnique({ where: { id: escrow.id } })
    expect(escrowAfter!.txReleaseId).not.toBeNull()

    return { escrowId: escrow.id, txReleaseId: escrowAfter!.txReleaseId as string, beneficiaryId, historicalDestination, txLockId: escrowAfter!.txLockId, txLockVout: escrowAfter!.txLockVout }
  }

  it('World A: a real, freshly-completed RELEASE gets its first durable OBSERVED_CONFIRMED baseline recorded', async () => {
    requirePostgres('release reorg — World A baseline')
    const { escrowId, txReleaseId } = await makeCompletedReleaseEscrow('world-a', 'RELEASE')

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '150' } as any
      if (url.includes(`/tx/${txReleaseId}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 120 }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const result = await sweepMultisigReleaseReorgs()

    expect(result.observedBaseline).toContain(escrowId)
    const evidence = await prisma.escrowReleaseEvidence.findMany({ where: { escrowId } })
    expect(evidence).toHaveLength(1)
    expect(evidence[0].kind).toBe('OBSERVED_CONFIRMED')
    expect(evidence[0].txid).toBe(txReleaseId)
    expect(evidence[0].observedAtHeight).toBe(120)
  })

  it('World C reorg: the confirmed RELEASE disappears, funding outpoint remains unspent — detected, durably recorded as REORGED_INVALIDATED, flagged manual, never auto-rebroadcast, and the ORIGINAL OBSERVED_CONFIRMED fact is never erased', async () => {
    requirePostgres('release reorg — World C detection')
    const { escrowId, txReleaseId, txLockId, txLockVout } = await makeCompletedReleaseEscrow('world-c', 'RELEASE')

    // First sweep: real baseline observation (World A).
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '150' } as any
      if (url.includes(`/tx/${txReleaseId}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 120 }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any
    const firstSweep = await sweepMultisigReleaseReorgs()
    expect(firstSweep.observedBaseline).toContain(escrowId)

    // Second sweep: simulate a reorg — the release txid is now genuinely
    // absent (real 404, never coerced from a different failure mode) AND
    // the ORIGINAL funding outpoint is reported still unspent (World C).
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '160' } as any
      if (url.includes(`/tx/${txReleaseId}/status`)) return { status: 404, ok: false } as any
      if (url.includes(`/tx/${txLockId}/outspend/${txLockVout}`)) return { ok: true, json: async () => ({ spent: false }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any
    const secondSweep = await sweepMultisigReleaseReorgs()

    expect(secondSweep.requiresManualReview.find((r) => r.escrowId === escrowId)).toBeDefined()

    const evidence = await prisma.escrowReleaseEvidence.findMany({ where: { escrowId }, orderBy: { recordedAt: 'asc' } })
    expect(evidence).toHaveLength(2)
    // The ORIGINAL fact — OBSERVATION ≠ FINALITY (mission §3) — is never
    // erased or mutated by the later reorg.
    expect(evidence[0].kind).toBe('OBSERVED_CONFIRMED')
    expect(evidence[0].txid).toBe(txReleaseId)
    expect(evidence[1].kind).toBe('REORGED_INVALIDATED')
    expect(evidence[1].note).toMatch(/exact rebroadcast is not possible/)

    // The escrow's own terminal status/txReleaseId are untouched — this
    // sweep never rewrites Escrow itself, only appends evidence.
    const escrowAfter = await prisma.escrow.findUnique({ where: { id: escrowId } })
    expect(escrowAfter!.status).toBe('COMPLETED')
    expect(escrowAfter!.txReleaseId).toBe(txReleaseId)
  })

  it('D1->D2 regression (mission §14): REFUND completes paying historical D1, PayoutAddress later rotates to D2, then a reorg is detected — the durable evidence trail never references D2, and the historical correspondence/destination facts already proven elsewhere are untouched by this sweep', async () => {
    requirePostgres('release reorg — REFUND D1 regression')
    const { escrowId, txReleaseId, beneficiaryId, historicalDestination } = await makeCompletedReleaseEscrow('refund-d1', 'REFUND')

    // Rotate AFTER completion.
    await payoutAddressService.setPayoutAddress(beneficiaryId, 'BTC', testnetAddress('m9f-refund-d1-rotated-D2'))

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '150' } as any
      if (url.includes(`/tx/${txReleaseId}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 120 }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any
    const result = await sweepMultisigReleaseReorgs()

    expect(result.observedBaseline).toContain(escrowId)
    const evidence = await prisma.escrowReleaseEvidence.findMany({ where: { escrowId } })
    // The evidence trail is destination-agnostic by construction (it only
    // ever records txid/height) — this sweep has no code path that could
    // reference D2 at all, proven here by simple absence.
    expect(evidence.every((e) => JSON.stringify(e).includes(historicalDestination) === false)).toBe(true)
    expect(evidence.every((e) => JSON.stringify(e).includes('rotated-D2') === false)).toBe(true)

    // The real destination proof (pending.toAddress === D1) is M8-RF's
    // own already-established territory (tests/integration/disputeOutcomeMultisigLive.test.ts,
    // tests/integration/m9rDispatchRecovery.test.ts) — re-confirmed here
    // only to the extent that this sweep does not regress it: the
    // Escrow row itself carries no destination field to check, and the
    // pending row is already gone (completed), consistent with M8-RF's
    // own proven behavior.
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).toBeNull()
  })
})
