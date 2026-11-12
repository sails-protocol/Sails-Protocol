// tests/integration/m9rRemediation.test.ts
//
// PE-M9R remediation of the #618 composition findings (CTO 25): R-1 (live ruling x C4 recovery), G2 (non-atomic
// dispute revert + Outcome delete) and R-4 on the execution side (round kind vs Outcome ruling, same payout address).
// Real PostgreSQL, real 2-of-3 P2WSH PSBTs and signatures; the explorer is SIMULATED (pendingRoundLifecycleHarness).
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

describe('PE-M9R remediation - R-1, G2, R-4 execution (real PostgreSQL, simulated explorer)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, loadDisputeRulingRecord: any, outcomeModule: any
  let reconcileMissingDispatch: any, submitSig: any
  const ARBITER_ID = 'm9r-rem-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-rem-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
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
    outcomeModule = require('../../src/modules/open-settlement/dispute-outcome')
    ;({ commitAuthoritativeDisputeRuling: commit, loadDisputeRulingRecord } = outcomeModule)
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'm9r remediation arbiter' } })
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

  type F = { escrowId: string; tradeId: string; buyerId: string; sellerId: string; disputeId: string; buyerAddr: string; sellerAddr: string }
  async function fixture(label: string, opts: { sameAddress?: boolean } = {}): Promise<F> {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, H.BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, H.SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`m9r-rem-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(`${label}-b`), sellerAddr = opts.sameAddress ? buyerAddr : H.testnetAddress(`${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    const d = await getDisputeService().raiseDispute(trade.id, buyer.id, `m9r rem ${label}`)
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d.id, buyerAddr, sellerAddr }
  }
  type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'
  const ruling = (f: F, outcome: Ruling = 'SPLIT') => {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps: outcome === 'SPLIT' ? 7000 : null, issuedAt }
    return { payload, signature: signAuthorityDecision(payload, kp.secretKey), issuedAt }
  }
  const resolveLive = (f: F, r: ReturnType<typeof ruling>) =>
    getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, r.payload.outcome, undefined, undefined, r.payload.buyerBps ?? undefined, r.signature, r.issuedAt)
  async function commitOnly(f: F, r: ReturnType<typeof ruling>) {
    const d = await prisma.dispute.findUnique({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, r.payload, r.signature, arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
  }
  const state = async (f: F) => {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const round = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: f.escrowId } })
    return { escrow: e.status, txRelease: !!e.txReleaseId, dispute: d.status, outcome: !!(await loadDisputeRulingRecord(f.escrowId, 0)), round }
  }
  const keyFor = (f: F, id: string) => (id === f.buyerId ? H.buyerKey : id === f.sellerId ? H.sellerKey : null)
  async function signAll(f: F): Promise<Error | null> {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    let last: Error | null = null
    for (const id of row.requiredSigners) {
      const key = keyFor(f, id); if (!key) continue
      try { await submitSig(f.escrowId, id, H.signRound(row.unsignedPsbtBase64, key)); last = null } catch (e) { last = e as Error }
    }
    return last
  }
  /** The live dispatch fails once, with C4 recovery dispatching the same generation first (`c4First`) or not at all. */
  function failLiveDispatchOnce(c4First: boolean) {
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (!first) return (realSplit as any)(...args)
      first = false
      if (c4First) { await reconcileMissingDispatch(); return (realSplit as any)(...args) } // fails: the round already exists
      throw new Error('m9r-rem injected live dispatch failure (provider unavailable)')
    }) as never)
  }

  it('R-1 live ruling racing C4 recovery: the generation C4 dispatched is never reverted - the ruling stands, the call succeeds, the round settles once', async () => {
    pg.requirePostgres('R-1')
    const f = await fixture('r1')
    failLiveDispatchOnce(true)
    const r = ruling(f)
    let returned: any = null
    const liveErr = await resolveLive(f, r).then((d: any) => { returned = d; return null }, (e: Error) => e)
    jest.restoreAllMocks()
    const after = await state(f)
    evidence('R-1', { liveError: liveErr?.message ?? null, dispute: after.dispute, outcome: after.outcome, roundGeneration: after.round?.rulingAppealRound })
    expect(liveErr).toBeNull()
    expect(returned).toMatchObject({ id: f.disputeId, status: 'RESOLVED', ruling: 'SPLIT', authoritySignature: r.signature })
    expect(after).toMatchObject({ dispute: 'RESOLVED', outcome: true, txRelease: false })
    expect(after.round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0, kind: 'split', rulingAuthoritySignature: r.signature })
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
    expect(chain.broadcasts).toEqual([])
    // Progress: the round is signable and settles exactly once.
    expect(await signAll(f)).toBeNull()
    expect(chain.broadcasts).toHaveLength(1)
    expect((await state(f)).txRelease).toBe(true)
  })

  it('G2 crash INSIDE the revert transaction (Outcome delete fails after the dispute update): both roll back, and C4 recovery dispatches the ruling', async () => {
    pg.requirePostgres('G2 before commit')
    const f = await fixture('g2a')
    failLiveDispatchOnce(false)
    jest.spyOn(outcomeModule, 'revertDisputeRulingRecord').mockRejectedValueOnce(new Error('m9r-rem SIMULATED crash before the revert commits'))
    const liveErr = await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    jest.restoreAllMocks()
    const crashed = await state(f)
    expect(liveErr?.message).toMatch(/SIMULATED crash/)
    expect(crashed).toMatchObject({ dispute: 'RESOLVED', outcome: true, round: null }) // never OPENED with a stale Outcome
    const rep = await reconcileMissingDispatch()
    expect(rep.resumed.map((x: any) => x.escrowId)).toContain(f.escrowId)
    expect((await state(f)).round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
    evidence('G2 before commit', { crashed: { dispute: crashed.dispute, outcome: crashed.outcome }, recovered: true })
  })

  it('G2 revert committed: the dispute is OPENED with no Outcome, and a new ruling is accepted and dispatched', async () => {
    pg.requirePostgres('G2 after commit')
    const f = await fixture('g2b')
    failLiveDispatchOnce(false)
    const liveErr = await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    expect(liveErr?.message).toMatch(/injected live dispatch failure/)
    expect(await state(f)).toMatchObject({ dispute: 'OPENED', outcome: false, round: null })
    await resolveLive(f, ruling(f))
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true })
    expect((await state(f)).round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
  })

  it('G2 a newer generation won before the revert: the Outcome is left untouched (delete only when this exact generation was reverted)', async () => {
    pg.requirePostgres('G2 identity')
    const f = await fixture('g2c')
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (!first) return (realSplit as any)(...args)
      first = false
      // SIMULATION: another authority signature took over this generation's row before the revert ran.
      await prisma.$executeRawUnsafe(`UPDATE "disputes" SET "authoritySignature" = 'another-signature' WHERE "id" = $1`, f.disputeId)
      throw new Error('m9r-rem injected live dispatch failure')
    }) as never)
    await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    expect(await state(f)).toMatchObject({ dispute: 'RESOLVED', outcome: true })
  })

  it('R-4 execution: buyer and seller share one payout address - a round whose kind is not its Outcome ruling is refused at execution (0 broadcasts); the matching kind settles', async () => {
    pg.requirePostgres('R-4 execution')
    const cases: Array<{ ruling: Ruling; kind: 'release' | 'refund'; ok: boolean }> = [
      { ruling: 'RELEASE', kind: 'refund', ok: false }, { ruling: 'REFUND', kind: 'release', ok: false },
      { ruling: 'RELEASE', kind: 'release', ok: true }, { ruling: 'REFUND', kind: 'refund', ok: true },
    ]
    const seen: Array<Record<string, unknown>> = []
    for (const c of cases) {
      const f = await fixture(`r4-${c.ruling}-${c.kind}`, { sameAddress: true })
      await commitOnly(f, ruling(f, c.ruling))
      const before = chain.broadcasts.length
      const built = await (c.kind === 'release' ? escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID) : escrowService.initiateRefund(f.escrowId, ARBITER_ID))
        .then(() => true, () => false)
      const sigErr = built ? await signAll(f) : null
      const s = await state(f)
      seen.push({ ...c, built, sigErr: sigErr?.message?.slice(0, 120) ?? null, posts: chain.broadcasts.length - before, escrow: s.escrow })
      if (!built) continue // R2 (#615) refuses it at creation in the composition; here only execution is under test
      if (c.ok) {
        expect(sigErr).toBeNull(); expect(chain.broadcasts.length - before).toBe(1)
      } else {
        expect(sigErr?.message).toMatch(/KIND_MISMATCH|R-4/)
        expect(chain.broadcasts.length - before).toBe(0)
        expect(s).toMatchObject({ escrow: 'DISPUTED', txRelease: false })
      }
    }
    evidence('R-4 execution', { seen })
    expect(seen.filter((x) => !x.ok && x.built).length).toBeGreaterThan(0) // the mismatched rounds really reached execution
  })
})
