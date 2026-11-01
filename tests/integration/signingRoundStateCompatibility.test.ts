// #235 R7G F8C — SIGNING_ROUND_STATE_COMPATIBILITY (candidate). Real MULTISIG (P2WSH 2-of-3) escrows, real
// secp256k1 keys and PSBT signatures, real PostgreSQL authority; the chain is the same controlled model as the
// #239D suite (signatureAuthorityConvergence.test.ts, whose harness this reuses). Interleavings are forced with
// barriers at the exact authority boundaries under test - never by mocking the authority itself.
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

describe('#235 R7G F8C — signing-round / escrow-state authority consistency (real Postgres, real PSBTs)', () => {
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

  const ARBITER_ID = 'r7gf8c-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const buyerKey = ECPair.fromPrivateKey(createHash('sha256').update('r7gf8c-buyer').digest(), { network: NETWORK })
  const sellerKey = ECPair.fromPrivateKey(createHash('sha256').update('r7gf8c-seller').digest(), { network: NETWORK })
  const createdEscrowIds: string[] = []
  const isolatedGraphs: Array<{ prisma: PrismaClient; redis: { quit(): Promise<unknown> } }> = []
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
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'r7gf8c-test-seed'
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
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'R7G F8C Test Arbiter' },
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
      // the extra instances some tests start (isolatedReconciler()), closed exactly like `restarted`
      for (const graph of isolatedGraphs) {
        await graph.prisma.$disconnect()
        await graph.redis.quit().catch(() => {})
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
    chain.fundingTxid = createHash('sha256').update(`r7gf8c-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
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


  /** Another instance's settlement reconciler: its own module graph, Prisma client and Redis connection, closed in afterAll. */
  function isolatedReconciler(): typeof reconcilePendingSettlements {
    let graph!: { reconcile: typeof reconcilePendingSettlements; prisma: PrismaClient; redis: { quit(): Promise<unknown> } }
    jest.isolateModules(() => {
      graph = {
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
    isolatedGraphs.push(graph)
    return graph.reconcile
  }
  /** The chain model holds one funding outpoint: a new fixture in the same test starts from a fresh one. */
  const freshChain = () => { chain.spentBy = null; chain.known.clear() }
  /** Funded MULTISIG escrow in FUNDS_LOCKED with both payout addresses registered. */
  async function locked(suffix: string) {
    freshChain()
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)) })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, Buffer.from(buyerKey.publicKey).toString('hex'), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, Buffer.from(sellerKey.publicKey).toString('hex'), MULTISIG_CAPABILITY_PROFILE_V1)
    chain.fundingTxid = createHash('sha256').update(`r7gf8c-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
    mockExplorer()
    await escrowService.lockFunds(escrow.id, seller.id)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', bitcoin.payments.p2wpkh({ pubkey: Buffer.from(sellerKey.publicKey), network: NETWORK }).address!)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', bitcoin.payments.p2wpkh({ pubkey: Buffer.from(buyerKey.publicKey), network: NETWORK }).address!)
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id }
  }
  const keyOf = (f: { buyerId: string }, id: string) => (id === f.buyerId ? buyerKey : sellerKey)
  const tradeOf = (id: string) => prisma.trade.findUniqueOrThrow({ where: { id }, select: { status: true } })
  /** A barrier: `hold()` parks a caller until `release()`; `reached` resolves once one is parked. */
  function barrier() {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let reachedResolve!: () => void
    const reached = new Promise<void>((r) => { reachedResolve = r })
    return { reached, release, hold: async () => { reachedResolve(); await gate } }
  }

  // ── reproductions of the two known findings ──────────────────────────────────────────────────────

  it('RACE-A (#239D): a ruling committed RESOLVED, C8 completes the escrow, the ruling dispatch fails: the dispute must not end OPENED beside a COMPLETED escrow', async () => {
    pg.requirePostgres('RACE-A')
    const f = await h1CompletedThenDisputed('race-a')
    chain.sailsBroadcasts = []
    // hold the ruling right after its RESOLVED commit, at its dispatch-eligibility check (the step that refuses
    // an H1 round and triggers the revert)
    const b = barrier()
    const dispatch = require('../../src/modules/open-settlement/dispute-dispatch')
    const real = dispatch.assertDisputeDispatchEligible
    const spy = jest.spyOn(dispatch, 'assertDisputeDispatchEligible').mockImplementation(async (...a: any[]) => { await b.hold(); return real(...a) })
    try {
      const ruling = settle(ruleRefund(f.disputeId, f.escrowId))
      await Promise.race([b.reached, ruling.then((r) => { throw new Error(`the ruling ended before its dispatch check: ${JSON.stringify(r)}`) })])
      expect((await disputeOf(f.disputeId)).status).toBe('RESOLVED')
      const c8 = await c8Until(f.escrowId, restarted!.reconcile)
      expect(c8.resumed).toHaveLength(1)
      expect(await escrowOf(f.escrowId)).toEqual({ status: 'COMPLETED', txReleaseId: f.expectedTxid })
      b.release()
      expect((await ruling).ok).toBe(false)
    } finally { spy.mockRestore() }
    expect(chain.sailsBroadcasts).toEqual([f.expectedTxid])
    const d = await disputeOf(f.disputeId)
    expect({ escrow: (await escrowOf(f.escrowId)).status, dispute: d.status, ruling: d.ruling }).toEqual({ escrow: 'COMPLETED', dispute: 'MOOT', ruling: null })
  })

  /** Holds the next Sails broadcast (POST /tx) at the chain until `release()`; later broadcasts pass. */
  function holdNextBroadcast() {
    const b = barrier()
    const inner = global.fetch
    let held = false
    global.fetch = (async (url: string, init?: { method?: string }) => {
      if (!held && init?.method === 'POST' && String(url).endsWith('/tx')) { held = true; await b.hold() }
      return (inner as any)(url, init)
    }) as any
    return b
  }
  /** The network accepts the next Sails broadcast but the HTTP answer is an error (an ambiguous broadcast). */
  function acceptNextBroadcastAmbiguously() {
    const inner = global.fetch
    let done = false
    global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (!done && init?.method === 'POST' && String(url).endsWith('/tx')) {
        done = true
        const txid = bitcoin.Transaction.fromHex(init.body!).getId()
        chain.sailsBroadcasts.push(txid); chain.spentBy = txid; chain.known.add(txid)
        return { ok: false, status: 502, text: async () => 'gateway timeout' } as any
      }
      return (inner as any)(url, init)
    }) as any
  }
  /** A fully signed cooperative REFUND round on a FUNDS_LOCKED escrow whose live finalize failed at the provider (unclaimed: a C8 candidate). */
  async function signedUnclaimedRefund(suffix: string) {
    const f = await locked(suffix)
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.refuseSailsBroadcasts = true
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.refuseSailsBroadcasts = false
    chain.sailsBroadcasts = []
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    return { ...f, round }
  }
  const refundTxid = (f: { round: { unsignedPsbtBase64: string; requiredSigners: string[] }; buyerId: string }) =>
    assembleOffline(f.round.unsignedPsbtBase64, f.round.requiredSigners.map((id) => signPsbt(f.round.unsignedPsbtBase64, keyOf(f, id)))).getId()

  it('RACE-B (NF-F8B-1) / C: payment marked under a cooperative REFUND round, then both sign: the live finalize and C8 both refuse before any broadcast', async () => {
    pg.requirePostgres('RACE-B')
    const f = await locked('race-b')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    chain.sailsBroadcasts = []
    const signed: string[] = []
    for (const id of round.requiredSigners) { const r = await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id)))); signed.push(r.ok ? 'OK' : r.e) }
    expect(signed[signed.length - 1]).toMatch(/Invalid escrow transition: PAYMENT_PENDING → REFUNDED/)
    const c8 = await c8Until(f.escrowId, restarted!.reconcile)
    expect(c8.failed.map((x) => x.error)).toEqual([expect.stringMatching(/Invalid escrow transition: PAYMENT_PENDING → REFUNDED/)])
    expect({ escrow: await escrowOf(f.escrowId), trade: (await tradeOf(f.tradeId)).status, broadcasts: chain.sailsBroadcasts })
      .toEqual({ escrow: { status: 'PAYMENT_PENDING', txReleaseId: null }, trade: 'ACTIVE', broadcasts: [] })
  })

  it('RACE-B liveness: the dormant bilateral REFUND round executes exactly once when a dispute makes its transition valid (D1/H1 frozen intent); the ruling never replaces it', async () => {
    pg.requirePostgres('RACE-B liveness')
    const f = await locked('race-b-live')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.sailsBroadcasts = []
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.buyerId, 'paid; the seller wants out')
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }
    await expect(getDisputeService().resolveDispute(dispute.id, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt)).rejects.toThrow(/Dispatch eligibility check failed/)
    expect((await disputeOf(dispute.id)).status).toBe('OPENED')
    const c8 = await c8Until(f.escrowId, restarted!.reconcile)
    expect(c8.resumed.map((r) => r.outcome)).toEqual(['NEWLY_BROADCAST'])
    const txid = assembleOffline(round.unsignedPsbtBase64, round.requiredSigners.map((id) => signPsbt(round.unsignedPsbtBase64, keyOf(f, id)))).getId()
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts, dispute: (await disputeOf(dispute.id)).status })
      .toEqual({ escrow: { status: 'REFUNDED', txReleaseId: txid }, broadcasts: [txid], dispute: 'MOOT' })
  })

  it('D: payment marked between the two signatures of a REFUND round: no broadcast, no claim', async () => {
    pg.requirePostgres('D')
    const f = await locked('d')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    const [first, second] = round.requiredSigners
    await escrowService.submitTransactionSignature(f.escrowId, first, signPsbt(round.unsignedPsbtBase64, keyOf(f, first)))
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    chain.sailsBroadcasts = []
    await expect(escrowService.submitTransactionSignature(f.escrowId, second, signPsbt(round.unsignedPsbtBase64, keyOf(f, second)))).rejects.toThrow(/Invalid escrow transition/)
    await c8Until(f.escrowId, restarted!.reconcile)
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts }).toEqual({ escrow: { status: 'PAYMENT_PENDING', txReleaseId: null }, broadcasts: [] })
  })

  it('E: the live finalize has claimed REFUNDED and is broadcasting: a concurrent payment claim is refused, one transaction', async () => {
    pg.requirePostgres('E')
    const f = await locked('e')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    const [first, second] = round.requiredSigners
    await escrowService.submitTransactionSignature(f.escrowId, first, signPsbt(round.unsignedPsbtBase64, keyOf(f, first)))
    chain.sailsBroadcasts = []
    const hold = holdNextBroadcast()
    const live = settle(escrowService.submitTransactionSignature(f.escrowId, second, signPsbt(round.unsignedPsbtBase64, keyOf(f, second))))
    await hold.reached
    expect((await escrowOf(f.escrowId)).status).toBe('REFUNDED')
    await expect(restarted!.escrowService.markPaymentSent(f.escrowId, f.buyerId)).rejects.toThrow(/Invalid escrow transition: REFUNDED → PAYMENT_PENDING/)
    hold.release()
    expect((await live).ok).toBe(true)
    expect({ escrow: (await escrowOf(f.escrowId)).status, broadcasts: chain.sailsBroadcasts.length }).toEqual({ escrow: 'REFUNDED', broadcasts: 1 })
  })

  it('F: C8 has claimed REFUNDED before its first broadcast: a concurrent payment claim is refused, one transaction', async () => {
    pg.requirePostgres('F')
    const f = await signedUnclaimedRefund('f')
    const hold = holdNextBroadcast()
    const c8 = settle(restarted!.reconcile())
    await hold.reached
    expect((await escrowOf(f.escrowId)).status).toBe('REFUNDED')
    await expect(escrowService.markPaymentSent(f.escrowId, f.buyerId)).rejects.toThrow(/Invalid escrow transition: REFUNDED → PAYMENT_PENDING/)
    hold.release()
    const report = await c8
    expect(report.ok).toBe(true)
    // PASS 0 itself converged the round it claimed: resumed once, nothing for manual review
    const r = (report as any).v
    expect({ resumed: r.resumedUnclaimed.filter((x: any) => x.escrowId === f.escrowId).map((x: any) => x.outcome), manual: r.requiresManualReview.filter((x: any) => x.escrowId === f.escrowId), failed: r.failed.filter((x: any) => x.escrowId === f.escrowId) })
      .toEqual({ resumed: ['NEWLY_BROADCAST'], manual: [], failed: [] })
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, broadcasts: [refundTxid(f)] })
  })

  it('G/H: the live final signature and two C8 runs on other instances race one round: one claim, one broadcast, one transaction', async () => {
    pg.requirePostgres('G/H')
    const f = await locked('gh')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    const [first, second] = round.requiredSigners
    await escrowService.submitTransactionSignature(f.escrowId, first, signPsbt(round.unsignedPsbtBase64, keyOf(f, first)))
    chain.sailsBroadcasts = []
    const other = isolatedReconciler()
    await Promise.all([
      settle(escrowService.submitTransactionSignature(f.escrowId, second, signPsbt(round.unsignedPsbtBase64, keyOf(f, second)))),
      settle(restarted!.reconcile()),
      settle(other()),
    ])
    await c8Until(f.escrowId, restarted!.reconcile).catch(() => undefined)
    const e = await escrowOf(f.escrowId)
    expect({ status: e.status, txReleaseId: e.txReleaseId, broadcasts: chain.sailsBroadcasts }).toEqual({ status: 'REFUNDED', txReleaseId: chain.sailsBroadcasts[0], broadcasts: [chain.sailsBroadcasts[0]] })
  })

  it('H: two C8 instances race one unclaimed fully signed round: exactly one claims and broadcasts', async () => {
    pg.requirePostgres('H')
    const f = await signedUnclaimedRefund('h')
    const other = isolatedReconciler()
    const [a, b] = await Promise.all([restarted!.reconcile(), other()])
    const took = [a, b].map((r) => ({ resumed: r.resumedUnclaimed.filter((x) => x.escrowId === f.escrowId).length, concurrent: r.alreadyClaimedConcurrently.filter((x) => x === f.escrowId).length }))
    expect(took.reduce((n, t) => n + t.resumed, 0)).toBe(1)
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, broadcasts: [refundTxid(f)] })
  })

  it('M/N: C8 crashes after its pre-broadcast claim; a fresh instance converges from chain truth with the same transaction; the old broadcast lands harmlessly', async () => {
    pg.requirePostgres('M')
    const f = await signedUnclaimedRefund('m')
    const hold = holdNextBroadcast()
    const crashed = settle(restarted!.reconcile())
    await hold.reached
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: null })
    // a fresh process: PASS 1 (terminal, no txReleaseId) asks the chain and broadcasts the one transaction once
    const fresh = isolatedReconciler()
    const report = await fresh()
    expect(report.recovered.filter((r) => r.escrowId === f.escrowId).map((r) => r.outcome)).toEqual(['NEWLY_BROADCAST'])
    hold.release()
    await crashed
    expect({ escrow: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)] }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, distinct: [refundTxid(f)] })
  })

  it('O/P: an ambiguous broadcast, then a payment claim: C8 sees the transaction on the network but never claims an invalid transition (manual review); a dispute then converges it once', async () => {
    pg.requirePostgres('O/P')
    const f = await locked('op')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    acceptNextBroadcastAmbiguously()
    let last = ''
    for (const id of round.requiredSigners) { const r = await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id)))); if (!r.ok) last = r.e }
    expect(last).toMatch(/502/)
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    await escrowService.markPaymentSent(f.escrowId, f.buyerId)
    const c8 = await c8Until(f.escrowId, restarted!.reconcile)
    expect(c8.manual.map((m) => m.reason)).toEqual([expect.stringMatching(/already on the network, but escrow status 'PAYMENT_PENDING' does not authorize REFUNDED/)])
    expect((await escrowOf(f.escrowId)).status).toBe('PAYMENT_PENDING')
    const dispute = await getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'the refund is already on chain')
    const c8b = await c8Until(f.escrowId, restarted!.reconcile)
    expect(c8b.resumed.map((r) => r.outcome)).toEqual(['ALREADY_BROADCAST'])
    const txid = chain.sailsBroadcasts[0]
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts, dispute: (await disputeOf(dispute.id)).status })
      .toEqual({ escrow: { status: 'REFUNDED', txReleaseId: txid }, broadcasts: [txid], dispute: 'MOOT' })
  })

  it('L: the reverse order of RACE-A - the ruling reverts first, then C8 completes: the terminal record makes the dispute MOOT', async () => {
    pg.requirePostgres('L')
    const f = await h1CompletedThenDisputed('l')
    await expect(ruleRefund(f.disputeId, f.escrowId)).rejects.toThrow(/Dispatch eligibility check failed/)
    expect((await disputeOf(f.disputeId)).status).toBe('OPENED')
    await c8Until(f.escrowId, restarted!.reconcile)
    const d = await disputeOf(f.disputeId)
    expect({ escrow: (await escrowOf(f.escrowId)).status, dispute: d.status, ruling: d.ruling, bound: d.mootedByTransitionId !== null }).toEqual({ escrow: 'COMPLETED', dispute: 'MOOT', ruling: null, bound: true })
  })

  it('L2: the revert holds the escrow lock between reading no terminal record and writing: the C8 record waits, then turns the restored dispute MOOT - never OPENED beside COMPLETED', async () => {
    pg.requirePostgres('L2')
    const f = await h1CompletedThenDisputed('l2')
    // pause the ruling's revert right after it read the escrow's (absent) terminal record, inside its transaction
    const b = barrier()
    let armed = true
    const realTx = prisma.$transaction.bind(prisma) as any
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) => typeof fn !== 'function' ? realTx(fn, opts) : realTx(async (tx: any) => fn(new Proxy(tx, {
      get(t, k) {
        if (k !== 'escrowEvent') return t[k]
        return { ...t.escrowEvent, findFirst: async (...a: any[]) => { const r = await t.escrowEvent.findFirst(...a); if (armed && r === null) { armed = false; await b.hold() } return r } }
      },
    })), opts)) as any)
    try {
      const ruling = settle(ruleRefund(f.disputeId, f.escrowId))
      await Promise.race([b.reached, ruling.then((r) => { throw new Error(`the ruling ended before its revert: ${JSON.stringify(r)}`) })])
      // C8 on another instance completes the escrow; its terminal record needs the escrow lock the revert holds
      const c8 = settle(c8Until(f.escrowId, restarted!.reconcile))
      await Promise.race([untilWaiting(1), c8])
      b.release()
      expect((await ruling).ok).toBe(false)
      expect((await c8).ok).toBe(true)
    } finally { spy.mockRestore() }
    const d = await disputeOf(f.disputeId)
    expect({ escrow: (await escrowOf(f.escrowId)).status, dispute: d.status, ruling: d.ruling, bound: d.mootedByTransitionId !== null }).toEqual({ escrow: 'COMPLETED', dispute: 'MOOT', ruling: null, bound: true })
  })

  // ── the database ─────────────────────────────────────────────────────────────────────────────────

  it('DB: once an escrow has a terminal transition record, no dispute of it is inserted with or moved into an open status; RESOLVED/APPEALED/MOOT and same-status updates are untouched', async () => {
    pg.requirePostgres('DB')
    const f = await h1CompletedThenDisputed('db')
    await c8Until(f.escrowId, restarted!.reconcile)
    expect((await disputeOf(f.disputeId)).status).toBe('MOOT')
    const refused = /already has a terminal transition record/
    const sql = (q: string, ...v: unknown[]) => settle(prisma.$executeRawUnsafe(q, ...v))
    for (const status of ['OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'AUTO_PROPOSED']) {
      expect(await sql(`UPDATE disputes SET status = '${status}' WHERE id = $1`, f.disputeId)).toMatchObject({ ok: false, e: expect.stringMatching(refused) })
    }
    expect(await sql(`UPDATE disputes SET status = 'APPEALED' WHERE id = $1`, f.disputeId)).toMatchObject({ ok: true })
    expect(await sql(`UPDATE disputes SET status = 'MOOT' WHERE id = $1`, f.disputeId)).toMatchObject({ ok: true })
    expect(await sql(`UPDATE disputes SET reason = reason WHERE id = $1`, f.disputeId)).toMatchObject({ ok: true })
    expect(await sql(`INSERT INTO disputes (id, "tradeId", "escrowId", "openedBy", reason, status, "updatedAt") VALUES (gen_random_uuid()::text, gen_random_uuid()::text, $1, $2, 'x', 'OPENED', now())`, f.escrowId, f.buyerId)).toMatchObject({ ok: false })
    // a non-terminal escrow's disputes are not affected
    freshChain()
    const g = await sellerSignedRelease('db-open')
    const dispute = await getDisputeService().raiseDispute(g.tradeId, g.sellerId, 'open')
    expect(await sql(`UPDATE disputes SET status = 'EVIDENCE_SUBMITTED' WHERE id = $1`, dispute.id)).toMatchObject({ ok: true })
  })

  // ── the read-only preflight ──────────────────────────────────────────────────────────────────────

  it('preflight: flags a #239D half-state and a dormant incompatible round, passes a clean escrow, never writes; its transition table is VALID_TRANSITIONS', async () => {
    pg.requirePostgres('preflight')
    const { runSigningRoundPreflight } = require('../../scripts/signing-round-preflight')
    const { VALID_TRANSITIONS } = require('../../src/modules/open-settlement/escrow-lifecycle')
    for (const [target, from] of Object.entries({ COMPLETED: ['PAYMENT_PENDING', 'DISPUTED'], REFUNDED: ['CREATED', 'FUNDS_LOCKED', 'DISPUTED', 'EXPIRED'], SPLIT: ['DISPUTED'] })) {
      expect(Object.keys(VALID_TRANSITIONS).filter((s) => VALID_TRANSITIONS[s].includes(target)).sort()).toEqual([...from].sort())
    }
    // the #239D half-state as the old revert wrote it (only reachable with the guard disabled)
    const half = await h1CompletedThenDisputed('pf-half')
    await c8Until(half.escrowId, restarted!.reconcile)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE disputes DISABLE TRIGGER disputes_terminal_escrow_not_open_guard')
      await tx.$executeRaw`UPDATE disputes SET status = 'OPENED', "mootedAt" = NULL, "mootedByTransitionId" = NULL WHERE id = ${half.disputeId}`
      await tx.$executeRawUnsafe('ALTER TABLE disputes ENABLE TRIGGER disputes_terminal_escrow_not_open_guard')
    })
    // a dormant REFUND round under PAYMENT_PENDING (RACE-B)
    const dormant = await locked('pf-dormant')
    const round = await escrowService.initiateRefund(dormant.escrowId, dormant.sellerId)
    await escrowService.markPaymentSent(dormant.escrowId, dormant.buyerId)
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(dormant.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(dormant, id))))
    freshChain()
    const clean = await sellerSignedRelease('pf-clean')
    const snapshot = async () => JSON.stringify(await Promise.all([half.escrowId, dormant.escrowId, clean.escrowId].map((id) => Promise.all([
      prisma.escrow.findUniqueOrThrow({ where: { id } }), prisma.dispute.findMany({ where: { escrowId: id } }), prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } }),
    ]))))
    const before = await snapshot()
    const report = await runSigningRoundPreflight(process.env.DATABASE_URL!)
    const of = (id: string) => report.results.find((r: any) => r.escrowId === id)
    expect(of(half.escrowId)).toMatchObject({ classification: 'REVIEW_REQUIRED', findings: [{ kind: 'TERMINAL_ESCROW_OPEN_DISPUTE' }] })
    expect(of(dormant.escrowId)).toMatchObject({ classification: 'REVIEW_REQUIRED', findings: [{ kind: 'ROUND_INCOMPATIBLE_WITH_STATE', detail: { status: 'PAYMENT_PENDING', roundKind: 'refund', fullySigned: true } }] })
    expect(of(clean.escrowId)).toMatchObject({ classification: 'SAFE', findings: [] })
    expect(await snapshot()).toEqual(before)
  })
})
