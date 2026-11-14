// tests/integration/m9rReleaseRefundDivergence.test.ts
//
// CTO 25 (AUX2, #343) - adversarial probe: the durable authoritative Outcome says RELEASE, and the assigned arbiter
// calls the refund route (settlement.routes.ts initiate-refund -> escrowService.initiateRefund(id, participantId)).
// No defective translator is injected: the refund PSBT is the provider's own honest refund. Real PostgreSQL, real
// 2-of-3 P2WSH PSBTs, real services; only the explorer is simulated, and every POST /tx is counted as an attempt.
// Runs unchanged on main and on the R2 branch; each step is printed as an [evidence] line for the comparison.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

describe('CTO 25 - a RELEASE Outcome never executes as a REFUND (real PostgreSQL)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, submitSig: any, loadDisputeRulingRecord: any
  const ARBITER_ID = 'aux2-divergence-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch; let posts = 0

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aux2-divergence-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling: commit, loadDisputeRulingRecord } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'aux2 divergence arbiter' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch; posts = 0
    const base = H.explorer(chain)
    global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && String(input).endsWith('/tx')) {
        posts++ // every attempt, before anything else
        const hex = init.body as string; const tx = bitcoin.Transaction.fromHex(hex); const txid = tx.getId()
        chain.mempool.add(txid); chain.hex.set(txid, hex); chain.broadcasts.push(txid)
        chain.spentBy.set(`${Buffer.from(tx.ins[0].hash).reverse().toString('hex')}:${tx.ins[0].index}`, txid)
        return { ok: true, status: 200, text: async () => txid, json: async () => ({}) } as unknown as Response
      }
      return base(input as string, init as RequestInit)
    }) as typeof fetch
  })
  afterEach(() => { if (realFetch) global.fetch = realFetch })

  async function fixture(label: string) {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY } = H.participantKeys() // one MULTISIG address per escrow (#621)
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`aux2-div-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(`${label}-b`), sellerAddr = H.testnetAddress(`${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    const d = await getDisputeService().raiseDispute(trade.id, buyer.id, `aux2 divergence ${label}`)
    return { escrowId: escrow.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d.id as string, buyerAddr, sellerAddr, buyerKey, sellerKey }
  }
  type F = Awaited<ReturnType<typeof fixture>>

  /** The arbiter's real signed RELEASE, committed through the production Core commit (Outcome record + RESOLVED dispute,
   *  one transaction). The dispatch is not run: this is the state a crash between commit and dispatch leaves (C4). */
  async function commitRelease(f: F) {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, payload, signAuthorityDecision(payload, kp.secretKey), arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
  }
  const payees = (f: F, hex: string) => bitcoin.Transaction.fromHex(hex).outs.map((o) => {
    const a = bitcoin.address.fromOutputScript(o.script, H.NETWORK)
    return a === f.buyerAddr ? 'buyer' : a === f.sellerAddr ? 'seller' : 'other'
  })
  /** What a node would check, short of the funding itself (simulated): the broadcast spends this escrow's funding
   *  outpoint, its witness script is this escrow's 2-of-3 P2WSH, and both signatures are valid BIP143 signatures by
   *  committed participant keys. Distinguishes a valid, fully signed transaction from a merely built one. */
  async function validity(f: F, hex: string) {
    const tx = bitcoin.Transaction.fromHex(hex)
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })
    const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId: f.escrowId } })
    const input = tx.ins[0]; const w = input.witness; const script = w[w.length - 1]
    const signers = w.slice(1, -1).map((der) => {
      const { signature, hashType } = bitcoin.script.signature.decode(der)
      const digest = tx.hashForWitnessV0(0, script, 100_000n, hashType)
      return keys.find((k: any) => ecc.verify(digest, Buffer.from(k.pubkey, 'hex'), signature))?.role ?? 'INVALID'
    })
    const outSats = tx.outs.reduce((s, o) => s + Number(o.value), 0)
    return {
      spendsEscrowFunding: Buffer.from(input.hash).reverse().toString('hex') === e.txLockId && input.index === e.txLockVout,
      scriptIsEscrowP2wsh: bitcoin.payments.p2wsh({ redeem: { output: script }, network: H.NETWORK }).address === e.multisigAddr,
      signers, minerFeeSats: 100_000 - outSats,
    }
  }
  async function snapshot(f: F) {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    return {
      escrow: e.status, txReleaseId: e.txReleaseId ?? null, txRefundId: e.txRefundId ?? null, dispute: d.status, ruling: d.ruling,
      outcomeRecord: !!(await loadDisputeRulingRecord(f.escrowId, 0)), pendingRounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }),
      r1Authorizations: await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrowId } }),
    }
  }

  /** Drives one route call to the end: creation, every required signature, then reports what reached the explorer. */
  async function drive(f: F, label: string, initiate: () => Promise<any>) {
    const ev: Record<string, unknown> = { label }
    let round: any = null
    try { round = await initiate(); ev.creation = { created: true, kind: round.kind, requiredSigners: round.requiredSigners.map((s: string) => (s === f.buyerId ? 'buyer' : s === f.sellerId ? 'seller' : s)) } } catch (e: any) { ev.creation = { created: false, error: `${e.constructor?.name}: ${e.message}` } }
    if (round) {
      const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
      ev.roundProvenance = { kind: row.kind, rulingOutcome: row.rulingOutcome, disputeId: row.disputeId === f.disputeId }
      const signatures: unknown[] = []
      for (const signer of row.requiredSigners as string[]) {
        const key = signer === f.buyerId ? f.buyerKey : signer === f.sellerId ? f.sellerKey : null
        if (!key) { signatures.push({ signer, error: 'no test key' }); continue }
        try { const r = await submitSig(f.escrowId, signer, H.signRound(row.unsignedPsbtBase64, key)); signatures.push({ signer: signer === f.buyerId ? 'buyer' : 'seller', complete: r.complete }) } catch (e: any) { signatures.push({ signer: signer === f.buyerId ? 'buyer' : 'seller', error: `${e.constructor?.name}: ${e.message}` }) }
      }
      ev.signatures = signatures
    }
    ev.postAttempts = posts
    ev.broadcastPayees = chain.broadcasts.map((txid) => payees(f, chain.hex.get(txid)!))
    ev.broadcastValidity = await Promise.all(chain.broadcasts.map((txid) => validity(f, chain.hex.get(txid)!)))
    ev.state = await snapshot(f)
    console.log(`[evidence] ${JSON.stringify(ev)}`)
    return ev as any
  }

  it('control: under a committed RELEASE Outcome the arbiter\'s initiate-release pays the buyer, once', async () => {
    pg.requirePostgres('control')
    const f = await fixture('ctl')
    await commitRelease(f)
    const ev = await drive(f, 'control RELEASE->release', () => escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID))
    expect(ev.postAttempts).toBe(1)
    expect(ev.broadcastPayees).toEqual([['buyer']])
    // The probe can tell a valid, fully signed spend apart: this is what the adversarial case is compared against.
    expect(ev.broadcastValidity).toEqual([expect.objectContaining({ spendsEscrowFunding: true, scriptIsEscrowP2wsh: true, signers: expect.not.arrayContaining(['INVALID']) })])
    expect(ev.broadcastValidity[0].signers).toHaveLength(2)
  })

  it('adversarial: under a committed RELEASE Outcome the arbiter\'s initiate-refund never pays the seller and never reaches the explorer', async () => {
    pg.requirePostgres('adversarial')
    const f = await fixture('adv')
    await commitRelease(f)
    const ev = await drive(f, 'adversarial RELEASE->refund', () => escrowService.initiateRefund(f.escrowId, ARBITER_ID))
    expect(ev.broadcastPayees.flat()).not.toContain('seller')
    expect(ev.postAttempts).toBe(0)
    // The authoritative facts survive the attempt.
    expect(ev.state).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcomeRecord: true, escrow: 'DISPUTED' })
  })

  it('arbiter authority without an Outcome: a round the arbiter builds before any ruling never reaches the explorer, and the later signed ruling still dispatches', async () => {
    pg.requirePostgres('pre-ruling')
    const f = await fixture('pre')
    const ev = await drive(f, 'pre-ruling arbiter initiate-release', () => escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID))
    expect(ev.postAttempts).toBe(0)
    // The arbiter's real signed RELEASE through the live path (resolveDispute -> Core commit -> dispatch).
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    let live: unknown = 'ok'
    try { await getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, kp.secretKey), issuedAt) } catch (e: any) { live = `${e.constructor?.name}: ${e.message}` }
    const after = { live, state: await snapshot(f), round: await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: f.escrowId }, select: { kind: true, rulingOutcome: true } }) }
    console.log(`[evidence] ${JSON.stringify({ label: 'pre-ruling then live signed RELEASE', ...after })}`)
    expect(after.live).toBe('ok')
    expect(after.round).toEqual({ kind: 'release', rulingOutcome: 'RELEASE' })
  })
})
