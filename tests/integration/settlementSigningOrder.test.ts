// tests/integration/settlementSigningOrder.test.ts
//
// MULTISIG disputed settlement: a round only executes a recorded ruling of the same kind, and the arbiter's signature
// exists only at execution (never persisted, never returned). Real PostgreSQL and real 2-of-3 P2WSH PSBTs; only the
// explorer is simulated (pendingRoundLifecycleHarness.ts).
import { PrismaClient } from '@prisma/client'
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { buyerKey, sellerKey, newChain, explorer, signRound, completeOutsideSails, buildCooperative, NETWORK, type Chain } from './pendingRoundLifecycleHarness'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'

describe('MULTISIG disputed settlement signing order (real PostgreSQL, real PSBTs)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: any
  let identityService: any
  let liquidityRouter: any
  let tradeService: any
  let payoutAddressService: any
  let getDisputeService: any
  let signAuthorityDecision: any
  let multisigProvider: any
  let toPendingTransactionResponse: any
  let withoutPartialSignatures: any
  let loadParticipantPubkeys: any

  const ARBITER_ID = 'sso-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  let chain: Chain
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'sso-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ;({ toPendingTransactionResponse, withoutPartialSignatures } = require('../../src/modules/open-settlement/settlement.routes'))
    ;({ loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    const publicKey = Buffer.from(arbiterKeypair.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey }, create: { id: ARBITER_ID, publicKey, displayName: 'sso arbiter' } })
  })
  beforeEach(() => { chain = newChain(); realFetch = global.fetch; global.fetch = explorer(chain) })
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks() })
  afterAll(async () => { if (dbAvailable) { await prisma.$disconnect(); await closeTestRedis() } })

  const deps = () => ({ prisma, escrowService, identityService, liquidityRouter, tradeService, payoutAddressService })
  const funded = (label: string) => buildCooperative(deps(), chain, `sso-${label}`, 'none')
  const partialSigs = (b64: string) => bitcoin.Psbt.fromBase64(b64, { network: NETWORK }).data.inputs.reduce((n, i) => n + (i.partialSig ?? []).length, 0)
  const round = (escrowId: string) => prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId }, include: { signatures: true } })
  async function resolve(f: Awaited<ReturnType<typeof funded>>, disputeId: string, outcome: 'RELEASE' | 'REFUND') {
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId, escrowId: f.escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps: null, issuedAt }
    return getDisputeService().resolveDispute(disputeId, ARBITER_ID, outcome, undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt)
  }

  it('1: while the dispute is OPEN, the assigned arbiter cannot create a release, refund or split round', async () => {
    pg.requirePostgres('1')
    const f = await funded('open')
    await getDisputeService().raiseDispute(f.trade.id, f.buyer.id, 'sso')
    await expect(escrowService.initiateRelease(f.escrow.id, undefined, ARBITER_ID)).rejects.toMatchObject({ code: 'DISPUTE_RULING_REQUIRED' })
    await expect(escrowService.initiateRefund(f.escrow.id, ARBITER_ID)).rejects.toMatchObject({ code: 'DISPUTE_RULING_REQUIRED' })
    await expect(escrowService.initiateSplit(f.escrow.id, undefined, undefined, 5000, ARBITER_ID)).rejects.toMatchObject({ code: 'DISPUTE_RULING_REQUIRED' })
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrow.id } })).toBe(0)
  })

  it('2: a RESOLVED ruling round carries no signature; one party alone cannot complete it; execution adds the arbiter signature and settles once', async () => {
    pg.requirePostgres('2')
    const f = await funded('ruled')
    const dispute = await getDisputeService().raiseDispute(f.trade.id, f.buyer.id, 'sso')
    await resolve(f, dispute.id, 'RELEASE')
    const r = await round(f.escrow.id)
    expect(r.disputeId).toBe(dispute.id)
    expect(partialSigs(r.unsignedPsbtBase64)).toBe(0)
    const buyerSig = signRound(r.unsignedPsbtBase64, buyerKey)
    expect(() => completeOutsideSails(r.unsignedPsbtBase64, [buyerSig])).toThrow()
    const done = await escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, buyerSig, r.id)
    expect(done.complete).toBe(true)
    expect(chain.broadcasts).toHaveLength(1)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrow.id } })).status).toBe('COMPLETED')
  })

  it('3: a ruling of a different kind does not authorize the round (REFUND ruling, release requested)', async () => {
    pg.requirePostgres('3')
    const f = await funded('mismatch')
    const dispute = await getDisputeService().raiseDispute(f.trade.id, f.buyer.id, 'sso')
    await resolve(f, dispute.id, 'REFUND')
    const dispatched = await round(f.escrow.id) // the ruling's own refund round
    expect(dispatched.kind).toBe('refund')
    await prisma.escrowPendingTransaction.delete({ where: { id: dispatched.id } })
    await expect(escrowService.initiateRelease(f.escrow.id, undefined, ARBITER_ID)).rejects.toMatchObject({ code: 'DISPUTE_RULING_REQUIRED' })
  })

  it('4: a stored partial signature never leaves the server in any response, and is accepted at execution only if valid', async () => {
    pg.requirePostgres('4')
    const f = await funded('stored-sig')
    const dispute = await getDisputeService().raiseDispute(f.trade.id, f.buyer.id, 'sso')
    await resolve(f, dispute.id, 'RELEASE')
    const r = await round(f.escrow.id)
    // A stored round whose PSBT already carries the arbiter's signature.
    const keys = await loadParticipantPubkeys(f.escrow.id)
    const withSig = multisigProvider.signAsArbiterAtExecution(
      { tradeId: f.trade.id, lockedAmount: '0.001', ...keys, status: 'DISPUTED', triggeredBy: ARBITER_ID }, r.unsignedPsbtBase64)
    await prisma.$executeRaw`UPDATE escrow_pending_transactions SET "unsignedPsbtBase64" = ${withSig} WHERE id = ${r.id}`
    const stored = await round(f.escrow.id)
    expect(partialSigs(stored.unsignedPsbtBase64)).toBe(1)
    expect(partialSigs(toPendingTransactionResponse(stored).unsignedPsbtBase64)).toBe(0)
    expect(partialSigs(withoutPartialSignatures(stored).unsignedPsbtBase64)).toBe(0)
    // Execution accepts the valid stored signature (no duplicate is added) and settles once.
    const done = await escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, signRound(stored.unsignedPsbtBase64, buyerKey), r.id)
    expect(done.complete).toBe(true)
    expect(chain.broadcasts).toHaveLength(1)
  })

  it('5: the seller cannot use a ruling round for the buyer (signer membership unchanged)', async () => {
    pg.requirePostgres('5')
    const f = await funded('member')
    const dispute = await getDisputeService().raiseDispute(f.trade.id, f.buyer.id, 'sso')
    await resolve(f, dispute.id, 'RELEASE')
    const r = await round(f.escrow.id)
    await expect(escrowService.submitTransactionSignature(f.escrow.id, f.seller.id, signRound(r.unsignedPsbtBase64, sellerKey), r.id)).rejects.toThrow()
    expect(chain.broadcasts).toHaveLength(0)
  })
})
