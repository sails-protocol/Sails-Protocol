// #239 (R3) — real-Postgres proof of the pending-signature round lifecycle on real MULTISIG escrows.
//
// The trap: a cooperative round left incomplete by a non-cooperating signer. Once a dispute exists, that
// round can never execute (ADR-005, authorizeDisputedPendingExecution()), yet as the escrow's one pending
// round it blocked the ruling's dispatch - live (initiate*) and C4 recovery - forever.
// The lifecycle: the ruling's dispatch supersedes such a round - if and only if it is a cooperative round
// that is not fully signed - inside its own escrow-locked transaction. A fully signed round is never
// superseded (it may already have been submitted; C8 decides it from the chain). No timer is involved.
//
// Interleavings are forced with the real escrow-scoped advisory lock, as in the #244 suite. "Restart"
// means an independent module graph with its own PrismaClient (jest.isolateModules), not an OS crash.
import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { ECPairFactory } from 'ecpair'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)

function testnetAddress(label: string): string {
  const pubkey = Buffer.from(ecc.pointFromScalar(createHash('sha256').update(label).digest(), true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.testnet }).address!
}

describe('#239 pending-signature round lifecycle — real Postgres', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let commitAuthoritativeDisputeRuling: typeof import('../../src/modules/open-settlement/dispute-outcome').commitAuthoritativeDisputeRuling
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let DISPATCH_RECOVERY_BATCH: number
  let restarted: {
    escrowService: typeof escrowService
    reconcileMissingDispatch: typeof reconcileMissingDispatch
    prisma: PrismaClient
    redis: { quit(): Promise<unknown> }
  } | undefined

  const ARBITER_ID = 'r3-239-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  // #235 R7G-B2A — signatures are verified before they are accepted, so this suite signs for real: each signer
  // signs the round that is pending when it calls (the round it "read").
  const ECPair = ECPairFactory(ecc)
  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('r3-239-buyer').digest(), { network: bitcoin.networks.testnet })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('r3-239-seller').digest(), { network: bitcoin.networks.testnet })
  const BUYER_PUBKEY = Buffer.from(buyerKey.publicKey).toString('hex')
  const SELLER_PUBKEY = Buffer.from(sellerKey.publicKey).toString('hex')
  async function signPending(escrowId: string, key: typeof buyerKey, db: { escrowPendingTransaction: PrismaClient['escrowPendingTransaction'] } = prisma): Promise<string> {
    const round = await db.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId } })
    const copy = bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: bitcoin.networks.testnet })
    copy.signInput(0, key)
    return copy.toBase64()
  }
  let realFetch: typeof fetch

  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'r3-239-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ reconcileMissingDispatch, DISPATCH_RECOVERY_BATCH } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      restarted = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        reconcileMissingDispatch: require('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'R3 #239 Test Arbiter' },
    })
  })

  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch })

  // This suite's own escrows. A fully signed, unclaimed MULTISIG round is exactly what settlement
  // reconciliation PASS 0 (C8) scans for, and later suites in the lane assume that queue holds only their
  // own rows - so the rounds this suite leaves fully signed (T1, T3b, T11) are removed when it ends, with
  // their #240 attempt rows. Nothing it did not create is touched.
  const createdEscrowIds: string[] = []

  afterAll(async () => {
    if (dbAvailable) {
      const rounds = await prisma.escrowPendingTransaction.findMany({
        where: { escrowId: { in: createdEscrowIds } },
        select: { id: true, requiredSigners: true, signatures: { select: { participantId: true } } },
      })
      const fullySigned = rounds.filter((r) => r.requiredSigners.every((id) => r.signatures.some((s) => s.participantId === id))).map((r) => r.id)
      await prisma.signatureCollectionFinalizationAttempt.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.escrowPendingTransaction.deleteMany({ where: { id: { in: fullySigned } } })
      await prisma.$disconnect()
      if (restarted) {
        await restarted.prisma.$disconnect()
        await restarted.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  /**
   * A funded MULTISIG escrow whose seller opened a cooperative REFUND round (required: seller, buyer),
   * with `sellerSigned` deciding whether the seller already signed it; then, optionally, the buyer raises
   * a dispute (#238) and the arbiter's RELEASE ruling commits durably - dispatch not yet run.
   */
  async function fixture(suffix: string, opts: { sellerSigned: boolean; disputed: boolean; ruled: boolean; completedBeforeDispute?: boolean }) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    mockExplorerForUtxo(createHash('sha256').update(`r3-239-${suffix}-${Date.now()}-${Math.random()}`).digest('hex'), 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', testnetAddress(`r3-239-${suffix}-seller`))
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`r3-239-${suffix}-buyer`))

    const cooperative = await escrowService.initiateRefund(escrow.id, seller.id)
    expect(cooperative.requiredSigners).toEqual([seller.id, buyer.id])
    if (opts.sellerSigned) await escrowService.submitTransactionSignature(escrow.id, seller.id, await signPending(escrow.id, sellerKey))
    // #239D H1: the buyer completes the set before any dispute. Its execution starts and fails at the
    // provider (this file's explorer stand-in cannot accept a broadcast), so the status reverts and the fully
    // signed round remains - with its pre-dispute bilateral authority marked.
    if (opts.completedBeforeDispute) {
      await expect(escrowService.submitTransactionSignature(escrow.id, buyer.id, await signPending(escrow.id, buyerKey))).rejects.toThrow()
    }

    let disputeId: string | undefined
    let buyerDestination: string | undefined
    if (opts.disputed) {
      const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `#239 ${suffix}`)
      expect(dispute.arbiterId).toBe(ARBITER_ID)
      disputeId = dispute.id
      if (opts.ruled) {
        const payload: AuthorityDecisionPayload = { disputeId, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt: new Date().toISOString() }
        const committed = await commitAuthoritativeDisputeRuling(
          { id: disputeId, escrowId: escrow.id, status: 'OPENED', appealRound: 0 },
          payload, signAuthorityDecision(payload, arbiterKeypair.secretKey), arbiterPublicKeyHex, '100000', 'BTC', buyer.id, seller.id,
        )
        if (!committed.committed) throw new Error(`ruling did not commit: ${committed.reason}`)
        buyerDestination = committed.destinations.find((d) => d.beneficiary === buyer.id)!.destination
      }
    }
    return { escrowId: escrow.id, tradeId: trade.id, cooperativeRoundId: cooperative.id, buyerId: buyer.id, sellerId: seller.id, disputeId, buyerDestination }
  }

  /** The ruling's live dispatch, exactly as applyRulingCoreAuthoritative() makes it after the ruling commits. */
  const dispatchRuling = (f: { escrowId: string; buyerDestination?: string }, service = escrowService) =>
    service.initiateRelease(f.escrowId, f.buyerDestination!, ARBITER_ID)

  const roundsOf = async (escrowId: string, client: PrismaClient = prisma) =>
    client.escrowPendingTransaction.findMany({
      where: { escrowId },
      select: { id: true, kind: true, disputeId: true, signatures: { select: { participantId: true, signedPsbtBase64: true } } },
    })
  const signaturesOfRound = (roundId: string, client: PrismaClient = prisma) => client.escrowTransactionSignature.count({ where: { pendingTxId: roundId } })

  // ── deterministic interleaving harness (as in the #244 suite) ───────────────────────────────────
  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1000; i++) {
      if ((await waitingOnAdvisoryLocks()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waitingOnAdvisoryLocks()}`)
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
    return async () => { release(); await done }
  }
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e: e.message }))

  // ── T1: the trap ────────────────────────────────────────────────────────────────────────────────

  it('T1 the trap: a partially signed cooperative round on a disputed escrow can never execute, and the pre-#239 dispatch predicate treated it as a dispatch', async () => {
    pg.requirePostgres('trap')
    const f = await fixture('t1', { sellerSigned: true, disputed: true, ruled: true })

    // The dead round cannot even be completed any more: #239D refuses cooperative signatures once a dispute
    // exists (it stays partial, so a ruling may supersede it).
    const completed = await settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, await signPending(f.escrowId, buyerKey)))
    expect(completed).toEqual({ ok: false, e: expect.stringMatching(/dispute authority took over before its cooperative refund round/) })
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(1)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).status).toBe('DISPUTED')

    // Before #239, C4 recovery skipped every escrow with ANY pending row (its predicate, as it was):
    const g = await fixture('t1-predicate', { sellerSigned: true, disputed: true, ruled: true })
    const [{ n: oldPredicate }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM disputes d WHERE d."escrowId" = ${g.escrowId} AND d.status = 'RESOLVED'
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId")`
    expect(oldPredicate).toBe(0) // never a C4 candidate: the ruling could not be dispatched by recovery either
  })

  // ── T2: supersession (live dispatch and C4 recovery) ───────────────────────────────────────────

  it('T2 the live ruling (resolveDispute) dispatches over the dead cooperative round: one new arbitrated round, no old round, no old signature', async () => {
    pg.requirePostgres('live supersession')
    const f = await fixture('t2', { sellerSigned: true, disputed: true, ruled: false })
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: f.disputeId!, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }

    const resolved = await getDisputeService().resolveDispute(f.disputeId!, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt)

    expect(resolved).toMatchObject({ status: 'RESOLVED', ruling: 'RELEASE' })
    const rounds = await roundsOf(f.escrowId)
    expect(rounds).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }])
    expect(rounds[0].id).not.toBe(f.cooperativeRoundId)
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(0)
    const ruling = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: rounds[0].id } })
    expect(ruling.requiredSigners).toEqual([f.buyerId]) // the ruling's own signer set (arbiter pre-signed), not the cooperative one
  })

  it('T2b C4 recovery resumes a committed ruling over a dead cooperative round (zero signatures)', async () => {
    pg.requirePostgres('C4 supersession')
    const f = await fixture('t2b', { sellerSigned: false, disputed: true, ruled: true })

    // The shared database keeps other suites' C4 candidates: sweep within the queue's own starvation bound
    // (ceil(queued / batch), counted with the same predicate as claimCandidates()), as m9rDispatchRecovery does.
    const [{ queued }] = await prisma.$queryRaw<Array<{ queued: number }>>`
      SELECT count(*)::int AS queued FROM disputes d JOIN escrows e ON e.id = d."escrowId"
      WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG' AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
          AND (p."disputeId" IS NOT NULL OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))
        AND EXISTS (SELECT 1 FROM semantic_transition_records r WHERE r."interactionId" = d."escrowId"
          AND r."transitionType" = 'escrow.dispute.rule' AND r."appealRound" = d."appealRound" AND r."outcomeContent" IS NOT NULL)`
    let resumed = false
    let claimed = false
    for (let sweep = 0; sweep <= Math.ceil(queued / DISPATCH_RECOVERY_BATCH) && !claimed; sweep++) {
      const report = await reconcileMissingDispatch()
      claimed = report.claimed.includes(f.escrowId)
      resumed = report.resumed.some((r) => r.escrowId === f.escrowId)
      if (claimed) expect({ failed: report.failed.filter((x) => x.escrowId === f.escrowId), notEligible: report.notEligible.filter((x) => x.escrowId === f.escrowId) }).toEqual({ failed: [], notEligible: [] })
    }
    expect(claimed).toBe(true)
    expect(resumed).toBe(true)
    const rounds = await roundsOf(f.escrowId)
    expect(rounds).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }])
    expect(rounds[0].id).not.toBe(f.cooperativeRoundId)
  })

  // ── T3 / T4: races with a signer ───────────────────────────────────────────────────────────────

  it('T3a a cooperative signature racing the dispatch (serialized first) is refused - the dispute already took authority - and the dead round is superseded', async () => {
    pg.requirePostgres('partial signer wins')
    const f = await fixture('t3a', { sellerSigned: false, disputed: true, ruled: true })
    const release = await holdEscrowLock(f.escrowId)

    const signer = settle(escrowService.submitTransactionSignature(f.escrowId, f.sellerId, await signPending(f.escrowId, sellerKey)))
    await untilWaiting(1)
    const dispatch = settle(dispatchRuling(f))
    await untilWaiting(2)
    await release()

    expect(await signer).toEqual({ ok: false, e: expect.stringMatching(/dispute authority took over/) })
    const dispatched = await dispatch
    expect(dispatched.ok).toBe(true)
    expect(await roundsOf(f.escrowId)).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }])
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(0)
  })

  it('T3b a completing signature racing the dispatch (serialized first) is refused too: the round never becomes complete after the dispute, and is superseded', async () => {
    pg.requirePostgres('completing signer wins')
    const f = await fixture('t3b', { sellerSigned: true, disputed: true, ruled: true })
    const release = await holdEscrowLock(f.escrowId)

    const signer = settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, await signPending(f.escrowId, buyerKey)))
    await untilWaiting(1)
    const dispatch = settle(dispatchRuling(f))
    await untilWaiting(2)
    await release()

    expect(await signer).toEqual({ ok: false, e: expect.stringMatching(/dispute authority took over/) }) // H2: never completed
    expect((await dispatch).ok).toBe(true)
    expect(await roundsOf(f.escrowId)).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }])
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(0)
  })

  it('T4 the dispatch commits first: the signer that read the old round fails closed and never signs into the ruling round', async () => {
    pg.requirePostgres('dispatch wins')
    const f = await fixture('t4', { sellerSigned: true, disputed: true, ruled: true })
    const release = await holdEscrowLock(f.escrowId)

    const dispatch = settle(dispatchRuling(f))
    await untilWaiting(1)
    const oldRoundSignature = await signPending(f.escrowId, buyerKey) // the signer read the cooperative round
    const signer = settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, oldRoundSignature))
    await untilWaiting(2) // the signer read the cooperative round
    await release()

    const dispatched = await dispatch
    expect(dispatched.ok).toBe(true)
    expect(await signer).toEqual({ ok: false, e: expect.stringMatching(/^Escrow \S+'s pending refund \S+ no longer exists \(cleaned up or replaced\) — signature not accepted/) })
    const rounds = await roundsOf(f.escrowId)
    expect(rounds).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }]) // nothing entered the new generation
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(0)
  })

  // ── T5 / T6: restart ──────────────────────────────────────────────────────────────────────────

  it('T5 restart before supersession: an independent process decides from durable truth alone and supersedes the dead round', async () => {
    pg.requirePostgres('restart before')
    const f = await fixture('t5', { sellerSigned: true, disputed: true, ruled: true })
    const fresh = restarted!

    expect((await roundsOf(f.escrowId, fresh.prisma)).map((r) => ({ id: r.id, signatures: r.signatures.length }))).toEqual([{ id: f.cooperativeRoundId, signatures: 1 }])
    const ruling = await dispatchRuling(f, fresh.escrowService)
    expect(await roundsOf(f.escrowId, fresh.prisma)).toEqual([{ id: ruling.id, kind: 'release', disputeId: f.disputeId, signatures: [] }])
  })

  it('T6 restart after supersession: only the ruling round exists, and an old-round signer from the fresh process is refused', async () => {
    pg.requirePostgres('restart after')
    const f = await fixture('t6', { sellerSigned: true, disputed: true, ruled: true })
    const ruling = await dispatchRuling(f)
    const fresh = restarted!

    expect(await roundsOf(f.escrowId, fresh.prisma)).toEqual([{ id: ruling.id, kind: 'release', disputeId: f.disputeId, signatures: [] }])
    // The seller is not a signer of the ruling round; the old round is gone.
    await expect(fresh.escrowService.submitTransactionSignature(f.escrowId, f.sellerId, await signPending(f.escrowId, sellerKey, fresh.prisma))).rejects.toThrow(/is not one of the required signers/)
    expect(await signaturesOfRound(ruling.id, fresh.prisma)).toBe(0)
  })

  // ── T7: dispute opening around the round ───────────────────────────────────────────────────────

  it('T7 opening the dispute leaves the cooperative round untouched; it is superseded only by the ruling dispatch, never before', async () => {
    pg.requirePostgres('dispute boundary')
    const f = await fixture('t7', { sellerSigned: true, disputed: true, ruled: false })

    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).status).toBe('DISPUTED')
    expect((await roundsOf(f.escrowId)).map((r) => ({ id: r.id, signatures: r.signatures.length }))).toEqual([{ id: f.cooperativeRoundId, signatures: 1 }])
    // A cooperative initiate (no ruling authority) while disputed is refused outright - never a replacement path.
    await expect(escrowService.initiateRefund(f.escrowId, f.sellerId)).rejects.toThrow(/not the current assigned arbiter/)
    expect((await roundsOf(f.escrowId)).map((r) => r.id)).toEqual([f.cooperativeRoundId])
  })

  // ── T8: two nodes ───────────────────────────────────────────────────────────────────────────────

  it('T8 two independent nodes dispatch the same ruling at once: one supersession, one ruling round, the other refused', async () => {
    pg.requirePostgres('two nodes')
    const f = await fixture('t8', { sellerSigned: true, disputed: true, ruled: true })

    const [a, b] = await Promise.all([settle(dispatchRuling(f)), settle(dispatchRuling(f, restarted!.escrowService))])

    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    const loser = [a, b].find((r) => !r.ok) as { ok: false; e: string }
    expect(loser.e).toMatch(/already has a pending release transaction awaiting signatures/)
    expect(await roundsOf(f.escrowId)).toEqual([{ id: expect.any(String), kind: 'release', disputeId: f.disputeId, signatures: [] }])
  })

  // ── T9–T13 ─────────────────────────────────────────────────────────────────────────────────────

  it('T9/T10 an arbitrated round is never superseded, and the superseded round can cause nothing afterwards', async () => {
    pg.requirePostgres('no second supersession')
    const f = await fixture('t9', { sellerSigned: true, disputed: true, ruled: true })
    const ruling = await dispatchRuling(f)

    await expect(dispatchRuling(f)).rejects.toThrow(/already has a pending release transaction awaiting signatures/)
    expect((await roundsOf(f.escrowId)).map((r) => r.id)).toEqual([ruling.id])
    // The old round's signers can contribute nothing: the buyer's signature now belongs to the ruling round only.
    const rulingSignature = await signPending(f.escrowId, buyerKey)
    const signed = await escrowService.submitTransactionSignature(f.escrowId, f.buyerId, rulingSignature).then(() => 'accepted', (e: Error) => e.message)
    expect(await roundsOf(f.escrowId)).toEqual([{ id: ruling.id, kind: 'release', disputeId: f.disputeId, signatures: [{ participantId: f.buyerId, signedPsbtBase64: rulingSignature }] }])
    expect(signed).not.toMatch(/no longer exists/)
    expect(await signaturesOfRound(f.cooperativeRoundId)).toBe(0)
  })

  it('T11/T12 a fully signed cooperative round (possibly submitted / UNKNOWN) is never superseded, by the live dispatch or by C4', async () => {
    pg.requirePostgres('fully signed preserved')
    // The only way a cooperative round is fully signed on a disputed escrow (#239D): completed before the dispute.
    const f = await fixture('t11', { sellerSigned: true, completedBeforeDispute: true, disputed: true, ruled: true })
    // Durable evidence that a submission may have happened (the #240 attempt row) - preserved untouched.
    await prisma.signatureCollectionFinalizationAttempt.create({ data: { escrowId: f.escrowId, pendingTxId: f.cooperativeRoundId, kind: 'refund', status: 'SUBMISSION_UNKNOWN' } })

    await expect(dispatchRuling(f)).rejects.toThrow(/is fully signed — it may already have been submitted, so a ruling never supersedes it/)
    const [{ n: c4Candidate }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM escrows e WHERE e.id = ${f.escrowId}
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = e.id
          AND (p."disputeId" IS NOT NULL OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))`
    expect(c4Candidate).toBe(0) // C4 does not treat it as dead either

    const rounds = await roundsOf(f.escrowId)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({ id: f.cooperativeRoundId, disputeId: null })
    expect(rounds[0].signatures).toHaveLength(2)
    expect(await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: f.escrowId } })).toMatchObject({ status: 'SUBMISSION_UNKNOWN', pendingTxId: f.cooperativeRoundId })
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).status).toBe('DISPUTED')
  })

  it('T13 no cooperative replacement: while not disputed, a second cooperative round is refused and the first is untouched', async () => {
    pg.requirePostgres('no cooperative replacement')
    const f = await fixture('t13', { sellerSigned: true, disputed: false, ruled: false })

    await expect(escrowService.initiateRefund(f.escrowId, f.sellerId)).rejects.toThrow(/already has a pending refund transaction awaiting signatures/)
    expect((await roundsOf(f.escrowId)).map((r) => ({ id: r.id, signatures: r.signatures.length }))).toEqual([{ id: f.cooperativeRoundId, signatures: 1 }])
  })
})
