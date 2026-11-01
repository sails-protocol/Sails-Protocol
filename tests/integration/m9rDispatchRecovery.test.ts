// tests/integration/m9rDispatchRecovery.test.ts
//
// Sails Core Implementation Program M9-R (Recovery Closure), Part 1 (R1)
// + Part 2 — real-Postgres reproduction of crash window C4 (found during
// the M9 analytical gate: a dispute ruling's Outcome commits durably,
// but the process dies before `initiateRelease/Refund/Split()` ever
// persists the unsigned PSBT) and proof that
// `reconcileMissingDispatch()` resumes it safely, without re-running
// discretionary authority or reinterpreting the ruling.
//
// C4 is reproduced by calling `commitAuthoritativeDisputeRuling()`
// directly and STOPPING there — exactly the same technique
// `disputeOutcomeMultisigLive.test.ts`'s own "P15/replay-resistance"
// test already uses to isolate the record-commit layer from the
// business-workflow layer, applied here to isolate "the commit
// succeeded, dispatch never ran" instead of "two appeal rounds."

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import nacl from 'tweetnacl'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)

function testnetAddress(label: string): string {
  const scalar = createHash('sha256').update(label).digest()
  const pubkey = Buffer.from(ecc.pointFromScalar(scalar, true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.testnet }).address!
}

describe('M9-R — C4 recovery: authorized dispatch that never persisted (real Postgres)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let OpenP2PTradeIntentHandler: any
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let commitAuthoritativeDisputeRuling: typeof import('../../src/modules/open-settlement/dispute-outcome').commitAuthoritativeDisputeRuling
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let DISPATCH_RECOVERY_BATCH: number

  const ARBITER_ID = 'm9r-c4-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')

  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

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
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-c4-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID

    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ reconcileMissingDispatch, DISPATCH_RECOVERY_BATCH } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    // Project the fixtures' escrow transitions as production does (handlers are registered at boot). Without
    // this, every fixture leaves its transitions claimed-but-never-projected in the shared database, where
    // every later PASS 3 (reconcileIncompleteProjections) run has to re-drive them.
    require('../../src/common/events/handlers').registerEventHandlers()

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-R C4 Test Arbiter' },
    })
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  beforeEach(() => {
    realFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  async function makeUndispatchedDisputedEscrow(suffix: string, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    const txid = createHash('sha256').update(`m9r-txid-${suffix}-${Date.now()}`).digest('hex')
    mockExplorerForUtxo(txid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `M9-R C4 test — ${suffix}`)
    expect(dispute.arbiterId).toBe(ARBITER_ID)

    if (ruling === 'RELEASE' || ruling === 'SPLIT') {
      await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`m9r-c4-${suffix}-buyer`))
    }
    if (ruling === 'REFUND' || ruling === 'SPLIT') {
      await payoutAddressService.setPayoutAddress(seller.id, 'BTC', testnetAddress(`m9r-c4-${suffix}-seller`))
    }

    // Reproduces C4 exactly: the atomic Outcome-commit transaction runs
    // and COMMITS (Dispute.status -> RESOLVED, SemanticTransitionRecord
    // inserted) — and nothing else. In the real
    // applyRulingCoreAuthoritative(), the very next lines would call
    // assertDisputeDispatchEligible() then initiateRelease/Refund/Split();
    // this test stops right after the commit, exactly reproducing "the
    // process died before dispatch ever persisted the unsigned PSBT."
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: ruling, buyerBps, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    const disputeRow = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    const commitResult = await commitAuthoritativeDisputeRuling(
      { id: dispute.id, escrowId: escrow.id, status: disputeRow!.status, appealRound: 0 },
      payload, signature, arbiterPublicKeyHex, '100000', 'BTC', buyer.id, seller.id,
    )
    expect(commitResult.committed).toBe(true)

    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id, fundingTxid: txid }
  }

  type DispatchRecoveryReport = import('../../src/modules/open-settlement/dispute-dispatch-recovery').DispatchRecoveryReport

  // Same candidate predicate as dispute-dispatch-recovery.ts's claimCandidates(), counted independently here so
  // the tests below can state the starvation bound (ceil(queued / DISPATCH_RECOVERY_BATCH) sweeps) as a number
  // taken from the real database, not from the implementation under test.
  async function queuedCandidateEscrowIds(): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ escrowId: string }>>`
      SELECT d."escrowId" FROM disputes d JOIN escrows e ON e.id = d."escrowId"
      WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG' AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
          AND (p."disputeId" IS NOT NULL
               OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))
        AND EXISTS (SELECT 1 FROM semantic_transition_records r WHERE r."interactionId" = d."escrowId"
          AND r."transitionType" = 'escrow.dispute.rule' AND r."appealRound" = d."appealRound" AND r."outcomeContent" IS NOT NULL)`
    return rows.map((r) => r.escrowId)
  }

  function mergeReports(reports: DispatchRecoveryReport[]): DispatchRecoveryReport {
    return {
      claimed: reports.flatMap((r) => r.claimed),
      resumed: reports.flatMap((r) => r.resumed),
      alreadyResumedConcurrently: reports.flatMap((r) => r.alreadyResumedConcurrently),
      notEligible: reports.flatMap((r) => r.notEligible),
      guardFailed: reports.flatMap((r) => r.guardFailed),
      failed: reports.flatMap((r) => r.failed),
    }
  }

  // M9-R bounded recovery: one invocation attempts at most DISPATCH_RECOVERY_BATCH candidates, so a test whose
  // escrow may sit behind a backlog (this database is shared and accumulates C4 leftovers across runs) sweeps
  // until that escrow has been claimed - and fails if that takes more sweeps than the starvation bound allows.
  async function sweepUntilClaimed(escrowId: string, sweep: () => Promise<DispatchRecoveryReport[]> = async () => [await reconcileMissingDispatch()]): Promise<DispatchRecoveryReport> {
    const bound = Math.ceil((await queuedCandidateEscrowIds()).length / DISPATCH_RECOVERY_BATCH)
    const reports: DispatchRecoveryReport[] = []
    for (let i = 0; i < bound; i++) {
      const round = await sweep()
      reports.push(...round)
      for (const r of round) expect(r.claimed.length).toBeLessThanOrEqual(DISPATCH_RECOVERY_BATCH)
      if (round.some((r) => r.claimed.includes(escrowId))) return mergeReports(reports)
    }
    throw new Error(`escrow ${escrowId} was not claimed within the starvation bound of ${bound} sweep(s)`)
  }

  it('R1: reproduces C4 — Outcome committed, Dispute RESOLVED, escrow non-terminal, NO pending transaction exists', async () => {
    requirePostgres('R1 reproduction')
    const { escrowId, disputeId } = await makeUndispatchedDisputedEscrow('r1', 'RELEASE')

    const escrowRow = await prisma.escrow.findUnique({ where: { id: escrowId } })
    expect(escrowRow!.status).not.toMatch(/COMPLETED|REFUNDED|SPLIT/)
    const disputeRow = await prisma.dispute.findUnique({ where: { id: disputeId } })
    expect(disputeRow!.status).toBe('RESOLVED')
    const record = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    expect(record).not.toBeNull()
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).toBeNull()

    // The client cannot simply retry — resolveDispute()'s own top-level
    // guard rejects a RESOLVED dispute unconditionally.
    await expect(
      getDisputeService().resolveDispute(disputeId, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, 'irrelevant', new Date().toISOString())
    ).rejects.toThrow(/already resolved/)
  })

  it('RESUME_AUTHORIZED_DISPATCH: RELEASE — resumes using the historical destination, never re-consults current PayoutAddress', async () => {
    requirePostgres('C4 RELEASE recovery')
    const { escrowId, buyerId } = await makeUndispatchedDisputedEscrow('release', 'RELEASE')
    const historicalRecord = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    const historicalDestination = (historicalRecord!.outcomeDestinationBinding as any[])[0].destination

    // Rotate the buyer's CURRENT payout address AFTER the Outcome
    // committed — the resumed dispatch must still use the historical one.
    await payoutAddressService.setPayoutAddress(buyerId, 'BTC', testnetAddress('m9r-release-rotated-after'))

    const report = await sweepUntilClaimed(escrowId)

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'RELEASE' }])
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.toAddress).toBe(historicalDestination)
    expect(pending!.toAddress).not.toBe('m9r-release-rotated-after')
  })

  // Sails Core Implementation Program M8-RF (Destination Consistency,
  // 2026-08-31) — REPLACES the prior version of this test, which
  // documented a real, pre-existing M8-R defect (buildUnsignedRefund()
  // always derived the seller's multisig-pubkey P2WPKH address, ignoring
  // the historical Outcome's own committed seller PayoutAddress
  // destinationBinding entirely) discovered as a byproduct of building
  // C4 recovery. That defect is now fixed at its actual source
  // (dispute.service.ts's applyRulingCoreAuthoritative() now threads the
  // historical sellerDestination into initiateRefund(); multisig.provider.ts's
  // buildUnsignedRefund() now REQUIRES and translates an authorized
  // destination instead of deriving one) — see M8-RF's own final report
  // for the full architectural justification
  // (docs/DESTINATION_AUTHORITY_ARCHITECTURE.md's F′ model already
  // required this; it was simply never applied to REFUND). This is now
  // the PRIMARY regression proof that fix didn't just move the bug: a
  // REFUND ruling's C4 crash (Outcome committed, dispatch never
  // persisted) now RESUMES successfully, using the historical seller
  // destination — never the seller's multisig-key-derived address, and
  // never a live re-read of current PayoutAddress state.
  it('RF-15: RESUME_AUTHORIZED_DISPATCH — REFUND now resumes successfully using the historical seller destination (M8-RF regression proof)', async () => {
    requirePostgres('C4 REFUND recovery — fixed')
    const { escrowId, sellerId } = await makeUndispatchedDisputedEscrow('refund', 'REFUND')
    const historicalRecord = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    const historicalDestination = (historicalRecord!.outcomeDestinationBinding as any[])[0].destination

    // RF-3 — rotate the seller's CURRENT payout address AFTER the
    // Outcome committed; the resumed REFUND must still use the OLD one.
    await payoutAddressService.setPayoutAddress(sellerId, 'BTC', testnetAddress('m8rf-refund-rotated-after'))

    const report = await sweepUntilClaimed(escrowId)

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'REFUND' }])
    expect(report.guardFailed.find((r) => r.escrowId === escrowId)).toBeUndefined()
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.kind).toBe('refund')
    expect(pending!.toAddress).toBe(historicalDestination)
    expect(pending!.toAddress).not.toBe('m8rf-refund-rotated-after')

    // RF-20 — the seller's own multisig-key-derived address (what the
    // OLD, buggy translation would have paid) must NEVER be what the
    // resumed dispatch actually used.
    const sellerKeyDerivedAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(SELLER_PUBKEY, 'hex'), network: bitcoin.networks.testnet }).address
    expect(pending!.toAddress).not.toBe(sellerKeyDerivedAddress)
  })

  it('RESUME_AUTHORIZED_DISPATCH: SPLIT — resumes with the historical buyerBps, never a re-derived one', async () => {
    requirePostgres('C4 SPLIT recovery')
    const { escrowId } = await makeUndispatchedDisputedEscrow('split', 'SPLIT', 6500)

    const report = await sweepUntilClaimed(escrowId)

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'SPLIT' }])
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.buyerBps).toBe(6500)
  })

  it('duplicate workers: two concurrent recovery runs never create two competing pending transactions for the same C4 escrow', async () => {
    requirePostgres('C4 duplicate workers')
    const { escrowId } = await makeUndispatchedDisputedEscrow('concurrent', 'RELEASE')

    const report = await sweepUntilClaimed(escrowId, () => Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()]))

    const resumedTotal = report.resumed.filter((r) => r.escrowId === escrowId).length
    const concurrentTotal = report.alreadyResumedConcurrently.filter((id) => id === escrowId).length
    // Exactly one of the two runs actually created the pending row for
    // this escrow; the other observed either "already exists" (lost the
    // pre-check) or "concurrent initiate" (lost the P2002 race inside the
    // lock) — never two successful creations.
    expect(resumedTotal + concurrentTotal).toBeGreaterThanOrEqual(1)
    expect(resumedTotal).toBe(1)
    const pendingRows = await prisma.escrowPendingTransaction.findMany({ where: { escrowId } })
    expect(pendingRows).toHaveLength(1)
  })

  it('a dispute whose ruling took the LEGACY (non-Core-authoritative) path is not a candidate at all — no durable Outcome exists for it', async () => {
    requirePostgres('legacy dispute is not a C4 candidate')
    // A RESOLVED dispute with no SemanticTransitionRecord at all (never
    // went through commitAuthoritativeDisputeRuling()) must be silently
    // excluded — this module's candidate query itself checks
    // `row.outcomeContent`, not just `Dispute.status === 'RESOLVED'`.
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)) })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'legacy', arbiterId: seller.id, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() },
    })

    const report = await reconcileMissingDispatch()
    expect(report.claimed).not.toContain(escrow.id)
    expect(report.resumed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.notEligible.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.failed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
  })
  // ─── M9-R bounded recovery: finite passes, fair order, convergence ─────────────────────────────────────────
  //
  // Every fixture below is a real C4 state built through the real services (makeUndispatchedDisputedEscrow).
  // Only the chain explorer is simulated, and only to decide which funding outpoints "exist": a dispatch can
  // succeed only if the explorer returns the escrow's own txLockId, so an escrow whose outpoint is withheld
  // fails deterministically and fast - a permanently failing candidate, with no real network involved.

  function mockExplorerWithFundedOutpoints(fundingTxids: string[]): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes('/tx/') && url.endsWith('/status')) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => fundingTxids.map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } })) } as any
    }) as any
  }

  function mockExplorerOutage(): void {
    global.fetch = jest.fn(async () => { throw new Error('explorer unreachable (simulated outage)') }) as any
  }

  interface IndependentWorker {
    sweep: (limit?: number) => Promise<DispatchRecoveryReport>
    shutdown: () => Promise<void>
  }

  // A genuinely independent module graph: its own PrismaClient (own connection pool), its own Redis client and
  // its own module singletons - the same technique feeBroadcastCrashConsistency.test.ts uses for "genuine
  // restart". What it shares with the test's own graph is only PostgreSQL, which is the property under test.
  function loadIndependentWorker(): IndependentWorker {
    let worker!: IndependentWorker
    jest.isolateModules(() => {
      const recovery = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      worker = {
        sweep: (limit?: number) => recovery.reconcileMissingDispatch(limit),
        shutdown: async () => {
          await db.prisma.$disconnect()
          await redisModule.redis?.quit?.().catch(() => undefined)
        },
      }
    })
    return worker
  }

  async function historicalDestination(escrowId: string): Promise<string> {
    const record = await prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId: escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
    })
    return (record!.outcomeDestinationBinding as any[])[0].destination
  }

  it('STARVATION: recoverable candidates queued behind more than a full batch of permanently failing ones are all resumed within ceil(queued / batch) sweeps, and no candidate is claimed twice before every queued candidate was claimed once', async () => {
    requirePostgres('bounded recovery - starvation')
    const poison = []
    for (let i = 0; i < DISPATCH_RECOVERY_BATCH + 2; i++) poison.push(await makeUndispatchedDisputedEscrow(`poison-${i}`, 'RELEASE'))
    const good = []
    for (let i = 0; i < 3; i++) good.push(await makeUndispatchedDisputedEscrow(`good-${i}`, 'RELEASE'))
    const goodIds = good.map((g) => g.escrowId)
    const poisonIds = poison.map((p) => p.escrowId)

    const queued = await queuedCandidateEscrowIds()
    expect(queued).toEqual(expect.arrayContaining([...poisonIds, ...goodIds]))
    // The dataset is adversarial for a naive oldest-first LIMIT: at least one full batch of candidates that can
    // never succeed resolved before every recoverable one, so "ORDER BY resolvedAt LIMIT batch" would retry
    // the same failing batch forever and never reach the recoverable candidates.
    const [{ n: olderThanGood }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM disputes WHERE "escrowId" = ANY(${queued})
        AND "resolvedAt" < (SELECT min("resolvedAt") FROM disputes WHERE "escrowId" = ANY(${goodIds}))`
    expect(Number(olderThanGood)).toBeGreaterThanOrEqual(DISPATCH_RECOVERY_BATCH)

    mockExplorerWithFundedOutpoints(good.map((g) => g.fundingTxid))
    const bound = Math.ceil(queued.length / DISPATCH_RECOVERY_BATCH)
    const reports: DispatchRecoveryReport[] = []
    for (let i = 0; i < bound; i++) {
      const report = await reconcileMissingDispatch()
      expect(report.claimed.length).toBeLessThanOrEqual(DISPATCH_RECOVERY_BATCH)
      reports.push(report)
    }

    // Round-robin: the first queued.length claims are exactly the queued candidates, each once.
    const firstCycle = reports.flatMap((r) => r.claimed).slice(0, queued.length)
    expect(firstCycle).toHaveLength(queued.length)
    expect(new Set(firstCycle)).toEqual(new Set(queued))

    const merged = mergeReports(reports)
    for (const id of goodIds) {
      expect(merged.resumed.filter((r) => r.escrowId === id)).toHaveLength(1)
      expect(await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })).toHaveLength(1)
    }
    for (const id of poisonIds) {
      expect(merged.resumed.find((r) => r.escrowId === id)).toBeUndefined()
      expect(merged.failed.find((f) => f.escrowId === id)).toBeDefined() // explicit failure, never silent
      expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: id } })).toBeNull()
    }

    // The failure cause goes away (the outpoints become visible): the same repeated sweeps converge the
    // previously failing candidates too, each exactly once, within the same kind of bound.
    mockExplorerWithFundedOutpoints(poison.map((p) => p.fundingTxid))
    const recoveryBound = Math.ceil((await queuedCandidateEscrowIds()).length / DISPATCH_RECOVERY_BATCH)
    const recovery: DispatchRecoveryReport[] = []
    for (let i = 0; i < recoveryBound; i++) recovery.push(await reconcileMissingDispatch())
    const recovered = mergeReports(recovery)
    for (const id of poisonIds) {
      expect(recovered.resumed.filter((r) => r.escrowId === id)).toHaveLength(1)
      expect(await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })).toHaveLength(1)
    }
    for (const id of goodIds) expect(recovered.claimed).not.toContain(id) // already dispatched: never claimed again
  })

  it('CONCURRENCY + BACKLOG > BATCH: two independent worker graphs sweeping the same PostgreSQL state concurrently converge every candidate with exactly one durable dispatch each, at its historical destination', async () => {
    requirePostgres('bounded recovery - concurrent independent workers')
    const items = []
    for (let i = 0; i < DISPATCH_RECOVERY_BATCH + 3; i++) items.push(await makeUndispatchedDisputedEscrow(`conc-${i}`, 'RELEASE'))
    const ids = items.map((i) => i.escrowId)
    const destinations = new Map<string, string>()
    for (const id of ids) destinations.set(id, await historicalDestination(id))
    mockExplorerWithFundedOutpoints(items.map((i) => i.fundingTxid))

    const workerA = loadIndependentWorker()
    const workerB = loadIndependentWorker()
    try {
      const bound = Math.ceil((await queuedCandidateEscrowIds()).length / DISPATCH_RECOVERY_BATCH)
      const reports: DispatchRecoveryReport[] = []
      let rounds = 0
      while (rounds < bound) {
        rounds++
        const [a, b] = await Promise.all([workerA.sweep(), workerB.sweep()])
        expect(a.claimed.length).toBeLessThanOrEqual(DISPATCH_RECOVERY_BATCH)
        expect(b.claimed.length).toBeLessThanOrEqual(DISPATCH_RECOVERY_BATCH)
        reports.push(a, b)
        if (await prisma.escrowPendingTransaction.count({ where: { escrowId: { in: ids } } }) === ids.length) break
      }
      expect(rounds).toBeLessThanOrEqual(bound)

      const merged = mergeReports(reports)
      for (const id of ids) {
        const pending = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })
        expect(pending).toHaveLength(1)
        expect(pending[0].toAddress).toBe(destinations.get(id))
        expect(merged.resumed.filter((r) => r.escrowId === id)).toHaveLength(1)
      }
    } finally {
      await workerA.shutdown()
      await workerB.shutdown()
    }
  })

  it('RESTART: a worker graph that dispatched part of a backlog, then claimed more during an explorer outage and was discarded, is converged by a fresh independent graph reading only durable state - nothing lost, nothing dispatched twice', async () => {
    requirePostgres('bounded recovery - restart')
    const items = []
    for (let i = 0; i < DISPATCH_RECOVERY_BATCH + 2; i++) items.push(await makeUndispatchedDisputedEscrow(`restart-${i}`, 'RELEASE'))
    const ids = items.map((i) => i.escrowId)
    mockExplorerWithFundedOutpoints(items.map((i) => i.fundingTxid))

    const first = loadIndependentWorker()
    const firstReports: DispatchRecoveryReport[] = []
    try {
      // Partial progress: sweep until at least one of these escrows has been dispatched.
      const bound = Math.ceil((await queuedCandidateEscrowIds()).length / DISPATCH_RECOVERY_BATCH)
      for (let i = 0; i < bound && !firstReports.some((r) => r.resumed.some((x) => ids.includes(x.escrowId))); i++) {
        firstReports.push(await first.sweep())
      }
      expect(firstReports.some((r) => r.resumed.some((x) => ids.includes(x.escrowId)))).toBe(true)

      // The explorer goes down: the next sweep's claims commit durably, but no dispatch can happen.
      mockExplorerOutage()
      const duringOutage = await first.sweep()
      firstReports.push(duringOutage)
      expect(duringOutage.claimed.some((id) => ids.includes(id))).toBe(true)
      expect(duringOutage.resumed).toEqual([])
    } finally {
      await first.shutdown() // the first worker is gone; only PostgreSQL survives
    }

    const dispatchedByFirst = new Set(mergeReports(firstReports).resumed.map((r) => r.escrowId))
    expect(ids.filter((id) => !dispatchedByFirst.has(id)).length).toBeGreaterThan(0)

    mockExplorerWithFundedOutpoints(items.map((i) => i.fundingTxid))
    const second = loadIndependentWorker()
    try {
      const bound = Math.ceil((await queuedCandidateEscrowIds()).length / DISPATCH_RECOVERY_BATCH)
      const secondReports: DispatchRecoveryReport[] = []
      for (let i = 0; i < bound; i++) {
        secondReports.push(await second.sweep())
        if (await prisma.escrowPendingTransaction.count({ where: { escrowId: { in: ids } } }) === ids.length) break
      }
      const secondMerged = mergeReports(secondReports)
      for (const id of dispatchedByFirst) expect(secondMerged.claimed).not.toContain(id)
      const all = mergeReports([...firstReports, ...secondReports])
      for (const id of ids) {
        expect(await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })).toHaveLength(1)
        expect(all.resumed.filter((r) => r.escrowId === id)).toHaveLength(1)
      }
    } finally {
      await second.shutdown()
    }
  })
  // ─── M9-R/C4 production wiring: the real scheduled tick, real PostgreSQL ───────────────────────────────────
  //
  // Each "node" below is an independent module graph running the exact tick startServer() schedules
  // (settlement-recovery-schedule.ts: reconcilePendingSettlements() then reconcileMissingDispatch()), on a
  // real timer, with its own PrismaClient, Redis client and event handlers (registered as buildApp() does at
  // boot). Nothing calls reconcileMissingDispatch() directly: every dispatch below was started by the schedule.

  interface ScheduledNode {
    log: { warn: jest.Mock; error: jest.Mock; info: jest.Mock; debug: jest.Mock }
    stop: () => Promise<void>
    shutdown: () => Promise<void>
  }

  const TICK_MS = 250

  function startScheduledNode(): ScheduledNode {
    let node!: ScheduledNode
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      const { startSettlementRecoverySchedule } = require('../../src/modules/open-settlement/settlement-recovery-schedule')
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      const log = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
      const schedule = startSettlementRecoverySchedule(log, TICK_MS)
      node = {
        log,
        stop: () => schedule.stop(),
        shutdown: async () => {
          await schedule.stop() // same order as startServer()'s SIGTERM: stop, drain the running tick, then disconnect
          await db.prisma.$disconnect()
          await redisModule.redis?.quit?.().catch(() => undefined)
        },
      }
    })
    return node
  }

  async function waitUntil(cond: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
    const end = Date.now() + deadlineMs
    while (Date.now() < end) {
      if (await cond()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return cond()
  }

  const allDispatched = (ids: string[]) => async () =>
    (await prisma.escrowPendingTransaction.count({ where: { escrowId: { in: ids } } })) === ids.length

  it('WIRING: with no direct call, the production schedule hands a C4 escrow to reconcileMissingDispatch() and it converges to exactly one dispatch at its historical destination', async () => {
    requirePostgres('C4 production schedule - eventual recovery')
    const { escrowId } = await makeUndispatchedDisputedEscrow('scheduled', 'RELEASE')
    const destination = await historicalDestination(escrowId)
    mockExplorerWithFundedOutpoints([(await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })).txLockId!])

    const node = startScheduledNode()
    try {
      expect(await waitUntil(allDispatched([escrowId]), 90_000)).toBe(true)
    } finally {
      await node.shutdown()
    }
    const pending = await prisma.escrowPendingTransaction.findMany({ where: { escrowId } })
    expect(pending).toHaveLength(1)
    expect(pending[0].toAddress).toBe(destination)
    expect(node.log.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'C4 dispatch recovery completed with findings', module: 'dispute-dispatch-recovery' }))
    expect(node.log.error).not.toHaveBeenCalledWith(expect.objectContaining({ msg: 'C4 dispatch recovery failed' }))
  })

  it('WIRING RESTART: a node whose ticks fail through an explorer outage keeps running (failures logged, never thrown), is shut down, and a restarted node converges the same durable state', async () => {
    requirePostgres('C4 production schedule - outage then restart')
    const items = []
    for (let i = 0; i < 3; i++) items.push(await makeUndispatchedDisputedEscrow(`sched-restart-${i}`, 'RELEASE'))
    const ids = items.map((i) => i.escrowId)

    mockExplorerOutage()
    const first = startScheduledNode()
    let claimedDuringOutage = false
    try {
      // The outage node keeps ticking; its claims commit durably but no dispatch can happen.
      claimedDuringOutage = await waitUntil(async () => {
        const rows = await prisma.dispute.findMany({ where: { escrowId: { in: ids } }, select: { dispatchRecoveryAttemptedAt: true } })
        return rows.every((r) => r.dispatchRecoveryAttemptedAt !== null)
      }, 90_000)
    } finally {
      await first.shutdown()
    }
    expect(claimedDuringOutage).toBe(true)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: { in: ids } } })).toBe(0)
    expect(first.log.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'C4 dispatch recovery completed with findings', failed: expect.any(Number) }))

    // Restart: a brand-new node (new module graph, new pool), explorer back.
    mockExplorerWithFundedOutpoints(items.map((i) => i.fundingTxid))
    const second = startScheduledNode()
    try {
      expect(await waitUntil(allDispatched(ids), 90_000)).toBe(true)
    } finally {
      await second.shutdown()
    }
    for (const id of ids) expect(await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })).toHaveLength(1)
  })

  it('WIRING MULTI-INSTANCE: two nodes running the production schedule concurrently over a backlog larger than one batch leave exactly one durable dispatch per escrow', async () => {
    requirePostgres('C4 production schedule - two instances')
    const items = []
    for (let i = 0; i < DISPATCH_RECOVERY_BATCH + 2; i++) items.push(await makeUndispatchedDisputedEscrow(`sched-multi-${i}`, 'RELEASE'))
    const ids = items.map((i) => i.escrowId)
    const destinations = new Map<string, string>()
    for (const id of ids) destinations.set(id, await historicalDestination(id))
    mockExplorerWithFundedOutpoints(items.map((i) => i.fundingTxid))

    const nodeA = startScheduledNode()
    const nodeB = startScheduledNode()
    try {
      expect(await waitUntil(allDispatched(ids), 90_000)).toBe(true)
    } finally {
      await Promise.all([nodeA.shutdown(), nodeB.shutdown()])
    }
    for (const id of ids) {
      const pending = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: id } })
      expect(pending).toHaveLength(1)
      expect(pending[0].toAddress).toBe(destinations.get(id))
    }
    for (const node of [nodeA, nodeB]) expect(node.log.error).not.toHaveBeenCalledWith(expect.objectContaining({ msg: 'C4 dispatch recovery failed' }))
  })
})
