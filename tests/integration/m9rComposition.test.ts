// tests/integration/m9rComposition.test.ts
//
// M9-R experimental composition (#618: #614 R1 + #604 + #613 + #615 R2), CTO 25 plan on #343 - T2, T9, T10 and the
// Gatekeeper's R-1/R-2 follow-ups. Composition-only TESTS: no production code is changed by this file.
// Real PostgreSQL, real 2-of-3 P2WSH PSBTs built by the production services, real signatures; the explorer is
// SIMULATED (funding outputs and broadcasts are a stub, see pendingRoundLifecycleHarness). Every SQL-only step that
// stands in for a code path is labelled SIMULATION in its test name.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('M9-R composition #618 - T2/T9/T10 (real PostgreSQL, simulated explorer)', () => {
  jest.setTimeout(600_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, MultisigProvider: any, guard: any
  let reconcileMissingDispatch: any, setDispatchRecoveryCursor: any, submitSig: any, loadDisputeRulingRecord: any, signatureSetDigest: any, outcomeModule: any
  const ARBITER_ID = 'm9r-comp-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch
  let defect = false
  let disputeLog: any // the dispute service's own logger, captured at module load (PE-M9R R-1 classification marker)
  const created: Array<{ escrowId: string; disputeId: string }> = []; const legacy = new Set<string>()
  const SHIFT = 0.15

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-comp-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    if (!pg.isAvailable()) return
    const loggerModule = require('../../src/common/logger'); const realChild = loggerModule.childLogger
    jest.spyOn(loggerModule, 'childLogger').mockImplementation(((name: string) => { const l = realChild(name); if (name === 'dispute-service') disputeLog = l; return l }) as never)
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
    ;({ MultisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ;({ reconcileMissingDispatch, setDispatchRecoveryCursor } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ signatureSetDigest } = require('../../src/modules/open-settlement/pending-round-retirement'))
    guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'm9r composition arbiter' } })
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
    // Same defective translator as m9rR2RoundLifecycle: a valid, arbiter-signed SPLIT PSBT that moves 15% to the buyer.
    const orig = MultisigProvider.prototype.buildUnsignedSpend
    jest.spyOn(MultisigProvider.prototype, 'buildUnsignedSpend').mockImplementation(function (this: any, escrow: any, parties: any, n: number, fn: (v: bigint) => Array<{ address: string; value: bigint }>) {
      const wrapped = (v: bigint) => { const outs = fn(v); if (!defect || outs.length !== 2) return outs; const shift = BigInt(Math.floor(Number(v) * SHIFT)); return [{ ...outs[0], value: outs[0].value + shift }, { ...outs[1], value: outs[1].value - shift }] }
      return orig.call(this, escrow, parties, n, wrapped)
    } as never)
  })
  afterEach(() => { jest.restoreAllMocks(); if (realFetch) global.fetch = realFetch })

  const deps = () => ({ prisma, escrowService, identityService, liquidityRouter, tradeService, payoutAddressService })
  type F = { escrowId: string; tradeId: string; buyerId: string; sellerId: string; disputeId: string; buyerAddr: string; sellerAddr: string; coopRoundId?: string }

  /** A funded MULTISIG escrow with an open dispute; `sameAddress` gives buyer and seller the same payout address. */
  async function fixture(label: string, opts: { sameAddress?: boolean } = {}): Promise<F> {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, H.BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, H.SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`m9r-comp-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    const buyerAddr = H.testnetAddress(`${label}-b`), sellerAddr = opts.sameAddress ? buyerAddr : H.testnetAddress(`${label}-s`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerAddr); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerAddr)
    const d = await getDisputeService().raiseDispute(trade.id, buyer.id, `m9r comp ${label}`)
    created.push({ escrowId: escrow.id, disputeId: d.id })
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d.id, buyerAddr, sellerAddr }
  }

  /** A real cooperative release round with ONE of its two signatures (buyer), then a dispute over it (#239 candidate). */
  async function coopFixture(label: string): Promise<F> {
    const c = await H.buildCooperative(deps(), chain, label, 'release')
    await escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, H.signRound(c.round.unsignedPsbtBase64, H.buyerKey))
    const buyerAddr = H.testnetAddress(`${label}-buyer`), sellerAddr = H.testnetAddress(`${label}-seller`)
    await payoutAddressService.setPayoutAddress(c.seller.id, 'BTC', sellerAddr)
    const d = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, `m9r comp ${label}`)
    created.push({ escrowId: c.escrow.id, disputeId: d.id })
    return { escrowId: c.escrow.id, tradeId: c.trade.id, buyerId: c.buyer.id, sellerId: c.seller.id, disputeId: d.id, buyerAddr, sellerAddr, coopRoundId: c.round.id }
  }

  type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'
  const ruling = (f: F, outcome: Ruling = 'SPLIT', buyerBps: number | null = 7000) => {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps: outcome === 'SPLIT' ? buyerBps : null, issuedAt }
    return { payload, signature: signAuthorityDecision(payload, kp.secretKey), issuedAt }
  }
  /** Commits the Outcome only: what a crash between the commit and the dispatch leaves (C4 recovery's input). */
  async function commitOnly(f: F, r: ReturnType<typeof ruling>) {
    const d = await prisma.dispute.findUnique({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, r.payload, r.signature, arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
    return { bd: c.destinations.find((x: any) => x.beneficiary === f.buyerId)?.destination, sd: c.destinations.find((x: any) => x.beneficiary === f.sellerId)?.destination }
  }
  const resolveLive = (f: F, r: ReturnType<typeof ruling>) =>
    getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, r.payload.outcome, undefined, undefined, r.payload.buyerBps ?? undefined, r.signature, r.issuedAt)
  const state = async (f: F) => {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } }); const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const rows = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: f.escrowId }, include: { signatures: true } })
    return {
      escrow: e.status, txRelease: !!e.txReleaseId, dispute: d.status, ruling: d.ruling,
      outcome: !!(await loadDisputeRulingRecord(f.escrowId, 0)), pending: rows.length, round: rows[0] ?? null,
      retirements: await prisma.escrowPendingRoundRetirement.count({ where: { escrowId: f.escrowId } }),
    }
  }
  const forResume = (rep: any, f: F) => ({
    resumed: rep.resumed.some((x: any) => x.escrowId === f.escrowId), guardFailed: rep.guardFailed.find((x: any) => x.escrowId === f.escrowId),
    failed: rep.failed.find((x: any) => x.escrowId === f.escrowId), notEligible: rep.notEligible.find((x: any) => x.escrowId === f.escrowId),
    concurrent: rep.alreadyResumedConcurrently.includes(f.escrowId),
  })
  const until = async (what: string, cond: () => Promise<boolean>) => {
    for (let i = 0; i < 600; i++) { if (await cond()) return; await sleep(50) }
    throw new Error(`condition not reached: ${what}`)
  }
  const waiting = async (like: string) => (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, like))[0].n > 0
  const keyFor = (f: F, id: string) => (id === f.buyerId ? H.buyerKey : id === f.sellerId ? H.sellerKey : null)
  /** Submits every buyer/seller signature the round requires; returns the error of the last submit, if any. */
  async function signAll(f: F): Promise<Error | null> {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    let last: Error | null = null
    for (const id of row.requiredSigners) {
      const key = keyFor(f, id); if (!key) continue
      try { await submitSig(f.escrowId, id, H.signRound(row.unsignedPsbtBase64, key)); last = null } catch (e) { last = e as Error }
    }
    return last
  }

  // ══════════════════════ T2 - cooperative round preserved when the guard refuses (paginated + bounded recovery) ══════
  it('T2 a refused C4 dispatch over a half-signed cooperative round keeps that round, its signature and zero retirements; the fixed run supersedes it once, with the same signature digest', async () => {
    pg.requirePostgres('T2')
    const f = await coopFixture('t2')
    const before = await state(f)
    expect(before.round).toMatchObject({ id: f.coopRoundId, disputeId: null, kind: 'release' })
    expect(before.round.signatures).toHaveLength(1)
    const digest = signatureSetDigest(before.round.signatures)
    expect(before.retirements).toBe(0)

    defect = true
    await commitOnly(f, ruling(f))
    // Unbounded run (#604 keyset pages) and bounded run (#613), both refused by R2 inside the initiate.
    const runs = [await reconcileMissingDispatch(), (setDispatchRecoveryCursor(''), await reconcileMissingDispatch({ maxCandidates: 50, budgetMs: 60_000 }))]
    for (const rep of runs) expect(forResume(rep, f)).toMatchObject({ resumed: false, failed: undefined, guardFailed: { escrowId: f.escrowId } })
    expect(runs[1].budget).toMatchObject({ stoppedBy: 'SWEEP_COMPLETE' })
    const refused = await state(f)
    expect(refused).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 1, retirements: 0, txRelease: false })
    expect(refused.round).toMatchObject({ id: f.coopRoundId, disputeId: null })
    expect(signatureSetDigest(refused.round.signatures)).toBe(digest)
    expect(chain.broadcasts).toEqual([])

    defect = false
    expect(forResume(await reconcileMissingDispatch(), f)).toMatchObject({ resumed: true })
    const fixed = await state(f)
    expect(fixed).toMatchObject({ pending: 1, retirements: 1, txRelease: false })
    expect(fixed.round).toMatchObject({ disputeId: f.disputeId, rulingOutcome: 'SPLIT' })
    expect(fixed.round.id).not.toBe(f.coopRoundId)
    const retirement = await prisma.escrowPendingRoundRetirement.findFirstOrThrow({ where: { escrowId: f.escrowId } })
    expect(retirement).toMatchObject({ reason: 'SUPERSEDED_BY_RULING', pendingOperationId: f.coopRoundId })
    expect(retirement.signatureSetDigest).toBe(digest)
    // Idempotent: the escrow is no longer recovery work.
    const third = forResume(await reconcileMissingDispatch(), f)
    expect(third).toMatchObject({ resumed: false, guardFailed: undefined, failed: undefined, notEligible: undefined, concurrent: false })
    expect(chain.broadcasts).toEqual([])
    evidence('T2', { coopRoundKept: true, digest, retirementsAfterRefusal: 0, retirementsAfterFix: 1 })
  })

  // ══════════════════════ T9 - generation changes, both lock orders, crash windows, live ruling x C4 ══════════════════
  it('T9-G1a (SIMULATION of appeal: SQL UPDATE of the dispute row held open) - a C4 build over a cooperative round parks on FOR SHARE, then refuses atomically: cooperative round, signature and zero retirements kept', async () => {
    pg.requirePostgres('T9-G1a')
    const f = await coopFixture('t9g1a')
    const digest = signatureSetDigest((await state(f)).round.signatures)
    await commitOnly(f, ruling(f))
    let release!: () => void; const gate = new Promise<void>((r) => { release = r }); let held = false
    // appeal() is not reachable for a MULTISIG dispute with an arbiter commitment (GK VERIFY #615 section 5): SQL stands in for it.
    const writer = prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`UPDATE "disputes" SET "status" = 'APPEALED', "appealRound" = 1, "ruling" = NULL WHERE "id" = $1`, f.disputeId)
      held = true; await gate
    }, { timeout: 120_000 })
    await until('writer holds the row', async () => held)
    const run = reconcileMissingDispatch()
    await until('C4 build parked on FOR SHARE', () => waiting('%FOR SHARE%'))
    expect((await state(f)).retirements).toBe(0) // the retirement written inside the parked transaction is not visible
    release(); await writer
    const r = forResume(await run, f)
    const after = await state(f)
    evidence('T9-G1a', { classification: r.failed ? 'failed' : r.notEligible ? 'notEligible' : r.guardFailed ? 'guardFailed' : 'other', error: r.failed?.error?.slice(0, 120) })
    expect(r.resumed).toBe(false)
    expect(after).toMatchObject({ pending: 1, retirements: 0, txRelease: false })
    expect(after.round).toMatchObject({ id: f.coopRoundId, disputeId: null })
    expect(signatureSetDigest(after.round.signatures)).toBe(digest)
    expect(chain.broadcasts).toEqual([])
  })

  it('T9-G1b R-5: a generation that is no longer RESOLVED is not C4 work - the next ticks do not keep reporting it as a failure', async () => {
    pg.requirePostgres('T9-G1b')
    const f = await fixture('t9g1b')
    await commitOnly(f, ruling(f))
    // SIMULATION of the appeal's committed effect (see G1a).
    await prisma.$executeRawUnsafe(`UPDATE "disputes" SET "status" = 'APPEALED', "appealRound" = 1, "ruling" = NULL WHERE "id" = $1`, f.disputeId)
    const ticks = [forResume(await reconcileMissingDispatch(), f), forResume(await reconcileMissingDispatch(), f)]
    evidence('T9-G1b R-5', { ticks: ticks.map((t) => (t.failed ? 'failed' : t.notEligible ? 'notEligible' : t.guardFailed ? 'guardFailed' : t.resumed ? 'resumed' : 'not-a-candidate')) })
    for (const t of ticks) expect(t).toMatchObject({ resumed: false, failed: undefined })
    expect(await state(f)).toMatchObject({ pending: 0, txRelease: false })
  })

  it('T9-G3 lock order A with real code: C4 holds the escrow lock + FOR SHARE (parked on its insert by a SIMULATION row), the REAL live-ruling revert (economic lock -> dispute row lock) waits behind it; no deadlock; R-1 fixed: the revert sees the C4 round and keeps the ruling', async () => {
    pg.requirePostgres('T9-G3')
    const f = await fixture('t9g3')
    const r = ruling(f)
    let releaseInsert!: () => void; const insertGate = new Promise<void>((res) => { releaseInsert = res })
    let blocker: Promise<unknown> | null = null; let c4: Promise<any> | null = null
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (!first) return (realSplit as any)(...args)
      first = false
      // The live ruling has committed (RESOLVED + Outcome). Park a C4 build AFTER its FOR SHARE: a SIMULATION session holds
      // an uncommitted insert of a pending row for the same escrow, so C4's own create waits on the unique index.
      let held = false
      blocker = prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`INSERT INTO "escrow_pending_transactions" ("id","escrowId","kind","toAddress","unsignedPsbtBase64","requiredSigners","triggeredBy") VALUES (gen_random_uuid()::text, $1, 'release', 'sim', 'x', ARRAY[]::text[], 'sim')`, f.escrowId)
        held = true; await insertGate; throw new Error('simulation rollback')
      }, { timeout: 120_000 }).catch(() => null)
      await until('simulation insert held', async () => held)
      c4 = reconcileMissingDispatch()
      await until('C4 parked on the insert', () => waiting('%INSERT INTO "public"."escrow_pending_transactions"%'))
      throw new Error('m9r-comp injected live dispatch failure (provider unavailable)')
    }) as never)
    const warn = jest.spyOn(disputeLog, 'warn')
    const live = resolveLive(f, r).then(() => null, (e: Error) => e)
    await until('real revert waits on the dispute row', () => waiting('%FOR UPDATE%'))
    const waitsObserved = true
    releaseInsert(); await blocker
    const liveErr = await live; const rep = forResume(await c4!, f)
    const s = await state(f)
    evidence('T9-G3 order A', { waitsObserved, liveError: liveErr?.message?.slice(0, 80), c4: rep, state: { dispute: s.dispute, outcome: s.outcome, pending: s.pending, roundDispute: s.round?.disputeId } })
    // PE-M9R R-1: C4 dispatched this generation while the live dispatch failed - the ruling stands, the call succeeds.
    expect(liveErr).toBeNull()
    expect(warn.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ msg: expect.stringMatching(/^PE-M9R R-1: .*already dispatched/), disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0 }))
    expect(s).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 1, txRelease: false })
    expect(s.round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
    expect(chain.broadcasts).toEqual([])
    expect(s.txRelease).toBe(false)
    // Atomicity of each committed transaction: Outcome present <=> dispute RESOLVED (no crash injected here).
    expect(s.outcome).toBe(s.dispute === 'RESOLVED')
  })

  it('T9-G3b lock order B (SIMULATION of the revert transaction: its same statements, held open): a C4 build parks on FOR SHARE behind the revert, then refuses - no round, no retirement, and the dispute accepts a new ruling', async () => {
    pg.requirePostgres('T9-G3b')
    const f = await fixture('t9g3b')
    await commitOnly(f, ruling(f))
    let release!: () => void; const gate = new Promise<void>((r) => { release = r }); let held = false
    const reverter = prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'economic-disposition:' + f.disputeId})::bigint)`
      await tx.$queryRawUnsafe(`SELECT "id" FROM "disputes" WHERE "id" = $1 FOR UPDATE`, f.disputeId)
      await tx.dispute.updateMany({ where: { id: f.disputeId, status: 'RESOLVED' }, data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null } })
      await outcomeModule.revertDisputeRulingRecord(tx, f.escrowId, 0)
      held = true; await gate
    }, { timeout: 120_000 })
    await until('revert holds the row', async () => held)
    const run = reconcileMissingDispatch()
    await until('C4 build parked on FOR SHARE', () => waiting('%FOR SHARE%'))
    release(); await reverter
    const r = forResume(await run, f)
    const after = await state(f)
    evidence('T9-G3b order B', { c4: r.failed ? `failed: ${r.failed.error.slice(0, 80)}` : r.resumed ? 'resumed' : 'other', state: { dispute: after.dispute, outcome: after.outcome, pending: after.pending } })
    expect(r.resumed).toBe(false)
    expect(after).toMatchObject({ dispute: 'OPENED', outcome: false, pending: 0, retirements: 0 })
    expect(await resolveLive(f, ruling(f)).then(() => 'accepted', (e: Error) => e.message)).toBe('accepted')
    expect(chain.broadcasts).toEqual([])
  })

  it('T9-G5 / R-1 live ruling racing C4 recovery (real code): the orphan round, its signatures refused by ADR-005 (0 broadcasts), a new ruling, and the recovery ticks are measured', async () => {
    pg.requirePostgres('T9-G5')
    const f = await fixture('t9g5')
    const r = ruling(f)
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (first) { first = false; await reconcileMissingDispatch() } // C4 wins the dispatch between the live commit and the live dispatch
      return (realSplit as any)(...args)
    }) as never)
    const liveErr = await resolveLive(f, r).then(() => null, (e: Error) => e)
    jest.restoreAllMocks()
    const orphan = await state(f)
    const sigErr = orphan.pending ? await signAll(f) : null
    const r2 = ruling(f)
    const reRuling = await resolveLive(f, r2).then(() => 'accepted', (e: Error) => `refused: ${e.message.slice(0, 100)}`)
    const ticks = [forResume(await reconcileMissingDispatch(), f), forResume(await reconcileMissingDispatch(), f)]
    const end = await state(f)
    evidence('T9-G5 R-1', {
      liveError: liveErr?.message?.slice(0, 90), orphan: { dispute: orphan.dispute, outcome: orphan.outcome, pending: orphan.pending, roundGeneration: orphan.round?.rulingAppealRound },
      signatureSubmit: sigErr ? `refused: ${sigErr.message.slice(0, 100)}` : 'accepted', reRuling,
      ticks: ticks.map((t) => (t.failed ? `failed: ${t.failed.error.slice(0, 80)}` : t.resumed ? 'resumed' : t.notEligible ? 'notEligible' : 'not-a-candidate')),
      end: { dispute: end.dispute, outcome: end.outcome, pending: end.pending },
    })
    // PE-M9R R-1: no orphan. The live call succeeds on the generation C4 dispatched, its round is the RESOLVED
    // generation's own and settles exactly once (a second ruling is correctly refused: the dispute is resolved).
    expect(liveErr).toBeNull()
    expect(orphan).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 1 })
    expect(orphan.round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
    expect(sigErr).toBeNull()
    expect(chain.broadcasts).toHaveLength(1)
    const outs = outputsOf(f, chain.hex.get(chain.broadcasts[0])!)
    expect(outs.map((o) => o.to).sort()).toEqual(['buyer', 'seller'])
    const buyerSats = outs.find((o) => o.to === 'buyer')!.sats, sellerSats = outs.find((o) => o.to === 'seller')!.sats
    expect(buyerSats).toBeGreaterThan(sellerSats) // 70/30 per the Outcome, not the defective translator's shift
    expect(end.txRelease).toBe(true)
    expect(ticks.every((t) => !t.resumed && !t.failed)).toBe(true)
  })

  it('T9-G2 crash injected INSIDE the real revert transaction (Outcome delete fails after the dispute update): both roll back - RESOLVED + Outcome, never OPENED with a stale Outcome - and C4 recovery dispatches it', async () => {
    pg.requirePostgres('T9-G2')
    const f = await fixture('t9g2')
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (first) { first = false; throw new Error('m9r-comp injected live dispatch failure (provider unavailable)') }
      return (realSplit as any)(...args)
    }) as never)
    jest.spyOn(outcomeModule, 'revertDisputeRulingRecord').mockRejectedValueOnce(new Error('m9r-comp SIMULATED crash before the revert commits'))
    const liveErr = await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    const crashed = await state(f)
    const ticks = [forResume(await reconcileMissingDispatch(), f), forResume(await reconcileMissingDispatch(), f)]
    const end = await state(f)
    evidence('T9-G2 before commit', { liveError: liveErr?.message?.slice(0, 80), crashed: { dispute: crashed.dispute, outcome: crashed.outcome }, ticks: ticks.map((t) => (t.failed ? 'failed' : t.resumed ? 'resumed' : 'not-a-candidate')), end: { dispute: end.dispute, outcome: end.outcome, pending: end.pending } })
    expect(liveErr?.message).toMatch(/SIMULATED crash/)
    expect(crashed).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 0 })
    expect(ticks[0].resumed).toBe(true)
    expect(end.round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
    expect(chain.broadcasts).toEqual([])
  })

  it('T9-G2b revert committed (no crash): OPENED with no Outcome, and the dispute accepts a new ruling', async () => {
    pg.requirePostgres('T9-G2b')
    const f = await fixture('t9g2b')
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (first) { first = false; throw new Error('m9r-comp injected live dispatch failure (provider unavailable)') }
      return (realSplit as any)(...args)
    }) as never)
    await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    expect(await state(f)).toMatchObject({ dispute: 'OPENED', outcome: false, pending: 0 })
    const reRuling = await resolveLive(f, ruling(f)).then(() => 'accepted', (e: Error) => `refused: ${e.message.slice(0, 100)}`)
    expect(reRuling).toBe('accepted')
    expect((await state(f)).round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
  })

  it('T9-G4 stress: live rulings (some failing), C4 ticks and the arbiter route interleaved with random delays - no deadlock left unhandled, no partial state', async () => {
    pg.requirePostgres('T9-G4')
    const N = 12
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let failNext = new Set<string>()
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (escrowId: string, ...rest: unknown[]) => {
      await sleep(Math.floor(Math.random() * 40))
      if (failNext.has(escrowId)) { failNext.delete(escrowId); throw new Error('m9r-comp injected live dispatch failure') }
      return (realSplit as any)(escrowId, ...rest)
    }) as never)
    const errors: string[] = []; const cases: F[] = []
    for (let i = 0; i < N; i++) {
      const f = await fixture(`t9g4-${i}`); cases.push(f)
      if (i % 2 === 0) failNext.add(f.escrowId)
      const ops = [
        () => resolveLive(f, ruling(f)),
        () => sleep(Math.floor(Math.random() * 30)).then(() => reconcileMissingDispatch()),
        () => sleep(Math.floor(Math.random() * 30)).then(() => escrowService.initiateSplit(f.escrowId, f.buyerAddr, f.sellerAddr, 7000, ARBITER_ID)),
      ]
      const results = await Promise.allSettled(ops.map((op) => op()))
      for (const x of results) if (x.status === 'rejected') errors.push(String((x.reason as Error)?.message ?? x.reason))
    }
    const deadlocks = errors.filter((m) => /deadlock|40P01/i.test(m))
    const finals = await Promise.all(cases.map(state))
    const partial = finals.filter((s) => s.outcome !== (s.dispute === 'RESOLVED') || s.pending > 1 || s.txRelease)
    const orphans = finals.filter((s) => s.pending === 1 && s.dispute !== 'RESOLVED')
    evidence('T9-G4', { iterations: N, deadlocks: deadlocks.length, partial: partial.length, orphansR1: orphans.length, errorKinds: [...new Set(errors.map((m) => m.slice(0, 60)))] })
    expect(deadlocks).toEqual([])
    expect(partial).toEqual([])
    expect(chain.broadcasts).toEqual([])
  })

  // ══════════════════════ R-2 - generation fields isolated ═══════════════════════════════════════════════════════════
  it('R-2a authoritySignature alone: a re-ruling with the same status, round and ruling but another signature, committed WHILE the round is being built (SIMULATION: SQL write held open), makes the build refuse', async () => {
    pg.requirePostgres('R-2a')
    const f = await fixture('r2a')
    const { bd, sd } = await commitOnly(f, ruling(f))
    let release!: () => void; const gate = new Promise<void>((r) => { release = r }); let held = false
    const writer = prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`UPDATE "disputes" SET "authoritySignature" = 'another-signature-same-content' WHERE "id" = $1`, f.disputeId)
      held = true; await gate
    }, { timeout: 120_000 })
    await until('writer holds the row', async () => held)
    const build = escrowService.initiateSplit(f.escrowId, bd, sd, 7000, ARBITER_ID).then(() => null, (e: Error) => e)
    await until('build parked on FOR SHARE', () => waiting('%FOR SHARE%'))
    release(); await writer
    const err = await build
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/no longer the RESOLVED generation 0/)
    expect(await state(f)).toMatchObject({ pending: 0 })
  })

  it('R-2b minerFeeSats: the guard receives the miner fee the round declares (an under-declared fee is refused)', async () => {
    pg.requirePostgres('R-2b')
    const f = await fixture('r2b')
    const { bd, sd } = await commitOnly(f, ruling(f))
    const seen: Array<number | undefined> = []
    const realAssert = guard.assertTranslationMatchesOutcome
    jest.spyOn(guard, 'assertTranslationMatchesOutcome').mockImplementation(((psbt: string, outcome: unknown, net: unknown, fee?: number) => { seen.push(fee); return realAssert(psbt, outcome, net, fee) }) as never)
    await escrowService.initiateSplit(f.escrowId, bd, sd, 7000, ARBITER_ID)
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(row.minerFeeSats ?? undefined)
    expect(typeof seen[0]).toBe('number')
  })

  // ══════════════════════ T10 - economic authority matrix: ruling x round kind, boundaries, same address ═══════════
  const KINDS = ['release', 'refund', 'split'] as const
  const RULINGS: Array<{ name: string; outcome: Ruling; bps: number | null }> = [
    { name: 'RELEASE', outcome: 'RELEASE', bps: null },
    { name: 'REFUND', outcome: 'REFUND', bps: null },
    { name: 'SPLIT-7000', outcome: 'SPLIT', bps: 7000 },
    { name: 'SPLIT-1', outcome: 'SPLIT', bps: 1 },
    { name: 'SPLIT-9999', outcome: 'SPLIT', bps: 9999 },
  ]
  const outputsOf = (f: F, hex: string) => bitcoin.Transaction.fromHex(hex).outs.map((o) => {
    const a = bitcoin.address.fromOutputScript(o.script, H.NETWORK)
    return { to: a === f.buyerAddr && a === f.sellerAddr ? 'both' : a === f.buyerAddr ? 'buyer' : a === f.sellerAddr ? 'seller' : 'other', sats: Number(o.value) }
  })
  async function cell(label: string, rule: (typeof RULINGS)[number], kind: (typeof KINDS)[number], opts: { sameAddress?: boolean } = {}) {
    const f = await fixture(label, opts)
    const { bd, sd } = await commitOnly(f, ruling(f, rule.outcome, rule.bps))
    const bps = kind === 'split' ? (rule.bps ?? 7000) : null
    const call = kind === 'release' ? escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID)
      : kind === 'refund' ? escrowService.initiateRefund(f.escrowId, ARBITER_ID)
      : escrowService.initiateSplit(f.escrowId, bd, sd, bps, ARBITER_ID)
    const err = await call.then(() => null, (e: Error) => e)
    const s = await state(f)
    let broadcast: Array<{ to: string; sats: number }> | null = null
    if (!err) {
      const sigErr = await signAll(f)
      if (!sigErr && chain.broadcasts.length) {
        const hex = chain.hex.get(chain.broadcasts[chain.broadcasts.length - 1])!
        // Cryptographically valid: the broadcast transaction decodes and every input carries a valid witness signature.
        const tx = bitcoin.Transaction.fromHex(hex)
        expect(tx.ins.every((i) => i.witness.length > 0)).toBe(true)
        broadcast = outputsOf(f, hex)
      } else if (sigErr) broadcast = [{ to: `submit refused: ${sigErr.message.slice(0, 60)}`, sats: 0 }]
    }
    const escrowStatus = (await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).status
    return { f, err, s, broadcast, roundKind: s.round?.kind, rulingOutcome: s.round?.rulingOutcome, escrowStatus }
  }

  it('T10 matrix: 5 rulings (incl. SPLIT boundaries) x 3 round kinds on the arbiter route - only the kind that matches the Outcome is ever built; every refusal is a 409 with 0 rounds and 0 POST', async () => {
    pg.requirePostgres('T10 matrix')
    const matrix: Array<Record<string, unknown>> = []
    for (const rule of RULINGS) for (const kind of KINDS) {
      const before = chain.broadcasts.length
      const c = await cell(`t10-${rule.name}-${kind}`, rule, kind)
      const expected = (rule.outcome === 'SPLIT' ? 'split' : rule.outcome.toLowerCase()) === kind
      matrix.push({ ruling: rule.name, kind, built: !c.err, expected, error: c.err ? `${c.err.constructor.name}:${(c.err as any).statusCode ?? ''}:${c.err.message.slice(0, 90)}` : null, broadcast: c.broadcast, escrowStatus: c.escrowStatus })
      if (!expected) {
        expect(c.err).toBeTruthy()
        expect(c.s.pending).toBe(0)
        expect(chain.broadcasts.length).toBe(before)
      }
    }
    evidence('T10 matrix', { matrix })
    // A matching kind that builds must broadcast exactly the Outcome's beneficiaries.
    for (const m of matrix.filter((x) => x.built && x.broadcast)) {
      const outs = m.broadcast as Array<{ to: string }>
      if (m.ruling === 'RELEASE') expect(outs.map((o) => o.to)).toEqual(['buyer'])
      if (m.ruling === 'REFUND') expect(outs.map((o) => o.to)).toEqual(['seller'])
    }
  })

  it('T10 same payout address for buyer and seller: which kinds build under each ruling, and whether the round kind stays consistent with the ruling (economic classification)', async () => {
    pg.requirePostgres('T10 same address')
    const matrix: Array<Record<string, unknown>> = []
    for (const rule of RULINGS.slice(0, 3)) for (const kind of KINDS) {
      const before = chain.broadcasts.length
      const c = await cell(`t10s-${rule.name}-${kind}`, rule, kind, { sameAddress: true })
      matrix.push({ ruling: rule.name, kind, built: !c.err, roundKind: c.roundKind ?? null, rulingOutcome: c.rulingOutcome ?? null, broadcast: c.broadcast, newPosts: chain.broadcasts.length - before, escrowStatus: c.escrowStatus })
    }
    evidence('T10 same address', { matrix })
    // Whatever builds, every broadcast pays only the (shared) Outcome destination.
    for (const m of matrix) for (const o of (m.broadcast as Array<{ to: string }> | null) ?? []) expect(['both']).toContain(o.to)
    // Economic classification: a built round's kind must be the kind its ruling authorizes (RELEASE->release, REFUND->refund, SPLIT->split).
    const inconsistent = matrix.filter((m) => m.built && m.roundKind !== String(m.rulingOutcome).toLowerCase())
    expect(inconsistent.map((m) => `${m.ruling}->${m.roundKind} escrow ${m.escrowStatus}`)).toEqual([])
  })

  it('T9-G2c restart SIMULATION (the revert transaction\'s own database backend is terminated mid-transaction, as a process death would): Postgres rolls both back - RESOLVED + Outcome - and C4 recovery dispatches it after reconnect', async () => {
    pg.requirePostgres('T9-G2c')
    const f = await fixture('t9g2c')
    const realSplit = escrowService.initiateSplit.bind(escrowService)
    let first = true
    jest.spyOn(escrowService, 'initiateSplit').mockImplementation((async (...args: unknown[]) => {
      if (first) { first = false; throw new Error('m9r-comp injected live dispatch failure (provider unavailable)') }
      return (realSplit as any)(...args)
    }) as never)
    jest.spyOn(outcomeModule, 'revertDisputeRulingRecord').mockImplementationOnce((async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_terminate_backend(pg_backend_pid())') // after the dispute update, inside the same tx
    }) as never)
    const liveErr = await resolveLive(f, ruling(f)).then(() => null, (e: Error) => e)
    const crashed = await state(f)
    const rep = forResume(await reconcileMissingDispatch(), f)
    const end = await state(f)
    evidence('T9-G2c restart', { liveError: liveErr?.message?.slice(0, 100), crashed: { dispute: crashed.dispute, outcome: crashed.outcome }, resumed: rep.resumed })
    expect(liveErr).toBeInstanceOf(Error)
    expect(crashed).toMatchObject({ dispute: 'RESOLVED', outcome: true, pending: 0 })
    expect(rep.resumed).toBe(true)
    expect(end.round).toMatchObject({ disputeId: f.disputeId, rulingAppealRound: 0 })
    expect(chain.broadcasts).toEqual([])
  })

  it('INVARIANT (CTO 25 condition 2): no dispute this file drove - crashes, concurrency, restart, stress - is left non-RESOLVED while an Outcome exists for its current appeal round', async () => {
    pg.requirePostgres('INVARIANT')
    const bad: string[] = []
    for (const c of created) {
      if (legacy.has(c.disputeId)) continue
      const d = await prisma.dispute.findUniqueOrThrow({ where: { id: c.disputeId } })
      if (d.status !== 'RESOLVED' && (await loadDisputeRulingRecord(c.escrowId, d.appealRound))) bad.push(`${c.disputeId}:${d.status}`)
    }
    evidence('INVARIANT', { disputesChecked: created.length - legacy.size, violations: bad.length })
    expect(created.length).toBeGreaterThan(30)
    expect(bad).toEqual([])
  })

  // ══════════════════════ KNOWN LIMITATION - characterization, NOT a GO criterion of the composition ═════════════════
  // CTO 25 decision (#614 comment 6832811925): the pre-fix two-step crash state is a declared historical limit. The
  // original test is kept verbatim as it.failing: it passes only while its original assertions still fail (the
  // limit is still reproduced); if it ever starts passing, it fails and must be reclassified. No recovery is built.
  describe('KNOWN LIMITATION T9-G2-legacy (pre-fix data only; re-evaluate before economic activation)', () => {
    it.failing('T9-G2-legacy (SIMULATION of the PRE-FIX two-step crash state, kept unchanged as a declared residual - only pre-patch data can hold it): the reverted dispute keeps a stale Outcome; recovery, a new ruling and the arbiter route are measured', async () => {
      pg.requirePostgres('T9-G2')
      const f = await fixture('t9g2')
      legacy.add(f.disputeId) // test bookkeeping only; the body below is the original, unchanged
      const r = ruling(f)
      await commitOnly(f, r)
      // The exact conditional revert dispute.service.ts runs (economic lock + updateMany), WITHOUT the Outcome delete that follows it.
      await prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'economic-disposition:' + f.disputeId})::bigint)`
        await tx.dispute.updateMany({ where: { id: f.disputeId, status: 'RESOLVED' }, data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null } })
      })
      const crashed = await state(f)
      const ticks = [forResume(await reconcileMissingDispatch(), f), forResume(await reconcileMissingDispatch(), f)]
      const arbiterRoute = await escrowService.initiateSplit(f.escrowId, f.buyerAddr, f.sellerAddr, 7000, ARBITER_ID).then(() => 'created', (e: Error) => `refused: ${e.message.slice(0, 100)}`)
      const reRuling = await resolveLive(f, ruling(f)).then(() => 'accepted', (e: Error) => `refused: ${e.message.slice(0, 100)}`)
      const end = await state(f)
      evidence('T9-G2', { crashed: { dispute: crashed.dispute, outcome: crashed.outcome }, ticks: ticks.map((t) => (t.failed ? 'failed' : t.resumed ? 'resumed' : 'not-a-candidate')), arbiterRoute, reRuling, end: { dispute: end.dispute, outcome: end.outcome, pending: end.pending } })
      expect(chain.broadcasts).toEqual([])
      expect(end.txRelease).toBe(false)
      expect(end.pending === 0 || end.round.disputeId === f.disputeId).toBe(true)
      // Liveness (CTO 25 HOLD criterion): the reverted dispute must be able to receive a new ruling.
      expect(reRuling).toBe('accepted')
    })
  })
})
