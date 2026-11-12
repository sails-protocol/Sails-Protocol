// tests/integration/pendingRoundLifecycle.test.ts
//
// Issue #239 - lifecycle of cooperative MULTISIG signing rounds, against REAL PostgreSQL with REAL 2-of-3 P2WSH
// PSBTs signed by keys this suite controls. Specification: issue #239 comments 6757131933, 6757229161, 6757615206.
//   T1-T15  retirement (seller cancellation, ruling supersession), authority, generation identity, concurrency;
//   B/C-2   external completion converged only with complete proofs, claim + result atomic, reorg/crash/mempool;
//   R5      fully signed round on a disputed escrow held, never superseded;
//   table   append-only retirement record (CHECKs, FKs, triggers, rollback, hash chain).
// Interleavings are forced with the real escrow advisory lock (the test holds it and queues contenders, observed in
// pg_locks). Only the explorer is simulated (pendingRoundLifecycleHarness.ts). T12 (two OS processes) lives in
// pendingRoundLifecycleProcesses.test.ts.
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import nacl from 'tweetnacl'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { testnetAddress, newChain, explorer, signRound, completeOutsideSails, buildCooperative, type Chain } from './pendingRoundLifecycleHarness'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'

describe('Issue #239 - cooperative signing-round lifecycle (real PostgreSQL, real PSBTs)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: any
  let liquidityRouter: any
  let tradeService: any
  let payoutAddressService: any
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let commitAuthoritativeDisputeRuling: typeof import('../../src/modules/open-settlement/dispute-outcome').commitAuthoritativeDisputeRuling
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let reconcile: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
  let dispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch')
  let retirementModule: typeof import('../../src/modules/open-settlement/pending-round-retirement')
  let asTrustedActor: typeof import('../../src/modules/open-settlement/escrow-lifecycle').asTrustedActor
  let toPendingTransactionResponse: typeof import('../../src/modules/open-settlement/settlement.routes').toPendingTransactionResponse

  const ARBITER_ID = 'i239-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  let chain: Chain
  let realFetch: typeof fetch
  let held: Array<() => Promise<void>> = []
  let inflight: Array<Promise<unknown>> = []
  const track = <T>(p: Promise<T>): Promise<T> => { inflight.push(p.catch(() => undefined)); return p }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'i239-test-seed'
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
    ;({ commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    reconcile = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    dispatch = require('../../src/modules/open-settlement/dispute-dispatch')
    retirementModule = require('../../src/modules/open-settlement/pending-round-retirement')
    ;({ asTrustedActor } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ toPendingTransactionResponse } = require('../../src/modules/open-settlement/settlement.routes'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    const publicKey = Buffer.from(arbiterKeypair.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey }, create: { id: ARBITER_ID, publicKey, displayName: 'i239 arbiter' } })
  })

  let mine: string[] = []
  beforeEach(() => {
    chain = newChain()
    realFetch = global.fetch
    global.fetch = explorer(chain)
    mine = []
    if (!dbAvailable) return
    // The external-spend watch pages every MULTISIG escrow in the shared database (50 per tick); narrowed here to
    // the escrows THIS test created, so an assertion about one escrow never depends on where its id falls.
    const findMany = prisma.escrow.findMany.bind(prisma.escrow)
    jest.spyOn(prisma.escrow, 'findMany').mockImplementation(((args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: mine } }] } } : args)) as never)
  })

  afterEach(async () => {
    for (const release of held) await release().catch(() => undefined)
    await Promise.all(inflight)
    held = []
    inflight = []
    global.fetch = realFetch
    jest.restoreAllMocks()
    reconcile?.resetExternalSpendCursor()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ───────────────────────────────────────────────────────────────
  async function cooperative(label: string, kind: 'release' | 'refund' = 'release') {
    const c = await buildCooperative({ prisma, escrowService, identityService, liquidityRouter, tradeService, payoutAddressService }, chain, label, kind)
    mine.push(c.escrow.id)
    return c
  }
  type Coop = Awaited<ReturnType<typeof cooperative>>
  const keyOf = (c: Coop, participantId: string) => (participantId === c.buyer.id ? c.buyerKey : c.sellerKey)

  /** Signs through the production path (submitTransactionSignature); returns the stored server copy. */
  async function sign(c: Coop, participantId: string, opts: { pendingTransactionId?: string } = {}) {
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: c.escrow.id } })
    await escrowService.submitTransactionSignature(c.escrow.id, participantId, signRound(round.unsignedPsbtBase64, keyOf(c, participantId)), opts.pendingTransactionId)
    return (await prisma.escrowTransactionSignature.findFirstOrThrow({ where: { pendingTxId: round.id, participantId } })).signedPsbtBase64
  }
  /** Every required signature persisted directly, no finalize (the "fully signed, not executed" state). */
  async function persistAllSignatures(c: Coop) {
    for (const id of c.round.requiredSigners) {
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: c.round.id, participantId: id, signedPsbtBase64: signRound(c.round.unsignedPsbtBase64, keyOf(c, id)) } })
    }
  }

  async function raiseDispute(c: Coop) {
    const dispute = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, 'i239')
    expect(dispute.arbiterId).toBe(ARBITER_ID)
    return dispute
  }
  function ruling(disputeId: string, escrowId: string, outcome: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) {
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId, escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps, issuedAt }
    return { payload, signature: signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt }
  }
  async function resolve(c: Coop, disputeId: string, outcome: 'RELEASE' | 'REFUND' | 'SPLIT') {
    await payoutAddressService.setPayoutAddress(c.buyer.id, 'BTC', testnetAddress(`${c.escrow.id}-rb`))
    await payoutAddressService.setPayoutAddress(c.seller.id, 'BTC', testnetAddress(`${c.escrow.id}-rs`))
    const r = ruling(disputeId, c.escrow.id, outcome, outcome === 'SPLIT' ? 6000 : null)
    return getDisputeService().resolveDispute(disputeId, ARBITER_ID, outcome, undefined, undefined, outcome === 'SPLIT' ? 6000 : undefined, r.signature, r.issuedAt)
  }

  /** One reconciler tick with the external-spend watch's minimum interval disabled (the production default is 60 s). */
  const tick = () => reconcile.reconcilePendingSettlements({ externalSpendMinIntervalMs: 0 })
  /** Everything one tick reported about one escrow - an assertion on it shows the whole picture when it fails. */
  const seen = (report: Awaited<ReturnType<typeof tick>>, escrowId: string) => ({
    reason: report.requiresManualReview.find((x) => x.escrowId === escrowId)?.reason,
    failed: report.failed.filter((x) => x.escrowId === escrowId || x.escrowId.startsWith('external-spend')),
    externallyCompleted: report.externallyCompleted.some((x) => x.escrowId === escrowId),
    buckets: { unreadable: report.externalSpendUnreadable.includes(escrowId), pendingConfirmation: report.externalSpendPendingConfirmation.includes(escrowId), fundingUncertain: report.externalSpendFundingUncertain.includes(escrowId) },
  })
  const retirements = (escrowId: string) => prisma.escrowPendingRoundRetirement.findMany({ where: { escrowId }, orderBy: { retiredAt: 'asc' } })
  const liveRound = (escrowId: string) => prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, include: { signatures: true } })

  // ─── lock interleaving helpers (same technique as staleDisputeCleanupSignatureRace.test.ts) ───────────
  const waiters = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1000; i++) {
      if ((await waiters()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waiters()}`)
  }
  async function holdEscrowLock(escrowId: string) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      acquired()
      await released
    }, { timeout: 60_000 })
    await isHeld
    let once = false
    const releaseOnce = async () => { if (once) return; once = true; release(); await done }
    held.push(releaseOnce)
    return releaseOnce
  }
  const outcomeOf = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (err: Error) => ({ ok: false as const, err: err.message }))

  // ─── T1-T8, T13, T14: seller cancellation ─────────────────────────────────────
  it('T1: the seller cancels a round with 0 and with 1 of 2 signatures; a durable retirement is recorded and a new round can start', async () => {
    pg.requirePostgres('T1')
    for (const signatures of [0, 1]) {
      const c = await cooperative(`t1-${signatures}`)
      if (signatures === 1) await sign(c, c.buyer.id)
      const result = await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))
      expect(result).toMatchObject({ outcome: 'CANCELLED', pendingTransactionId: c.round.id })
      expect((result as { note?: string }).note).toMatch(/Retired, not revoked/)
      expect(await liveRound(c.escrow.id)).toBeNull()
      expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: c.round.id } })).toBe(0)
      const [r] = await retirements(c.escrow.id)
      expect(r).toMatchObject({
        pendingOperationId: c.round.id, reason: 'CANCELLED', retiredBy: c.seller.id, kind: 'release',
        fundingTxid: c.funding, fundingVout: 0, requiredSigners: c.round.requiredSigners, disputeId: null, prevRecordHash: 'genesis',
        signedBy: signatures === 1 ? [c.buyer.id] : [],
      })
      expect(r.unsignedTxid).toBe(require('../../src/modules/open-settlement/multisig-round-proofs').roundUnsignedTxid(c.round.unsignedPsbtBase64, require('./pendingRoundLifecycleHarness').NETWORK))
      expect(await retirementModule.verifyRetirementChain(prisma, c.escrow.id)).toEqual({ ok: true })
      // A replacement round starts normally and chains a second retirement.
      await escrowService.initiateRelease(c.escrow.id, undefined, c.seller.id)
      const next = (await liveRound(c.escrow.id))!
      await escrowService.cancelPendingSignatureRound(c.escrow.id, next.id, asTrustedActor(c.seller.id))
      const chainRows = await retirements(c.escrow.id)
      expect(chainRows).toHaveLength(2)
      expect(chainRows.find((x) => x.pendingOperationId === next.id)!.prevRecordHash).toBe(r.recordHash)
      expect(await retirementModule.verifyRetirementChain(prisma, c.escrow.id)).toEqual({ ok: true })
    }
  })

  it('T2: a fully signed round is never retired; round, signatures and retirement table stay untouched', async () => {
    pg.requirePostgres('T2')
    const c = await cooperative('t2')
    await persistAllSignatures(c)
    await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow(/fully signed/)
    expect((await liveRound(c.escrow.id))!.signatures).toHaveLength(2)
    expect(await retirements(c.escrow.id)).toHaveLength(0)
  })

  it('T3: cancellation against the last signature, both orders, has exactly one winner', async () => {
    pg.requirePostgres('T3')
    // (a) cancel queued first: it retires the round; the last signature then finds none.
    const a = await cooperative('t3a')
    await sign(a, a.buyer.id)
    const releaseA = await holdEscrowLock(a.escrow.id)
    const cancelA = track(outcomeOf(escrowService.cancelPendingSignatureRound(a.escrow.id, a.round.id, asTrustedActor(a.seller.id))))
    await untilWaiting(1)
    const lastA = track(outcomeOf(escrowService.submitTransactionSignature(a.escrow.id, a.seller.id, signRound(a.round.unsignedPsbtBase64, a.sellerKey))))
    await untilWaiting(2)
    await releaseA()
    expect(await cancelA).toMatchObject({ ok: true, v: { outcome: 'CANCELLED' } })
    expect(await lastA).toEqual({ ok: false, err: expect.stringMatching(/has no pending transaction/) })
    expect(await retirements(a.escrow.id)).toHaveLength(1)

    // (b) the last signature queued first: the round completes; cancellation is refused.
    const b = await cooperative('t3b')
    await sign(b, b.buyer.id)
    const releaseB = await holdEscrowLock(b.escrow.id)
    const lastB = track(outcomeOf(escrowService.submitTransactionSignature(b.escrow.id, b.seller.id, signRound(b.round.unsignedPsbtBase64, b.sellerKey))))
    await untilWaiting(1)
    const cancelB = track(outcomeOf(escrowService.cancelPendingSignatureRound(b.escrow.id, b.round.id, asTrustedActor(b.seller.id))))
    await untilWaiting(2)
    await releaseB()
    const [signedB, cancelledB] = await Promise.all([lastB, cancelB])
    // The last signature, read from the snapshot taken under the lock, finalizes for real.
    expect(signedB).toMatchObject({ ok: true, v: { complete: true } })
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: b.escrow.id } })).status).toBe('COMPLETED')
    expect(cancelledB).toEqual({ ok: false, err: expect.stringMatching(/fully signed|COMPLETED|non-terminal/) })
    expect(await retirements(b.escrow.id)).toHaveLength(0)
  })

  it('T4: two concurrent cancellations: one CANCELLED, one GONE, one retirement row', async () => {
    pg.requirePostgres('T4')
    const c = await cooperative('t4')
    const release = await holdEscrowLock(c.escrow.id)
    const first = track(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id)))
    const second = track(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id)))
    await untilWaiting(2)
    await release()
    expect((await Promise.all([first, second])).map((r) => r.outcome).sort()).toEqual(['CANCELLED', 'GONE'])
    expect(await retirements(c.escrow.id)).toHaveLength(1)
  })

  it('T5: a stale generation id is refused by cancellation and by signing; the new round is untouched', async () => {
    pg.requirePostgres('T5')
    const c = await cooperative('t5')
    await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))
    // A different destination makes the replacement a different transaction (an identical one is the SAME instruction).
    await payoutAddressService.setPayoutAddress(c.buyer.id, 'BTC', testnetAddress('t5-buyer-rotated'))
    await escrowService.initiateRelease(c.escrow.id, undefined, c.seller.id)
    const next = (await liveRound(c.escrow.id))!
    expect(await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).toEqual({ outcome: 'GONE', pendingTransactionId: c.round.id })
    await expect(escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, signRound(next.unsignedPsbtBase64, c.buyerKey), c.round.id)).rejects.toThrow(/live round is/)
    // The old round's own signature is refused on the new round (different transaction).
    await expect(escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, signRound(c.round.unsignedPsbtBase64, c.buyerKey))).rejects.toThrow(/does not sign this round/)
    expect((await liveRound(c.escrow.id))!).toMatchObject({ id: next.id, signatures: [] })
  })

  it('T6: a crash before the commit changes nothing; after the commit the retirement holds and a retry is GONE', async () => {
    pg.requirePostgres('T6')
    const c = await cooperative('t6')
    await sign(c, c.buyer.id)
    const real = retirementModule.retireRound
    jest.spyOn(retirementModule, 'retireRound').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await real(...args)
      throw new Error('process died before commit')
    })
    await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow('process died before commit')
    expect((await liveRound(c.escrow.id))!.signatures).toHaveLength(1)
    expect(await retirements(c.escrow.id)).toHaveLength(0)
    // A fresh client (another process after restart) sees the committed truth.
    await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))
    const { PrismaPg } = require('@prisma/adapter-pg')
    const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
    try {
      expect(await fresh.escrowPendingTransaction.findUnique({ where: { id: c.round.id } })).toBeNull()
      expect(await fresh.escrowPendingRoundRetirement.count({ where: { pendingOperationId: c.round.id } })).toBe(1)
    } finally {
      await fresh.$disconnect()
    }
    expect(await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).toMatchObject({ outcome: 'GONE' })
  })

  it('T7: only the seller (or the seller\'s own agent, service level) cancels; never the buyer, a third party or the arbiter, never in a dispute', async () => {
    pg.requirePostgres('T7')
    const c = await cooperative('t7')
    const stranger = await registerTestParticipant(identityService, 'Stranger')
    for (const actor of [c.buyer.id, stranger.id, ARBITER_ID, `agent:wallet:${c.buyer.id}`, `agent:wallet:${stranger.id}`]) {
      await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(actor))).rejects.toThrow(/is not the seller/)
    }
    expect(await liveRound(c.escrow.id)).not.toBeNull()
    expect(await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(`agent:wallet:${c.seller.id}`))).toMatchObject({ outcome: 'CANCELLED' })
    expect((await retirements(c.escrow.id))[0].retiredBy).toBe(`agent:wallet:${c.seller.id}`)

    // In a dispute nobody cancels manually - not the seller either.
    const d = await cooperative('t7-disputed')
    await raiseDispute(d)
    await expect(escrowService.cancelPendingSignatureRound(d.escrow.id, d.round.id, asTrustedActor(d.seller.id))).rejects.toThrow(/DISPUTED/)
    expect(await liveRound(d.escrow.id)).not.toBeNull()
  })

  it('T8: a round with any execution evidence (EDA, capability authorization, finalization attempt) is never retired', async () => {
    pg.requirePostgres('T8')
    const evidence: Array<(c: Coop) => Promise<unknown>> = [
      (c) => prisma.economicDispositionAuthorization.create({ data: { pendingOperationId: c.round.id, escrowId: c.escrow.id, disputeId: 'd', appealRound: 0, arbiterId: ARBITER_ID, ruling: 'RELEASE', operationDigest: 'x' } }),
      (c) => prisma.capabilityExecutionAuthorization.create({ data: { pendingOperationId: c.round.id, escrowId: c.escrow.id, grantId: 'g', grantedTo: c.seller.id, capabilityName: 'opensettlement', requiredScope: 'settlement.escrow.released', operationDigest: 'x' } }),
      (c) => prisma.signatureCollectionFinalizationAttempt.create({ data: { escrowId: c.escrow.id, pendingTxId: c.round.id, kind: 'release' } }),
    ]
    for (const [i, write] of evidence.entries()) {
      const c = await cooperative(`t8-${i}`)
      await write(c)
      await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow(/execution evidence/)
      expect(await liveRound(c.escrow.id)).not.toBeNull()
    }
  })

  it('T13: a spent or unreadable funding outpoint refuses cancellation and ruling supersession', async () => {
    pg.requirePostgres('T13')
    const c = await cooperative('t13')
    chain.spentBy.set(`${c.funding}:0`, 'aa'.repeat(32))
    await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow(/already spent/)
    chain.spentBy.clear()
    chain.outspendUnreadable = true
    await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow(/could not be read/)
    // The same guard protects the ruling path.
    chain.outspendUnreadable = false
    const dispute = await raiseDispute(c)
    chain.outspendUnreadable = true
    await expect(resolve(c, dispute.id, 'RELEASE')).rejects.toThrow()
    expect((await liveRound(c.escrow.id))!.id).toBe(c.round.id)
    expect(await retirements(c.escrow.id)).toHaveLength(0)
  })

  it('T14: LIGHTNING_HODL and SAFE_GUARD_EVM fail closed: no cancellation, no supersession', async () => {
    pg.requirePostgres('T14')
    for (const type of ['LIGHTNING_HODL', 'SAFE_GUARD_EVM'] as const) {
      const c = await cooperative(`t14-${type}`)
      await prisma.escrow.update({ where: { id: c.escrow.id }, data: { type } })
      await expect(escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).rejects.toThrow(/does not support cancelling/)
      expect(dispatch.isSupersedableCooperativeRound({ ...c.round, signatures: [] })).toBe(true) // the round itself would be...
      const grant = dispatch.issueRulingSupersessionGrant({ id: 'x', appealRound: 0, arbiterId: ARBITER_ID, ruling: 'RELEASE', authoritySignature: 's', authorityIssuedAt: new Date(), status: 'RESOLVED' })
      // ...but the rail is not MULTISIG: the core refuses before any lock or chain read, as main does without a grant.
      // Called by the seller, an authorized initiator, so the refusal is the rail gate's and not an authorization one.
      const outspendsBefore = chain.outspendCalls.length
      await expect(escrowService.initiateRelease(c.escrow.id, undefined, c.seller.id, grant)).rejects.toThrow(/already has a pending release transaction awaiting signatures/)
      expect(chain.outspendCalls.length).toBe(outspendsBefore)
      expect((await liveRound(c.escrow.id))!.id).toBe(c.round.id)
      expect(await retirements(c.escrow.id)).toHaveLength(0)
    }
  })

  // ─── T9, T10, T15: ruling supersession and its internal authority ───────────────
  it('T9: a valid live ruling (RELEASE, REFUND, SPLIT) supersedes a partially signed cooperative round; a fully signed one is never superseded', async () => {
    pg.requirePostgres('T9')
    for (const outcome of ['RELEASE', 'REFUND', 'SPLIT'] as const) {
      const c = await cooperative(`t9-${outcome}`)
      await sign(c, c.buyer.id)
      const dispute = await raiseDispute(c)
      await resolve(c, dispute.id, outcome)
      const next = (await liveRound(c.escrow.id))!
      expect(next.id).not.toBe(c.round.id)
      expect(next.disputeId).toBe(dispute.id)
      expect(next.kind).toBe(outcome.toLowerCase())
      const [r] = await retirements(c.escrow.id)
      expect(r).toMatchObject({ pendingOperationId: c.round.id, reason: 'SUPERSEDED_BY_RULING', retiredBy: ARBITER_ID, disputeId: dispute.id, appealRound: 0, supersedingPendingOperationId: next.id, signedBy: [c.buyer.id] })
    }
    const full = await cooperative('t9-full')
    await persistAllSignatures(full)
    const dispute = await raiseDispute(full)
    // A fully signed round counts as the dispatch (it may already have executed): the ruling is refused, not dispatched.
    await expect(resolve(full, dispute.id, 'RELEASE')).rejects.toThrow(/dispatch already occurred/)
    expect((await liveRound(full.escrow.id))!.id).toBe(full.round.id)
    expect((await liveRound(full.escrow.id))!.signatures).toHaveLength(2)
    expect(await retirements(full.escrow.id)).toHaveLength(0)
  })

  it('T9 (B2): a ruling never supersedes while the funding evidence is uncertain; nothing is retired', async () => {
    pg.requirePostgres('T9 B2')
    for (const outcome of ['REFUND', 'RELEASE'] as const) {
      const c = await cooperative(`t9-b2-${outcome}`)
      await sign(c, c.buyer.id)
      const dispute = await raiseDispute(c)
      await prisma.escrowFundingEvidence.create({ data: { escrowId: c.escrow.id, kind: 'REORGED_INVALIDATED', txid: c.funding, vout: 0 } })
      // REFUND is otherwise allowed under uncertain funding, so only the supersession's own check refuses it; RELEASE
      // is refused earlier by the generic release check. Either way the cooperative round stays and nothing is retired.
      const reason = outcome === 'REFUND' ? /funding evidence is uncertain .*refusing to supersede its cooperative round/ : /funding evidence is currently uncertain/
      await expect(resolve(c, dispute.id, outcome)).rejects.toThrow(reason)
      const live = (await liveRound(c.escrow.id))!
      expect(live.id).toBe(c.round.id)
      expect(live.signatures.map((s) => s.participantId)).toEqual([c.buyer.id])
      expect(await retirements(c.escrow.id)).toHaveLength(0)
      expect((await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).ruling).toBeNull() // reverted
    }
  })

  // CTO 24 item 6 (Claude F-1): the translation guard runs after the dispatch committed, and its failure path deletes
  // the escrow's pending row (pre-existing `deleteMany({ escrowId })`, not changed here). Reproduced, not fixed.
  it('F-1 evidence (live ruling): guard failure after supersession - the retirement stays, the superseding round is deleted, a later ruling dispatches a new id', async () => {
    pg.requirePostgres('F-1 live')
    const guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const c = await cooperative('f1-live')
    await sign(c, c.buyer.id)
    const dispute = await raiseDispute(c)
    const statusBefore = (await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).status
    const spy = jest.spyOn(guard, 'assertTranslationMatchesOutcome').mockImplementationOnce(() => { throw new Error('i239 F-1: forced translation mismatch') })
    await expect(resolve(c, dispute.id, 'RELEASE')).rejects.toThrow(/forced translation mismatch/)
    expect(spy).toHaveBeenCalledTimes(1)
    const [r] = await retirements(c.escrow.id)
    expect(r).toMatchObject({ pendingOperationId: c.round.id, reason: 'SUPERSEDED_BY_RULING', disputeId: dispute.id, signedBy: [c.buyer.id] })
    const superseding = r.supersedingPendingOperationId!
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { id: superseding } })).toBeNull()
    expect(await liveRound(c.escrow.id)).toBeNull()
    expect(await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).toMatchObject({ status: statusBefore, ruling: null })
    expect(await retirementModule.verifyRetirementChain(prisma, c.escrow.id)).toMatchObject({ ok: true })
    // Funds did not move and the escrow is still DISPUTED; the next valid ruling dispatches normally, under a new id.
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'DISPUTED', txReleaseId: null })
    await resolve(c, dispute.id, 'RELEASE')
    const next = (await liveRound(c.escrow.id))!
    expect(next.disputeId).toBe(dispute.id)
    expect(next.id).not.toBe(superseding)
    expect(await retirements(c.escrow.id)).toHaveLength(1)
    expect(chain.broadcasts).toEqual([])
  })

  it('F-1 evidence (C4): guard failure after supersession in recovery - guardFailed, superseding round deleted, the next C4 pass re-dispatches', async () => {
    pg.requirePostgres('F-1 C4')
    const guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const c = await cooperative('f1-c4')
    await sign(c, c.buyer.id)
    const dispute = await raiseDispute(c)
    await payoutAddressService.setPayoutAddress(c.buyer.id, 'BTC', testnetAddress(`${c.escrow.id}-f1b`))
    const r = ruling(dispute.id, c.escrow.id, 'RELEASE')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })
    expect((await commitAuthoritativeDisputeRuling(
      { id: dispute.id, escrowId: c.escrow.id, status: row.status, appealRound: 0 }, r.payload, r.signature,
      Buffer.from(arbiterKeypair.publicKey).toString('hex'), '100000', 'BTC', c.buyer.id, c.seller.id,
    )).committed).toBe(true)
    jest.spyOn(guard, 'assertTranslationMatchesOutcome').mockImplementationOnce(() => { throw new Error('i239 F-1: forced translation mismatch') })
    const first = await reconcileMissingDispatch()
    expect(first.guardFailed.find((x) => x.escrowId === c.escrow.id)).toBeDefined()
    const [retired] = await retirements(c.escrow.id)
    expect(retired).toMatchObject({ pendingOperationId: c.round.id, reason: 'SUPERSEDED_BY_RULING' })
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { id: retired.supersedingPendingOperationId! } })).toBeNull()
    expect(await liveRound(c.escrow.id)).toBeNull()
    const second = await reconcileMissingDispatch()
    expect(second.resumed.find((x) => x.escrowId === c.escrow.id)).toBeDefined()
    const next = (await liveRound(c.escrow.id))!
    expect(next.id).not.toBe(retired.supersedingPendingOperationId)
    expect(await retirements(c.escrow.id)).toHaveLength(1)
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'DISPUTED', txReleaseId: null })
  })

  it('T9 (C4): recovery of a committed ruling whose dispatch never persisted supersedes the cooperative round', async () => {
    pg.requirePostgres('T9 C4')
    const c = await cooperative('t9-c4')
    await sign(c, c.buyer.id)
    const dispute = await raiseDispute(c)
    await payoutAddressService.setPayoutAddress(c.buyer.id, 'BTC', testnetAddress(`${c.escrow.id}-c4b`))
    const r = ruling(dispute.id, c.escrow.id, 'RELEASE')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })
    const committed = await commitAuthoritativeDisputeRuling(
      { id: dispute.id, escrowId: c.escrow.id, status: row.status, appealRound: 0 }, r.payload, r.signature,
      Buffer.from(arbiterKeypair.publicKey).toString('hex'), '100000', 'BTC', c.buyer.id, c.seller.id,
    )
    expect(committed.committed).toBe(true)
    const report = await reconcileMissingDispatch()
    expect(report.resumed.find((x) => x.escrowId === c.escrow.id)).toBeDefined()
    const next = (await liveRound(c.escrow.id))!
    expect(next.disputeId).toBe(dispute.id)
    expect((await retirements(c.escrow.id))[0]).toMatchObject({ pendingOperationId: c.round.id, reason: 'SUPERSEDED_BY_RULING', supersedingPendingOperationId: next.id })
  })

  it('T10: opening a dispute against the last signature has one winner; a cooperative round takes no signature once DISPUTED', async () => {
    pg.requirePostgres('T10')
    const c = await cooperative('t10')
    await sign(c, c.buyer.id)
    const release = await holdEscrowLock(c.escrow.id)
    const opening = track(outcomeOf(getDisputeService().raiseDispute(c.trade.id, c.buyer.id, 'race')))
    await untilWaiting(1)
    const last = track(outcomeOf(escrowService.submitTransactionSignature(c.escrow.id, c.seller.id, signRound(c.round.unsignedPsbtBase64, c.sellerKey))))
    await untilWaiting(2)
    await release()
    const [opened, signed] = await Promise.all([opening, last])
    expect(opened.ok).toBe(true)
    expect(signed).toEqual({ ok: false, err: expect.stringMatching(/DISPUTED: its cooperative release round accepts no further signatures/) })
    expect((await liveRound(c.escrow.id))!.signatures).toHaveLength(1)
  })

  it('T15 (A-1): the arbiter calling initiate-* directly never supersedes; a forged grant is refused; no route imports the grant issuer', async () => {
    pg.requirePostgres('T15')
    const c = await cooperative('t15')
    await sign(c, c.buyer.id)
    await raiseDispute(c) // OPENED, no ruling
    await payoutAddressService.setPayoutAddress(c.seller.id, 'BTC', testnetAddress('t15-seller'))
    // Exactly what POST /initiate-release and /initiate-refund do (settlement.routes.ts): no grant.
    await expect(escrowService.initiateRelease(c.escrow.id, undefined, ARBITER_ID)).rejects.toThrow(/already has a pending release transaction/)
    await expect(escrowService.initiateRefund(c.escrow.id, ARBITER_ID)).rejects.toThrow(/already has a pending release transaction/)
    // A structural copy of a grant is not a grant.
    const forged = { disputeId: 'd', appealRound: 0, arbiterId: ARBITER_ID, ruling: 'RELEASE', authoritySignature: 's', authorityIssuedAt: new Date() }
    await expect(escrowService.initiateRelease(c.escrow.id, undefined, ARBITER_ID, forged as never)).rejects.toThrow(/not issued by the ruling dispatch path/)
    // A genuine grant for a ruling that is not committed is refused under the lock.
    const dispute = (await prisma.dispute.findFirstOrThrow({ where: { escrowId: c.escrow.id } }))
    const stale = dispatch.issueRulingSupersessionGrant({ ...dispute, status: 'RESOLVED', ruling: 'RELEASE', arbiterId: ARBITER_ID })
    await expect(escrowService.initiateRelease(c.escrow.id, undefined, ARBITER_ID, stale)).rejects.toThrow(/no longer matches the committed ruling/)
    expect((await liveRound(c.escrow.id))!.id).toBe(c.round.id)
    expect(await retirements(c.escrow.id)).toHaveLength(0)

    const fs = require('fs')
    const path = require('path')
    const dir = path.join(__dirname, '../../src')
    const routes: string[] = []
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e: any) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.routes.ts') && routes.push(path.join(d, e.name)))
    walk(dir)
    expect(routes.length).toBeGreaterThan(3)
    for (const file of routes) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/issueRulingSupersessionGrant|RulingSupersessionGrant/)
  })

  it('T11 (GK B1): a hostile co-signer cannot lock the round with a high-S or malformed signature; the honest seller still cancels', async () => {
    pg.requirePostgres('T11 B1')
    const bitcoin = require('bitcoinjs-lib')
    const { NETWORK } = require('./pendingRoundLifecycleHarness')
    const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    const c = await cooperative('t11-b1', 'refund') // requires [seller, buyer]
    await sign(c, c.seller.id)
    const reshape = (edit: (der: Buffer) => Buffer) => {
      const psbt = bitcoin.Psbt.fromBase64(signRound(c.round.unsignedPsbtBase64, c.buyerKey), { network: NETWORK })
      psbt.data.inputs[0].partialSig[0].signature = edit(Buffer.from(psbt.data.inputs[0].partialSig[0].signature))
      return psbt.toBase64()
    }
    const highS = reshape((der) => {
      const { signature, hashType } = bitcoin.script.signature.decode(der)
      const s = BigInt('0x' + Buffer.from(signature.subarray(32)).toString('hex'))
      return bitcoin.script.signature.encode(Buffer.concat([Buffer.from(signature.subarray(0, 32)), Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex')]), hashType)
    })
    const malformed = reshape((der) => { der[0] = 0x31; return der })
    for (const [submitted, reason] of [[highS, /not low-S/], [malformed, /not a valid DER signature/]] as const) {
      const err = await escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, submitted).then(() => null, (e: any) => e)
      expect(err?.message).toMatch(reason)
      expect(err?.statusCode).toBe(409) // a domain refusal (EscrowError), never a 500
      const live = (await liveRound(c.escrow.id))!
      expect(live.signatures.map((s) => s.participantId)).toEqual([c.seller.id]) // nothing written
    }
    expect(chain.broadcasts).toEqual([])
    // The round is still cancellable: the honest seller is not locked in.
    expect(await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).toMatchObject({ outcome: 'CANCELLED' })
    expect(await retirements(c.escrow.id)).toHaveLength(1)
  })

  // ─── T11: submit refuses what does not belong to the live round (real PSBTs) ─────
  it('T11: submit refuses another generation, another transaction, a non-ALL sighash and the wrong key, before writing', async () => {
    pg.requirePostgres('T11')
    const bitcoin = require('bitcoinjs-lib')
    const { NETWORK } = require('./pendingRoundLifecycleHarness')
    const c = await cooperative('t11')
    const other = await cooperative('t11-other')
    const none = (() => {
      const psbt = bitcoin.Psbt.fromBase64(c.round.unsignedPsbtBase64, { network: NETWORK })
      psbt.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_NONE })
      psbt.signInput(0, c.buyerKey, [bitcoin.Transaction.SIGHASH_NONE])
      return psbt.toBase64()
    })()
    const attempts: Array<[string, string, RegExp, string?]> = [
      ['another transaction', signRound(other.round.unsignedPsbtBase64, other.buyerKey), /does not sign this round/],
      ['SIGHASH_NONE', none, /SIGHASH_ALL/],
      ['the wrong key', signRound(c.round.unsignedPsbtBase64, c.sellerKey), /registered key/],
      ['another generation id', signRound(c.round.unsignedPsbtBase64, c.buyerKey), /live round is/, other.round.id],
    ]
    for (const [, psbt, error, generation] of attempts) {
      await expect(escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, psbt, generation)).rejects.toThrow(error)
    }
    expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: c.round.id } })).toBe(0)
    // The legitimate signature, with the right generation id, is stored as the server copy plus that one signature.
    await sign(c, c.buyer.id, { pendingTransactionId: c.round.id })
    expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: c.round.id } })).toBe(1)
  })

  // ─── B / C-2: external completion ─────────────────────────────────────────────────
  /** A cooperative round the seller signed in Sails and the buyer completed and broadcast on its own. */
  async function completedOutside(label: string, kind: 'release' | 'refund' = 'release') {
    const c = await cooperative(label, kind)
    const sellerStored = await sign(c, c.seller.id)
    const spend = completeOutsideSails(c.round.unsignedPsbtBase64, [sellerStored, signRound(c.round.unsignedPsbtBase64, c.buyerKey)])
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    chain.hex.set(spend.txid, spend.hex)
    return { c, spend }
  }

  it('B: a confirmed external completion (release and refund) converges once, through the existing economic path, with a true persisted note', async () => {
    pg.requirePostgres('B converge')
    for (const kind of ['release', 'refund'] as const) {
      const { c, spend } = await completedOutside(`b-${kind}`, kind)
      chain.confirmed.add(spend.txid)
      const repository = require('../../src/modules/open-settlement/escrow-repository').escrowRepository
      const write = jest.spyOn(repository, 'updateSignatureCollectionResult')
      const report = await tick()
      // Written through the write-once primitive, bound to this exact live operation, inside the claim's transaction.
      expect(write).toHaveBeenCalledWith(c.escrow.id, expect.objectContaining({ txReleaseId: spend.txid }), expect.objectContaining({ tx: expect.anything(), operation: { pendingOperationId: c.round.id } }))
      write.mockRestore()
      expect(report.externallyCompleted).toContainEqual({ escrowId: c.escrow.id, txId: spend.txid })
      const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })
      expect(escrow).toMatchObject({ status: kind === 'release' ? 'COMPLETED' : 'REFUNDED', txReleaseId: spend.txid })
      const events = await prisma.escrowEvent.findMany({ where: { escrowId: c.escrow.id, toStatus: escrow.status } })
      expect(events).toHaveLength(1)
      expect(events[0].note).toMatch(/^Completed externally: transaction [0-9a-f]{64} was broadcast outside Sails/)
      expect(events[0].note).not.toMatch(/crash/)
      // No authorization was fabricated, nothing was broadcast by Sails, the round was cleaned up.
      expect(await prisma.capabilityExecutionAuthorization.count({ where: { pendingOperationId: c.round.id } })).toBe(0)
      expect(await prisma.economicDispositionAuthorization.count({ where: { pendingOperationId: c.round.id } })).toBe(0)
      expect(chain.broadcasts).toEqual([])
      expect(await liveRound(c.escrow.id)).toBeNull()
      // Idempotent: another tick changes nothing.
      const again = await tick()
      expect(again.externallyCompleted.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
      expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: escrow.status } })).toBe(1)
    }
  })

  it('C-2: the mempool never authorizes a claim; a spend that vanishes before confirming leaves nothing behind', async () => {
    pg.requirePostgres('C-2 mempool')
    const { c, spend } = await completedOutside('c2-mempool')
    chain.mempool.add(spend.txid)
    const report = await tick()
    expect(report.externalSpendPendingConfirmation).toContain(c.escrow.id)
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'PAYMENT_PENDING', txReleaseId: null })
    chain.mempool.clear()
    chain.spentBy.clear() // reorged out / evicted
    const after = await tick()
    expect(after.externalSpendPendingConfirmation).not.toContain(c.escrow.id)
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'PAYMENT_PENDING', txReleaseId: null })
  })

  it('C-2: a crash before the commit rolls claim and result back together; the next tick converges', async () => {
    pg.requirePostgres('C-2 crash before commit')
    const { c, spend } = await completedOutside('c2-crash-before')
    chain.confirmed.add(spend.txid)
    const repository = require('../../src/modules/open-settlement/escrow-repository').escrowRepository
    const realWrite = repository.updateSignatureCollectionResult.bind(repository)
    // The result IS written, then the process dies before the transaction commits: claim and result roll back together.
    jest.spyOn(repository, 'updateSignatureCollectionResult').mockImplementationOnce(async (...args: unknown[]) => {
      await (realWrite as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('process died before commit')
    })
    const first = await tick()
    expect(first.failed).toContainEqual({ escrowId: c.escrow.id, error: 'process died before commit' })
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'PAYMENT_PENDING', txReleaseId: null })
    const second = await tick()
    expect(second.externallyCompleted).toContainEqual({ escrowId: c.escrow.id, txId: spend.txid })
  })

  it('C-2: a crash after the commit, before the completion effects, is finished by PASS 2 without a second transition', async () => {
    pg.requirePostgres('C-2 crash after commit')
    const { c, spend } = await completedOutside('c2-crash-after')
    chain.confirmed.add(spend.txid)
    const fees = require('../../src/modules/open-settlement/fee-obligation.service').feeObligationService
    jest.spyOn(fees, 'recordObligationForEscrowSettlement').mockRejectedValueOnce(new Error('process died after commit'))
    const first = await tick()
    expect(first.failed).toContainEqual({ escrowId: c.escrow.id, error: 'process died after commit' })
    expect(first.externallyCompleted.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
    // Claim and result were already committed together: terminal WITH its txReleaseId, effects still owed.
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'COMPLETED', txReleaseId: spend.txid })
    expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: 'COMPLETED' } })).toBe(0)
    // The next tick's PASS 2 (which runs before the watch) finishes them, exactly once.
    const second = await tick()
    expect(second.completionEffectsRecovered.find((x) => x.escrowId === c.escrow.id)).toBeDefined()
    expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: 'COMPLETED' } })).toBe(1)
    const third = await tick()
    expect(third.completionEffectsRecovered.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
    expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: 'COMPLETED' } })).toBe(1)
  })

  it('C-2: a reorg after convergence is the existing release reorg sweep\'s (COMPLETED and REFUNDED)', async () => {
    pg.requirePostgres('C-2 reorg after')
    const { sweepMultisigReleaseReorgs } = require('../../src/modules/open-settlement/multisig-release-reorg-sweep')
    for (const kind of ['release', 'refund'] as const) {
      const { c, spend } = await completedOutside(`c2-reorg-${kind}`, kind)
      chain.confirmed.add(spend.txid)
      await tick()
      expect((await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).txReleaseId).toBe(spend.txid)
      expect((await sweepMultisigReleaseReorgs()).observedBaseline).toContain(c.escrow.id) // first confirmed observation
      chain.confirmed.delete(spend.txid)
      chain.spentBy.clear() // the spend is gone, the funding outpoint unspent again (World C)
      const swept = await sweepMultisigReleaseReorgs()
      expect(swept.requiresManualReview.find((x: { escrowId: string }) => x.escrowId === c.escrow.id)?.reason).toMatch(/disappeared/)
    }
  })

  it('B: proofs and state gate the convergence: wrong signer set, ever-disputed escrow, invalid transition, funding uncertain', async () => {
    pg.requirePostgres('B negatives')
    // A spend that is not this round (a different output) is AMBIGUOUS, never claimed.
    const ambiguous = await cooperative('b-ambiguous')
    chain.spentBy.set(`${ambiguous.funding}:0`, 'cd'.repeat(32))
    chain.confirmed.add('cd'.repeat(32))
    let report = await tick()
    expect(seen(report, ambiguous.escrow.id)).toMatchObject({ reason: expect.stringMatching(/^AMBIGUOUS/) })

    // A served transaction whose witness is not the round's required signers (lying explorer bytes) is not converged.
    const { c: lying, spend } = await completedOutside('b-lying')
    chain.confirmed.add(spend.txid)
    chain.hex.set(spend.txid, (await completedOutside('b-lying-other')).spend.hex)
    report = await tick()
    expect(seen(report, lying.escrow.id)).toMatchObject({ reason: expect.stringMatching(/not proven to be this round/) })
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: lying.escrow.id } })).txReleaseId).toBeNull()

    // A refund round completed while the escrow moved to PAYMENT_PENDING: PAYMENT_PENDING -> REFUNDED is not allowed.
    const { c: moved, spend: movedSpend } = await completedOutside('b-moved', 'refund')
    chain.confirmed.add(movedSpend.txid)
    await escrowService.markPaymentSent(moved.escrow.id, moved.buyer.id)
    report = await tick()
    expect(seen(report, moved.escrow.id)).toMatchObject({ reason: expect.stringMatching(/not an allowed transition/) })

    // Funding evidence uncertain: skipped and reported, nothing claimed.
    const { c: uncertain, spend: uSpend } = await completedOutside('b-uncertain')
    chain.confirmed.add(uSpend.txid)
    await prisma.escrowFundingEvidence.create({ data: { escrowId: uncertain.escrow.id, kind: 'REORGED_INVALIDATED', txid: uncertain.funding, vout: 0 } })
    report = await tick()
    expect(report.externalSpendFundingUncertain).toContain(uncertain.escrow.id)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: uncertain.escrow.id } })).txReleaseId).toBeNull()

    // An escrow that was ever disputed: its cooperative origin is not provable - manual review.
    const { c: disputed, spend: dSpend } = await completedOutside('b-disputed')
    chain.confirmed.add(dSpend.txid)
    await prisma.dispute.create({ data: { tradeId: disputed.trade.id, escrowId: disputed.escrow.id, openedBy: disputed.buyer.id, reason: 'an earlier dispute record' } })
    report = await tick()
    expect(seen(report, disputed.escrow.id)).toMatchObject({ reason: expect.stringMatching(/ADR-005/) })
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: disputed.escrow.id } })).txReleaseId).toBeNull()
  })

  it('B: a retired round executed outside Sails is manual review, never converged (the window after the outpoint read)', async () => {
    pg.requirePostgres('B retired')
    const c = await cooperative('b-retired')
    const sellerStored = await sign(c, c.seller.id)
    // The outpoint is read unspent, then the buyer broadcasts before the retirement commits.
    const realRetire = retirementModule.retireRound
    let spendTxid = ''
    jest.spyOn(retirementModule, 'retireRound').mockImplementationOnce(async (...args: Parameters<typeof realRetire>) => {
      const spend = completeOutsideSails(c.round.unsignedPsbtBase64, [sellerStored, signRound(c.round.unsignedPsbtBase64, c.buyerKey)])
      spendTxid = spend.txid
      chain.spentBy.set(`${c.funding}:0`, spend.txid)
      chain.confirmed.add(spend.txid)
      chain.hex.set(spend.txid, spend.hex)
      return realRetire(...args)
    })
    expect(await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))).toMatchObject({ outcome: 'CANCELLED' })
    const report = await tick()
    expect(report.requiresManualReview.find((x) => x.escrowId === c.escrow.id)?.reason).toMatch(new RegExp(`^RETIRED_ROUND_EXECUTED_EXTERNALLY: retired round ${c.round.id}.*${spendTxid}`))
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).txReleaseId).toBeNull()
    expect(report.externallyCompleted.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
  })

  it('§5 identical txid: a live round byte-identical to a retired one is the same instruction; the live round takes precedence', async () => {
    pg.requirePostgres('identical txid')
    const c = await cooperative('identical')
    const retiredSellerSignature = await sign(c, c.seller.id)
    await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))
    // Same destination, same fee: the replacement is the same transaction - retiring never revoked the old signature.
    await escrowService.initiateRelease(c.escrow.id, undefined, c.seller.id)
    const live = (await liveRound(c.escrow.id))!
    const { roundUnsignedTxid } = require('../../src/modules/open-settlement/multisig-round-proofs')
    const { NETWORK } = require('./pendingRoundLifecycleHarness')
    expect(roundUnsignedTxid(live.unsignedPsbtBase64, NETWORK)).toBe((await retirements(c.escrow.id))[0].unsignedTxid)
    const spend = completeOutsideSails(live.unsignedPsbtBase64, [retiredSellerSignature, signRound(live.unsignedPsbtBase64, c.buyerKey)])
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    chain.confirmed.add(spend.txid)
    chain.hex.set(spend.txid, spend.hex)
    const report = await tick()
    expect(report.externallyCompleted).toContainEqual({ escrowId: c.escrow.id, txId: spend.txid })
    expect(report.requiresManualReview.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).txReleaseId).toBe(spend.txid)
  })

  it('B: an external completion of a disputed (ruling) round is manual review: its dispute provenance is not dropped', async () => {
    pg.requirePostgres('B disputed round')
    const c = await cooperative('b-ruling')
    const dispute = await raiseDispute(c)
    await resolve(c, dispute.id, 'REFUND')
    const ruling = (await liveRound(c.escrow.id))!
    expect(ruling.disputeId).toBe(dispute.id)
    // A disputed refund is arbiter-presigned; the seller completes it outside Sails.
    const spend = completeOutsideSails(ruling.unsignedPsbtBase64, [signRound(ruling.unsignedPsbtBase64, c.sellerKey)])
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    chain.confirmed.add(spend.txid)
    chain.hex.set(spend.txid, spend.hex)
    const report = await tick()
    expect(seen(report, c.escrow.id)).toMatchObject({ reason: expect.stringMatching(/Disputed round .* dispute provenance/) })
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).txReleaseId).toBeNull()
  })

  it('watch: one page of at most 50 per tick, and an unreadable explorer claims nothing', async () => {
    pg.requirePostgres('watch bounds')
    const findMany = jest.spyOn(prisma.escrow, 'findMany')
    const c = await cooperative('watch')
    chain.outspendUnreadable = true
    const report = await tick()
    expect(report.externalSpendUnreadable).toContain(c.escrow.id)
    const watchCalls = findMany.mock.calls.filter(([args]: any[]) => args?.where?.OR?.[0]?.pendingTransaction)
    expect(watchCalls.length).toBe(1)
    expect((watchCalls[0][0] as any).take).toBe(50)
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'PAYMENT_PENDING', txReleaseId: null })
  })

  it('F-2: the production tick logs manual review (id + reason code), explorer blindness and held rounds - no free text, no PSBT', async () => {
    pg.requirePostgres('F-2 log')
    const { runSettlementReconcilerTick } = require('../../src/app')
    const logged = async () => {
      const log = { warn: jest.fn(), error: jest.fn() }
      await runSettlementReconcilerTick(log)
      return log.warn.mock.calls.map((x: any[]) => x[0]).find((e: any) => e.msg === 'Settlement reconciliation: held rounds, manual review or external-spend watch findings')
    }
    const ambiguous = await cooperative('f2-ambiguous')
    chain.spentBy.set(`${ambiguous.funding}:0`, 'ef'.repeat(32))
    chain.confirmed.add('ef'.repeat(32))
    const first = await logged()
    expect(first.requiresManualReview).toContainEqual({ escrowId: ambiguous.escrow.id, code: 'AMBIGUOUS' })
    chain.spentBy.clear()
    reconcile.resetExternalSpendCursor()
    chain.outspendUnreadable = true
    const second = await logged()
    expect(second.externalSpendUnreadable).toContain(ambiguous.escrow.id)
    for (const entry of [first, second]) {
      const text = JSON.stringify(entry)
      expect(text).not.toContain(ambiguous.round.unsignedPsbtBase64.slice(0, 40))
      expect(text).not.toMatch(/matches no round|was spent by/) // reasons are reduced to their code
    }
  })

  it('watch: 55 candidates - the second tick continues after the first 50, the third starts over (GK F-3/C)', async () => {
    pg.requirePostgres('watch pagination')
    const ids: string[] = []
    for (let i = 0; i < 55; i++) ids.push((await cooperative(`page-${i}`, 'refund')).escrow.id)
    const fundingOf = new Map((await prisma.escrow.findMany({ where: { id: { in: ids } }, select: { id: true, txLockId: true } })).map((e) => [e.id, e.txLockId]))
    const outpoints = [...ids].sort().map((id) => `${fundingOf.get(id)}:0`)
    const ticked = async () => { chain.outspendCalls.length = 0; await tick(); return [...chain.outspendCalls] }
    expect(await ticked()).toEqual(outpoints.slice(0, 50))
    expect(await ticked()).toEqual(outpoints.slice(50)) // the five beyond the first page are reached
    expect(await ticked()).toEqual(outpoints.slice(0, 50)) // an incomplete page restarts the scan
  }, 600_000)

  it('watch: never holds up recovery - at most once per 60 s by default, and a slow explorer stops it within its 15 s budget, resuming where it stopped', async () => {
    pg.requirePostgres('watch budget')
    const candidates = []
    for (let i = 0; i < 4; i++) candidates.push(await cooperative(`budget-${i}`))
    const outpoints = candidates.sort((a, b) => (a.escrow.id < b.escrow.id ? -1 : 1)).map((x) => `${x.funding}:0`)
    // Default interval: the first tick runs the watch, an immediate second one does not.
    await reconcile.reconcilePendingSettlements()
    expect(chain.outspendCalls).toEqual(outpoints)
    chain.outspendCalls.length = 0
    await reconcile.reconcilePendingSettlements()
    expect(chain.outspendCalls).toEqual([])
    // Each explorer read now "takes" 6 s: three fit in the 15 s budget, the fourth waits for the next tick.
    reconcile.resetExternalSpendCursor()
    let offset = 0
    const realNow = Date.now.bind(Date)
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const stub = global.fetch
    global.fetch = (async (url: unknown, init?: unknown) => {
      if (/\/outspend\//.test(String(url))) offset += 6_000
      return (stub as any)(url, init)
    }) as typeof fetch
    await tick()
    expect(chain.outspendCalls).toEqual(outpoints.slice(0, 3))
    chain.outspendCalls.length = 0
    await tick()
    expect(chain.outspendCalls[0]).toBe(outpoints[3])
  })

  // ─── R5: fully signed round on a disputed escrow ─────────────────────────────────────
  it('R5: a fully signed cooperative round on a disputed escrow is held (typed), never broadcast, never superseded; on-chain truth still converges', async () => {
    pg.requirePostgres('R5')
    const c = await cooperative('r5')
    await persistAllSignatures(c)
    await raiseDispute(c)
    const report = await tick()
    expect(report.heldIncompatibleRounds).toContainEqual({ escrowId: c.escrow.id, pendingTransactionId: c.round.id })
    expect(report.failed.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
    expect(chain.broadcasts).toEqual([])
    expect((await liveRound(c.escrow.id))!.id).toBe(c.round.id)
    expect(await retirements(c.escrow.id)).toHaveLength(0)
    // If its signers broadcast it, PASS 0 converges to that truth (UNKNOWN != FAILED).
    const spend = completeOutsideSails(c.round.unsignedPsbtBase64, (await liveRound(c.escrow.id))!.signatures.map((s) => s.signedPsbtBase64))
    chain.confirmed.add(spend.txid)
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    const after = await tick()
    expect(after.resumedUnclaimed.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: spend.txid, outcome: 'ALREADY_BROADCAST' })
  })

  // ─── GET exposure ─────────────────────────────────────────────────────────────────
  it('GET shape: no signed PSBT anywhere in the HTTP response; the service still has the full row', async () => {
    pg.requirePostgres('GET shape')
    const c = await cooperative('get')
    await sign(c, c.buyer.id)
    const full = await escrowService.getPendingTransaction(c.escrow.id)
    expect(full.signatures[0].signedPsbtBase64).toBeTruthy()
    const body = JSON.parse(JSON.stringify(toPendingTransactionResponse(full)))
    const keys: string[] = []
    const walk = (v: unknown) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x) } }
    walk(body)
    expect(keys).not.toContain('signedPsbtBase64')
    expect(JSON.stringify(body)).not.toContain(full.signatures[0].signedPsbtBase64)
    expect(body).toMatchObject({ id: c.round.id, unsignedPsbtBase64: c.round.unsignedPsbtBase64, requiredSigners: c.round.requiredSigners, signedBy: [{ participantId: c.buyer.id }] })
    expect(body.signatures).toBeUndefined()
  })

  // ─── the retirement table ─────────────────────────────────────────────────────────
  it('table: append-only (UPDATE, DELETE, TRUNCATE refused), CHECKs, RESTRICT FKs, unique ids, transactional rollback', async () => {
    pg.requirePostgres('table')
    const c = await cooperative('table')
    await escrowService.cancelPendingSignatureRound(c.escrow.id, c.round.id, asTrustedActor(c.seller.id))
    const [row] = await retirements(c.escrow.id)
    await expect(prisma.$executeRawUnsafe(`UPDATE escrow_pending_round_retirements SET reason = 'CANCELLED' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRawUnsafe(`DELETE FROM escrow_pending_round_retirements WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRawUnsafe('TRUNCATE escrow_pending_round_retirements')).rejects.toThrow(/append-only/)

    const base = { ...row, id: randomUUID(), pendingOperationId: randomUUID(), recordHash: 'f'.repeat(64) } as Record<string, unknown>
    delete base.retiredAt
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ['fully signed', { signedBy: row.requiredSigners }, /signers_check/],
      ['signer outside the round', { signedBy: ['someone-else'] }, /signers_check/],
      ['unknown reason', { reason: 'REVOKED' }, /reason_check/],
      ['incoherent supersession', { reason: 'SUPERSEDED_BY_RULING' }, /reason_coherence_check/],
      ['not a hash', { unsignedTxid: 'xyz' }, /hex_check/],
      ['negative vout', { fundingVout: -1 }, /vout_check/],
      ['unknown kind', { kind: 'steal' }, /kind_check/],
      ['duplicate round', { pendingOperationId: row.pendingOperationId }, /Unique constraint|unique/i],
      ['duplicate record hash', { recordHash: row.recordHash }, /Unique constraint|unique/i],
    ]
    for (const [, override, error] of bad) {
      await expect(prisma.escrowPendingRoundRetirement.create({ data: { ...base, ...override } as never })).rejects.toThrow(error)
    }
    const fks = await prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
      SELECT conname::text AS conname, confdeltype::text AS confdeltype FROM pg_constraint WHERE conrelid = 'escrow_pending_round_retirements'::regclass AND contype = 'f' ORDER BY conname`
    expect(fks).toEqual([
      { conname: 'escrow_pending_round_retirements_disputeId_fkey', confdeltype: 'r' },
      { conname: 'escrow_pending_round_retirements_escrowId_fkey', confdeltype: 'r' },
    ])
    // Transactional: a retirement inserted in a transaction that then fails leaves nothing.
    await expect(prisma.$transaction(async (tx) => {
      await tx.escrowPendingRoundRetirement.create({ data: { ...base, recordHash: 'e'.repeat(64) } as never })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await prisma.escrowPendingRoundRetirement.count({ where: { pendingOperationId: base.pendingOperationId as string } })).toBe(0)
  })
})
