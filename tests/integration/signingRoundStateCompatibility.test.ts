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

  /**
   * P4 / Gate 3 - the explorer ACCEPTS the next Sails broadcast on arrival, but the caller's answer is held and then
   * lost (a transport error): the attempt owning the claim learns nothing while the transaction is already public.
   */
  function acceptNextBroadcastThenLoseResponse() {
    const b = barrier()
    const inner = global.fetch
    let done = false
    global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (!done && init?.method === 'POST' && String(url).endsWith('/tx')) {
        done = true
        const txid = bitcoin.Transaction.fromHex(init.body!).getId()
        chain.sailsBroadcasts.push(txid); chain.spentBy = txid; chain.known.add(txid)
        await b.hold()
        throw new Error('transport connection lost after explorer accepted transaction')
      }
      return (inner as any)(url, init)
    }) as any
    return b
  }

  // The claim owner holds REFUNDED and the transaction is already public (the M/N window); its answer is then
  // lost, so its catch reverts the claim, while PASS 1 on another instance has read that chain truth and is about
  // to record the result. Both serializations of the revert and PASS 1's write are exercised, each with the
  // escrow lock held so the interleaving is deterministic rather than timing-dependent.
  it.each([
    ['PASS 1 queues first, the revert second', false],
    ['the revert queues first, PASS 1 second', true],
  ])('P4-A (%s): the escrow never ends non-terminal beside a recorded settlement result, and converges once', async (_name, revertQueuesFirst) => {
    pg.requirePostgres('P4-A')
    const f = await signedUnclaimedRefund(revertQueuesFirst ? 'p4a-revert-first' : 'p4a-pass1-first')
    const lostAnswer = acceptNextBroadcastThenLoseResponse()
    const claimOwner = settle(restarted!.reconcile())
    await lostAnswer.reached
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: null })
    const releaseLock = await holdEscrowLock(f.escrowId)
    let pass1!: ReturnType<typeof settle>
    const startPass1 = async (waiters: number) => { pass1 = settle(isolatedReconciler()()); await untilWaiting(waiters) }
    try {
      if (revertQueuesFirst) {
        // the lost answer reaches the owner's catch first: its revert parks on the escrow lock, then PASS 1 reads the same chain truth
        lostAnswer.release()
        await untilWaiting(1)
        await startPass1(2)
      } else {
        await startPass1(1)
        lostAnswer.release()
        // serialized, the revert parks behind the held lock; an unserialized revert would complete (and settle the owner) at once
        await Promise.race([untilWaiting(2).catch(() => undefined), claimOwner])
      }
    } catch (choreographyError) {
      // never leave the escrow lock held (or the parked broadcast pending) for the tests that follow
      lostAnswer.release()
      await releaseLock().catch(() => undefined)
      throw choreographyError
    }
    await releaseLock()
    expect((await claimOwner).ok).toBe(true)
    expect((await pass1).ok).toBe(true)

    const after = await escrowOf(f.escrowId)
    // the contradiction this test guards: a settlement result recorded on an escrow that is not in the terminal state it settled
    expect(after.txReleaseId !== null ? after.status : 'REFUNDED').toBe('REFUNDED')
    // and whatever state it is in converges to the one transaction the chain holds, with no second spend
    if (after.txReleaseId === null) await c8Until(f.escrowId, restarted!.reconcile)
    expect({ escrow: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)] })
      .toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, distinct: [refundTxid(f)] })
  })

  // The status re-check alone is not enough: PASS 1 passes it, and only then does the claim owner's answer get lost.
  // The revert must therefore wait for the lock PASS 1's transaction already holds, not commit between its re-check
  // and its write (the window P4-A's lock-queue orders cannot reach).
  it('P4-B: the lost answer arrives AFTER PASS 1 passed its locked status re-check and BEFORE its write: the revert waits, the result is recorded on a REFUNDED escrow', async () => {
    pg.requirePostgres('P4-B')
    const f = await signedUnclaimedRefund('p4b')
    const lostAnswer = acceptNextBroadcastThenLoseResponse()
    const claimOwner = settle(restarted!.reconcile())
    await lostAnswer.reached
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: null })
    const original = escrowRepository.updateSignatureCollectionResult.bind(escrowRepository)
    let interleaved = false
    const spy = jest.spyOn(escrowRepository, 'updateSignatureCollectionResult').mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!interleaved && args[0] === f.escrowId) {
        interleaved = true
        // PASS 1 is inside its locked transaction, past the status re-check, about to write: the owner's answer is lost now
        lostAnswer.release()
        await Promise.race([untilWaiting(1).catch(() => undefined), claimOwner])
      }
      return original(...args)
    })
    try {
      const report = await reconcilePendingSettlements()
      expect(interleaved).toBe(true)
      expect(report.failed.filter((r) => r.escrowId === f.escrowId)).toEqual([])
    } finally { spy.mockRestore(); lostAnswer.release() }
    expect((await claimOwner).ok).toBe(true)
    expect({ escrow: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)] })
      .toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, distinct: [refundTxid(f)] })
  })

  it('P4-D: a failure raised by the broadcast request is classified outcome-UNKNOWN on the error the live finalize surfaces, while behavior (revert, retained round) is unchanged', async () => {
    pg.requirePostgres('P4-D')
    const f = await locked('p4d')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.refuseSailsBroadcasts = true
    let surfaced: (Error & { broadcastAttempted?: boolean }) | undefined
    for (const id of round.requiredSigners) {
      try { await escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))) } catch (e) { surfaced = e as Error }
    }
    chain.refuseSailsBroadcasts = false
    expect(surfaced?.message).toMatch(/broadcast failed with 503/)
    expect(surfaced?.broadcastAttempted).toBe(true)
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
  })

  /** PASS 1 laps until it takes `escrowId` (a shared database holds other escrows that compete for each batch). */
  async function pass1Until(escrowId: string, reconcile: typeof reconcilePendingSettlements) {
    for (let lap = 0; lap < 60; lap++) {
      const report = await reconcile()
      const mine = {
        recovered: report.recovered.filter((r) => r.escrowId === escrowId),
        failed: report.failed.filter((r) => r.escrowId === escrowId),
        manual: report.requiresManualReview.filter((r) => r.escrowId === escrowId),
      }
      if (mine.recovered.length + mine.failed.length + mine.manual.length > 0) return mine
    }
    throw new Error(`PASS 1 never took escrow ${escrowId}`)
  }

  /** Every explorer READ fails (transport error) until `restore()`; broadcasts (POST) are untouched. */
  function explorerReadOutage() {
    const inner = global.fetch
    let down = true
    global.fetch = (async (url: string, init?: { method?: string }) => {
      if (down && init?.method !== 'POST') throw new Error('explorer unreachable (read-side outage)')
      return (inner as any)(url, init)
    }) as any
    return { restore: () => { down = false } }
  }

  it('P4-C1 (PASS 0): an accepted broadcast whose answer was lost, then an explorer READ outage: C8 fails closed - no claim, no rebroadcast - and converges once reads return', async () => {
    pg.requirePostgres('P4-C1')
    const f = await locked('p4c1')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    acceptNextBroadcastAmbiguously()
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    const accepted = [...chain.sailsBroadcasts]
    expect(accepted).toHaveLength(1)
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    const outage = explorerReadOutage()
    const during = await c8Until(f.escrowId, restarted!.reconcile)
    expect({ resumed: during.resumed, manual: during.manual }).toEqual({ resumed: [], manual: [] })
    expect(during.failed.map((x) => x.error)).toEqual([expect.stringMatching(/explorer unreachable/)])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect(chain.sailsBroadcasts).toEqual(accepted)
    outage.restore()
    const after = await c8Until(f.escrowId, restarted!.reconcile)
    expect(after.resumed.map((x) => x.outcome)).toEqual(['ALREADY_BROADCAST'])
    expect({ escrow: await escrowOf(f.escrowId), broadcasts: chain.sailsBroadcasts }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: accepted[0] }, broadcasts: accepted })
  })

  it('P4-C2 (PASS 1): a claim owner stuck at its broadcast, then an explorer READ outage: PASS 1 fails closed - claim kept, nothing recorded - and converges once reads return', async () => {
    pg.requirePostgres('P4-C2')
    const f = await signedUnclaimedRefund('p4c2')
    const hold = holdNextBroadcast()
    const owner = settle(restarted!.reconcile())
    await hold.reached
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: null })
    const outage = explorerReadOutage()
    const pass1 = isolatedReconciler()
    const during = await pass1Until(f.escrowId, pass1)
    expect(during.recovered).toEqual([])
    expect(during.failed.map((r) => r.error)).toEqual([expect.stringMatching(/explorer unreachable/)])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: null })
    outage.restore()
    const after = await pass1Until(f.escrowId, pass1)
    expect(after.recovered).toHaveLength(1)
    hold.release()
    await owner
    expect({ escrow: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)] }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: refundTxid(f) }, distinct: [refundTxid(f)] })
  })

  it('PASS 0 transport-loss oracle: accepted refund with rejected network promise is recovered from chain truth on a fresh C8 run', async () => {
    pg.requirePostgres('PASS 0 transport loss')
    const f = await signedUnclaimedRefund('pass0-lost-response')
    const inner = global.fetch
    let injected = false
    global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (!injected && init?.method === 'POST' && String(url).endsWith('/tx')) {
        injected = true
        const txid = bitcoin.Transaction.fromHex(init.body!).getId()
        chain.sailsBroadcasts.push(txid)
        chain.spentBy = txid
        chain.known.add(txid)
        throw new Error('transport connection lost after explorer accepted transaction')
      }
      return (inner as any)(url, init)
    }) as any
    const first = await c8Until(f.escrowId, restarted!.reconcile)
    expect(injected).toBe(true)
    expect(first.failed.map((x) => x.error)).toEqual([expect.stringMatching(/transport connection lost after explorer accepted transaction/)])
    // The current PASS 0 catch reverts its claim. The durable signed operation
    // must still be recovered from the exact txid already visible on chain.
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    const next = await c8Until(f.escrowId, restarted!.reconcile)
    expect(next.resumed.map((x) => x.outcome)).toEqual(['ALREADY_BROADCAST'])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: refundTxid(f) })
    expect(chain.sailsBroadcasts).toEqual([refundTxid(f)])
  })

  it('LIVE transport-loss oracle: accepted refund with rejected network promise converges through C8 without rebroadcast', async () => {
    pg.requirePostgres('LIVE transport loss')
    const f = await locked('live-lost-response')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    const inner = global.fetch
    let injected = false
    global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (!injected && init?.method === 'POST' && String(url).endsWith('/tx')) {
        injected = true
        const txid = bitcoin.Transaction.fromHex(init.body!).getId()
        chain.sailsBroadcasts.push(txid)
        chain.spentBy = txid
        chain.known.add(txid)
        throw new Error('live transport lost after explorer accepted transaction')
      }
      return (inner as any)(url, init)
    }) as any
    let error = ''
    for (const id of round.requiredSigners) {
      const result = await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
      if (!result.ok) error = result.e
    }
    expect(injected).toBe(true)
    expect(error).toMatch(/live transport lost after explorer accepted transaction/)
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'FUNDS_LOCKED', txReleaseId: null })
    const recovered = await c8Until(f.escrowId, restarted!.reconcile)
    expect(recovered.resumed.map((x) => x.outcome)).toEqual(['ALREADY_BROADCAST'])
    expect(chain.sailsBroadcasts).toHaveLength(1)
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: chain.sailsBroadcasts[0] })
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

  // ── P5: UNKNOWN-outcome policy evidence ───────────────────────────────────────────────────────────
  // Strategy-neutral: each scenario asserts INVARIANTS (one distinct transaction, no result beside a non-terminal
  // escrow, convergence to the transaction the chain holds, nothing blocked for good) and records what the policy
  // under test actually does to P4_OBS (one JSON line per observation) so the A/B comparison reads real runs.
  const observe = (label: string, data: Record<string, unknown>) => {
    const file = process.env.P4_OBS
    if (file) require('fs').appendFileSync(file, JSON.stringify({ label, ...data }) + '\n')
  }
  /** Recovery laps (PASS 0 + PASS 1 + ...) until the escrow has a settlement result; returns the lap, or -1. */
  async function convergeUntil(escrowId: string, reconcile: typeof reconcilePendingSettlements = reconcilePendingSettlements, laps = 40) {
    const manual: string[] = []
    for (let lap = 1; lap <= laps; lap++) {
      const report = await reconcile()
      for (const m of report.requiresManualReview) if (m.escrowId === escrowId) manual.push(m.reason)
      if ((await escrowOf(escrowId)).txReleaseId !== null) return { lap, manual }
    }
    return { lap: -1, manual }
  }
  /** A cooperative REFUND round whose live finalize ended in an AMBIGUOUS broadcast: accepted by the network, HTTP 502. */
  async function ambiguousAcceptedRefund(suffix: string) {
    const f = await locked(suffix)
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    acceptNextBroadcastAmbiguously()
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    expect(chain.sailsBroadcasts).toHaveLength(1)
    return { ...f, round, txid: chain.sailsBroadcasts[0] }
  }

  it('P5-1 expiry: an accepted-but-unacknowledged refund, then the escrow\'s timelock expires: the escrow never ends EXPIRED beside the refund on the network without converging or a visible signal', async () => {
    pg.requirePostgres('P5-1')
    const f = await ambiguousAcceptedRefund('p5-1')
    const afterFailure = await escrowOf(f.escrowId)
    await prisma.escrow.update({ where: { id: f.escrowId }, data: { expiresAt: new Date(Date.now() - 3_600_000) } })
    const swept = await escrowService.sweepExpiredEscrows()
    const afterSweep = await escrowOf(f.escrowId)
    const { lap, manual } = await convergeUntil(f.escrowId, reconcilePendingSettlements, 12)
    const final = await escrowOf(f.escrowId)
    observe('P5-1', { afterFailure, afterSweep, sweptRefunded: swept.refunded.includes(f.escrowId), lap, manualReview: manual.length, final, distinct: [...new Set(chain.sailsBroadcasts)].length })
    expect([...new Set(chain.sailsBroadcasts)]).toEqual([f.txid])
    // the invariant: the refund is on the network, so the escrow either converged to it or the disagreement is surfaced
    expect(final.txReleaseId === f.txid || manual.length > 0).toBe(true)
    expect(final.txReleaseId !== null ? final.status : 'REFUNDED').toBe('REFUNDED')
  })

  it('P5-2 definite refusal (HTTP 503, nothing accepted), then the explorer returns: the round converges to its one transaction - nothing is blocked for good', async () => {
    pg.requirePostgres('P5-2')
    const f = await locked('p5-2')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    chain.refuseSailsBroadcasts = true
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.refuseSailsBroadcasts = false
    const afterRefusal = await escrowOf(f.escrowId)
    const txid = refundTxid({ round, buyerId: f.buyerId })
    const { lap } = await convergeUntil(f.escrowId)
    observe('P5-2', { afterRefusal, lap, final: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)].length })
    expect(lap).toBeGreaterThan(0)
    expect({ escrow: await escrowOf(f.escrowId), distinct: [...new Set(chain.sailsBroadcasts)] }).toEqual({ escrow: { status: 'REFUNDED', txReleaseId: txid }, distinct: [txid] })
  })

  it('P5-2b dispute eligibility after a definite refusal: recorded for the policy; either way the round still converges once', async () => {
    pg.requirePostgres('P5-2b')
    const f = await locked('p5-2b')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    chain.refuseSailsBroadcasts = true
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.refuseSailsBroadcasts = false
    const afterRefusal = await escrowOf(f.escrowId)
    const dispute = await settle(getDisputeService().raiseDispute(f.tradeId, f.sellerId, 'the explorer refused the refund'))
    const { lap } = await convergeUntil(f.escrowId)
    observe('P5-2b', { afterRefusal, disputeRaised: dispute.ok, disputeError: dispute.ok ? null : dispute.e.slice(0, 120), lap, final: await escrowOf(f.escrowId) })
    expect(lap).toBeGreaterThan(0)
    expect([...new Set(chain.sailsBroadcasts)]).toHaveLength(1)
    expect((await escrowOf(f.escrowId)).status).toBe('REFUNDED')
  })

  /** Runs the recovery passes in a NEW OS PROCESS (fresh module graph, Prisma pool, Redis connection; no inherited
   *  fetch mock) against the same database, with a deterministic explorer fixture seeded from the parent's chain model. */
  async function recoverInFreshProcess(escrowId: string) {
    const { spawn } = require('child_process') as typeof import('child_process')
    const { resolve: resolvePath } = require('path') as typeof import('path')
    const code = String.raw`
      require('ts-node/register/transpile-only')
      const bitcoin = require('bitcoinjs-lib')
      const state = JSON.parse(process.env.P5_CHAIN)
      const known = new Set(state.known)
      const posts = []
      global.fetch = async (url, init) => {
        const u = String(url)
        if (init && init.method === 'POST' && u.endsWith('/tx')) {
          const txid = bitcoin.Transaction.fromHex(init.body).getId()
          posts.push(txid); known.add(txid); state.spentBy = txid
          return { ok: true, status: 200, text: async () => txid }
        }
        if (u.includes('/blocks/tip/height')) return { ok: true, status: 200, text: async () => '100' }
        if (u.includes('/v1/fees/recommended')) return { ok: true, status: 200, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) }
        const m = u.match(/\/tx\/([0-9a-f]{64})\/status/)
        if (m) return (m[1] === state.fundingTxid || known.has(m[1]))
          ? { ok: true, status: 200, json: async () => ({ confirmed: true, block_height: 100 }) }
          : { ok: false, status: 404, text: async () => 'Transaction not found', json: async () => ({}) }
        return { ok: true, status: 200, json: async () => (state.spentBy ? [] : [{ txid: state.fundingTxid, vout: 0, value: 100000, status: { confirmed: true } }]) }
      }
      const { prisma } = require('./src/common/database')
      const { intentEngine } = require('./src/core/intent-engine')
      intentEngine.registerHandler(require('./src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
      require('./src/common/events/handlers').registerEventHandlers()
      const { reconcilePendingSettlements } = require('./src/modules/open-settlement/escrow-settlement-reconciliation.service')
      ;(async () => {
        let laps = 0
        const mine = { recovered: [], resumed: [], failed: [], manual: [] }
        for (; laps < 30; laps++) {
          const r = await reconcilePendingSettlements()
          const id = process.env.P5_ESCROW
          mine.recovered.push(...r.recovered.filter(x => x.escrowId === id).map(x => x.outcome))
          mine.resumed.push(...r.resumedUnclaimed.filter(x => x.escrowId === id).map(x => x.outcome))
          mine.failed.push(...r.failed.filter(x => x.escrowId === id).map(x => x.error))
          mine.manual.push(...r.requiresManualReview.filter(x => x.escrowId === id).map(x => x.reason))
          const row = await prisma.escrow.findUnique({ where: { id }, select: { txReleaseId: true } })
          if (row && row.txReleaseId) break
        }
        await new Promise((res, rej) => process.stdout.write('P5_REPORT:' + JSON.stringify({ laps, posts, ...mine }) + '\n', e => e ? rej(e) : res()))
        await prisma.$disconnect()
        process.exit(0)
      })().catch(async err => { process.stderr.write(String(err.stack || err)); await prisma.$disconnect(); process.exit(1) })
    `
    return await new Promise<{ code: number | null; report: { laps: number; posts: string[]; recovered: string[]; resumed: string[]; failed: string[]; manual: string[] } | null; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['-e', code], {
        cwd: resolvePath(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', P5_ESCROW: escrowId, P5_CHAIN: JSON.stringify({ fundingTxid: chain.fundingTxid, known: [...chain.known], spentBy: chain.spentBy }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''; let err = ''
      child.stdout.on('data', (c: Buffer) => { out += c.toString() })
      child.stderr.on('data', (c: Buffer) => { err += c.toString() })
      const watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fresh-process recovery timeout: ' + err.slice(-1500))) }, 150_000)
      child.on('error', (e) => { clearTimeout(watchdog); reject(e) })
      child.on('close', (c) => {
        clearTimeout(watchdog)
        const line = out.split('\n').find((l) => l.startsWith('P5_REPORT:'))
        done({ code: c, report: line ? JSON.parse(line.slice('P5_REPORT:'.length)) : null, stderr: err.slice(-1500) })
      })
    })
  }

  it('P5-3 real process restart, transaction ALREADY on the network (accepted, answer lost): a fresh OS process converges it and transmits nothing', async () => {
    pg.requirePostgres('P5-3')
    const f = await ambiguousAcceptedRefund('p5-3')
    const before = await escrowOf(f.escrowId)
    const child = await recoverInFreshProcess(f.escrowId)
    observe('P5-3', { before, childCode: child.code, report: child.report, final: await escrowOf(f.escrowId) })
    expect({ code: child.code, stderr: child.stderr }).toEqual({ code: 0, stderr: '' })
    expect(child.report?.posts).toEqual([])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: f.txid })
  })

  it('P5-3b real process restart, nothing accepted (definite refusal): a fresh OS process transmits exactly the round\'s one transaction, once', async () => {
    pg.requirePostgres('P5-3b')
    const f = await locked('p5-3b')
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.sailsBroadcasts = []
    chain.refuseSailsBroadcasts = true
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.refuseSailsBroadcasts = false
    const txid = refundTxid({ round, buyerId: f.buyerId })
    const before = await escrowOf(f.escrowId)
    const child = await recoverInFreshProcess(f.escrowId)
    observe('P5-3b', { before, childCode: child.code, report: child.report, final: await escrowOf(f.escrowId) })
    expect({ code: child.code, stderr: child.stderr }).toEqual({ code: 0, stderr: '' })
    expect(child.report?.posts).toEqual([txid])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: txid })
  })

  /** A fully signed REFUND round whose live finalize was refused (HTTP 503) - left unresolved, whatever state the policy leaves the escrow in. */
  async function signedUnresolvedRefund(suffix: string) {
    const f = await locked(suffix)
    const round = await escrowService.initiateRefund(f.escrowId, f.sellerId)
    chain.refuseSailsBroadcasts = true
    for (const id of round.requiredSigners) await settle(escrowService.submitTransactionSignature(f.escrowId, id, signPsbt(round.unsignedPsbtBase64, keyOf(f, id))))
    chain.refuseSailsBroadcasts = false
    chain.sailsBroadcasts = []
    expect((await escrowOf(f.escrowId)).txReleaseId).toBeNull()
    return { ...f, round }
  }

  it('P5-4 four recovery workers race one fully-signed round: at most one transaction is ever transmitted, the escrow converges', async () => {
    pg.requirePostgres('P5-4')
    const f = await signedUnresolvedRefund('p5-4')
    const workers = [isolatedReconciler(), isolatedReconciler(), isolatedReconciler(), isolatedReconciler()]
    const reports = await Promise.all(workers.map((w) => w()))
    for (let lap = 0; lap < 20 && (await escrowOf(f.escrowId)).txReleaseId === null; lap++) await Promise.all(workers.map((w) => w()))
    const resumed = reports.flatMap((r) => [...r.resumedUnclaimed, ...r.recovered].filter((x) => x.escrowId === f.escrowId))
    observe('P5-4', { resumed: resumed.length, distinct: [...new Set(chain.sailsBroadcasts)].length, total: chain.sailsBroadcasts.length, final: await escrowOf(f.escrowId) })
    expect(resumed.length).toBeGreaterThanOrEqual(1)
    expect([...new Set(chain.sailsBroadcasts)]).toEqual([refundTxid(f)])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: refundTxid(f) })
  })

  it('P5-4b PASS 0 and PASS 1 together: a stuck claim owner plus three workers: still one transaction, converged, the late owner changes nothing', async () => {
    pg.requirePostgres('P5-4b')
    const f = await signedUnresolvedRefund('p5-4b')
    const hold = holdNextBroadcast()
    const owner = settle(restarted!.reconcile())
    await hold.reached
    const workers = [isolatedReconciler(), isolatedReconciler(), isolatedReconciler()]
    await Promise.all(workers.map((w) => w()))
    for (let lap = 0; lap < 20 && (await escrowOf(f.escrowId)).txReleaseId === null; lap++) await Promise.all(workers.map((w) => w()))
    hold.release()
    expect((await owner).ok).toBe(true)
    observe('P5-4b', { distinct: [...new Set(chain.sailsBroadcasts)].length, total: chain.sailsBroadcasts.length, final: await escrowOf(f.escrowId) })
    expect([...new Set(chain.sailsBroadcasts)]).toEqual([refundTxid(f)])
    expect(await escrowOf(f.escrowId)).toEqual({ status: 'REFUNDED', txReleaseId: refundTxid(f) })
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
