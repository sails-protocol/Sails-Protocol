// #239D (R3) — real-Postgres proof of the frozen CTO decisions on real MULTISIG (P2WSH 2-of-3) escrows with
// real secp256k1 keys and real PSBT signatures:
//   X1  another participant's signature is never returned through Sails;
//   D1  a cooperative set completed BEFORE any dispute (H1) is the frozen intent: only that exact
//       transaction executes/recovers, no ruling replaces it;
//   H2  once a dispute exists, no cooperative signature is accepted;
//   MOOT a dispute whose escrow reached its terminal disposition without a ruling becomes MOOT, atomically
//       with the escrow's terminal transition record.
// Legacy rounds (created under the old read contract, signaturesConfidential=false - what the migration
// backfills) are never superseded: fail closed for manual review.
//
// The chain is a controlled MODEL (mocked explorer) - mempool/propagation/provider behavior is
// REQUIRES_LIVE_ECONOMIC_REHEARSAL. "Restart" = an independent module graph with its own PrismaClient.
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
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NETWORK = bitcoin.networks.testnet

describe('#239D signature confidentiality + bilateral intent authority + MOOT convergence — real Postgres', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let escrowRepository: typeof import('../../src/modules/open-settlement/escrow-repository').escrowRepository
  let claimEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').claimEscrowTransition
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let multisigProvider: any
  let restarted: {
    escrowService: typeof escrowService
    getDisputeService: typeof getDisputeService
    reconcile: typeof reconcilePendingSettlements
    prisma: PrismaClient
    redis: { quit(): Promise<unknown> }
  } | undefined

  const ARBITER_ID = 'r3-239d-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('r3-239d-buyer').digest(), { network: NETWORK })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('r3-239d-seller').digest(), { network: NETWORK })
  const createdEscrowIds: string[] = []
  let realFetch: typeof fetch

  /** Controlled chain model: one funding outpoint; the first accepted spend wins; Sails' broadcasts recorded. */
  const chain = { fundingTxid: '', known: new Set<string>(), spentBy: null as string | null, sailsBroadcasts: [] as string[], refuseSailsBroadcasts: false }
  function mockExplorer(): void {
    global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/tx')) {
        const txid = bitcoin.Transaction.fromHex(init.body!).getId()
        chain.sailsBroadcasts.push(txid)
        if (chain.refuseSailsBroadcasts) return { ok: false, status: 503, text: async () => 'upstream unavailable' } as any
        if (chain.spentBy && chain.spentBy !== txid) return { ok: false, status: 400, text: async () => 'bad-txns-inputs-missingorspent' } as any
        chain.spentBy = txid
        chain.known.add(txid)
        return { ok: true, status: 200, text: async () => txid } as any
      }
      if (url.includes('/blocks/tip/height')) return { ok: true, status: 200, text: async () => '100' } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, status: 200, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      const status = url.match(/\/tx\/([0-9a-f]{64})\/status/)
      if (status) {
        return status[1] === chain.fundingTxid || chain.known.has(status[1])
          ? { ok: true, status: 200, json: async () => ({ confirmed: true, block_height: 100 }) } as any
          : { ok: false, status: 404, text: async () => 'Transaction not found', json: async () => ({}) } as any
      }
      return { ok: true, status: 200, json: async () => (chain.spentBy ? [] : [{ txid: chain.fundingTxid, vout: 0, value: 100_000, status: { confirmed: true } }]) } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'r3-239d-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ claimEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      restarted = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        getDisputeService: require('../../src/modules/open-settlement/dispute.service').getDisputeService,
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'R3 #239D Test Arbiter' },
    })
  })

  beforeEach(() => { realFetch = global.fetch; chain.known.clear(); chain.spentBy = null; chain.sailsBroadcasts = []; chain.refuseSailsBroadcasts = false })
  afterEach(() => { global.fetch = realFetch })

  afterAll(async () => {
    if (dbAvailable) {
      // A fully signed, unclaimed MULTISIG round is a PASS 0 candidate for every later suite: remove this suite's own.
      const rounds = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: createdEscrowIds } }, include: { signatures: { select: { participantId: true } } } })
      const fullySigned = rounds.filter((r) => r.requiredSigners.every((id) => r.signatures.some((s) => s.participantId === id))).map((r) => r.id)
      await prisma.escrowPendingTransaction.deleteMany({ where: { id: { in: fullySigned } } })
      await prisma.$disconnect()
      if (restarted) {
        await restarted.prisma.$disconnect()
        await restarted.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  const signPsbt = (unsignedPsbtBase64: string, key: typeof buyerKey) => {
    const copy = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network: NETWORK })
    copy.signInput(0, key)
    return copy.toBase64()
  }
  const assembleOffline = (unsignedPsbtBase64: string, signedCopies: string[]) => {
    const psbt = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network: NETWORK }).combine(...signedCopies.map((s) => bitcoin.Psbt.fromBase64(s, { network: NETWORK })))
    psbt.finalizeAllInputs()
    return psbt.extractTransaction()
  }

  /** Funded MULTISIG escrow in PAYMENT_PENDING; the seller (the payer) opens a cooperative RELEASE and signs it. */
  async function sellerSignedRelease(suffix: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)) })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, Buffer.from(buyerKey.publicKey).toString('hex'), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, Buffer.from(sellerKey.publicKey).toString('hex'), MULTISIG_CAPABILITY_PROFILE_V1)
    chain.fundingTxid = createHash('sha256').update(`r3-239d-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
    mockExplorer()
    await escrowService.lockFunds(escrow.id, seller.id)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', bitcoin.payments.p2wpkh({ pubkey: Buffer.from(sellerKey.publicKey), network: NETWORK }).address!)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', bitcoin.payments.p2wpkh({ pubkey: Buffer.from(buyerKey.publicKey), network: NETWORK }).address!)
    await escrowService.markPaymentSent(escrow.id, buyer.id)
    const round = await escrowService.initiateRelease(escrow.id, undefined, seller.id)
    await escrowService.submitTransactionSignature(escrow.id, seller.id, signPsbt(round.unsignedPsbtBase64, sellerKey))
    return { escrowId: escrow.id, tradeId: trade.id, roundId: round.id, unsigned: round.unsignedPsbtBase64, buyerId: buyer.id, sellerId: seller.id }
  }

  /**
   * H1 with an execution that did not finish: the buyer's final signature completes the set before any
   * dispute; the execution then fails at the provider (broadcast refused) and the status reverts - a fully
   * signed round that is the frozen intent. Then the seller opens a dispute.
   */
  async function h1CompletedThenDisputed(suffix: string) {
    const f = await sellerSignedRelease(suffix)
    chain.refuseSailsBroadcasts = true
    await expect(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, signPsbt(f.unsigned, buyerKey))).rejects.toThrow(/broadcast failed with 503/)
    chain.refuseSailsBroadcasts = false
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    expect(round.bilateralAuthorityAt).not.toBeNull()
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'buyer reversed the fiat payment')
    const expectedTx = multisigProvider.buildFinalizedTransaction({ tradeId: f.tradeId, multisigAddr: (await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).multisigAddr }, round.unsignedPsbtBase64, round.requiredSigners.map((id) => round.signatures.find((s) => s.participantId === id)!.signedPsbtBase64))
    return { ...f, disputeId: dispute.id, expectedTxid: expectedTx.getId() as string, expectedTx }
  }

  const ruleRefund = (disputeId: string, escrowId: string, service = getDisputeService()) => {
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId, escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'REFUND', buyerBps: null, issuedAt }
    return service.resolveDispute(disputeId, ARBITER_ID, 'REFUND', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt)
  }

  async function c8Until(escrowId: string, reconcile = reconcilePendingSettlements) {
    for (let lap = 0; lap < 60; lap++) {
      const report = await reconcile()
      const mine = {
        resumed: report.resumedUnclaimed.filter((r) => r.escrowId === escrowId),
        failed: report.failed.filter((r) => r.escrowId === escrowId),
        manual: report.requiresManualReview.filter((r) => r.escrowId === escrowId),
      }
      if (mine.resumed.length + mine.failed.length + mine.manual.length > 0) return mine
    }
    throw new Error(`C8 never took escrow ${escrowId}`)
  }

  const disputeOf = (id: string, client: PrismaClient = prisma) => client.dispute.findUniqueOrThrow({ where: { id }, select: { status: true, ruling: true, resolvedAt: true, mootedAt: true, mootedByTransitionId: true } })
  const escrowOf = (id: string, client: PrismaClient = prisma) => client.escrow.findUniqueOrThrow({ where: { id }, select: { status: true, txReleaseId: true } })

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

  // ── X1 ──────────────────────────────────────────────────────────────────────────────────────────

  it('T1/T2 X1: the counterparty sees who signed and when, never the signature; the signer sees their own; the arbiter sees none', async () => {
    pg.requirePostgres('X1 read contract')
    const f = await sellerSignedRelease('t1')

    const asBuyer = await escrowService.getPendingTransaction(f.escrowId, f.buyerId)
    expect(asBuyer.signatures).toEqual([{ id: expect.any(String), pendingTxId: f.roundId, participantId: f.sellerId, createdAt: expect.any(Date) }])
    const asSeller = await escrowService.getPendingTransaction(f.escrowId, f.sellerId)
    expect(asSeller.signatures).toEqual([expect.objectContaining({ participantId: f.sellerId, signedPsbtBase64: expect.any(String) })])
    const asArbiter = await escrowService.getPendingTransaction(f.escrowId, ARBITER_ID)
    expect(asArbiter.signatures.some((s: Record<string, unknown>) => 'signedPsbtBase64' in s)).toBe(false)
    // The cooperative round's unsigned transaction carries no signature at all (no server/arbiter material).
    expect(bitcoin.Psbt.fromBase64(asBuyer.unsignedPsbtBase64, { network: NETWORK }).data.inputs[0].partialSig ?? []).toEqual([])
    expect((await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId } })).signaturesConfidential).toBe(true)
  })

  // ── H2 ──────────────────────────────────────────────────────────────────────────────────────────

  it('T4/T12/T14 H2: dispute first; the missing cooperative signature is refused, the buyer holds nothing to complete the spend, the ruling supersedes the dead round safely', async () => {
    pg.requirePostgres('H2')
    const f = await sellerSignedRelease('t4')
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'dispute before completion')

    const buyerSig = signPsbt(f.unsigned, buyerKey)
    await expect(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, buyerSig)).rejects.toThrow(/dispute authority took over before its cooperative release round .* was complete/)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    expect([round.signatures.map((s) => s.participantId), round.bilateralAuthorityAt]).toEqual([[f.sellerId], null])

    // Everything Sails gives the buyer: their own signature cannot complete a 2-of-3 alone.
    const visible = await escrowService.getPendingTransaction(f.escrowId, f.buyerId)
    const material = visible.signatures.flatMap((s) => ('signedPsbtBase64' in s ? [s.signedPsbtBase64] : []))
    expect(material).toEqual([])
    expect(() => assembleOffline(visible.unsignedPsbtBase64, [buyerSig])).toThrow()

    await ruleRefund(dispute.id, f.escrowId)
    const ruling = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(ruling.id).not.toBe(f.roundId)
    expect(ruling.disputeId).toBe(dispute.id)
  })

  // ── H1 / D1 ─────────────────────────────────────────────────────────────────────────────────────

  it('T3/T11 H1: completion before the dispute marks bilateral authority; the ruling is then refused and the dispute stays open, not resolved', async () => {
    pg.requirePostgres('H1')
    const f = await h1CompletedThenDisputed('t3')

    await expect(ruleRefund(f.disputeId, f.escrowId)).rejects.toThrow(/Dispatch eligibility check failed/)
    expect(await disputeOf(f.disputeId)).toMatchObject({ status: 'OPENED', ruling: null })
    expect((await prisma.escrowPendingTransaction.findMany({ where: { escrowId: f.escrowId } })).map((r) => r.id)).toEqual([f.roundId])
  })

  it('T6/T8/T19/T20 H1 then C8: only the exact cooperative transaction is broadcast, the escrow settles and the dispute becomes MOOT with no ruling', async () => {
    pg.requirePostgres('H1 C8')
    const f = await h1CompletedThenDisputed('t6')
    chain.sailsBroadcasts = []

    const mine = await c8Until(f.escrowId)

    expect(mine.resumed).toEqual([{ escrowId: f.escrowId, txId: f.expectedTxid, outcome: 'NEWLY_BROADCAST' }])
    expect(chain.sailsBroadcasts).toEqual([f.expectedTxid]) // one broadcast, of the exact frozen transaction
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'COMPLETED', txReleaseId: f.expectedTxid })
    const transition = await prisma.escrowEvent.findFirstOrThrow({ where: { escrowId: f.escrowId, toStatus: 'COMPLETED' } })
    expect(await disputeOf(f.disputeId)).toEqual({ status: 'MOOT', ruling: null, resolvedAt: null, mootedAt: expect.any(Date), mootedByTransitionId: transition.id })
    // The transaction pays exactly what the cooperative round authorized.
    const buyerPayout = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(buyerKey.publicKey), network: NETWORK }).address!
    expect(f.expectedTx.outs.map((o: bitcoin.TxOutput) => bitcoin.address.fromOutputScript(o.script, NETWORK))).toContain(buyerPayout)
    // A moot dispute can no longer be ruled on.
    await expect(ruleRefund(f.disputeId, f.escrowId)).rejects.toThrow(/is moot/)
  })

  it('T7 H1 with the exact transaction already on the network: C8 converges from chain truth without broadcasting, and the dispute becomes MOOT', async () => {
    pg.requirePostgres('H1 observed')
    const f = await h1CompletedThenDisputed('t7')
    chain.known.add(f.expectedTxid); chain.spentBy = f.expectedTxid; chain.sailsBroadcasts = []

    const mine = await c8Until(f.escrowId)

    expect(mine.resumed).toEqual([{ escrowId: f.escrowId, txId: f.expectedTxid, outcome: 'ALREADY_BROADCAST' }])
    expect(chain.sailsBroadcasts).toEqual([])
    expect((await disputeOf(f.disputeId)).status).toBe('MOOT')
  })

  it('T18 H1 whose funding was spent by something else: never a different transaction, never a reset - ANOMALY, round and dispute preserved', async () => {
    pg.requirePostgres('H1 anomaly')
    const f = await h1CompletedThenDisputed('t18')
    chain.spentBy = 'f'.repeat(64); chain.sailsBroadcasts = []

    const mine = await c8Until(f.escrowId)

    expect(mine.manual).toEqual([{ escrowId: f.escrowId, reason: expect.stringMatching(/no longer unspent/) }])
    expect(chain.sailsBroadcasts).toEqual([])
    expect((await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })).signatures).toHaveLength(2)
    expect(await disputeOf(f.disputeId)).toMatchObject({ status: 'OPENED', mootedAt: null })
  })

  // ── MOOT crash/restart convergence ──────────────────────────────────────────────────────────────

  it('T9/T10 crash after the escrow was finalized but before its transition record: the half-state is repaired by a fresh process, and MOOT lands with the record', async () => {
    pg.requirePostgres('MOOT crash repair')
    const f = await h1CompletedThenDisputed('t9')
    // The live path up to "result persisted", then the process dies before the completion effects.
    await claimEscrowTransition(f.escrowId, 'DISPUTED', 'COMPLETED')
    chain.known.add(f.expectedTxid); chain.spentBy = f.expectedTxid
    await escrowRepository.updateSignatureCollectionResult(f.escrowId, { txReleaseId: f.expectedTxid, releasedAt: new Date() }, { operation: { pendingOperationId: f.roundId } })
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'COMPLETED', txReleaseId: f.expectedTxid })
    expect((await disputeOf(f.disputeId)).status).toBe('OPENED') // the transient half-state

    const fresh = restarted!
    const [{ queued }] = await prisma.$queryRaw<Array<{ queued: number }>>`
      SELECT count(*)::int AS queued FROM escrows WHERE status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND "txReleaseId" IS NOT NULL AND "completionVerifiedAt" IS NULL`
    for (let run = 0; run <= Math.ceil(queued / 50) && (await disputeOf(f.disputeId, fresh.prisma)).status !== 'MOOT'; run++) {
      await fresh.reconcile({ projectionGraceMs: 0 })
    }

    const transition = await fresh.prisma.escrowEvent.findFirstOrThrow({ where: { escrowId: f.escrowId, toStatus: 'COMPLETED' } })
    expect(await disputeOf(f.disputeId, fresh.prisma)).toMatchObject({ status: 'MOOT', ruling: null, mootedByTransitionId: transition.id })
    expect(await fresh.prisma.escrowEvent.count({ where: { escrowId: f.escrowId, toStatus: 'COMPLETED' } })).toBe(1)
  })

  // ── the final-signature vs dispute boundary ─────────────────────────────────────────────────────

  it('T5a final signature serialized first: H1 (authority marked); the dispute that follows cannot replace it', async () => {
    pg.requirePostgres('signature first')
    const f = await sellerSignedRelease('t5a')
    chain.refuseSailsBroadcasts = true // keep the execution from finishing, so the authority question stays open
    const release = await holdEscrowLock(f.escrowId)

    const signer = settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, signPsbt(f.unsigned, buyerKey)))
    await untilWaiting(1)
    const disputer = settle(getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'race'))
    await untilWaiting(2)
    await release()
    await signer
    await disputer

    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    expect(round.signatures).toHaveLength(2)
    expect(round.bilateralAuthorityAt).not.toBeNull()
  })

  it('T5b dispute serialized first: H2 (the final signature refused, no authority marker)', async () => {
    pg.requirePostgres('dispute first')
    const f = await sellerSignedRelease('t5b')
    const release = await holdEscrowLock(f.escrowId)

    const disputer = settle(getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'race'))
    await untilWaiting(1)
    const signer = settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, signPsbt(f.unsigned, buyerKey)))
    await untilWaiting(2)
    await release()

    expect((await disputer).ok).toBe(true)
    expect(await signer).toEqual({ ok: false, e: expect.stringMatching(/dispute authority took over/) })
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    expect([round.signatures.length, round.bilateralAuthorityAt]).toEqual([1, null])
  })

  it('T5c two independent instances race the final signature against the dispute: exactly one of the two defined histories results', async () => {
    pg.requirePostgres('two-instance race')
    const f = await sellerSignedRelease('t5c')
    chain.refuseSailsBroadcasts = true

    const [signed, disputed] = await Promise.all([
      settle(escrowService.submitTransactionSignature(f.escrowId, f.buyerId, signPsbt(f.unsigned, buyerKey))),
      settle(restarted!.getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'race')),
    ])

    expect(disputed.ok).toBe(true)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    const h1 = round.signatures.length === 2 && round.bilateralAuthorityAt !== null
    const h2 = round.signatures.length === 1 && round.bilateralAuthorityAt === null && !signed.ok && /dispute authority took over/.test(signed.e)
    expect([h1, h2].filter(Boolean)).toHaveLength(1)
  })

  it('T17 a ruling and C8 recovery race on two instances over an H1 round: the ruling never wins, the frozen transaction executes once', async () => {
    pg.requirePostgres('ruling vs recovery')
    const f = await h1CompletedThenDisputed('t17')
    chain.sailsBroadcasts = []

    const [ruled, recovered] = await Promise.all([settle(ruleRefund(f.disputeId, f.escrowId, restarted!.getDisputeService())), settle(c8Until(f.escrowId))])

    expect(ruled.ok).toBe(false)
    expect(recovered.ok).toBe(true)
    expect(chain.sailsBroadcasts).toEqual([f.expectedTxid])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'COMPLETED', txReleaseId: f.expectedTxid })
    expect((await disputeOf(f.disputeId)).status).toBe('MOOT')
  })

  // ── legacy (potentially exposed) rounds ─────────────────────────────────────────────────────────

  it('T15/T16 a legacy partial round is never superseded: its partial signature may already be in the beneficiary\'s hands (old P1), so the ruling fails closed for manual review', async () => {
    pg.requirePostgres('legacy partial')
    const f = await sellerSignedRelease('t15')
    // What the migration backfills for every round that existed before X1.
    await prisma.escrowPendingTransaction.update({ where: { id: f.roundId }, data: { signaturesConfidential: false } })
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'dispute on a legacy round')

    // Old contract (P1): the payer's signature was readable, so the beneficiary can still complete the old spend alone.
    const exposed = (await prisma.escrowTransactionSignature.findFirstOrThrow({ where: { pendingTxId: f.roundId, participantId: f.sellerId } })).signedPsbtBase64
    const oldSpend = assembleOffline(f.unsigned, [exposed, signPsbt(f.unsigned, buyerKey)])
    expect(Buffer.from(oldSpend.ins[0].hash).reverse().toString('hex')).toBe(chain.fundingTxid)

    // So Sails never builds a competing ruling spend over it.
    await expect(ruleRefund(dispute.id, f.escrowId)).rejects.toThrow(/predates signature confidentiality .* manual review required/)
    expect((await prisma.escrowPendingTransaction.findMany({ where: { escrowId: f.escrowId } })).map((r) => r.id)).toEqual([f.roundId])
    expect((await disputeOf(dispute.id)).status).toBe('OPENED')
  })

  it('T21 a legacy round completed after its dispute (the #239B state, written by the old code) carries no pre-dispute authority: fail closed everywhere, until the chain shows its exact transaction - then convergence and MOOT', async () => {
    pg.requirePostgres('legacy complete-after-dispute')
    const f = await sellerSignedRelease('t21')
    await prisma.escrowPendingTransaction.update({ where: { id: f.roundId }, data: { signaturesConfidential: false } })
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'dispute before completion (legacy)')
    // The old code accepted this completing signature after the dispute; written directly here as that history.
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: f.roundId, participantId: f.buyerId, signedPsbtBase64: signPsbt(f.unsigned, buyerKey) } })
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: f.roundId }, include: { signatures: true } })
    expect(round.bilateralAuthorityAt).toBeNull()
    const txid = multisigProvider.buildFinalizedTransaction({ tradeId: f.tradeId, multisigAddr: (await prisma.escrow.findUniqueOrThrow({ where: { id: f.escrowId } })).multisigAddr }, round.unsignedPsbtBase64, round.requiredSigners.map((id) => round.signatures.find((s) => s.participantId === id)!.signedPsbtBase64)).getId()

    // Not D1 (no pre-dispute authority), not supersedable (fully signed): C8 asks the chain, then the gate refuses.
    chain.sailsBroadcasts = []
    expect((await c8Until(f.escrowId)).failed).toEqual([{ escrowId: f.escrowId, error: expect.stringMatching(/cooperative origin cannot be proven/) }])
    await expect(ruleRefund(dispute.id, f.escrowId)).rejects.toThrow(/Dispatch eligibility check failed/)
    expect(chain.sailsBroadcasts).toEqual([])

    // Its exact transaction appears on the network (anyone holding the legacy-exposed set broadcast it).
    chain.known.add(txid); chain.spentBy = txid
    expect((await c8Until(f.escrowId)).resumed).toEqual([{ escrowId: f.escrowId, txId: txid, outcome: 'ALREADY_BROADCAST' }])
    expect(chain.sailsBroadcasts).toEqual([])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'COMPLETED', txReleaseId: txid })
    expect(await disputeOf(dispute.id)).toMatchObject({ status: 'MOOT', ruling: null })
  })
})
