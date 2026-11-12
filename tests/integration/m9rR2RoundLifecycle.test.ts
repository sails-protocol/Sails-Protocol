// tests/integration/m9rR2RoundLifecycle.test.ts
//
// GK-M9R-D R2 (#343) - a disputed MULTISIG round is checked against its durable authoritative Outcome inside the escrow
// lock, before it exists (escrow-pending-tx.ts assertDisputedRoundMatchesOutcome). Real PostgreSQL, real 2-of-3 P2WSH
// PSBTs, real services; only the explorer is simulated. The defective translator is injected the way the GK-M9R-D PoC
// did it: MultisigProvider.buildUnsignedSpend shifts 15% of a SPLIT from the seller to the buyer before the provider adds
// the arbiter's signature, so the PSBT is valid and arbiter-signed but does not correspond to the Outcome.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

describe('GK-M9R-D R2 - a disputed MULTISIG round never exists before its translation matches the Outcome (real PostgreSQL)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, MultisigProvider: any, guard: any
  let reconcileMissingDispatch: any, submitSig: any, loadDisputeRulingRecord: any
  const ARBITER_ID = 'aux2-r2-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch
  let defect = false; const mine: string[] = []
  const SHIFT = 0.15

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aux2-r2-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
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
    ;({ MultisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'aux2 r2 arbiter' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch; defect = false
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
    const orig = MultisigProvider.prototype.buildUnsignedSpend
    jest.spyOn(MultisigProvider.prototype, 'buildUnsignedSpend').mockImplementation(function (this: any, escrow: any, parties: any, n: number, fn: (v: bigint) => Array<{ address: string; value: bigint }>) {
      const wrapped = (v: bigint) => { const outs = fn(v); if (!defect || outs.length !== 2) return outs; const shift = BigInt(Math.floor(Number(v) * SHIFT)); return [{ ...outs[0], value: outs[0].value + shift }, { ...outs[1], value: outs[1].value - shift }] }
      return orig.call(this, escrow, parties, n, wrapped)
    } as never)
  })
  afterEach(() => { jest.restoreAllMocks(); if (realFetch) global.fetch = realFetch })

  async function fixture(label: string, dispute = true) {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, H.BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, H.SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`aux2-r2-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(`${label}-b`), sellerAddr = H.testnetAddress(`${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    const d = dispute ? await getDisputeService().raiseDispute(trade.id, buyer.id, `aux2 r2 ${label}`) : null
    mine.push(escrow.id)
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d?.id as string, buyerAddr, sellerAddr }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const ruling = (f: F, buyerBps = 7000) => { const issuedAt = new Date().toISOString(); const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'SPLIT' as const, buyerBps, issuedAt }; return { payload, signature: signAuthorityDecision(payload, kp.secretKey), issuedAt } }
  const resolveLive = (f: F, r: ReturnType<typeof ruling>) => getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, 'SPLIT', undefined, undefined, 7000, r.signature, r.issuedAt)
  /** Commits the Outcome only - what a crash between the commit and the dispatch leaves (C4 recovery's input). */
  async function commitOnly(f: F, r: ReturnType<typeof ruling>) {
    const d = await prisma.dispute.findUnique({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, r.payload, r.signature, arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
    return { bd: c.destinations.find((x: any) => x.beneficiary === f.buyerId)?.destination, sd: c.destinations.find((x: any) => x.beneficiary === f.sellerId)?.destination }
  }
  const shares = (f: F, hex: string) => bitcoin.Transaction.fromHex(hex).outs.map((o) => {
    const addr = bitcoin.address.fromOutputScript(o.script, H.NETWORK)
    return { who: addr === f.buyerAddr ? 'buyer' : addr === f.sellerAddr ? 'seller' : 'other', sats: Number(o.value) }
  })
  const state = async (f: F) => {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    return {
      escrow: e.status, txRelease: !!e.txReleaseId, dispute: d.status, ruling: d.ruling,
      outcome: !!(await loadDisputeRulingRecord(f.escrowId, 0)), pending: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }),
    }
  }
  const forResume = (rep: any, f: F) => ({
    resumed: rep.resumed.some((x: any) => x.escrowId === f.escrowId), guardFailed: rep.guardFailed.find((x: any) => x.escrowId === f.escrowId),
    failed: rep.failed.find((x: any) => x.escrowId === f.escrowId), concurrent: rep.alreadyResumedConcurrently.includes(f.escrowId),
  })

  it('R2-1 control: a faithful translation dispatches; one signature broadcasts exactly the 70/30 the Outcome authorized', async () => {
    pg.requirePostgres('R2-1')
    const f = await fixture('r2-1')
    await resolveLive(f, ruling(f))
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(row.disputeId).toBe(f.disputeId)
    expect((await submitSig(f.escrowId, f.buyerId, H.signRound(row.unsignedPsbtBase64, H.buyerKey))).complete).toBe(true)
    expect(chain.broadcasts).toHaveLength(1)
    const outs = shares(f, chain.hex.get(chain.broadcasts[0])!)
    const buyer = outs.find((o) => o.who === 'buyer')!.sats, seller = outs.find((o) => o.who === 'seller')!.sats
    expect(Math.round((buyer / (buyer + seller)) * 100)).toBe(70)
  })

  it('R2-2 live ruling, defective translation: refused before the round exists; the ruling and its Outcome are reverted; nothing to sign, 0 broadcasts', async () => {
    pg.requirePostgres('R2-2')
    const f = await fixture('r2-2'); defect = true
    // Watch the moment the dispatch returns: under the M9-R window the round was already collectable here (GK-M9R-D T5).
    const realInit = escrowService.initiateSplit.bind(escrowService)
    let atReturn: { pending: number } | Error | null = null
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...a: any[]) => {
      try { const out = await realInit(...a); atReturn = { pending: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }) }; return out } catch (e) { atReturn = e as Error; throw e }
    }) as never)
    await expect(resolveLive(f, ruling(f))).rejects.toBeInstanceOf(guard.TranslationGuardError)
    expect(atReturn).toBeInstanceOf(guard.TranslationGuardError) // the dispatch itself refused; it never returned a round
    expect(await state(f)).toMatchObject({ escrow: 'DISPUTED', txRelease: false, dispute: 'OPENED', ruling: null, outcome: false, pending: 0 })
    expect(chain.broadcasts).toEqual([])
    // The arbiter can rule again; with a faithful translator it dispatches normally.
    defect = false
    await resolveLive(f, ruling(f))
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', ruling: 'SPLIT', outcome: true, pending: 1 })
  })

  it('R2-3 crash after the commit, before the dispatch; restart with the same defect: C4 reports guardFailed, writes nothing, keeps the Outcome; a fixed translator resumes it', async () => {
    pg.requirePostgres('R2-3')
    const f = await fixture('r2-3'); defect = true
    const { bd, sd } = await commitOnly(f, ruling(f))
    // The dispatch that the crashed process would have run, now refused under the lock (GK-M9R-D T3 left a collectable round here).
    await expect(escrowService.initiateSplit(f.escrowId, bd, sd, 7000, ARBITER_ID)).rejects.toBeInstanceOf(guard.TranslationGuardError)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 0 })
    const first = forResume(await reconcileMissingDispatch(), f)
    expect(first).toMatchObject({ resumed: false, failed: undefined, guardFailed: { escrowId: f.escrowId, mismatches: expect.any(Array) } })
    expect(first.guardFailed.mismatches.length).toBeGreaterThan(0)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', ruling: 'SPLIT', outcome: true, pending: 0 }) // provenance intact
    expect(chain.broadcasts).toEqual([])
    defect = false
    expect(forResume(await reconcileMissingDispatch(), f)).toMatchObject({ resumed: true })
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(row).toMatchObject({ disputeId: f.disputeId, rulingOutcome: 'SPLIT' })
  })

  it('R2-4 the assigned arbiter\'s own initiate-release/refund (settlement.routes.ts) cannot create a disputed round that differs from the committed Outcome, nor one before any Outcome', async () => {
    pg.requirePostgres('R2-4')
    const f = await fixture('r2-4')
    // Before a ruling: no durable Outcome to check against - refused (before R2 this created a disputed round with ruling provenance).
    await expect(escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID)).rejects.toThrow(/no durable authoritative Outcome .*GK-M9R-D R2/)
    expect(await state(f)).toMatchObject({ pending: 0 })
    // After a committed SPLIT whose dispatch never persisted: a RELEASE/REFUND translation does not match it.
    await commitOnly(f, ruling(f))
    await expect(escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID)).rejects.toBeInstanceOf(guard.TranslationGuardError)
    await expect(escrowService.initiateRefund(f.escrowId, ARBITER_ID)).rejects.toBeInstanceOf(guard.TranslationGuardError)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 0 })
    expect(chain.broadcasts).toEqual([])
  })

  it('R2-5 concurrency: two C4 passes against the same defective translation write nothing and keep the Outcome; two passes after the fix create exactly one round', async () => {
    pg.requirePostgres('R2-5')
    const f = await fixture('r2-5'); defect = true
    await commitOnly(f, ruling(f))
    const [a, b] = (await Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()])).map((rep) => forResume(rep, f))
    expect([a, b].every((x) => x.guardFailed && !x.resumed && !x.failed)).toBe(true)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 0 })
    defect = false
    const [c, d] = (await Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()])).map((rep) => forResume(rep, f))
    expect([c, d].filter((x) => x.resumed)).toHaveLength(1)
    expect([c, d].every((x) => x.resumed || x.concurrent || (!x.guardFailed && !x.failed))).toBe(true)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 1 })
  })

  it('R2-6 cooperative rounds are untouched: no dispute, no Outcome lookup, no translation guard', async () => {
    pg.requirePostgres('R2-6')
    const f = await fixture('r2-6', false)
    const spy = jest.spyOn(guard, 'assertTranslationMatchesOutcome')
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    const p = await escrowService.initiateRelease(f.escrowId, undefined, f.sellerId)
    expect(spy).not.toHaveBeenCalled()
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(row).toMatchObject({ id: p.id, disputeId: null, kind: 'release' })
  })

  it('R2-8 the assigned arbiter\'s route keeps working when its translation matches the committed Outcome: a RELEASE ruling, then initiate-release, one beneficiary signature broadcasts to the buyer (CTO 25 item 3)', async () => {
    pg.requirePostgres('R2-8')
    const f = await fixture('r2-8')
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    await commitOnly(f, { payload, signature: signAuthorityDecision(payload, kp.secretKey), issuedAt } as never)
    // Same call settlement.routes.ts makes: no caller destination, the arbiter as participant.
    await escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID)
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(row).toMatchObject({ disputeId: f.disputeId, rulingOutcome: 'RELEASE', rulingAppealRound: 0, kind: 'release' })
    expect((await submitSig(f.escrowId, f.buyerId, H.signRound(row.unsignedPsbtBase64, H.buyerKey))).complete).toBe(true)
    expect(chain.broadcasts).toHaveLength(1)
    expect(shares(f, chain.hex.get(chain.broadcasts[0])!).map((o) => o.who)).toEqual(['buyer'])
  })

  it('R2-9 generation binding: an appeal that holds the dispute row while a round is being built makes the build wait, then refuse; an unrelated write to the row lets it proceed (CTO 25 item 2)', async () => {
    pg.requirePostgres('R2-9')
    const until = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 400; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)) }
      throw new Error('R2-9: condition not reached')
    }
    const waitingOnRowLock = async () => (await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`)[0].n > 0
    /** Holds an UPDATE of the dispute row open (appeal()'s own claim is an UPDATE of this row), dispatches, then commits. */
    async function raceDispatch(f: F, setSql: string) {
      const { bd, sd } = await commitOnly(f, ruling(f))
      let commitNow!: () => void; const gate = new Promise<void>((r) => { commitNow = r })
      let held = false
      const writer = prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`UPDATE "disputes" SET ${setSql} WHERE "id" = $1`, f.disputeId)
        held = true
        await gate
      }, { timeout: 60_000 })
      await until(async () => held)
      const dispatch = escrowService.initiateSplit(f.escrowId, bd, sd, 7000, ARBITER_ID).then(() => null, (e: Error) => e)
      await until(waitingOnRowLock) // the build is parked on the dispute row, inside the escrow lock, before any round exists
      expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(0)
      commitNow(); await writer
      return dispatch
    }
    const appealed = await fixture('r2-9a')
    const refused = await raceDispatch(appealed, `"status" = 'APPEALED', "appealRound" = 1, "ruling" = NULL`)
    expect(refused).toBeInstanceOf(Error)
    expect(refused!.message).toMatch(/no longer the RESOLVED generation 0 .*GK-M9R-D R2/)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: appealed.escrowId } })).toBe(0)
    expect(await loadDisputeRulingRecord(appealed.escrowId, 0)).not.toBeNull() // the round-0 Outcome is kept as provenance

    const untouched = await fixture('r2-9b')
    expect(await raceDispatch(untouched, `"updatedAt" = now()`)).toBeNull()
    expect(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: untouched.escrowId } })).toMatchObject({ disputeId: untouched.disputeId, rulingAppealRound: 0 })
  })

  it('R2-7 no unconditional pending-round delete is left on the dispute dispatch paths', () => {
    const fs = require('fs'), path = require('path')
    for (const file of ['dispute.service.ts', 'dispute-dispatch-recovery.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../src/modules/open-settlement', file), 'utf8')
      expect(src).not.toMatch(/escrowPendingTransaction\.deleteMany\(\{\s*where:\s*\{\s*escrowId[^}]*\}\s*\}\)/)
    }
  })
})
