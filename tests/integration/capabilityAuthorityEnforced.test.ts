// tests/integration/capabilityAuthorityEnforced.test.ts
//
// Issue #303 - real Postgres + real Redis evidence that, with
// ENFORCE_CAPABILITIES=true (the only value a production process may boot
// with), a complete settlement lifecycle works WITHOUT manual database
// intervention (every actor onboards through the SDK's real
// ensureCanonicalGrants() against the real registry), and that the
// ADR-004 gates/revocation/expiry/recovery semantics hold:
//   - Gate A (admission) and Gate B (execution commit) both fire;
//   - revoked / expired / missing grants fail closed at each window;
//   - after the durable Gate B commit, the same immutable attempt recovers
//     without a live grant (ADR-004 s4);
//   - an arbiter or a seller without a settlement grant is refused - there
//     is no silent "system" exemption - and becomes able to act as soon as
//     it onboards, so nothing deadlocks.
// Real ECPair signatures / PSBT finalization follow m9fReleaseReorg.test.ts;
// only the block explorer HTTP is mocked (no Bitcoin network is touched).

process.env.ENFORCE_CAPABILITIES = 'true' // before ANY src/config load (the harness probe loads it)

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NETWORK = bitcoin.networks.testnet

function testnetAddress(label: string): string {
  const scalar = createHash('sha256').update(label).digest()
  const pubkey = Buffer.from(ecc.pointFromScalar(scalar, true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address!
}

describe('Issue #303 - Capability Authority enforced end to end (real Postgres + real Redis)', () => {
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
  let capabilityRegistry: typeof import('../../src/core/capability-registry').capabilityRegistry
  let authorizePendingExecution: typeof import('../../src/modules/open-settlement/capability-execution-authorization').authorizePendingExecution
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let SailsCapabilitiesModule: typeof import('../../packages/sails-sdk/src/modules/capabilities').SailsCapabilitiesModule
  let SailsTransport: typeof import('../../packages/sails-sdk/src/transport').SailsTransport
  let config: typeof import('../../src/config').config

  const ARBITER_ID = 'cap303-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('cap303-buyer').digest(), { network: NETWORK })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('cap303-seller').digest(), { network: NETWORK })
  const BUYER_PUBKEY = Buffer.from(buyerKey.publicKey).toString('hex')
  const SELLER_PUBKEY = Buffer.from(sellerKey.publicKey).toString('hex')
  const SETTLEMENT = 'settlement'

  let realFetch: typeof fetch

  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string, init?: any) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      if (init?.method === 'POST') return { ok: true, text: async () => createHash('sha256').update(String(init.body)).digest('hex') } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'cap303-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID

    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ config } = require('../../src/config'))
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
    ;({ capabilityRegistry } = require('../../src/core/capability-registry'))
    ;({ authorizePendingExecution } = require('../../src/modules/open-settlement/capability-execution-authorization'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ SailsCapabilitiesModule } = require('../../packages/sails-sdk/src/modules/capabilities'))
    ;({ SailsTransport } = require('../../packages/sails-sdk/src/transport'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'Cap303 Test Arbiter' },
    })
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // The REAL SDK onboarding call, answered by the REAL (Postgres-backed)
  // registry with the same semantics as capability.routes.ts: grantedTo =
  // issuedBy = the caller. No direct prisma.capabilityGrant writes anywhere
  // in this file except the deliberate expiry manipulation below.
  async function onboard(participantId: string): Promise<void> {
    const fetchImpl = async (url: string, init: any) => {
      const respond = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => ({ success: status < 300, data }) })
      if (String(url).endsWith('/v1/capabilities/register')) {
        const body = JSON.parse(init.body)
        return respond(201, await capabilityRegistry.grant({ grantedTo: participantId, issuedBy: participantId, ...body }))
      }
      return respond(200, await capabilityRegistry.listGrants(participantId))
    }
    const transport = new SailsTransport({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken('s')
    await new SailsCapabilitiesModule(transport).ensureCanonicalGrants(participantId)
  }

  async function revokeAllSettlementGrants(participantId: string): Promise<void> {
    for (const g of await capabilityRegistry.listGrants(participantId)) {
      if (g.capabilityName === SETTLEMENT) await capabilityRegistry.revoke(g.grantId, participantId)
    }
  }

  async function expireSettlementGrants(participantId: string): Promise<void> {
    await prisma.capabilityGrant.updateMany({
      where: { grantedTo: participantId, capabilityName: SETTLEMENT, revokedAt: null },
      data: { constraints: { expiresAt: new Date(Date.now() - 60_000).toISOString() } },
    })
  }

  async function makeDisputedEscrow(suffix: string, opts: { onboardArbiter: boolean }) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    await onboard(seller.id)
    await onboard(buyer.id)
    await revokeAllSettlementGrants(ARBITER_ID) // start every scenario from a known state
    if (opts.onboardArbiter) await onboard(ARBITER_ID)

    // createOffer() -> intentEngine.create() runs the 'intent.created' gate for real.
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const fundingTxid = createHash('sha256').update(`cap303-funding-${suffix}-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(fundingTxid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `cap303 - ${suffix}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`cap303-${suffix}-D1`))
    return { seller, buyer, escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id }
  }

  async function resolveRelease(disputeId: string, escrowId: string) {
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId, escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    return getDisputeService().resolveDispute(disputeId, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signature, issuedAt)
  }

  async function buyerSignature(escrowId: string): Promise<string> {
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    const psbt = bitcoin.Psbt.fromBase64(pending!.unsignedPsbtBase64, { network: NETWORK })
    psbt.signInput(0, buyerKey)
    return psbt.toBase64()
  }

  it('the process under test really runs with enforcement ON (this file proves the production posture)', () => {
    requirePostgres('enforcement is on')
    expect(config.features.enforceCapabilities).toBe(true)
  })

  it('COMPLETE LIFECYCLE with enforcement on and no manual DB intervention: SDK-onboarded seller/buyer/arbiter, Gate A, Gate B, real signature, real finalize', async () => {
    requirePostgres('complete enforced lifecycle')
    const { buyer, escrowId, disputeId } = await makeDisputedEscrow('lifecycle', { onboardArbiter: true })

    await resolveRelease(disputeId, escrowId) // Gate A (arbiter = triggeredBy)
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.triggeredBy).toBe(ARBITER_ID)
    expect(await prisma.capabilityExecutionAuthorization.findUnique({ where: { pendingOperationId: pending!.id } })).toBeNull() // Gate B not yet

    const result = await escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId)) // Gate B
    expect(result.complete).toBe(true)

    const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } })
    expect(escrow!.status).toBe('COMPLETED')
    const authz = await prisma.capabilityExecutionAuthorization.findUnique({ where: { pendingOperationId: pending!.id } })
    expect(authz).not.toBeNull()
    expect(authz!.grantedTo).toBe(ARBITER_ID) // original triggeredBy, not the final signer
    expect(authz!.requiredScope).toBe('settlement.escrow.released')
    const grant = await prisma.capabilityGrant.findUnique({ where: { id: authz!.grantId } })
    expect(grant!.issuedBy).toBe(grant!.grantedTo) // self-issued consent, recorded as such
  })

  it('an arbiter WITHOUT a settlement grant fails closed (no system exemption): nothing is pending, nothing moves - and onboarding lets it complete', async () => {
    requirePostgres('arbiter without grant')
    const { buyer, escrowId, disputeId } = await makeDisputedEscrow('arbiter-missing', { onboardArbiter: false })

    await expect(resolveRelease(disputeId, escrowId)).rejects.toThrow(/no active 'settlement' capability grant/)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })).toBeNull()
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.status).not.toBe('COMPLETED')

    // Not a deadlock: the arbiter self-onboards through the SDK, retries, and it completes.
    await onboard(ARBITER_ID)
    await resolveRelease(disputeId, escrowId)
    const result = await escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId))
    expect(result.complete).toBe(true)
  })

  it('revocation BEFORE admission blocks (Gate A)', async () => {
    requirePostgres('revoked before admission')
    const { escrowId, disputeId } = await makeDisputedEscrow('revoked-before', { onboardArbiter: true })
    await revokeAllSettlementGrants(ARBITER_ID)

    await expect(resolveRelease(disputeId, escrowId)).rejects.toThrow(/no active 'settlement' capability grant/)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })).toBeNull()
  })

  it('an EXPIRED grant blocks admission (Gate A)', async () => {
    requirePostgres('expired at admission')
    const { escrowId, disputeId } = await makeDisputedEscrow('expired-admission', { onboardArbiter: true })
    await expireSettlementGrants(ARBITER_ID)

    await expect(resolveRelease(disputeId, escrowId)).rejects.toThrow(/no active 'settlement' capability grant/)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })).toBeNull()
  })

  it('revocation BETWEEN admission and Gate B blocks the first execution commit - nothing durable is written, no funds move; a NEW valid grant then re-authorizes the unchanged operation (ADR-004 s6)', async () => {
    requirePostgres('revoked between admission and Gate B')
    const { buyer, escrowId, disputeId } = await makeDisputedEscrow('revoked-between', { onboardArbiter: true })
    await resolveRelease(disputeId, escrowId) // admitted
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })

    await revokeAllSettlementGrants(ARBITER_ID)
    await expect(
      escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId))
    ).rejects.toThrow(/no active 'settlement' capability grant .* at execution commit/)
    expect(await prisma.capabilityExecutionAuthorization.findUnique({ where: { pendingOperationId: pending!.id } })).toBeNull()
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.status).not.toBe('COMPLETED')

    await onboard(ARBITER_ID) // a different, currently-valid grant
    const result = await escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId))
    expect(result.complete).toBe(true)
  })

  it('an EXPIRED grant between admission and Gate B blocks the first execution commit', async () => {
    requirePostgres('expired between admission and Gate B')
    const { buyer, escrowId, disputeId } = await makeDisputedEscrow('expired-between', { onboardArbiter: true })
    await resolveRelease(disputeId, escrowId)
    await expireSettlementGrants(ARBITER_ID)

    await expect(
      escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId))
    ).rejects.toThrow(/at execution commit/)
  })

  it('revocation AFTER the durable Gate B commit does NOT invalidate recovery of the same immutable attempt (ADR-004 s4); a repeated authorization returns the SAME durable row, before and after a revoke', async () => {
    requirePostgres('revoked after durable Gate B')
    const { buyer, escrowId, disputeId } = await makeDisputedEscrow('revoked-after', { onboardArbiter: true })
    await resolveRelease(disputeId, escrowId)
    const pending = (await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } }))!

    const committed = await authorizePendingExecution(pending as any) // first execution commit, durable
    expect(committed).not.toBeNull()

    await revokeAllSettlementGrants(ARBITER_ID) // prospective only
    const replay = await authorizePendingExecution(pending as any) // restart/retry of the same attempt
    expect(replay!.id).toBe(committed!.id)

    const result = await escrowService.submitTransactionSignature(escrowId, buyer.id, await buyerSignature(escrowId))
    expect(result.complete).toBe(true) // the live path also reuses the durable authorization
    expect(await prisma.capabilityExecutionAuthorization.count({ where: { pendingOperationId: pending.id } })).toBe(1)
  })

  it('SELLER / SWEEPER: an expired escrow refund by the sweeper is refused while the seller has no settlement grant (explicit, reported in failed[], funds stay locked) and succeeds once the seller onboards', async () => {
    requirePostgres('seller sweeper')
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    await onboard(seller.id)
    await onboard(buyer.id)
    await revokeAllSettlementGrants(seller.id) // seller keeps trade-coordination only

    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    // MOCK is a deliberate non-production type: the direct (non-signature-collection) refund path the sweeper drives.
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.lockFunds(escrow.id, seller.id)
    await prisma.escrow.update({ where: { id: escrow.id }, data: { expiresAt: new Date(Date.now() - 60_000) } })

    const refused = await escrowService.sweepExpiredEscrows()
    expect(refused.refunded).not.toContain(escrow.id)
    const failure = refused.failed.find((f) => f.escrowId === escrow.id)
    expect(failure?.error).toMatch(/no active 'settlement' capability grant covering 'settlement.escrow.refunded'/)
    expect((await prisma.escrow.findUnique({ where: { id: escrow.id } }))!.status).toBe('FUNDS_LOCKED')

    await onboard(seller.id)
    const recovered = await escrowService.sweepExpiredEscrows()
    expect(recovered.refunded).toContain(escrow.id)
    expect((await prisma.escrow.findUnique({ where: { id: escrow.id } }))!.status).toBe('REFUNDED')
  })

  it('RESTART/RECOVERY: a RESOLVED dispute whose dispatch never happened is resumed by reconcileMissingDispatch() only once the arbiter holds a grant - still fail-closed before that', async () => {
    requirePostgres('dispatch recovery under enforcement')
    const { escrowId, disputeId } = await makeDisputedEscrow('recovery', { onboardArbiter: true })
    await resolveRelease(disputeId, escrowId) // ruling durably committed + dispatched (pending exists)
    // Simulate the crash window: dispatch effects gone, durable ruling remains.
    await prisma.escrowPendingTransaction.delete({ where: { escrowId } })
    await revokeAllSettlementGrants(ARBITER_ID)

    const blocked = await reconcileMissingDispatch()
    expect(blocked.resumed.map((r) => r.escrowId)).not.toContain(escrowId)
    expect(blocked.failed.find((f) => f.escrowId === escrowId)?.error).toMatch(/no active 'settlement' capability grant/) // explicit, not silent
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })).toBeNull()

    await onboard(ARBITER_ID)
    const resumed = await reconcileMissingDispatch()
    expect(resumed.resumed.map((r) => r.escrowId)).toContain(escrowId)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })).not.toBeNull()
  })
})
