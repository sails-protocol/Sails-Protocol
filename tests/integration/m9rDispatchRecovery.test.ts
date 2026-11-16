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
import type { DispatchRecoveryReport } from '../../src/modules/open-settlement/dispute-dispatch-recovery'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import nacl from 'tweetnacl'
import * as H from './pendingRoundLifecycleHarness'

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
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-R C4 Test Arbiter' },
    })
  })

  // The client and the Redis connection are closed once, by the file-level afterAll at the end of this file:
  // the #343 keyset describe below shares them.

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
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER',
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

    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id }
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

    const report = await reconcileMissingDispatch()

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

    const report = await reconcileMissingDispatch()

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

    const report = await reconcileMissingDispatch()

    expect(report.resumed).toEqual([{ escrowId, disputeId: expect.any(String), ruling: 'SPLIT' }])
    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    expect(pending).not.toBeNull()
    expect(pending!.buyerBps).toBe(6500)
  })

  it('duplicate workers: two concurrent recovery runs never create two competing pending transactions for the same C4 escrow', async () => {
    requirePostgres('C4 duplicate workers')
    const { escrowId } = await makeUndispatchedDisputedEscrow('concurrent', 'RELEASE')

    const [reportA, reportB] = await Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()])

    const resumedTotal = reportA.resumed.length + reportB.resumed.length
    const concurrentTotal = reportA.alreadyResumedConcurrently.length + reportB.alreadyResumedConcurrently.length
    // Exactly one of the two runs actually created the pending row for
    // this escrow; the other observed either "already exists" (lost the
    // pre-check) or "concurrent initiate" (lost the P2002 race inside the
    // lock) — never two successful creations.
    expect(resumedTotal + concurrentTotal).toBeGreaterThanOrEqual(1)
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
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'legacy', arbiterId: seller.id, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() },
    })

    const report = await reconcileMissingDispatch()
    expect(report.resumed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.notEligible.find((r) => r.escrowId === escrow.id)).toBeUndefined()
    expect(report.failed.find((r) => r.escrowId === escrow.id)).toBeUndefined()
  })

  // Issue #343 - the work follows unresolved C4 cases, not retained history: RESOLVED disputes on a non-terminal
  // MULTISIG escrow whose dispatch already persisted, or whose ruling never took the Core path, are never loaded.
  it('#343 bounded discovery: 150 historical non-C4 disputes are never materialized; the one real C4 case is resumed once', async () => {
    requirePostgres('#343 bounded discovery')
    const NOISE = 150
    const host = await makeUndispatchedDisputedEscrow('343-host', 'RELEASE')
    expect((await reconcileMissingDispatch()).resumed.map((r) => r.escrowId)).toContain(host.escrowId) // now dispatched

    // Unrelated history on the host escrow: half carry the host's ruling round (dispatch persisted, dispute-bound),
    // half a round with no Core record (legacy). Each needs its own trade (Dispute.tradeId is unique).
    const cols = (await prisma.$queryRaw<Array<{ c: string }>>`
      SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'trades' AND column_name NOT IN ('id', 'escrowId')`)
      .map((r) => `"${r.c}"`).join(', ')
    const ids = Array.from({ length: NOISE }, (_, i) => `m9r-343-noise-${Date.now()}-${i}`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO trades ("id", ${cols}) SELECT n, ${cols} FROM trades, unnest($1::text[]) AS n WHERE trades.id = $2`, ids, host.tradeId)
    await prisma.dispute.createMany({
      data: ids.map((tradeId, i) => ({ tradeId, escrowId: host.escrowId, openedBy: host.buyerId, reason: 'history', arbiterId: ARBITER_ID, status: 'RESOLVED' as const, ruling: 'RELEASE' as const, resolvedAt: new Date(), appealRound: i % 2 === 0 ? 0 : 7 })),
    })

    const real = await makeUndispatchedDisputedEscrow('343-real', 'REFUND')
    const findMany = prisma.dispute.findMany.bind(prisma.dispute)
    const loaded: Array<{ escrowId: string }> = []
    jest.spyOn(prisma.dispute, 'findMany').mockImplementation(((args: any) =>
      findMany(args).then((rows: any[]) => { loaded.push(...rows); return rows })) as never)

    const report = await reconcileMissingDispatch()
    expect(report.resumed).toContainEqual({ escrowId: real.escrowId, disputeId: real.disputeId, ruling: 'REFUND' })
    expect(loaded.filter((d) => d.escrowId === host.escrowId)).toEqual([])
    expect(loaded.length).toBeLessThan(NOISE)

    loaded.length = 0
    const again = await reconcileMissingDispatch()
    expect(again.resumed.find((r) => r.escrowId === real.escrowId)).toBeUndefined()
    expect(loaded.filter((d) => d.escrowId === real.escrowId || d.escrowId === host.escrowId)).toEqual([])
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: real.escrowId } })).toBe(1)
    jest.restoreAllMocks()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Issue #343 - keyset pagination of the recovery, across more than one page. The suite above proves the bounded query
// on ONE real C4 case among noise; this one proves the behaviour BETWEEN pages, which one case never reaches: more than
// 100 eligible candidates, so the cursor (`d.id > afterId`, 100 per page) is crossed.
//
//   K1  every eligible candidate is read exactly once across the pages - none omitted, none loaded twice, the cursor
//       strictly increasing, the number of page queries what the page sizes imply (including the empty last page);
//   K2  the recovery is idempotent: a second run loads nothing and creates nothing;
//   K3  history that is not recovery work is never loaded and never touched (settled, legacy, already dispatched, and
//       a fully signed cooperative round);
//   K4  #239: a cooperative round that is still missing a signature is superseded by the ruling, also across a page
//       boundary; a fully signed one is not a candidate at all;
//   K5  failures in the middle of a run (a throwing dispatch, a conflict, a guard failure, a crash right after the
//       dispatch persisted) never lose the other candidates and never produce a second disposition: a later run
//       finishes exactly the unresolved ones;
//   K6  two reconcilers racing through the same pages resume each escrow once.
//
// "No economic double disposition": every candidate ends with exactly ONE pending round (the table is unique per
// escrow), no transaction is ever broadcast, no escrow leaves its non-terminal state and none records a release txid.
//
// LIMITS: only the explorer is simulated (pendingRoundLifecycleHarness.ts); nothing here moves funds or signs for a
// real counterparty. The page size (100) is the production constant of dispute-dispatch-recovery.ts, restated here;
// the first assertion of K1 fails if it changes. The database may hold candidates of other suites: everything is asserted
// about THIS describe's escrows, and the assertions about pages hold for any database.
const PAGE = 100
type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'
const RULINGS: Ruling[] = ['RELEASE', 'REFUND', 'SPLIT']
interface Case { escrowId: string; disputeId: string; ruling: Ruling; roundId?: string }

describe('Issue #343 - M9-R dispatch recovery across keyset pages (real PostgreSQL, real PSBTs)', () => {
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: any
  let identityService: any
  let liquidityRouter: any
  let tradeService: any
  let payoutAddressService: any
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let commitAuthoritativeDisputeRuling: typeof import('../../src/modules/open-settlement/dispute-outcome').commitAuthoritativeDisputeRuling
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let EscrowError: typeof import('../../src/common/errors').EscrowError
  let guard: typeof import('../../src/modules/open-settlement/dispatch-translation-guard')

  // The trusted-arbiter configuration is read once per process, by whichever describe of this file loads the services first:
  // both use the same arbiter id, each with its own key (the first describe has finished when this one starts).
  const ARBITER_ID = 'm9r-c4-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  let chain: H.Chain
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'm9r-343-keyset-seed'
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
    ;({ EscrowError } = require('../../src/common/errors'))
    guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbiterPublicKeyHex }, create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'M9-R #343 keyset arbiter' } })
    chain = H.newChain()
    realFetch = global.fetch
    global.fetch = H.explorer(chain)
  }, 120_000)

  afterEach(() => { jest.restoreAllMocks() })

  // ISOLATION BETWEEN SUITES ONLY - this proves nothing about ruling finalization or recovery.
  // What this describe builds is permanent state in the database that the PostgreSQL lane shares with every later suite, and
  // the finalization sweep (200 per call, oldest first) pages through it: its committed rulings were never finalized (they are
  // built by commitAuthoritativeDisputeRuling(), not resolveDispute()), so left alone they sit in front of every later suite's
  // own deferred ruling (rulingFinalizationEligibility D11-R/D12 stopped seeing theirs when this suite had ~300 of them).
  // Hence two things. The population is kept small (101 eligible candidates: just over one page; the same population serves
  // every test) because its volume is paid by every later suite as output the jest process keeps in memory. And afterAll
  // records, for exactly the disputes this describe created - all raised with the reason prefix '#343 '; the unrelated history
  // disputes of the first describe are not touched - the claim a real finalization writes. afterAll runs whether the tests
  // passed or failed; a process killed before it (timeout, out of memory) skips it.
  afterAll(async () => {
    if (!dbAvailable) return
    global.fetch = realFetch
    const mine = await prisma.dispute.findMany({ where: { reason: { startsWith: '#343 ' } }, select: { id: true, appealRound: true } })
    await prisma.eventProjectionClaim.createMany({ data: mine.map((d) => ({ eventId: d.id, projectionKey: 'dispute.ruling-finalized', subjectId: String(d.appealRound) })), skipDuplicates: true })
  })

  // ─── fixtures: real participants, real MULTISIG escrow funded through the production services ───────────────
  const deps = () => ({ prisma, escrowService, identityService, liquidityRouter, tradeService, payoutAddressService })

  async function funded(label: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, H.BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, H.SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const { createHash } = require('crypto')
    const funding = createHash('sha256').update(`m9r-343-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding)
    chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id)
    chain.locking = null
    return { escrow, trade, buyer, seller }
  }

  /** Commits the Core ruling and STOPS: exactly crash window C4 (Outcome durable, dispatch never persisted). */
  async function commitRuling(c: { escrow: { id: string }; buyer: { id: string }; seller: { id: string } }, disputeId: string, ruling: Ruling) {
    const buyerBps = ruling === 'SPLIT' ? 6500 : null
    const payload: AuthorityDecisionPayload = { disputeId, escrowId: c.escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: ruling, buyerBps, issuedAt: new Date().toISOString() }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })
    const result = await commitAuthoritativeDisputeRuling({ id: disputeId, escrowId: c.escrow.id, status: row.status, appealRound: 0 }, payload, signature, arbiterPublicKeyHex, '100000', 'BTC', c.buyer.id, c.seller.id)
    expect(result.committed).toBe(true)
  }

  async function payoutsFor(c: { escrow: { id: string }; buyer: { id: string }; seller: { id: string } }, ruling: Ruling) {
    if (ruling !== 'REFUND') await payoutAddressService.setPayoutAddress(c.buyer.id, 'BTC', H.testnetAddress(`${c.escrow.id}-b`))
    if (ruling !== 'RELEASE') await payoutAddressService.setPayoutAddress(c.seller.id, 'BTC', H.testnetAddress(`${c.escrow.id}-s`))
  }

  /** An undispatched C4 case on an ordinary funded escrow. */
  async function c4(label: string, ruling: Ruling): Promise<Case> {
    const c = await funded(label)
    const dispute = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, `#343 ${label}`)
    expect(dispute.arbiterId).toBe(ARBITER_ID)
    await payoutsFor(c, ruling)
    await commitRuling(c, dispute.id, ruling)
    return { escrowId: c.escrow.id, disputeId: dispute.id, ruling }
  }

  /** #239: a cooperative round with ONE of two signatures, then the dispute, then a committed ruling that never dispatched. */
  async function c4OverCooperativeRound(label: string, signatures: 1 | 2): Promise<Case> {
    const c = await H.buildCooperative(deps(), chain, label, 'release')
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: c.escrow.id } })
    if (signatures === 1) {
      await escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, H.signRound(round.unsignedPsbtBase64, H.buyerKey))
    } else {
      const { sellerKey } = H
      for (const [id, key] of [[c.buyer.id, H.buyerKey], [c.seller.id, H.sellerKey]] as const) {
        await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: id, signedPsbtBase64: H.signRound(round.unsignedPsbtBase64, key) } })
      }
    }
    const dispute = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, `#343 ${label}`)
    await payoutsFor(c, 'RELEASE')
    await commitRuling(c, dispute.id, 'RELEASE')
    return { escrowId: c.escrow.id, disputeId: dispute.id, ruling: 'RELEASE', roundId: round.id }
  }

  // ─── observation of the pages ──────────────────────────────────────────────────────────────────────────────
  /** Which dispute ids each page loaded, and which cursor each page query was given - read from the real calls. */
  function observe() {
    const pages: string[][] = []
    const cursors: string[] = []
    const findMany = prisma.dispute.findMany.bind(prisma.dispute)
    jest.spyOn(prisma.dispute, 'findMany').mockImplementation(((args: any) =>
      findMany(args).then((rows: any[]) => { if (args?.where?.id?.in) pages.push(rows.map((r) => r.id)); return rows })) as never)
    const queryRaw = (prisma.$queryRaw as any).bind(prisma)
    jest.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (Array.isArray(strings) && strings.join('?').includes('FROM disputes d')) cursors.push(String(values[1]))
      return queryRaw(strings, ...values)
    }) as never)
    return { pages, cursors }
  }

  const pendingRows = (escrowIds: string[]) => prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: escrowIds } }, orderBy: { escrowId: 'asc' } })
  const sorted = (cases: Case[]) => [...cases].sort((a, b) => (a.disputeId < b.disputeId ? -1 : 1))
  const ids = (cases: Case[]) => cases.map((c) => c.escrowId)

  /** The invariants of every run: no broadcast, no escrow terminal, no release txid, one pending round per escrow. */
  async function expectNoEconomicDisposition(cases: Case[]) {
    expect(chain.broadcasts).toEqual([])
    const escrows = await prisma.escrow.findMany({ where: { id: { in: ids(cases) } } })
    expect(escrows.every((e) => !['COMPLETED', 'REFUNDED', 'SPLIT'].includes(e.status) && e.txReleaseId === null)).toBe(true)
    const rows = await pendingRows(ids(cases))
    expect(new Set(rows.map((r) => r.escrowId)).size).toBe(rows.length)
  }

  // ═════════════════════ one population, several runs ═══════════════════════════════════════════════════════════
  // 101 eligible candidates (just over one page: the cursor is crossed once) and 6 excluded histories, built once and used by
  // every test below, in order: K6 races two reconcilers through them, K4 reads what that did to the cooperative rounds, then
  // the pending rounds of the first run are removed (the deletion the guard-failure path itself performs) so that K5/K1/K2
  // can run the same candidates again under failures.
  describe('K1-K6: 101 eligible candidates (96 plain + 5 over a cooperative round), 6 excluded histories', () => {
    const PLAIN = 96
    const COOP = 5
    let plain: Case[] = []
    let coop: Case[] = []
    let fullySigned: Case
    let excluded: { settled: Case[]; legacy: Case[]; dispatched: Case[] } = { settled: [], legacy: [], dispatched: [] }
    let eligible: Case[] = []
    let dispatchedBefore: Array<{ escrowId: string; id: string }> = []

    beforeAll(async () => {
      if (!dbAvailable) return
      for (let i = 0; i < PLAIN; i++) plain.push(await c4(`p${i}`, RULINGS[i % 3]))
      for (let i = 0; i < COOP; i++) coop.push(await c4OverCooperativeRound(`coop${i}`, 1))
      eligible = [...plain, ...coop]

      // Histories that are NOT recovery work, each of a different kind (K3).
      for (let i = 0; i < 2; i++) { // settled: the escrow is terminal although a ruling record exists
        const s = await c4(`settled${i}`, 'RELEASE')
        await prisma.escrow.update({ where: { id: s.escrowId }, data: { status: 'COMPLETED' } })
        excluded.settled.push(s)
      }
      for (let i = 0; i < 2; i++) { // legacy: RESOLVED with no Core record at all
        const c = await funded(`legacy${i}`)
        const dispute = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, `#343 legacy${i}`)
        await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() } })
        excluded.legacy.push({ escrowId: c.escrow.id, disputeId: dispute.id, ruling: 'RELEASE' })
      }
      { // already dispatched: the live ruling path persisted its round, bound to its dispute
        const c = await funded('live0')
        const dispute = await getDisputeService().raiseDispute(c.trade.id, c.buyer.id, '#343 live0')
        await payoutsFor(c, 'RELEASE')
        const issuedAt = new Date().toISOString()
        const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: c.escrow.id, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt }
        await getDisputeService().resolveDispute(dispute.id, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt)
        excluded.dispatched.push({ escrowId: c.escrow.id, disputeId: dispute.id, ruling: 'RELEASE' })
      }
      fullySigned = await c4OverCooperativeRound('fully-signed', 2) // #239: every signature present - never superseded
      dispatchedBefore = (await pendingRows([...ids(excluded.dispatched), fullySigned.escrowId])).map((r) => ({ escrowId: r.escrowId, id: r.id }))
      expect(dispatchedBefore).toHaveLength(2)
    }, 3_600_000)

    const allExcluded = () => [...excluded.settled, ...excluded.legacy, ...excluded.dispatched, fullySigned]
    let firstRunResumed: string[] = []
    const inject = { generic: new Set<string>(), conflict: new Set<string>(), crash: new Set<string>() }
    let guardFailedEscrow: string | undefined

    it('K6: two reconcilers racing through the pages resume each of the 101 candidates exactly once, and load none of the excluded histories', async () => {
      pg.requirePostgres('K6')
      const seen = observe()
      const [a, b] = await Promise.all([reconcileMissingDispatch(), reconcileMissingDispatch()])
      const mine = new Set(ids(eligible))
      const resumed = [...a.resumed, ...b.resumed].map((r) => r.escrowId).filter((id) => mine.has(id))
      process.stdout.write(`[evidence] ${JSON.stringify({ label: 'K6 two reconcilers', candidates: eligible.length, resumedByA: a.resumed.filter((r) => mine.has(r.escrowId)).length, resumedByB: b.resumed.filter((r) => mine.has(r.escrowId)).length, benignConflicts: [...a.alreadyResumedConcurrently, ...b.alreadyResumedConcurrently].filter((id) => mine.has(id)).length })}\n`)
      expect(resumed).toHaveLength(eligible.length) // none lost
      expect(new Set(resumed).size).toBe(eligible.length) // none twice
      expect([...a.failed, ...b.failed].filter((f) => mine.has(f.escrowId))).toEqual([])
      expect([...a.guardFailed, ...b.guardFailed].filter((f) => mine.has(f.escrowId))).toEqual([])
      const loaded = seen.pages.flat()
      for (const c of eligible) expect(loaded).toContain(c.disputeId) // every candidate was read by someone
      for (const e of allExcluded()) expect(loaded).not.toContain(e.disputeId) // K3: no history was
      expect(await pendingRows(ids(eligible))).toHaveLength(eligible.length)
      await expectNoEconomicDisposition(eligible)
    }, 1_800_000)

    it('K4 (#239): each cooperative round with a signature missing was superseded by its ruling, once; the fully signed one was not touched', async () => {
      pg.requirePostgres('K4')
      for (const c of coop) {
        const retirements = await prisma.escrowPendingRoundRetirement.findMany({ where: { escrowId: c.escrowId } })
        expect(retirements).toHaveLength(1)
        expect(retirements[0]).toMatchObject({ pendingOperationId: c.roundId, reason: 'SUPERSEDED_BY_RULING', disputeId: c.disputeId, appealRound: 0 })
        const live = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: c.escrowId } })
        expect(live.id).not.toBe(c.roundId) // a new round
        expect(live.id).toBe(retirements[0].supersedingPendingOperationId)
        expect(live.disputeId).toBe(c.disputeId)
      }
      const still = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: fullySigned.escrowId }, include: { signatures: true } })
      expect(still.id).toBe(fullySigned.roundId)
      expect(still.signatures).toHaveLength(2)
      expect(await prisma.escrowPendingRoundRetirement.count({ where: { escrowId: fullySigned.escrowId } })).toBe(0)
    }, 120_000)

    it('K5 + K1: failures in the middle of a run (a throwing dispatch, a conflict, a guard failure, a crash after persisting) lose no other candidate, across the page boundary', async () => {
      pg.requirePostgres('K5/K1 first run')
      // The 101 candidates become unresolved again: only the pending rounds K6 created are removed.
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: ids(eligible) } } })
      const order = sorted(eligible)
      // One failure of each kind, on both sides of the boundary: order[100] is alone on page 2, order[99] is the last of page 1.
      const generic = [order[3], order[PAGE]]
      const conflict = order[PAGE - 1]
      const crash = order[50]
      const guardTarget = order[PAGE - 5].escrowId // its translation guard is made to fail, the first time it runs for this candidate
      for (const x of generic) inject.generic.add(x.escrowId)
      inject.conflict.add(conflict.escrowId)
      inject.crash.add(crash.escrowId)

      let guardArmed = false
      const real = { initiateRelease: escrowService.initiateRelease.bind(escrowService), initiateRefund: escrowService.initiateRefund.bind(escrowService), initiateSplit: escrowService.initiateSplit.bind(escrowService) }
      const wrap = (name: keyof typeof real) => jest.spyOn(escrowService, name).mockImplementation(((escrowId: string, ...rest: unknown[]) => {
        if (inject.generic.has(escrowId)) return Promise.reject(new Error('m9r-343 injected dispatch failure'))
        if (inject.conflict.has(escrowId)) return Promise.reject(new EscrowError(`Escrow ${escrowId} already has a pending transaction (concurrent initiate)`))
        // The dispatch really persisted, then the process "died": the run reports a failure, the round exists.
        if (inject.crash.has(escrowId)) return (real[name] as any)(escrowId, ...rest).then(() => { throw new Error('m9r-343 injected crash after the dispatch persisted') })
        // Armed BEFORE the dispatch starts, so the failure hits the first guard check of THIS candidate wherever the guard runs:
        // today right after the dispatch persisted (resumeCandidate); after GK-M9R-D R2, inside the initiate, before the round
        // exists. Arming after the initiate returned would, under R2, fail the next candidate instead (CTO 25, K5).
        if (escrowId === guardTarget) { guardArmed = true; return (real[name] as any)(escrowId, ...rest) }
        return (real[name] as any)(escrowId, ...rest)
      }) as never)
      wrap('initiateRelease'); wrap('initiateRefund'); wrap('initiateSplit')
      // A guard failure for one named candidate: armed by that candidate's dispatch, consumed by its first guard check.
      const realGuard = guard.assertTranslationMatchesOutcome
      jest.spyOn(guard, 'assertTranslationMatchesOutcome').mockImplementation(((...args: unknown[]) => {
        if (guardArmed) { guardArmed = false; throw new guard.TranslationGuardError(['m9r-343 injected translation mismatch']) }
        return (realGuard as any)(...args)
      }) as never)

      const { pages, cursors } = observe()
      const mine = new Set(ids(eligible))
      const whole = await reconcileMissingDispatch()
      const mineOf = <T extends { escrowId: string }>(xs: T[]) => xs.filter((x) => mine.has(x.escrowId))
      const report = { ...whole, failed: mineOf(whole.failed), guardFailed: mineOf(whole.guardFailed), notEligible: mineOf(whole.notEligible), resumed: mineOf(whole.resumed), alreadyResumedConcurrently: whole.alreadyResumedConcurrently.filter((id) => mine.has(id)) }

      // K1 - the pages themselves.
      const loaded = pages.flat()
      process.stdout.write(`[evidence] ${JSON.stringify({ label: 'K1 pages of the first run', pageSizes: pages.map((p) => p.length), cursorsAreIncreasing: cursors.every((c, i) => i === 0 || c > cursors[i - 1]), pageQueries: cursors.length })}\n`)
      expect(pages[0]).toHaveLength(PAGE)
      expect(pages.slice(0, -1).every((p) => p.length === PAGE)).toBe(true) // every page but the last is full
      expect(pages[pages.length - 1].length).toBeLessThanOrEqual(PAGE)
      expect(pages.length).toBeGreaterThanOrEqual(2) // 101 eligible: the cursor crossed the boundary
      // Every other eligible candidate of the database is read too (other suites may leave some): none of THIS describe's is omitted.
      const pageOf = (id: string) => pages.findIndex((p) => p.includes(eligible.find((c) => c.escrowId === id)!.disputeId))
      const targets = [...generic.map((g) => g.escrowId), conflict.escrowId, crash.escrowId, guardTarget]
      process.stdout.write(`[evidence] ${JSON.stringify({ label: 'K5 injected failures by page', pages: targets.map(pageOf), loadedBeyondThisDescribe: loaded.length - eligible.length })}\n`)
      expect(new Set(targets.map(pageOf)).size).toBeGreaterThanOrEqual(2) // the failures are not all on one page
      expect(new Set(loaded).size).toBe(loaded.length) // no dispute loaded twice
      for (const p of pages) expect([...p]).toEqual([...p].sort()) // each page in id order
      expect(loaded).toEqual([...loaded].sort()) // and the pages in id order: nothing behind the cursor
      expect(cursors[0]).toBe('')
      for (let i = 1; i < cursors.length; i++) expect(cursors[i]).toBe(pages[i - 1][pages[i - 1].length - 1]) // each cursor is the last id of the page before
      expect(cursors.length).toBe(pages.length + (pages[pages.length - 1].length === PAGE ? 1 : 0)) // one query per page, plus the empty one that ends a run whose last page was full
      for (const c of eligible) expect(loaded).toContain(c.disputeId) // none omitted
      // K3 - histories that are not recovery work are never loaded.
      for (const e of allExcluded()) expect(loaded).not.toContain(e.disputeId)

      // K5 - what each failure did.
      expect(report.failed.map((f) => f.escrowId).sort()).toEqual([...generic.map((g) => g.escrowId), crash.escrowId].sort())
      expect(report.alreadyResumedConcurrently).toEqual([conflict.escrowId])
      expect(report.guardFailed).toHaveLength(1)
      guardFailedEscrow = report.guardFailed[0].escrowId
      expect(guardFailedEscrow).toBe(guardTarget)
      expect(guardArmed).toBe(false) // the armed failure was consumed by the target itself, not left for a later candidate
      expect(report.notEligible).toEqual([])
      const resumed = report.resumed.map((r) => r.escrowId)
      firstRunResumed = resumed
      expect(new Set(resumed).size).toBe(resumed.length) // exactly once each
      const unresolved = new Set([...generic.map((g) => g.escrowId), conflict.escrowId, guardFailedEscrow])
      // Every other candidate - including those after the failures and on the later page - was resumed in this same run.
      for (const c of eligible) {
        if (unresolved.has(c.escrowId) || c.escrowId === crash.escrowId) continue
        expect(resumed).toContain(c.escrowId)
      }
      expect(resumed).not.toContain(crash.escrowId) // reported as failed, not as resumed ...
      const rows = await pendingRows(ids(eligible))
      expect(rows.some((r) => r.escrowId === crash.escrowId)).toBe(true) // ... but its round DID persist: that dispatch happened
      for (const id of unresolved) expect(rows.some((r) => r.escrowId === id)).toBe(false) // the others have no round yet (guard failure deleted its own)
      expect(rows).toHaveLength(eligible.length - unresolved.size)
      await expectNoEconomicDisposition(eligible)
    }, 1_800_000)

    it('K5 + K2: the next run finishes exactly the unresolved candidates - not the one whose dispatch already persisted - and the one after it does nothing', async () => {
      pg.requirePostgres('K5/K2 second and third run')
      const crashed = [...inject.crash][0]
      const expected = [...inject.generic, ...inject.conflict, guardFailedEscrow!].sort()
      const second = observe()
      const report = await reconcileMissingDispatch()
      const mineResumed = report.resumed.map((r) => r.escrowId).filter((id) => ids(eligible).includes(id))
      expect([...mineResumed].sort()).toEqual(expected)
      expect(mineResumed).not.toContain(crashed) // a persisted dispatch is never repeated
      expect(report.failed.filter((f) => ids(eligible).includes(f.escrowId))).toEqual([])
      expect(second.pages.flat().filter((id) => eligible.some((c) => c.disputeId === id))).toHaveLength(expected.length) // only unresolved work is loaded
      expect(new Set([...firstRunResumed, ...mineResumed]).size).toBe(firstRunResumed.length + mineResumed.length) // no escrow resumed in two runs
      await expectNoEconomicDisposition(eligible)

      // K2 - idempotent.
      jest.restoreAllMocks()
      const third = observe()
      const again = await reconcileMissingDispatch()
      expect(again.resumed.filter((r) => ids(eligible).includes(r.escrowId))).toEqual([])
      expect(third.pages.flat().filter((id) => eligible.some((c) => c.disputeId === id))).toEqual([])
      const rows = await pendingRows(ids(eligible))
      expect(rows).toHaveLength(eligible.length)
      expect(new Set(rows.map((r) => r.escrowId)).size).toBe(eligible.length)
      // Each escrow has ONE round, bound to its own dispute.
      for (const c of eligible) expect(rows.find((r) => r.escrowId === c.escrowId)!.disputeId).toBe(c.disputeId)
      process.stdout.write(`[evidence] ${JSON.stringify({ label: 'K2 idempotent', secondRunResumed: mineResumed.length, thirdRunResumed: 0, thirdRunPagesLoadingMine: 0, pendingRounds: rows.length })}\n`)
    }, 1_800_000)

    it('K3: the settled, legacy and already dispatched histories were never touched by any of the runs', async () => {
      pg.requirePostgres('K3')
      for (const s of excluded.settled) {
        expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: s.escrowId } })).toBe(0)
        expect((await prisma.escrow.findUniqueOrThrow({ where: { id: s.escrowId } })).status).toBe('COMPLETED')
      }
      for (const l of excluded.legacy) expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: l.escrowId } })).toBe(0)
      const after = (await pendingRows([...ids(excluded.dispatched), fullySigned.escrowId])).map((r) => ({ escrowId: r.escrowId, id: r.id }))
      expect(after).toEqual(dispatchedBefore) // the very same rounds: not replaced, not deleted
    })
  })

  // ═════════════════════ C4 durable claim (CTO 341) ═════════════════════════════════════════════════════════════
  // reconcileMissingDispatch({ maxCandidates, budgetMs }) CLAIMS its candidates in the database (FOR UPDATE SKIP LOCKED) and
  // stamps them with the database's own clock: the queue position is durable, nothing lives in process memory. To COUNT visits
  // most tests make every dispatch fail: nothing persists, the eligible set stays the same, and the stamps are the evidence.
  // Other suites may have left candidates in the database: they are part of the queue, and every assertion about this
  // describe's escrows holds whatever else is there.
  describe('C4 durable claim: per-call budget, durable fair order, no starvation (24 plain + 3 over a cooperative round)', () => {
    const MAX = 10
    let mine: Case[] = []
    let coop: Case[] = []
    let fullySigned: Case

    beforeAll(async () => {
      if (!dbAvailable) return
      const plain: Case[] = []
      for (let i = 0; i < 24; i++) plain.push(await c4(`b${i}`, RULINGS[i % 3]))
      for (let i = 0; i < 3; i++) coop.push(await c4OverCooperativeRound(`bcoop${i}`, 1))
      fullySigned = await c4OverCooperativeRound('bfully', 2) // #239: every signature present - never selected
      mine = [...plain, ...coop]
    }, 1_800_000)

    // CTO 344: SAILS_C4_RECOVERY_ENABLED is off by default; this describe turns it on for the tick tests and F1 turns it off.
    const c4Flag = () => require('../../src/config').config.features as { c4Recovery: boolean }
    let originalFlag = false
    beforeEach(() => { originalFlag = c4Flag().c4Recovery; c4Flag().c4Recovery = true })
    afterEach(() => { c4Flag().c4Recovery = originalFlag })

    const bounded = (extra: Partial<{ budgetMs: number; now: () => number }> = {}) => reconcileMissingDispatch({ maxCandidates: MAX, budgetMs: 60_000, ...extra })
    const failEveryDispatch = (onCall?: () => void) => {
      for (const name of ['initiateRelease', 'initiateRefund', 'initiateSplit'] as const) {
        jest.spyOn(escrowService, name).mockImplementation((() => { onCall?.(); return Promise.reject(new Error('c4 durable claim injected dispatch failure')) }) as never)
      }
    }
    type Row = { id: string; t: Date | null; u: Date; key: Date }
    // Raw SQL: the stamp and updatedAt are read exactly as stored, whatever the generated client knows about the column.
    async function rows(cases: Case[]): Promise<Map<string, Row>> {
      const found = await prisma.$queryRaw<Row[]>`
        SELECT id, "dispatchRecoveryAttemptedAt" AS t, "updatedAt" AS u, COALESCE("dispatchRecoveryAttemptedAt", "resolvedAt", "createdAt") AS key
        FROM disputes WHERE id = ANY(${cases.map((c) => c.disputeId)}::text[])`
      return new Map(found.map((r) => [r.id, r]))
    }
    const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null)
    const resetStamps = () => prisma.$executeRaw`UPDATE disputes SET "dispatchRecoveryAttemptedAt" = NULL WHERE id = ANY(${mine.map((c) => c.disputeId)}::text[])`
    /** One call; which of this describe's disputes it claimed = those whose stamp changed. updatedAt must never change. */
    async function claimedBy(run: () => Promise<DispatchRecoveryReport>) {
      const before = await rows(mine)
      const report = await run()
      const after = await rows(mine)
      for (const c of mine) expect(after.get(c.disputeId)!.u.getTime()).toBe(before.get(c.disputeId)!.u.getTime())
      return { report, before, claimed: mine.filter((c) => !same(before.get(c.disputeId)!.t, after.get(c.disputeId)!.t)).map((c) => c.disputeId) }
    }
    /** A clock that expires the budget right after the first claim: the claimed chunk is stamped but never attempted. */
    const expiresAfterClaim = () => { let n = 0; return () => (n++ < 2 ? 0 : 1e9) }
    const claimStatements = () => {
      const claimed: string[][] = []
      const queryRaw = (prisma.$queryRaw as any).bind(prisma)
      jest.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const result = queryRaw(strings, ...values)
        if (Array.isArray(strings) && strings.join('?').includes('UPDATE disputes d SET')) return result.then((r: Array<{ id: string }>) => { claimed.push(r.map((x) => x.id)); return r })
        return result
      }) as never)
      return claimed
    }

    it('S1: a backlog larger than the budget is claimed fairly, at most MAX per call, each candidate - always failing - once before any is claimed twice; updatedAt never moves; the fully signed round is never selected', async () => {
      pg.requirePostgres('C4 S1')
      await resetStamps()
      failEveryDispatch()
      const roundsBefore = (await pendingRows(ids(mine))).map((r) => r.id)
      const sequence: string[] = []
      const calls: string[][] = []
      const perCall: Array<{ claimed: number; processed: number; stoppedBy: string }> = []
      for (let call = 0; call < 40 && !mine.every((c) => sequence.includes(c.disputeId)); call++) {
        const { report, claimed } = await claimedBy(bounded)
        perCall.push({ claimed: claimed.length, processed: report.budget!.processed, stoppedBy: report.budget!.stoppedBy })
        expect(report.budget!.processed).toBeLessThanOrEqual(MAX)
        calls.push(claimed)
        sequence.push(...claimed)
      }
      // Fair order: nobody is claimed a second time until the circle has closed. Only the call that closes it (the last one)
      // may repeat candidates - it continues from the oldest attempted - and every earlier call claims only new ones.
      const seen = new Set<string>()
      calls.slice(0, -1).forEach((claimed) => { for (const id of claimed) { expect(seen.has(id)).toBe(false); seen.add(id) } })
      process.stdout.write(`[evidence] ${JSON.stringify({ label: 'C4 S1 sweep', max: MAX, calls: perCall.length, perCall })}\n`)
      expect(perCall[0]).toMatchObject({ processed: MAX, stoppedBy: 'MAX_CANDIDATES' })
      for (const c of mine) expect(sequence).toContain(c.disputeId) // every candidate, though it fails every time
      expect((await rows([fullySigned])).get(fullySigned.disputeId)!.t).toBeNull() // #239: never selected, never stamped
      expect((await pendingRows(ids(mine))).map((r) => r.id)).toEqual(roundsBefore) // every dispatch failed: nothing persisted or replaced
      await expectNoEconomicDisposition(mine)
    }, 1_800_000)

    it('S2 restart: a brand new instance of the module continues the SAME queue - the next-oldest candidates, none just attempted - because the order is in the database, not in memory', async () => {
      pg.requirePostgres('C4 S2')
      await resetStamps()
      failEveryDispatch()
      const first = await claimedBy(bounded)
      // Restart: a separate OS process loads the module from scratch (nothing from this process survives) and claims one chunk.
      expect((require('../../src/modules/open-settlement/dispute-dispatch-recovery') as any).setDispatchRecoveryCursor).toBeUndefined() // no in-memory position exists to restore
      const second = await claimedBy(async () => {
        const out = require('child_process').execFileSync(process.execPath, [require.resolve('tsx/cli'), require('path').join(__dirname, 'helpers', 'c4ClaimChild.ts')], {
          env: { ...process.env, C4_MAX: String(MAX), NODE_ENV: 'test' }, encoding: 'utf8', timeout: 180_000,
        }) as string
        const line = out.split('\n').find((l) => l.startsWith('C4_CHILD '))
        if (!line) throw new Error('child produced no report: ' + out)
        return { budget: JSON.parse(line.slice('C4_CHILD '.length)) } as DispatchRecoveryReport
      })
      expect(second.report.budget).toMatchObject({ processed: 0, stoppedBy: 'BUDGET_MS' })
      expect(second.claimed.length).toBeGreaterThan(0)
      for (const id of second.claimed) expect(first.claimed).not.toContain(id) // not the ones the first instance just attempted
      // Queue order: every candidate the restarted instance claimed was ahead of every candidate it left.
      const queue = second.before
      const left = mine.filter((c) => !second.claimed.includes(c.disputeId))
      const maxClaimed = Math.max(...second.claimed.map((id) => queue.get(id)!.key.getTime()))
      const minLeft = Math.min(...left.map((c) => queue.get(c.disputeId)!.key.getTime()))
      expect(maxClaimed).toBeLessThanOrEqual(minLeft)
    }, 1_800_000)

    it('S3 worker failure: candidates claimed by a worker that died before attempting them lose one turn, not the candidate - they are still eligible, and the next calls reach them', async () => {
      pg.requirePostgres('C4 S3')
      await resetStamps()
      failEveryDispatch()
      const died = await claimedBy(() => bounded({ now: expiresAfterClaim() })) // claimed (stamped), never attempted
      expect(died.report.budget).toMatchObject({ processed: 0, stoppedBy: 'BUDGET_MS' })
      expect(died.claimed.length).toBeGreaterThan(0)
      expect(await pendingRows(died.claimed.map((id) => mine.find((c) => c.disputeId === id)!.escrowId))).toEqual([]) // nothing was attempted
      const sequence: string[] = []
      for (let call = 0; call < 40 && !died.claimed.every((id) => sequence.includes(id)); call++) sequence.push(...(await claimedBy(bounded)).claimed)
      for (const id of died.claimed) expect(sequence).toContain(id) // still reached
      // They went behind the candidates that had never been attempted: those come first.
      const firstAgain = sequence.findIndex((id) => died.claimed.includes(id))
      const untouched = mine.filter((c) => !died.claimed.includes(c.disputeId)).map((c) => c.disputeId)
      expect(untouched.length === 0 || sequence.slice(0, firstAgain).some((id) => untouched.includes(id))).toBe(true)
    }, 1_800_000)

    it('S5 clocks: the stamp is the DATABASE clock - instances whose Node clocks are a day apart, in opposite directions, stamp inside the database window and keep one order', async () => {
      pg.requirePostgres('C4 S5')
      await resetStamps()
      failEveryDispatch()
      const dbNow = async () => (await prisma.$queryRaw<Array<{ t: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS t`)[0].t.getTime()
      const realNow = Date.now
      const windows: Array<{ lo: number; hi: number; claimed: Array<[string, number]> }> = []
      for (const skew of [+86_400_000, -86_400_000]) {
        const lo = await dbNow()
        const skewed = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
        const { claimed } = await claimedBy(() => bounded())
        skewed.mockRestore()
        const hi = await dbNow()
        const stamped = await rows(mine)
        windows.push({ lo, hi, claimed: claimed.map((id) => [id, stamped.get(id)!.t!.getTime()] as [string, number]) })
      }
      for (const w of windows) {
        expect(w.claimed.length).toBeGreaterThan(0)
        for (const [, t] of w.claimed) { expect(t).toBeGreaterThanOrEqual(w.lo - 1); expect(t).toBeLessThanOrEqual(w.hi + 1) } // the database's window, not Node's +/- 1 day
      }
      const firstMax = Math.max(...windows[0].claimed.map(([, t]) => t))
      for (const [, t] of windows[1].claimed) expect(t).toBeGreaterThanOrEqual(firstMax) // later call, later stamp, whatever Node said
    }, 1_800_000)
    it('S4 concurrency: two bounded reconcilers claim disjoint candidates; real dispatch resumes each exactly once, the cooperative rounds are superseded once, the fully signed round is untouched', async () => {
      pg.requirePostgres('C4 S4')
      await resetStamps()
      failEveryDispatch()
      const statements = claimStatements()
      await Promise.all([bounded(), bounded()])
      const all = statements.flat()
      expect(new Set(all).size).toBe(all.length) // no candidate claimed by both overlapping calls
      jest.restoreAllMocks()
      await resetStamps()
      const target = new Set(ids(mine))
      const resumed: string[] = []
      for (let round = 0; round < 12 && (await pendingRows(ids(mine))).length < mine.length; round++) {
        const [a, b] = await Promise.all([bounded(), bounded()])
        expect(a.budget!.processed).toBeLessThanOrEqual(MAX)
        expect(b.budget!.processed).toBeLessThanOrEqual(MAX)
        resumed.push(...[...a.resumed, ...b.resumed].map((r) => r.escrowId).filter((id) => target.has(id)))
      }
      expect(new Set(resumed).size).toBe(resumed.length) // never resumed twice
      expect([...new Set(resumed)].sort()).toEqual([...target].sort()) // every one of them
      expect(await pendingRows(ids(mine))).toHaveLength(mine.length) // one round each
      for (const c of coop) expect(await prisma.escrowPendingRoundRetirement.count({ where: { escrowId: c.escrowId } })).toBe(1) // #239 superseded once
      expect((await pendingRows([fullySigned.escrowId])).map((r) => r.id)).toEqual([fullySigned.roundId])
      await expectNoEconomicDisposition(mine)
    }, 1_800_000)

    // ─── the production tick (CTO 341): runSettlementReconcilerTick() now runs C4 and the stale-translation cleanup ────────────
    // Each step is bounded and fails independently. These use FRESH candidates: S4 above resumed the population of this describe.
    const tickLog = () => ({ warn: jest.fn(), error: jest.fn() })
    const loggedMessages = (log: { warn: jest.Mock; error: jest.Mock }) => [...log.warn.mock.calls, ...log.error.mock.calls].map(([entry]) => String((entry as { msg?: string }).msg))
    const runTick = (log: ReturnType<typeof tickLog>) => require('../../src/app').runSettlementReconcilerTick(log) as Promise<void>
    const hasRound = async (c: Case) => (await pendingRows([c.escrowId])).length === 1
    /** Ticks until `done()`, at most 40 times: candidates that can never succeed may sit ahead, and fairness reaches ours. */
    async function tickUntil(log: ReturnType<typeof tickLog>, done: () => Promise<boolean>) {
      for (let i = 0; i < 40 && !(await done()); i++) await runTick(log)
    }

    it('T1 production tick: one tick resumes a C4 candidate through the real wiring - a persisted round, no broadcast, no economic disposition - and the next tick does nothing more', async () => {
      pg.requirePostgres('C4 T1')
      const fresh = [await c4('tick1', 'RELEASE'), await c4('tick2', 'REFUND')]
      const log = tickLog()
      await tickUntil(log, async () => (await Promise.all(fresh.map(hasRound))).every(Boolean))
      expect((await pendingRows(ids(fresh))).map((r) => r.escrowId).sort()).toEqual(ids(fresh).sort())
      expect(loggedMessages(log)).toContain('C4 dispatch recovery completed with findings')
      await expectNoEconomicDisposition(fresh)
      const before = (await pendingRows(ids(fresh))).map((r) => r.id)
      await runTick(tickLog())
      expect((await pendingRows(ids(fresh))).map((r) => r.id)).toEqual(before) // idempotent: same rounds, none replaced
    }, 1_800_000)

    it('T2 independence: a failing C4 step, a failing settlement pass and a failing cleanup each leave the other steps running, and the tick never throws', async () => {
      pg.requirePostgres('C4 T2')
      const recovery = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
      const stale = require('../../src/modules/open-settlement/dispute-pending-reconciliation')
      const settlement = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      const c4Spy = jest.spyOn(recovery, 'reconcileMissingDispatch')
      const staleSpy = jest.spyOn(stale, 'reconcileStalePendingDisputeTranslations')
      // 1. C4 throws: the settlement pass already ran, the cleanup still runs.
      c4Spy.mockRejectedValueOnce(new Error('c4 step failed'))
      let log = tickLog()
      await expect(runTick(log)).resolves.toBeUndefined()
      expect(loggedMessages(log)).toContain('C4 dispatch recovery failed')
      expect(staleSpy).toHaveBeenCalledTimes(1)
      // 2. The settlement pass throws: C4 and the cleanup still run.
      jest.spyOn(settlement, 'reconcilePendingSettlements').mockRejectedValueOnce(new Error('settlement pass failed'))
      c4Spy.mockClear(); staleSpy.mockClear()
      log = tickLog()
      await expect(runTick(log)).resolves.toBeUndefined()
      expect(loggedMessages(log)).toContain('Settlement reconciliation failed')
      expect(c4Spy).toHaveBeenCalledTimes(1)
      expect(staleSpy).toHaveBeenCalledTimes(1)
      // 3. The cleanup throws: reported on its own.
      staleSpy.mockRejectedValueOnce(new Error('cleanup failed'))
      log = tickLog()
      await expect(runTick(log)).resolves.toBeUndefined()
      expect(loggedMessages(log)).toContain('Stale dispute translation cleanup failed')
      // The budgets handed to the real functions are the bounded ones (never an unbounded sweep from the tick).
      expect(c4Spy.mock.calls[0][0]).toMatchObject({ maxCandidates: expect.any(Number), budgetMs: expect.any(Number) })
      expect(staleSpy.mock.calls[0][0]).toMatchObject({ maxRows: expect.any(Number), budgetMs: expect.any(Number) })
    }, 1_800_000)

    it('T3 interruption: a tick whose dispatch dies mid-run (after the round persisted, and before it) never throws, loses nothing, and the next tick finishes exactly the unresolved candidate', async () => {
      pg.requirePostgres('C4 T3')
      const dies = await c4('tickdie', 'RELEASE') // dispatch fails before anything persists
      const crashes = await c4('tickcrash', 'REFUND') // the round persists, then the process "dies" before the guard
      const real = { initiateRelease: escrowService.initiateRelease.bind(escrowService), initiateRefund: escrowService.initiateRefund.bind(escrowService) }
      jest.spyOn(escrowService, 'initiateRelease').mockImplementation(((escrowId: string, ...rest: unknown[]) =>
        escrowId === dies.escrowId ? Promise.reject(new Error('c4 tick injected failure')) : (real.initiateRelease as any)(escrowId, ...rest)) as never)
      jest.spyOn(escrowService, 'initiateRefund').mockImplementation(((escrowId: string, ...rest: unknown[]) =>
        escrowId === crashes.escrowId ? (real.initiateRefund as any)(escrowId, ...rest).then(() => { throw new Error('c4 tick injected crash after persisting') }) : (real.initiateRefund as any)(escrowId, ...rest)) as never)
      await expect(runTick(tickLog())).resolves.toBeUndefined()
      await tickUntil(tickLog(), () => hasRound(crashes)) // never throws, whatever dies on the way
      expect((await pendingRows([dies.escrowId])).length).toBe(0) // nothing persisted for the first
      expect((await pendingRows([crashes.escrowId])).length).toBe(1) // the second persisted, guard never ran
      jest.restoreAllMocks()
      await tickUntil(tickLog(), () => hasRound(dies))
      expect((await pendingRows([dies.escrowId])).length).toBe(1) // finished by the next tick
      expect((await pendingRows([crashes.escrowId])).length).toBe(1) // not repeated, not duplicated
      await expectNoEconomicDisposition([dies, crashes])
    }, 1_800_000)

    it('T4 "persists before it validates": the unvalidated round a crash leaves is removed by the tick when unsigned and aged, kept when it carries a signature - and C4 then rebuilds a validated one', async () => {
      pg.requirePostgres('C4 T4')
      const unsigned = await c4('tickwin1', 'RELEASE')
      const signed = await c4('tickwin2', 'RELEASE')
      const real = { initiateRelease: escrowService.initiateRelease.bind(escrowService) }
      // The dispatch persists its round and the process dies BEFORE the translation guard ran: the window.
      jest.spyOn(escrowService, 'initiateRelease').mockImplementation(((escrowId: string, ...rest: unknown[]) =>
        (real.initiateRelease as any)(escrowId, ...rest).then(() => { throw new Error('c4 injected crash before validation') })) as never)
      for (let i = 0; i < 40 && !((await hasRound(unsigned)) && (await hasRound(signed))); i++) await bounded()
      jest.restoreAllMocks()
      for (const c of [unsigned, signed]) expect((await pendingRows([c.escrowId])).length).toBe(1)
      const aged = new Date(Date.now() - 10 * 60 * 1000)
      await prisma.escrowPendingTransaction.updateMany({ where: { escrowId: { in: [unsigned.escrowId, signed.escrowId] } }, data: { createdAt: aged } })
      const signedRound = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: signed.escrowId } })
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: signedRound.id, participantId: signedRound.requiredSigners[0], signedPsbtBase64: 'signed-by-a-participant' } })
      // Their translation does not match the durable Outcome.
      const guardModule = require('../../src/modules/open-settlement/dispatch-translation-guard')
      const ours = new Set([(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: unsigned.escrowId } })).unsignedPsbtBase64, signedRound.unsignedPsbtBase64])
      const realValidate = guardModule.validateTranslatedOutputsAgainstOutcome
      jest.spyOn(guardModule, 'validateTranslatedOutputsAgainstOutcome').mockImplementation(((psbt: string, ...rest: unknown[]) =>
        ours.has(psbt) ? { ok: false, mismatches: ['c4 injected mismatch'] } : (realValidate as any)(psbt, ...rest)) as never) // only THESE two rounds mismatch
      // The cleanup runs after the C4 step in the same tick and takes at most 50 rows per run: tick until it has reached ours.
      for (let i = 0; i < 40 && (await hasRound(unsigned)); i++) await runTick(tickLog())
      jest.restoreAllMocks()
      expect((await pendingRows([signed.escrowId])).length).toBe(1) // a round with a signature is never deleted by this path
      expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: signedRound.id } })).toBe(1)
      // The unsigned one is gone ...
      expect((await pendingRows([unsigned.escrowId])).length).toBe(0)
      // ... and the next tick - guard now real - rebuilds a round for it, validated against the Outcome by the dispatch itself.
      await tickUntil(tickLog(), () => hasRound(unsigned))
      expect((await pendingRows([unsigned.escrowId])).length).toBe(1)
      await expectNoEconomicDisposition([unsigned, signed])
    }, 1_800_000)

    it('F1 flag OFF (the default): the tick performs ZERO C4 operations - no dispatch claim, no stamp, no round, no cleanup - while the rest of the tick still runs', async () => {
      pg.requirePostgres('C4 F1')
      const candidate = await c4('flagoff', 'RELEASE')
      c4Flag().c4Recovery = false
      const recovery = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
      const stale = require('../../src/modules/open-settlement/dispute-pending-reconciliation')
      const settlement = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      const c4Spy = jest.spyOn(recovery, 'reconcileMissingDispatch')
      const staleSpy = jest.spyOn(stale, 'reconcileStalePendingDisputeTranslations')
      const settlementSpy = jest.spyOn(settlement, 'reconcilePendingSettlements')
      const claims = claimStatements()
      const before = (await rows([candidate])).get(candidate.disputeId)!
      await runTick(tickLog())
      await runTick(tickLog())
      expect(settlementSpy).toHaveBeenCalledTimes(2) // the settlement pass is not gated by this flag
      expect(c4Spy).not.toHaveBeenCalled()
      expect(staleSpy).not.toHaveBeenCalled()
      expect(claims).toEqual([]) // not even the claim statement was issued
      const after = (await rows([candidate])).get(candidate.disputeId)!
      expect(after.t).toBeNull()
      expect(after.u.getTime()).toBe(before.u.getTime())
      expect(await pendingRows([candidate.escrowId])).toEqual([]) // nothing was dispatched
      await expectNoEconomicDisposition([candidate])
    }, 1_800_000)

    it('F2 flag ON: the tick runs BOTH routines - the bounded dispatch recovery and the bounded stale-translation cleanup - and the candidate is claimed and resumed', async () => {
      pg.requirePostgres('C4 F2')
      const candidate = await c4('flagon', 'REFUND')
      const recovery = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
      const stale = require('../../src/modules/open-settlement/dispute-pending-reconciliation')
      const c4Spy = jest.spyOn(recovery, 'reconcileMissingDispatch')
      const staleSpy = jest.spyOn(stale, 'reconcileStalePendingDisputeTranslations')
      let ticks = 0
      for (; ticks < 40 && !(await hasRound(candidate)); ticks++) await runTick(tickLog())
      expect(await hasRound(candidate)).toBe(true)
      expect(c4Spy).toHaveBeenCalledTimes(ticks)
      expect(staleSpy).toHaveBeenCalledTimes(ticks)
      expect(c4Spy.mock.calls[0][0]).toMatchObject({ maxCandidates: expect.any(Number), budgetMs: expect.any(Number) })
      expect(staleSpy.mock.calls[0][0]).toMatchObject({ maxRows: expect.any(Number), budgetMs: expect.any(Number) })
      expect((await rows([candidate])).get(candidate.disputeId)!.t).not.toBeNull() // stamped by the claim
      await expectNoEconomicDisposition([candidate])
    }, 1_800_000)

    it('T5 stale cleanup budget: a bounded run loads at most maxRows and, over a few runs from any starting position, reaches every row; rows that cannot be acted on never use the budget', async () => {
      pg.requirePostgres('C4 T5')
      const stale = require('../../src/modules/open-settlement/dispute-pending-reconciliation')
      const rounds = await prisma.escrowPendingTransaction.findMany({ where: { escrow: { type: 'MULTISIG', disputes: { some: { status: 'RESOLVED' } } }, signatures: { none: {} } } })
      const aged = new Date(Date.now() - 10 * 60 * 1000)
      await prisma.escrowPendingTransaction.updateMany({ where: { id: { in: rounds.map((r) => r.id) } }, data: { createdAt: aged } })
      const total = rounds.length
      expect(total).toBeGreaterThan(3)
      const MAXROWS = 2
      const seen = new Set<string>()
      for (const start of ['', 'ffffffff-ffff-ffff-ffff-ffffffffffff', rounds[1].id]) {
        stale.setStalePendingCursor(start)
        for (let run = 0; run < Math.ceil(total / MAXROWS) + 1; run++) {
          const report = await stale.reconcileStalePendingDisputeTranslations({ maxRows: MAXROWS, budgetMs: 60_000 })
          expect(report.reconciled.length + report.skippedHasSignatures.length + report.skippedTooYoung.length + report.failed.length).toBeLessThanOrEqual(MAXROWS)
          for (const r of report.reconciled) seen.add(r.escrowId)
        }
      }
      for (const r of rounds) expect(seen.has(r.escrowId) || (await prisma.escrowPendingTransaction.count({ where: { id: r.id } })) === 0).toBe(true)
      // The clock budget: no row is started once it has elapsed.
      let t = 0
      const none = await stale.reconcileStalePendingDisputeTranslations({ maxRows: 50, budgetMs: 0, now: () => (t += 1) })
      expect(none.reconciled.length + none.failed.length).toBe(0)
    }, 1_800_000)
  })
})

// One teardown for the whole file: both describes share the database client and the Redis connection.
afterAll(async () => {
  const { prisma } = require('../../src/common/database')
  await prisma.$disconnect()
  await closeTestRedis()
})
