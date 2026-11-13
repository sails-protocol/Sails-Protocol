// tests/integration/m9rFundingInteraction.test.ts
//
// CTO 25 composition #620 + #621: the M9-R guards (R2 kind/Outcome binding at creation, R-4 at execution, R-1/G2 live
// revert, C4 dispatch recovery) interacting with the funding binding P2 (round input = the escrow's recorded funding)
// on DISPUTED rounds. #621's own suite covers P2 alone on cooperative rounds; #620's suites cover R2/R-4 alone. Only
// the interactions are tested here. Real PostgreSQL, real 2-of-3 P2WSH PSBTs and signatures; the explorer is SIMULATED.
// "SIMULATION" marks a persisted row rewritten to stand for a round built before a guard existed.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

bitcoin.initEccLib(ecc)
const evidence = (label: string, data: unknown) => process.stdout.write(`[evidence] ${JSON.stringify({ label, ...(data as object) })}\n`)

describe('M9-R x funding binding interaction (real PostgreSQL, simulated explorer)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, loadDisputeRulingRecord: any
  let reconcileMissingDispatch: any, submitSig: any, MultisigProvider: any, reconcile: any
  const ARBITER_ID = 'm9r-fund-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-fund-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
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
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ MultisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ;({ reconcilePendingSettlements: reconcile } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'm9r funding arbiter' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch
    const base = H.explorer(chain)
    global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && String(input).endsWith('/tx')) {
        const hex = init.body as string; const tx = bitcoin.Transaction.fromHex(hex); const txid = tx.getId()
        chain.mempool.add(txid); chain.hex.set(txid, hex); chain.broadcasts.push(txid)
        chain.spentBy.set(`${Buffer.from(tx.ins[0].hash).reverse().toString('hex')}:${tx.ins[0].index}`, txid)
        return { ok: true, status: 200, text: async () => txid, json: async () => ({}) } as unknown as Response
      }
      return base(input as string, init as RequestInit)
    }) as typeof fetch
  })
  afterEach(() => { jest.restoreAllMocks(); if (realFetch) global.fetch = realFetch })

  type F = { escrowId: string; tradeId: string; buyerId: string; sellerId: string; disputeId: string; buyerKey: H.Key; sellerKey: H.Key }
  /** A funded MULTISIG escrow with an OPENED dispute. `sameAddress`: buyer and seller share one payout address (R-4). */
  async function fixture(label: string, opts: { sameAddress?: boolean } = {}): Promise<F> {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY } = H.participantKeys()
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`m9r-fund-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(`${label}-b`), sellerAddr = opts.sameAddress ? buyerAddr : H.testnetAddress(`${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    const d = await getDisputeService().raiseDispute(trade.id, buyer.id, `m9r fund ${label}`)
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d.id, buyerKey, sellerKey }
  }
  type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'
  const ruling = (f: F, outcome: Ruling = 'SPLIT') => {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps: outcome === 'SPLIT' ? 7000 : null, issuedAt }
    return { payload, signature: signAuthorityDecision(payload, kp.secretKey), issuedAt }
  }
  const resolveLive = (f: F, r: ReturnType<typeof ruling>) =>
    getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, r.payload.outcome, undefined, undefined, r.payload.buyerBps ?? undefined, r.signature, r.issuedAt)
  /** Commits the Core ruling and stops: crash window C4 (Outcome durable, dispatch never persisted). */
  async function commitOnly(f: F, r: ReturnType<typeof ruling>) {
    const d = await prisma.dispute.findUnique({ where: { id: f.disputeId } })
    expect((await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, r.payload, r.signature, arbPub, '100000', 'BTC', f.buyerId, f.sellerId)).committed).toBe(true)
  }
  const initiate = (f: F, kind: 'release' | 'refund') =>
    (kind === 'release' ? escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID) : escrowService.initiateRefund(f.escrowId, ARBITER_ID))
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (err: any) => ({ name: err.constructor?.name, code: err.code, statusCode: err.statusCode, message: String(err.message).slice(0, 160) }))
  const keyFor = (f: F, id: string) => (id === f.buyerId ? f.buyerKey : id === f.sellerId ? f.sellerKey : null)
  /** Signs the persisted round with every required participant key; returns the last refusal, if any. */
  async function signAll(f: F) {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    let last: unknown = 'ok'
    for (const id of row.requiredSigners) {
      const key = keyFor(f, id); if (!key) continue
      last = await outcome(submitSig(f.escrowId, id, H.signRound(row.unsignedPsbtBase64, key)))
    }
    return last
  }
  /** The provider's own PSBT with the input moved to another vout of the same funding txid: outputs, value, script unchanged. */
  function tamper(psbtBase64: string) {
    const src = bitcoin.Psbt.fromBase64(psbtBase64, { network: H.NETWORK })
    const inp = src.txInputs[0]; const data = src.data.inputs[0]
    const p = new bitcoin.Psbt({ network: H.NETWORK })
    p.addInput({ hash: inp.hash, index: inp.index + 1, witnessUtxo: data.witnessUtxo!, witnessScript: data.witnessScript! })
    for (const o of src.txOutputs) p.addOutput({ script: o.script, value: o.value })
    return p.toBase64()
  }
  /** Every provider builder returns the tampered input (a translation that does not spend the recorded funding). */
  function tamperBuilders() {
    for (const name of ['buildUnsignedRelease', 'buildUnsignedRefund', 'buildUnsignedSplit'] as const) {
      const real = MultisigProvider.prototype[name]
      jest.spyOn(MultisigProvider.prototype, name).mockImplementation(async function (this: any, ...args: any[]) {
        const r = await real.apply(this, args); return { ...r, psbtBase64: tamper(r.psbtBase64) }
      } as never)
    }
  }
  const state = async (f: F) => {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    return {
      escrow: e.status, txRelease: e.txReleaseId, dispute: d.status, outcome: !!(await loadDisputeRulingRecord(f.escrowId, 0)),
      rounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }),
      authorizations: await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrowId } }),
    }
  }

  it('I1 creation, R2 and P2 violated together (kind is not the Outcome ruling AND the input is not the recorded funding): the R2 refusal wins, nothing is written, 0 POST', async () => {
    pg.requirePostgres('I1')
    const f = await fixture('i1', { sameAddress: true })
    await commitOnly(f, ruling(f, 'RELEASE'))
    tamperBuilders()
    const result = await outcome(initiate(f, 'refund'))
    jest.restoreAllMocks()
    const s = await state(f)
    evidence('I1', { result, state: s, posts: chain.broadcasts.length })
    expect(result).toMatchObject({ name: 'TranslationGuardError', code: 'TRANSLATION_GUARD_MISMATCH', statusCode: 409 }) // R2 runs first
    expect(s).toMatchObject({ escrow: 'DISPUTED', txRelease: null, dispute: 'RESOLVED', outcome: true, rounds: 0, authorizations: 0 })
    expect(chain.broadcasts).toEqual([])
    // Control: each guard alone still refuses with its own code.
    tamperBuilders()
    expect(await outcome(initiate(f, 'release'))).toMatchObject({ name: 'RoundInputMismatch', code: 'ROUND_INPUT_MISMATCH', statusCode: 409 })
    jest.restoreAllMocks()
    expect(await outcome(initiate(f, 'refund'))).toMatchObject({ code: 'TRANSLATION_GUARD_MISMATCH' })
    expect((await state(f)).rounds).toBe(0)
  })

  it('I2 live ruling whose dispatch P2 refuses: R-1/G2 revert the generation atomically (OPENED, no Outcome, no round, 0 POST); a later honest ruling dispatches', async () => {
    pg.requirePostgres('I2')
    const f = await fixture('i2')
    tamperBuilders()
    const liveErr = await outcome(resolveLive(f, ruling(f)))
    jest.restoreAllMocks()
    const reverted = await state(f)
    evidence('I2', { liveErr, reverted, posts: chain.broadcasts.length })
    expect(liveErr).toMatchObject({ code: 'ROUND_INPUT_MISMATCH' })
    expect(reverted).toMatchObject({ dispute: 'OPENED', outcome: false, rounds: 0, authorizations: 0, escrow: 'DISPUTED' })
    expect(chain.broadcasts).toEqual([])
    expect(await outcome(resolveLive(f, ruling(f)))).toBe('ok')
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true, rounds: 1 })
  })

  it('I3 C4 recovery refused by P2 while the live ruling is dispatching: no orphan round, the revert sees nothing dispatched and reverts, 0 POST', async () => {
    pg.requirePostgres('I3')
    const f = await fixture('i3')
    tamperBuilders()
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true; let c4: any = null
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (!first) return (realSplit as any)(...args)
      first = false
      c4 = await reconcileMissingDispatch() // C4 builds this same generation first; P2 refuses it
      return (realSplit as any)(...args)
    }) as never)
    const liveErr = await outcome(resolveLive(f, ruling(f)))
    jest.restoreAllMocks()
    const s = await state(f)
    const mine = (xs: any[]) => xs.filter((x) => x.escrowId === f.escrowId)
    evidence('I3', { liveErr, c4: { resumed: mine(c4.resumed), guardFailed: mine(c4.guardFailed), failed: mine(c4.failed) }, state: s })
    expect(mine(c4.resumed)).toEqual([])
    expect(mine(c4.guardFailed).length + mine(c4.failed).length).toBeGreaterThan(0)
    expect(liveErr).toMatchObject({ code: 'ROUND_INPUT_MISMATCH' })
    expect(s).toMatchObject({ dispute: 'OPENED', outcome: false, rounds: 0, authorizations: 0 })
    expect(chain.broadcasts).toEqual([])
  })

  it('I4 execution, R-4 and P2 violated together (SIMULATION: a round persisted before both guards, kind rewritten and input moved): P2 refuses first - no ADR-005 authorization, no claim, 0 POST, signatures kept', async () => {
    pg.requirePostgres('I4')
    const f = await fixture('i4', { sameAddress: true })
    await commitOnly(f, ruling(f, 'RELEASE'))
    await initiate(f, 'release')
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    await prisma.escrowPendingTransaction.update({ where: { id: row.id }, data: { kind: 'refund', unsignedPsbtBase64: tamper(row.unsignedPsbtBase64) } })
    const result = await signAll(f)
    const s = await state(f)
    const signatures = await prisma.escrowTransactionSignature.count({ where: { pendingTxId: row.id } })
    evidence('I4', { result, state: s, signatures, posts: chain.broadcasts.length })
    expect(result).toMatchObject({ code: 'ROUND_INPUT_MISMATCH' }) // not KIND_MISMATCH: P2 runs before the ADR-005 gate
    expect(s).toMatchObject({ escrow: 'DISPUTED', txRelease: null, rounds: 1, authorizations: 0 })
    expect(signatures).toBe(row.requiredSigners.length) // every signature submitted is kept (persisted before the refusal)
    expect(chain.broadcasts).toEqual([])
  })

  it('I5 execution, only P2 violated on a disputed round of the right kind: refused before the ADR-005 gate writes an authorization, 0 POST; the untampered control settles once', async () => {
    pg.requirePostgres('I5')
    const f = await fixture('i5')
    await commitOnly(f, ruling(f, 'RELEASE'))
    await initiate(f, 'release')
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    await prisma.escrowPendingTransaction.update({ where: { id: row.id }, data: { unsignedPsbtBase64: tamper(row.unsignedPsbtBase64) } }) // SIMULATION
    const result = await signAll(f)
    const s = await state(f)
    evidence('I5', { result, state: s, posts: chain.broadcasts.length })
    expect(result).toMatchObject({ code: 'ROUND_INPUT_MISMATCH' })
    expect(s).toMatchObject({ escrow: 'DISPUTED', txRelease: null, rounds: 1, authorizations: 0 })
    expect(chain.broadcasts).toEqual([])
    // Control on a fresh escrow: the same disputed flow, untampered, authorizes once and broadcasts once.
    const g = await fixture('i5-ok')
    await commitOnly(g, ruling(g, 'RELEASE'))
    await initiate(g, 'release')
    expect(await signAll(g)).toBe('ok')
    expect(chain.broadcasts).toHaveLength(1)
    expect(await state(g)).toMatchObject({ authorizations: 1, txRelease: chain.broadcasts[0] }) // settled once; the round row is consumed
  })

  it('I6 reconciliation PASS 0 and PASS 1 on a disputed, fully signed round that does not bind: never broadcast, no ADR-005 authorization, no claim, manual review', async () => {
    pg.requirePostgres('I6')
    const f = await fixture('i6')
    await commitOnly(f, ruling(f, 'RELEASE'))
    await initiate(f, 'release')
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    const altered = tamper(row.unsignedPsbtBase64)
    await prisma.escrowPendingTransaction.update({ where: { id: row.id }, data: { unsignedPsbtBase64: altered } }) // SIMULATION
    // Crash window C8: both signatures persisted, execution never ran.
    for (const id of row.requiredSigners) {
      const key = keyFor(f, id); if (!key) continue
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: row.id, participantId: id, signedPsbtBase64: H.signRound(altered, key) } })
    }
    const pass0 = await reconcile()
    const afterPass0 = await state(f)
    await prisma.escrow.update({ where: { id: f.escrowId }, data: { status: 'COMPLETED' } }) // PASS 1: the claim landed, the result did not
    const pass1 = await reconcile()
    const afterPass1 = await state(f)
    const review = (r: any) => r.requiresManualReview.filter((x: any) => x.escrowId === f.escrowId)
    evidence('I6', { pass0: review(pass0), pass1: review(pass1), afterPass0, afterPass1, posts: chain.broadcasts.length })
    expect(review(pass0)).toContainEqual({ escrowId: f.escrowId, reason: expect.stringMatching(/ROUND_INPUT_MISMATCH/) })
    expect(afterPass0).toMatchObject({ escrow: 'DISPUTED', txRelease: null, authorizations: 0 })
    expect(review(pass1)).toContainEqual({ escrowId: f.escrowId, reason: expect.stringMatching(/ROUND_INPUT_MISMATCH/) })
    expect(afterPass1).toMatchObject({ escrow: 'COMPLETED', txRelease: null, authorizations: 0 })
    expect(chain.broadcasts).toEqual([])
  })
})
