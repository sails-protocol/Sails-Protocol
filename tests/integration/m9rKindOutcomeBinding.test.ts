// tests/integration/m9rKindOutcomeBinding.test.ts
//
// CTO 25 T10/R-4 (AUX2, #343) - a disputed MULTISIG round's kind must be the one its durable authoritative Outcome
// rules: RELEASE <-> release, REFUND <-> refund, SPLIT <-> split. When buyer and seller share a payout address the
// outputs alone cannot tell release from refund apart, yet the kind decides the final status, the fee obligation, the
// settlement event and the reputation outcome. Real PostgreSQL, real 2-of-3 P2WSH PSBTs, real services and event
// handlers; only the explorer is simulated, and every POST /tx is counted as an attempt.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'
type Kind = 'release' | 'refund' | 'split'
const KIND: Record<Ruling, Kind> = { RELEASE: 'release', REFUND: 'refund', SPLIT: 'split' }
const BUYER_BPS = 6000
const FEE_SATS = 400 // 0.4% of the 100 000 sat trade notional, pre-funded on top of it

describe('CTO 25 T10/R-4 - a disputed round\'s kind is bound to its Outcome\'s ruling (real PostgreSQL)', () => {
  jest.setTimeout(600_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, submitSig: any, loadDisputeRulingRecord: any, issueGrant: any, feePolicyService: any, config: any
  const ARBITER_ID = 'aux2-kind-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch; let posts = 0; let fundingValue = 100_000

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aux2-kind-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
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
    ;({ issueRulingSupersessionGrant: issueGrant } = require('../../src/modules/open-settlement/dispute-dispatch'))
    ;({ feePolicyService } = require('../../src/modules/open-settlement/fee-policy.service'))
    ;({ config } = require('../../src/config'))
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'aux2 kind arbiter' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch; posts = 0; fundingValue = 100_000
    const base = H.explorer(chain)
    global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/tx')) {
        posts++ // every attempt, before anything else
        const hex = init.body as string; const tx = bitcoin.Transaction.fromHex(hex); const txid = tx.getId()
        chain.mempool.add(txid); chain.hex.set(txid, hex); chain.broadcasts.push(txid)
        chain.spentBy.set(`${Buffer.from(tx.ins[0].hash).reverse().toString('hex')}:${tx.ins[0].index}`, txid)
        return { ok: true, status: 200, text: async () => txid, json: async () => ({}) } as unknown as Response
      }
      if (url.includes('/utxo')) {
        const body = (chain.locking ? [chain.locking] : [...chain.fundings]).map((txid) => ({ txid, vout: 0, value: fundingValue, status: { confirmed: true } }))
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
      }
      return base(url, init as RequestInit)
    }) as typeof fetch
  })
  afterEach(() => { if (realFetch) global.fetch = realFetch })

  /** A funded, disputed MULTISIG escrow. `shared`: buyer and seller register the same payout address. `fee`: a
   *  published 0.4% protocol-fee policy is snapshotted before funding, so the seller funds T + Fmax. */
  async function fixture(label: string, opts: { shared: boolean; fee?: boolean }) {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    // The escrow's fee regime is this fixture's own, never whatever PUBLISHED MULTISIG policy another file left in a
    // shared database: the live-policy lookup createEscrow() makes is pinned, and the real snapshot path does the rest.
    const feeAddr = H.testnetAddress(`${label}-fee`)
    const policy = opts.fee ? await prisma.feePolicyVersion.create({
      data: {
        label: `aux2-kind-${label}`, railScope: `MULTISIG-aux2-kind-${label}-${Date.now()}`, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10', requiredConfirmations: 2, createdBy: 'aux2-kind-test',
      },
    }) : null
    const live = jest.spyOn(feePolicyService, 'findLivePolicyForRail').mockResolvedValue(policy)
    const collection = config.settlement.protocolFeeCollectionAddress
    if (opts.fee) config.settlement.protocolFeeCollectionAddress = feeAddr
    let escrow: any
    try {
      escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    } finally { live.mockRestore(); config.settlement.protocolFeeCollectionAddress = collection }
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const snap = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(snap).toMatchObject(opts.fee
      ? { feePolicyVersionId: policy!.id, snapshotFeeCollectionAddress: feeAddr, snapshotFeeCollectionWaivedPreFunding: false }
      : { feePolicyVersionId: null })
    if (opts.fee) fundingValue = 100_000 + FEE_SATS
    const { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY } = H.participantKeys() // one MULTISIG address per escrow (#621)
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`aux2-kind-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(opts.shared ? `${label}-shared` : `${label}-b`)
    const sellerAddr = H.testnetAddress(opts.shared ? `${label}-shared` : `${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    return { label, escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, buyerAddr, sellerAddr, feeAddr, buyerKey, sellerKey }
  }
  type F = Awaited<ReturnType<typeof fixture>> & { disputeId?: string }

  async function raise(f: F) { f.disputeId = (await getDisputeService().raiseDispute(f.tradeId, f.buyerId, `aux2 kind ${f.label}`)).id }

  /** The arbiter's real signed ruling, committed through the production Core commit (Outcome + RESOLVED dispute, one
   *  transaction), without the dispatch: the state a crash between commit and dispatch leaves (C4). */
  async function commitRuling(f: F, ruling: Ruling) {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId!, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: ruling, buyerBps: ruling === 'SPLIT' ? BUYER_BPS : null, issuedAt }
    const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, payload, signAuthorityDecision(payload, kp.secretKey), arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
  }

  /** The assigned arbiter's own route for `kind` (settlement.routes.ts initiate-release / -refund / -split). */
  const route = (f: F, kind: Kind, grant?: unknown) =>
    kind === 'release' ? escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID, grant)
    : kind === 'refund' ? escrowService.initiateRefund(f.escrowId, ARBITER_ID, undefined, grant)
    : escrowService.initiateSplit(f.escrowId, undefined, undefined, BUYER_BPS, ARBITER_ID, grant)

  async function validity(f: F, hex: string) {
    const tx = bitcoin.Transaction.fromHex(hex)
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })
    const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId: f.escrowId } })
    const input = tx.ins[0]; const w = input.witness; const script = w[w.length - 1]
    const signers = w.slice(1, -1).map((der) => {
      const { signature, hashType } = bitcoin.script.signature.decode(der)
      const digest = tx.hashForWitnessV0(0, script, BigInt(fundingValue), hashType)
      return keys.find((k: any) => ecc.verify(digest, Buffer.from(k.pubkey, 'hex'), signature))?.role ?? 'INVALID'
    })
    return {
      spendsEscrowFunding: Buffer.from(input.hash).reverse().toString('hex') === e.txLockId && input.index === e.txLockVout,
      scriptIsEscrowP2wsh: bitcoin.payments.p2wsh({ redeem: { output: script }, network: H.NETWORK }).address === e.multisigAddr,
      signers, outputs: tx.outs.map((o) => ({ address: bitcoin.address.fromOutputScript(o.script, H.NETWORK), sats: Number(o.value) })),
    }
  }

  async function snapshot(f: F) {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const t = await prisma.trade.findUniqueOrThrow({ where: { id: f.tradeId } })
    const [b, s] = await Promise.all([f.buyerId, f.sellerId].map((id) => prisma.user.findUniqueOrThrow({ where: { id } })))
    const obligation = await prisma.feeObligation.findUnique({ where: { escrowId: f.escrowId } })
    return {
      escrow: e.status, trade: t.status, dispute: d.status, ruling: d.ruling,
      outcomeRecord: !!(await loadDisputeRulingRecord(f.escrowId, 0)), pendingRounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }),
      r1Authorizations: await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrowId } }),
      settlementEvents: (await prisma.durableEventRecord.findMany({ where: { correlationId: f.tradeId, eventName: { in: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'] } } }))
        .map((r: any) => ({ eventName: r.eventName, disputeId: r.payload?.disputeId ?? null })),
      reputation: { buyer: b.reputationScore, seller: s.reputationScore },
      feeObligation: obligation ? { economicDetermination: obligation.economicDetermination, collectionStatus: obligation.collectionStatus } : null,
    }
  }

  /** One route call to the end: creation, a non-required party's signature (must be refused), every required
   *  signature, then what reached the explorer. */
  async function drive(f: F, kind: Kind) {
    const ev: Record<string, any> = { label: f.label, kind }
    let round: any = null
    try { round = await route(f, kind); ev.created = true } catch (e: any) { ev.created = false; ev.error = { name: e.constructor?.name, code: e.code, message: e.message } }
    if (round) {
      const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
      ev.round = { kind: row.kind, rulingOutcome: row.rulingOutcome, requiredSigners: (row.requiredSigners as string[]).map((s) => (s === f.buyerId ? 'buyer' : s === f.sellerId ? 'seller' : s)) }
      const other = row.requiredSigners.includes(f.buyerId) ? f.sellerId : f.buyerId
      try { await submitSig(f.escrowId, other, H.signRound(row.unsignedPsbtBase64, other === f.buyerId ? f.buyerKey : f.sellerKey)); ev.nonRequiredSigner = 'accepted' } catch (e: any) { ev.nonRequiredSigner = `refused: ${e.message}` }
      for (const signer of row.requiredSigners as string[]) {
        const r = await submitSig(f.escrowId, signer, H.signRound(row.unsignedPsbtBase64, signer === f.buyerId ? f.buyerKey : f.sellerKey)); ev.complete = r.complete
      }
    }
    ev.postAttempts = posts
    ev.broadcasts = await Promise.all(chain.broadcasts.map((txid) => validity(f, chain.hex.get(txid)!)))
    return ev
  }

  /** Durable projections run after the settlement returns: wait for the trade's projected status. */
  /** Waits for both projections (trade status, and BOTH parties' reputation: they are updated separately) or gives up
   *  after ~20 s and returns what is there, so the assertion that follows reports the real state. */
  async function settled(f: F, trade: string, reputation: { buyer: number; seller: number }) {
    for (let i = 0; i < 200; i++) {
      const s = await snapshot(f)
      if (s.trade === trade && s.reputation.buyer === reputation.buyer && s.reputation.seller === reputation.seller) return s
      await new Promise((r) => setTimeout(r, 100))
    }
    return snapshot(f)
  }

  function refusedWithNothingWritten(ev: any, s: any, ruling: Ruling) {
    expect(ev.created).toBe(false)
    expect(ev.error).toMatchObject({ name: 'TranslationGuardError', code: 'TRANSLATION_GUARD_MISMATCH' })
    expect(ev.error.message).toMatch(new RegExp(`Outcome ruling ${ruling} does not authorize a ${ev.kind} round`))
    expect(ev.postAttempts).toBe(0)
    expect(s).toMatchObject({
      escrow: 'DISPUTED', dispute: 'RESOLVED', ruling, outcomeRecord: true, pendingRounds: 0, r1Authorizations: 0,
      settlementEvents: [], reputation: { buyer: 0, seller: 0 },
    })
  }

  const RULINGS: Ruling[] = ['RELEASE', 'REFUND', 'SPLIT']
  const MISMATCHES = RULINGS.flatMap((ruling) => (['release', 'refund', 'split'] as Kind[]).filter((k) => k !== KIND[ruling]).map((kind) => [ruling, kind] as const))

  describe.each([['different addresses', false], ['same address', true]] as const)('%s', (_name, shared) => {
    it.each(MISMATCHES)('%s Outcome: the arbiter\'s %s route is refused before the round exists - 0 POST, nothing written', async (ruling, kind) => {
      pg.requirePostgres(`mismatch ${ruling}->${kind}`)
      const f: F = await fixture(`mm-${shared ? 'same' : 'diff'}-${ruling}-${kind}`, { shared }); await raise(f); await commitRuling(f, ruling)
      const ev = await drive(f, kind); const s = await snapshot(f)
      console.log(`[evidence] ${JSON.stringify({ ...ev, state: s })}`)
      refusedWithNothingWritten(ev, s, ruling)
    })

    it.each(RULINGS)('%s Outcome: the matching route builds the round, only the required signer completes it, one valid POST, final state and projections follow the ruling', async (ruling) => {
      pg.requirePostgres(`faithful ${ruling}`)
      const f: F = await fixture(`ok-${shared ? 'same' : 'diff'}-${ruling.toLowerCase()}-${ruling === 'SPLIT' ? 'split' : 'x'}`, { shared }); await raise(f); await commitRuling(f, ruling)
      const kind = KIND[ruling]
      const ev = await drive(f, kind)
      const expected = {
        RELEASE: { escrow: 'COMPLETED', trade: 'COMPLETED', event: 'settlement.escrow.released', signer: 'buyer', reputation: { buyer: 2, seller: -5 } },
        REFUND: { escrow: 'REFUNDED', trade: 'CANCELLED', event: 'settlement.escrow.refunded', signer: 'seller', reputation: { buyer: -5, seller: 2 } },
        SPLIT: { escrow: 'SPLIT', trade: 'COMPLETED', event: 'settlement.escrow.split', signer: 'buyer', reputation: { buyer: 0, seller: 0 } },
      }[ruling]
      const s = await settled(f, expected.trade, expected.reputation)
      console.log(`[evidence] ${JSON.stringify({ ...ev, state: s })}`)
      expect(ev.round).toEqual({ kind, rulingOutcome: ruling, requiredSigners: [expected.signer] })
      expect(ev.nonRequiredSigner).toMatch(/^refused: .*is not one of the required signers/)
      expect(ev.complete).toBe(true)
      expect(ev.postAttempts).toBe(1)
      expect(ev.broadcasts).toHaveLength(1)
      expect(ev.broadcasts[0]).toMatchObject({ spendsEscrowFunding: true, scriptIsEscrowP2wsh: true })
      expect(ev.broadcasts[0].signers).toEqual(expect.arrayContaining(['arbiter', expected.signer]))
      expect(ev.broadcasts[0].signers).toHaveLength(2)
      const paid = new Set(ev.broadcasts[0].outputs.map((o: any) => o.address))
      expect(paid).toEqual(new Set(ruling === 'RELEASE' ? [f.buyerAddr] : ruling === 'REFUND' ? [f.sellerAddr] : [f.buyerAddr, f.sellerAddr]))
      expect(s).toMatchObject({
        escrow: expected.escrow, trade: expected.trade, dispute: 'RESOLVED', ruling, outcomeRecord: true, r1Authorizations: 1,
        settlementEvents: [{ eventName: expected.event, disputeId: f.disputeId }], reputation: expected.reputation,
        feeObligation: null, // no fee policy on this escrow: no obligation, ever
      })
    })
  })

  describe('protocol fee > 0 (0.4%, pre-funded reserve of 400 sats), same address', () => {
    it.each([['RELEASE', 'refund'], ['REFUND', 'release']] as const)('%s Outcome: the arbiter\'s %s route is refused - 0 POST, nothing written, the reserve never moves', async (ruling, kind) => {
      pg.requirePostgres(`fee mismatch ${ruling}->${kind}`)
      const f: F = await fixture(`fee-mm-${ruling}-${kind}`, { shared: true, fee: true }); await raise(f); await commitRuling(f, ruling)
      const ev = await drive(f, kind); const s = await snapshot(f)
      console.log(`[evidence] ${JSON.stringify({ ...ev, state: s })}`)
      refusedWithNothingWritten(ev, s, ruling)
      expect(s.feeObligation).toBeNull()
    })

    it('REFUND Outcome: the refund round completes, REFUNDED, the whole funding (reserve included) returns to the seller, no fee owed', async () => {
      pg.requirePostgres('fee faithful REFUND')
      const f: F = await fixture('fee-ok-refund', { shared: true, fee: true }); await raise(f); await commitRuling(f, 'REFUND')
      const ev = await drive(f, 'refund'); const s = await settled(f, 'CANCELLED', { buyer: -5, seller: 2 })
      console.log(`[evidence] ${JSON.stringify({ ...ev, state: s })}`)
      expect(ev.postAttempts).toBe(1)
      expect(ev.broadcasts[0].outputs.map((o: any) => o.address)).toEqual([f.sellerAddr])
      expect(s).toMatchObject({ escrow: 'REFUNDED', trade: 'CANCELLED', settlementEvents: [{ eventName: 'settlement.escrow.refunded', disputeId: f.disputeId }], reputation: { buyer: -5, seller: 2 } })
      expect(s.feeObligation).toMatchObject({ economicDetermination: 'NOT_APPLICABLE' })
    })

    it('characterization (pre-existing, unchanged): RELEASE Outcome with a collectible fee - the translation guard\'s protocol-fee-inactive scope refuses the fee output, 0 POST', async () => {
      pg.requirePostgres('fee RELEASE characterization')
      const f: F = await fixture('fee-char-release', { shared: true, fee: true }); await raise(f); await commitRuling(f, 'RELEASE')
      const ev = await drive(f, 'release'); const s = await snapshot(f)
      console.log(`[evidence] ${JSON.stringify({ ...ev, state: s })}`)
      expect(ev.created).toBe(false)
      expect(ev.error.message).toMatch(/translated PSBT has 2 output\(s\), expected exactly 1/)
      expect(ev.postAttempts).toBe(0)
      expect(s).toMatchObject({ escrow: 'DISPUTED', pendingRounds: 0, settlementEvents: [] })
    })
  })

  it('a cooperative round survives a ruling grant offered for the wrong kind: refused, the round and its signature intact, 0 POST', async () => {
    pg.requirePostgres('cooperative preserved')
    const f: F = await fixture('coop', { shared: true })
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    const coop = await escrowService.initiateRelease(f.escrowId, undefined, f.sellerId)
    await submitSig(f.escrowId, f.sellerId, H.signRound(coop.unsignedPsbtBase64, f.sellerKey))
    const before = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId }, include: { signatures: true } })
    await raise(f); await commitRuling(f, 'RELEASE')
    const grant = issueGrant(await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } }))
    let error = ''
    try { await route(f, 'refund', grant) } catch (e: any) { error = e.message }
    const after = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId }, include: { signatures: true } })
    console.log(`[evidence] ${JSON.stringify({ label: 'coop', error, before: before.id, after: after.id, signatures: after.signatures.length })}`)
    expect(error).toMatch(/Ruling RELEASE does not authorize a refund round/)
    expect(after).toMatchObject({ id: before.id, kind: 'release', disputeId: null, unsignedPsbtBase64: before.unsignedPsbtBase64 })
    expect(after.signatures.map((s: any) => s.signedPsbtBase64)).toEqual(before.signatures.map((s: any) => s.signedPsbtBase64))
    expect(posts).toBe(0)
  })
})
