// tests/integration/rulingPriorStateAtomicity.test.ts
//
// Ruling prior-state / revert-target atomicity — real PostgreSQL proof that the state a ruling records as
// displaced (SemanticTransitionRecord.fromState) and restores if its payout fails is the state it ACTUALLY
// displaced when it acquired economic authority, never the value it read before its lock.
//
// Every ruling below goes through the real, signed resolveDispute(). A barrier holds it right after its
// pre-lock read of the dispute; the competing transition (contest, expiry sweep, a new proposal, evidence,
// another ruling, an appeal-shaped transition) commits; then the ruling resumes. Payout failure is forced at
// the only external boundary involved: the chain explorer reports no funding output for the escrow, so the
// real initiateRelease() throws and the real revert runs. Success variants use a funded explorer instead, so
// the durable ruling record (and its fromState) survives to be inspected.

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)

function testnetAddress(label: string): string {
  const scalar = createHash('sha256').update(label).digest()
  const pubkey = Buffer.from(ecc.pointFromScalar(scalar, true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.testnet }).address!
}

describe('Ruling prior-state / revert-target atomicity (real Postgres)', () => {
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

  const ARBITER_ID = 'ruling-prior-state-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

  let realFetch: typeof fetch

  // The chain explorer, the one external boundary a ruling's dispatch touches: `fundingTxids` are the
  // outputs it reports. An escrow whose funding outpoint is absent cannot be spent, so initiateRelease()
  // fails and the ruling is reverted.
  function mockExplorer(fundingTxids: string[]): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes('/tx/') && url.endsWith('/status')) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => fundingTxids.map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } })) } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'ruling-prior-state-seed'
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
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'Ruling prior-state arbiter' },
    })
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

  interface Fixture { disputeId: string; escrowId: string; tradeId: string; buyerId: string; sellerId: string; fundingTxid: string }

  async function makeDispute(suffix: string, escrowType: 'MULTISIG' | 'MOCK' = 'MULTISIG'): Promise<Fixture> {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: escrowType, lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const fundingTxid = createHash('sha256').update(`ruling-prior-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
    if (escrowType === 'MULTISIG') {
      await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
      await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
      mockExplorer([fundingTxid])
    }
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `ruling prior-state — ${suffix}`, [{ type: 'chat_log', note: 'opening evidence' }])
    expect(dispute.arbiterId).toBe(ARBITER_ID)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`ruling-prior-${suffix}-buyer-${Date.now()}`))
    return { disputeId: dispute.id, escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, fundingTxid }
  }

  async function propose(f: Fixture, recommendation: 'RELEASE' | 'REFUND', deadlineOffsetMs: number): Promise<Date> {
    const proposed = await getDisputeService().proposeAutoResolution(f.disputeId, recommendation, 0.95, `proposal ${recommendation}`)
    expect(proposed!.status).toBe('AUTO_PROPOSED')
    const deadline = new Date(Date.now() + deadlineOffsetMs)
    await prisma.dispute.update({ where: { id: f.disputeId }, data: { autoResolutionDeadline: deadline } })
    return deadline
  }

  function sign(f: Fixture, outcome: 'RELEASE' | 'REFUND', appealRound = 0): [string, string] {
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound, authorityId: ARBITER_ID, outcome, buyerBps: null, issuedAt }
    return [signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt]
  }

  // The arbiter's real, signed resolveDispute() call.
  function rule(f: Fixture, outcome: 'RELEASE' | 'REFUND' = 'RELEASE'): Promise<unknown> {
    const [signature, issuedAt] = sign(f, outcome)
    return getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, outcome, undefined, undefined, undefined, signature, issuedAt)
  }

  // ─── deterministic interleaving ──────────────────────────────────────────────────────────────────────────

  interface Gate { reached: Promise<void>; release: () => void }

  // Holds the NEXT prisma.dispute.findUnique — resolveDispute()'s own pre-lock read — right after it returns.
  function holdAfterPreLockRead(): Gate {
    const delegate = prisma.dispute as any
    const original = delegate.findUnique.bind(delegate)
    let signalReached!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { signalReached = r })
    const released = new Promise<void>((r) => { release = r })
    jest.spyOn(delegate, 'findUnique').mockImplementationOnce(async (args: unknown) => {
      const row = await original(args)
      signalReached()
      await released
      return row
    })
    return { reached, release }
  }

  async function reachedOrSettled(gate: Gate, caller: Promise<unknown>): Promise<void> {
    await Promise.race([
      gate.reached,
      caller.then(
        () => { throw new Error('the held ruling completed before reaching its pre-lock read') },
        (err) => { throw new Error(`the held ruling was refused before its pre-lock read: ${err instanceof Error ? err.message : String(err)}`) },
      ),
    ])
  }

  // ─── observations ────────────────────────────────────────────────────────────────────────────────────────

  const row = (f: Fixture) => prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
  const rulingRecord = (f: Fixture) => prisma.semanticTransitionRecord.findUnique({
    where: { interactionId_transitionType_appealRound: { interactionId: f.escrowId, transitionType: 'escrow.dispute.rule', appealRound: 0 } },
  })

  async function resolvedEvents(f: Fixture): Promise<number> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM durable_events WHERE "eventName" = 'dispute.resolved' AND payload->>'disputeId' = ${f.disputeId}`
    return Number(n)
  }

  // After a failed payout: no ruling left anywhere, and nothing dispatched.
  async function assertFullyReverted(f: Fixture): Promise<void> {
    const r = await row(f)
    expect(r.ruling).toBeNull()
    expect(r.authoritySignature).toBeNull()
    expect(r.resolvedAt).toBeNull()
    expect(r.appealRound).toBe(0)
    expect(await rulingRecord(f)).toBeNull()
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(0)
    expect(await resolvedEvents(f)).toBe(0)
  }

  // After a successful ruling: exactly one ruling, one record, one dispatch, one event.
  async function assertRuledOnce(f: Fixture): Promise<void> {
    const r = await row(f)
    expect(r.status).toBe('RESOLVED')
    expect(r.ruling).toBe('RELEASE')
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: f.escrowId, transitionType: 'escrow.dispute.rule' } })).toBe(1)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
    expect(await resolvedEvents(f)).toBe(1)
  }

  // Runs one held ruling across a competing transition, with the given payout outcome.
  async function ruleAcross(f: Fixture, competing: () => Promise<unknown>, payout: 'fails' | 'succeeds'): Promise<PromiseSettledResult<unknown>> {
    const gate = holdAfterPreLockRead()
    const ruling = rule(f)
    await reachedOrSettled(gate, ruling)
    await competing()
    mockExplorer(payout === 'succeeds' ? [f.fundingTxid] : [])
    gate.release()
    const [settled] = await Promise.allSettled([ruling])
    return settled
  }

  // ─── A. contest wins before the ruling's authority ───────────────────────────────────────────────────────

  it('A (payout fails) — ruling read AUTO_PROPOSED, a contest won first: the revert restores EVIDENCE_SUBMITTED, never an AUTO_PROPOSED without a deadline', async () => {
    requirePostgres('A contest then failed ruling')
    const f = await makeDispute('a-fail')
    await propose(f, 'REFUND', 3_600_000)

    const settled = await ruleAcross(f, () => getDisputeService().contestAutoResolution(f.disputeId, f.buyerId), 'fails')

    expect(settled.status).toBe('rejected')
    const r = await row(f)
    expect(r.status).toBe('EVIDENCE_SUBMITTED')
    expect(r.autoResolutionDeadline).toBeNull()
    expect(r.autoResolutionRecommendation).toBeNull()
    await assertFullyReverted(f)
  })

  it('A (payout succeeds) — the durable ruling record names EVIDENCE_SUBMITTED, the state it actually displaced, not the AUTO_PROPOSED it read', async () => {
    requirePostgres('A contest then successful ruling')
    const f = await makeDispute('a-ok')
    await propose(f, 'REFUND', 3_600_000)

    const settled = await ruleAcross(f, () => getDisputeService().contestAutoResolution(f.disputeId, f.buyerId), 'succeeds')

    expect(settled.status).toBe('fulfilled')
    expect((await rulingRecord(f))!.fromState).toBe('EVIDENCE_SUBMITTED')
    await assertRuledOnce(f)
  })

  // ─── B. expiry sweep wins before the ruling's authority ──────────────────────────────────────────────────

  it('B (payout fails) — ruling read an expired AUTO_PROPOSED, the sweep won first: the revert restores EVIDENCE_SUBMITTED with the sweep\'s own result (QVAC context kept, no deadline)', async () => {
    requirePostgres('B sweep then failed ruling')
    const f = await makeDispute('b-fail')
    await propose(f, 'REFUND', -60_000)

    const settled = await ruleAcross(f, async () => {
      expect((await getDisputeService().sweepExpiredAutoResolutions()).revertedToHuman).toContain(f.disputeId)
    }, 'fails')

    expect(settled.status).toBe('rejected')
    const r = await row(f)
    expect(r.status).toBe('EVIDENCE_SUBMITTED')
    expect(r.autoResolutionDeadline).toBeNull()
    expect(r.autoResolutionRecommendation).toBe('REFUND')
    await assertFullyReverted(f)
  })

  // ─── C. P1 -> contest -> P2 before the ruling's authority ───────────────────────────────────────────────

  it('C (payout fails) — ruling read proposal P1; P1 was contested and P2 made before its authority: the revert restores P2 exactly (its recommendation and deadline), the generation actually displaced', async () => {
    requirePostgres('C P1 contest P2 then failed ruling')
    const f = await makeDispute('c-fail')
    await propose(f, 'REFUND', 3_600_000)
    let p2Deadline!: Date

    const settled = await ruleAcross(f, async () => {
      await getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
      p2Deadline = await propose(f, 'RELEASE', 7_200_000)
    }, 'fails')

    expect(settled.status).toBe('rejected')
    const r = await row(f)
    expect(r.status).toBe('AUTO_PROPOSED')
    expect(r.autoResolutionRecommendation).toBe('RELEASE')
    expect(r.autoResolutionDeadline!.getTime()).toBe(p2Deadline.getTime())
    await assertFullyReverted(f)
  })

  it('C (payout succeeds) — the ruling record names AUTO_PROPOSED (P2 was displaced) and P2\'s fields stay intact under RESOLVED', async () => {
    requirePostgres('C P1 contest P2 then successful ruling')
    const f = await makeDispute('c-ok')
    await propose(f, 'REFUND', 3_600_000)
    let p2Deadline!: Date

    const settled = await ruleAcross(f, async () => {
      await getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
      p2Deadline = await propose(f, 'RELEASE', 7_200_000)
    }, 'succeeds')

    expect(settled.status).toBe('fulfilled')
    expect((await rulingRecord(f))!.fromState).toBe('AUTO_PROPOSED')
    expect((await row(f)).autoResolutionDeadline!.getTime()).toBe(p2Deadline.getTime())
    await assertRuledOnce(f)
  })

  // ─── D. a proposal is made before the ruling's authority ─────────────────────────────────────────────────

  it('D (payout fails) — ruling read EVIDENCE_SUBMITTED, a proposal was made before its authority: the revert restores that AUTO_PROPOSED generation, never EVIDENCE_SUBMITTED with orphaned proposal fields', async () => {
    requirePostgres('D proposal then failed ruling')
    const f = await makeDispute('d-fail')
    await getDisputeService().submitEvidence(f.disputeId, f.buyerId, { type: 'payment_receipt', note: 'receipt' })
    let deadline!: Date

    const settled = await ruleAcross(f, async () => { deadline = await propose(f, 'REFUND', 3_600_000) }, 'fails')

    expect(settled.status).toBe('rejected')
    const r = await row(f)
    expect(r.status).toBe('AUTO_PROPOSED')
    expect(r.autoResolutionRecommendation).toBe('REFUND')
    expect(r.autoResolutionDeadline!.getTime()).toBe(deadline.getTime())
    await assertFullyReverted(f)
  })

  // ─── E. evidence changes the eligible state before the ruling's authority ────────────────────────────────

  it('E — ruling read OPENED, evidence moved it to EVIDENCE_SUBMITTED first: the record names EVIDENCE_SUBMITTED; on failure the revert restores EVIDENCE_SUBMITTED with the evidence intact', async () => {
    requirePostgres('E evidence then ruling')
    const ok = await makeDispute('e-ok')
    const okSettled = await ruleAcross(ok, () => getDisputeService().submitEvidence(ok.disputeId, ok.sellerId, { type: 'payment_receipt', note: 'late' }), 'succeeds')
    expect(okSettled.status).toBe('fulfilled')
    expect((await rulingRecord(ok))!.fromState).toBe('EVIDENCE_SUBMITTED')
    await assertRuledOnce(ok)

    const bad = await makeDispute('e-fail')
    const badSettled = await ruleAcross(bad, () => getDisputeService().submitEvidence(bad.disputeId, bad.sellerId, { type: 'payment_receipt', note: 'late' }), 'fails')
    expect(badSettled.status).toBe('rejected')
    const r = await row(bad)
    expect(r.status).toBe('EVIDENCE_SUBMITTED')
    expect((r.evidence as Array<{ note?: string }>).map((e) => e.note)).toEqual(['opening evidence', 'late'])
    await assertFullyReverted(bad)
  })

  // ─── F. two competing rulings ────────────────────────────────────────────────────────────────────────────

  // F races two VALID rulings: each beneficiary has a registered payout address, so a ruling can lose only to
  // the other one, never fail on its own. (With only the buyer's address, a REFUND that reached the lock first
  // was refused for the seller's missing address instead, and the RELEASE then won: the outcome was the same,
  // the loser's error depended on which transaction the scheduler let through first.)
  async function twoValidRulings(suffix: string) {
    const f = await makeDispute(suffix)
    await payoutAddressService.setPayoutAddress(f.sellerId, 'BTC', testnetAddress(`ruling-prior-${suffix}-seller-${Date.now()}`))
    const priorStatus = (await row(f)).status
    const gateA = holdAfterPreLockRead()
    const release = rule(f, 'RELEASE')
    await reachedOrSettled(gateA, release)
    const gateB = holdAfterPreLockRead()
    const refund = rule(f, 'REFUND')
    await reachedOrSettled(gateB, refund)
    mockExplorer([f.fundingTxid])
    return { f, priorStatus, release, refund, gateA, gateB }
  }

  /** Exactly one ruling committed and it is `winner`: one record (naming the state it displaced), one dispatch, one event; the other was refused as already resolved. */
  async function assertOneRulingWon(f: Fixture, priorStatus: string, winner: 'RELEASE' | 'REFUND', outcomes: PromiseSettledResult<unknown>[]): Promise<void> {
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')!
    expect(String(rejected.reason?.message)).toMatch(/already resolved/)
    const r = await row(f)
    expect(r.status).toBe('RESOLVED')
    expect(r.ruling).toBe(winner)
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: f.escrowId, transitionType: 'escrow.dispute.rule' } })).toBe(1)
    expect((await rulingRecord(f))!.fromState).toBe(priorStatus)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
    expect(await resolvedEvents(f)).toBe(1)
  }

  it('F — two rulings both read the dispute before either acquired authority: exactly one commits (one record, one dispatch, one event); the other is refused', async () => {
    requirePostgres('F two rulings')
    const { f, priorStatus, release, refund, gateA, gateB } = await twoValidRulings('f')
    gateA.release()
    gateB.release()
    const outcomes = await Promise.allSettled([release, refund])
    // either may take authority first; whichever did is the one durable ruling
    await assertOneRulingWon(f, priorStatus, outcomes[0].status === 'fulfilled' ? 'RELEASE' : 'REFUND', outcomes)
  })

  for (const first of ['RELEASE', 'REFUND'] as const) {
    it(`F (${first} takes authority first) — the first ruling commits and the other cannot overwrite it`, async () => {
      requirePostgres(`F ${first} first`)
      const { f, priorStatus, release, refund, gateA, gateB } = await twoValidRulings(`f-${first.toLowerCase()}`)
      const [winner, loser] = first === 'RELEASE' ? [{ gate: gateA, ruling: release }, { gate: gateB, ruling: refund }] : [{ gate: gateB, ruling: refund }, { gate: gateA, ruling: release }]
      winner.gate.release()
      await winner.ruling // committed and dispatched before the other ruling takes the lock
      loser.gate.release()
      await assertOneRulingWon(f, priorStatus, first, await Promise.allSettled([release, refund]))
    })
  }

  // ─── G. a ruling signed for round 0 after the dispute moved to round 1 ───────────────────────────────────

  // appeal() refuses MULTISIG (script-committed arbiter), so the transition it commits on appeal-capable rails is
  // written with its own claim shape: RESOLVED -> APPEALED, next round, previous ruling/arbiter captured. The
  // re-drawn arbiter is the same identity here: the worst case, where only the round tells the two rulings apart.
  async function appealToRoundOne(f: Fixture, previousRuling: 'RELEASE' | 'REFUND'): Promise<void> {
    const moved = await prisma.dispute.updateMany({
      where: { id: f.disputeId, status: 'RESOLVED', appealRound: 0 },
      data: { status: 'APPEALED', appealRound: 1, previousRuling, previousArbiterId: ARBITER_ID, ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null },
    })
    expect(moved.count).toBe(1)
  }

  it('G (MULTISIG) — a ruling signed for round 0 that acquires authority after the dispute moved to round 1 is refused, and round 1 stands', async () => {
    requirePostgres('G stale-round ruling, MULTISIG')
    const f = await makeDispute('g-multisig')

    const settled = await ruleAcross(f, async () => {
      const payload: AuthorityDecisionPayload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt: new Date().toISOString() }
      const committed = await commitAuthoritativeDisputeRuling(
        { id: f.disputeId, escrowId: f.escrowId, status: 'OPENED', appealRound: 0 }, payload, signAuthorityDecision(payload, arbiterKeypair.secretKey),
        arbiterPublicKeyHex, '100000', 'BTC', f.buyerId, f.sellerId,
      )
      expect(committed.committed).toBe(true)
      await appealToRoundOne(f, 'RELEASE')
    }, 'succeeds')

    expect(settled.status).toBe('rejected')
    const r = await row(f)
    expect(r.status).toBe('APPEALED')
    expect(r.appealRound).toBe(1)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(0)
    expect(await resolvedEvents(f)).toBe(0)
  })

  it('G (legacy rail, MOCK) — the same stale-round ruling on the applyRuling() path is refused before it can claim round 1, so APPEALED is never overwritten', async () => {
    requirePostgres('G stale-round ruling, legacy path')
    const f = await makeDispute('g-legacy', 'MOCK')

    const gate = holdAfterPreLockRead()
    const stale = rule(f, 'RELEASE') // signed for round 0
    await reachedOrSettled(gate, stale)
    await rule(f, 'REFUND') // another round-0 ruling commits and settles first (MOCK moves no funds)
    await appealToRoundOne(f, 'REFUND')
    gate.release()

    await expect(stale).rejects.toThrow(/no longer authorized for a ruling/)
    const r = await row(f)
    expect(r.status).toBe('APPEALED')
    expect(r.appealRound).toBe(1)
    expect(r.ruling).toBeNull()
  })

  // ─── H / I / J. restart after RESOLVED, C4 and ruling-finalization recovery ─────────────────────────────

  it('H/I/J — a ruling committed with a stale caller status (the process then dies before dispatch) still records the state it displaced; a restarted process resumes the dispatch through C4 and finalizes the ruling once', async () => {
    requirePostgres('H/I/J restart and recovery')
    const f = await makeDispute('hij')
    await propose(f, 'REFUND', 3_600_000)
    await getDisputeService().contestAutoResolution(f.disputeId, f.buyerId) // actual state: EVIDENCE_SUBMITTED

    // The commit a ruling performs, handed the STALE status its caller read before the contest — then nothing
    // else (the crash window C4 exists for).
    const payload: AuthorityDecisionPayload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt: new Date().toISOString() }
    const committed = await commitAuthoritativeDisputeRuling(
      { id: f.disputeId, escrowId: f.escrowId, status: 'AUTO_PROPOSED', appealRound: 0 }, payload, signAuthorityDecision(payload, arbiterKeypair.secretKey),
      arbiterPublicKeyHex, '100000', 'BTC', f.buyerId, f.sellerId,
    )
    expect(committed.committed).toBe(true)
    expect(committed.committed && committed.displacedStatus).toBe('EVIDENCE_SUBMITTED')
    expect((await rulingRecord(f))!.fromState).toBe('EVIDENCE_SUBMITTED')

    let fresh!: { c4: () => Promise<{ claimed: string[]; resumed: Array<{ escrowId: string }> }>; finalize: () => Promise<{ recovered: string[] }>; shutdown: () => Promise<void> }
    jest.isolateModules(() => {
      const recovery = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
      const service = require('../../src/modules/open-settlement/dispute.service').getDisputeService()
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      fresh = {
        c4: () => recovery.reconcileMissingDispatch(),
        finalize: () => service.recoverMissingRulingFinalization(),
        shutdown: async () => { await db.prisma.$disconnect(); await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    try {
      mockExplorer([f.fundingTxid])
      const [{ n: queued }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM disputes d JOIN escrows e ON e.id = d."escrowId"
        WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG' AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
          -- #239: same predicate as claimCandidates() - a dead cooperative round (not fully signed, no ruling) is no dispatch
          AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
            AND (p."disputeId" IS NOT NULL OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))`
      for (let i = 0; i < Math.ceil(Number(queued) / 10) + 1; i++) {
        if ((await fresh.c4()).claimed.includes(f.escrowId)) break
      }
      expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)

      const [{ n: unfinalized }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM disputes d WHERE d.status = 'RESOLVED' AND NOT EXISTS (
          SELECT 1 FROM event_projection_claims c WHERE c."eventId" = d.id AND c."projectionKey" = 'dispute.ruling-finalized' AND c."subjectId" = d."appealRound"::text)`
      let recovered = false
      for (let i = 0; i < Math.ceil(Number(unfinalized) / 200) + 1 && !recovered; i++) recovered = (await fresh.finalize()).recovered.includes(f.disputeId)
      expect(recovered).toBe(true)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: f.disputeId, projectionKey: 'dispute.ruling-finalized' } })).toBe(1)
    } finally {
      await fresh.shutdown()
    }
    expect((await row(f)).status).toBe('RESOLVED')
    expect((await rulingRecord(f))!.fromState).toBe('EVIDENCE_SUBMITTED')
  })
})
