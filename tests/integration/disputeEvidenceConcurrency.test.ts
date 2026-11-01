// tests/integration/disputeEvidenceConcurrency.test.ts
//
// persistEvidence() — real PostgreSQL proof that evidence submission (a) never overwrites an authoritative
// state committed after its read and (b) never loses a concurrently accepted submission.
//
// persistEvidence() reads a dispute, validates it, then writes. Every test forces the dangerous interleaving
// deterministically: a barrier holds the submission's write just before it executes (after its read and all
// of its in-memory checks), the competing transition commits, then the write is released. The barrier
// recognises both the conditional UPDATE persistEvidence() uses now and the unconditional
// prisma.dispute.update() it used before, so the same tests run against either version of the code.
// Assertions cover the final durable status, the complete evidence list, ruling and proposal fields,
// durable event counts, and what recovery can still see.

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash, randomUUID } from 'crypto'
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

describe('persistEvidence() — authority and lost-update races decided by the durable write (real Postgres)', () => {
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

  const ARBITER_ID = 'evidence-concurrency-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

  let realFetch: typeof fetch

  function mockExplorerWithFundedOutpoints(fundingTxids: string[]): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes('/tx/') && url.endsWith('/status')) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => fundingTxids.map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } })) } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'evidence-concurrency-seed'
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
    // Projections complete as in production (handlers registered at boot); QVAC auto-resolution stays off
    // (its default), so the evidence handler returns without calling out.
    require('../../src/common/events/handlers').registerEventHandlers()

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'Evidence concurrency arbiter' },
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
    writeGates.length = 0
    interceptorInstalled = false
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

  interface Fixture { disputeId: string; escrowId: string; tradeId: string; buyerId: string; sellerId: string; fundingTxid: string }

  // A real MULTISIG escrow, funded and disputed (arbiter from the real trusted-list provider), opened with ONE
  // piece of evidence so that any overwrite of the list is visible.
  async function makeDispute(suffix: string): Promise<Fixture> {
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
    const fundingTxid = createHash('sha256').update(`evidence-race-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
    mockExplorerWithFundedOutpoints([fundingTxid])
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `evidence race — ${suffix}`, [{ type: 'chat_log', note: 'opening evidence' }])
    expect(dispute.arbiterId).toBe(ARBITER_ID)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`evidence-race-${suffix}-buyer-${Date.now()}`))
    return { disputeId: dispute.id, escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, fundingTxid }
  }

  // The real authoritative ruling commit (signature verified, State claimed, durable record written — one
  // transaction), stopping before dispatch: exactly the durable C4 state recovery exists for.
  async function commitRuling(f: Fixture): Promise<void> {
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const payload: AuthorityDecisionPayload = {
      disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE', buyerBps: null, issuedAt: new Date().toISOString(),
    }
    const signature = signAuthorityDecision(payload, arbiterKeypair.secretKey)
    const result = await commitAuthoritativeDisputeRuling(
      { id: f.disputeId, escrowId: f.escrowId, status: row.status, appealRound: 0 },
      payload, signature, arbiterPublicKeyHex, '100000', 'BTC', f.buyerId, f.sellerId,
    )
    expect(result.committed).toBe(true)
  }

  function submit(f: Fixture, by: string, note: string, idempotencyKey?: string) {
    return getDisputeService().submitEvidence(f.disputeId, by, { type: 'payment_receipt', note }, idempotencyKey)
  }

  // ─── deterministic interleaving ──────────────────────────────────────────────────────────────────────────

  interface Gate { reached: Promise<void>; release: () => void }
  const writeGates: Array<{ signalReached: () => void; released: Promise<void> }> = []
  let interceptorInstalled = false

  // Holds the next evidence write — the conditional `UPDATE disputes SET evidence = ...` persistEvidence() issues
  // now (with RETURNING since #309), or the `prisma.dispute.update({ data: { evidence } })` it issued before — until release(). One write per
  // gate, in gate order; every other statement passes straight through.
  function holdNextEvidenceWrite(): Gate {
    let signalReached!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { signalReached = r })
    const released = new Promise<void>((r) => { release = r })
    writeGates.push({ signalReached, released })
    if (!interceptorInstalled) {
      interceptorInstalled = true
      const client = prisma as any
      // The write is a raw `UPDATE disputes SET evidence = ...`: through $executeRaw, or through $queryRaw since
      // #309 added `RETURNING "evidenceGeneration"` to it. Both are held the same way.
      for (const method of ['$executeRaw', '$queryRaw'] as const) {
        const originalRaw = client[method].bind(client)
        jest.spyOn(client, method).mockImplementation(async (...args: unknown[]) => {
          const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]]
          if (Array.isArray(strings) && strings.join('?').includes('UPDATE disputes') && strings.join('?').includes('SET evidence') && writeGates.length > 0) {
            const gate = writeGates.shift()!
            gate.signalReached()
            await gate.released
          }
          return originalRaw(strings, ...values)
        })
      }
      const delegate = client.dispute
      const originalUpdate = delegate.update.bind(delegate)
      jest.spyOn(delegate, 'update').mockImplementation(async (args: any) => {
        if (args?.data?.evidence !== undefined && writeGates.length > 0) {
          const gate = writeGates.shift()!
          gate.signalReached()
          await gate.released
        }
        return originalUpdate(args)
      })
    }
    return { reached, release }
  }

  // Waits for the held submission to reach its write; if it settles first instead, fail at once with that outcome.
  async function reachedOrSettled(gate: Gate, caller: Promise<unknown>): Promise<void> {
    await Promise.race([
      gate.reached,
      caller.then(
        () => { throw new Error('the held submission completed before reaching its write') },
        (err) => { throw new Error(`the held submission was refused before reaching its write: ${err instanceof Error ? err.message : String(err)}`) },
      ),
    ])
  }

  // ─── observations ────────────────────────────────────────────────────────────────────────────────────────

  async function notes(disputeId: string): Promise<string[]> {
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })
    return (row.evidence as Array<{ note?: string }>).map((e) => e.note ?? '')
  }

  async function durableEvents(eventName: string, disputeId: string): Promise<number> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM durable_events WHERE "eventName" = ${eventName} AND payload->>'disputeId' = ${disputeId}`
    return Number(n)
  }

  async function c4ResumesDispatch(f: Fixture): Promise<void> {
    const queue = async () => (await prisma.$queryRaw<Array<{ escrowId: string }>>`
      SELECT d."escrowId" FROM disputes d JOIN escrows e ON e.id = d."escrowId"
      WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG' AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
        -- #239: same predicate as claimCandidates() - a dead cooperative round (not fully signed, no ruling) is no dispatch
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
          AND (p."disputeId" IS NOT NULL OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))
        AND EXISTS (SELECT 1 FROM semantic_transition_records r WHERE r."interactionId" = d."escrowId"
          AND r."transitionType" = 'escrow.dispute.rule' AND r."appealRound" = d."appealRound" AND r."outcomeContent" IS NOT NULL)`).map((r) => r.escrowId)
    expect(await queue()).toContain(f.escrowId)
    mockExplorerWithFundedOutpoints([f.fundingTxid])
    const bound = Math.ceil((await queue()).length / DISPATCH_RECOVERY_BATCH)
    for (let i = 0; i < bound; i++) {
      if ((await reconcileMissingDispatch()).claimed.includes(f.escrowId)) break
    }
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
  }

  async function finalizationRecovers(f: Fixture): Promise<void> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM disputes d WHERE d.status = 'RESOLVED' AND NOT EXISTS (
        SELECT 1 FROM event_projection_claims c WHERE c."eventId" = d.id AND c."projectionKey" = 'dispute.ruling-finalized' AND c."subjectId" = d."appealRound"::text)`
    let recovered = false
    for (let i = 0; i < Math.ceil(Number(n) / 200) + 1 && !recovered; i++) {
      recovered = (await getDisputeService().recoverMissingRulingFinalization()).recovered.includes(f.disputeId)
    }
    expect(recovered).toBe(true)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: f.disputeId, projectionKey: 'dispute.ruling-finalized' } })).toBe(1)
  }

  async function assertResolvedIntact(f: Fixture): Promise<void> {
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('RESOLVED')
    expect(row.ruling).toBe('RELEASE')
    expect(row.authoritySignature).not.toBeNull()
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: f.escrowId, transitionType: 'escrow.dispute.rule' } })).toBe(1)
  }

  // ─── A / G. evidence vs ruling ───────────────────────────────────────────────────────────────────────────

  it('A/G — a submission validated before the ruling, whose write lands after RESOLVED committed, changes nothing and emits nothing; the ruling stays visible to C4 and finalization recovery', async () => {
    requirePostgres('A evidence vs ruling')
    const f = await makeDispute('a')

    const gate = holdNextEvidenceWrite()
    const stale = submit(f, f.buyerId, 'late receipt')
    await reachedOrSettled(gate, stale)
    await commitRuling(f)
    gate.release()

    await expect(stale).rejects.toThrow('cannot accept new evidence from status RESOLVED')
    await assertResolvedIntact(f)
    expect(await notes(f.disputeId)).toEqual(['opening evidence'])
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(0)
    await c4ResumesDispatch(f)
    await finalizationRecovers(f)
  })

  // ─── B / H. evidence vs a proposal ───────────────────────────────────────────────────────────────────────

  it('B/H — a submission whose write lands after an auto-resolution proposal committed never erases it: the proposal and its deadline stay, nothing is appended, nothing is emitted', async () => {
    requirePostgres('B evidence vs proposal')
    const f = await makeDispute('b')

    const gate = holdNextEvidenceWrite()
    const stale = submit(f, f.sellerId, 'late statement')
    await reachedOrSettled(gate, stale)
    const proposed = await getDisputeService().proposeAutoResolution(f.disputeId, 'REFUND', 0.95, 'proposal')
    gate.release()

    await expect(stale).rejects.toThrow('cannot accept new evidence from status AUTO_PROPOSED')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('AUTO_PROPOSED')
    expect(row.autoResolutionRecommendation).toBe('REFUND')
    expect(row.autoResolutionDeadline!.getTime()).toBe(proposed!.autoResolutionDeadline!.getTime())
    expect(await notes(f.disputeId)).toEqual(['opening evidence'])
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(0)
  })

  // ─── C. evidence vs proposal then contest (ABA) ──────────────────────────────────────────────────────────

  it('C (ABA) — a proposal made and contested while the submission was held leaves the dispute genuinely open again: the submission is appended to the CURRENT evidence, once, and emits once', async () => {
    requirePostgres('C evidence vs proposal+contest')
    const f = await makeDispute('c')

    const gate = holdNextEvidenceWrite()
    const held = submit(f, f.buyerId, 'receipt during proposal')
    await reachedOrSettled(gate, held)
    await getDisputeService().proposeAutoResolution(f.disputeId, 'REFUND', 0.95, 'proposal')
    await getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
    gate.release()
    await held

    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('EVIDENCE_SUBMITTED')
    expect(row.autoResolutionDeadline).toBeNull()
    expect(await notes(f.disputeId)).toEqual(['opening evidence', 'receipt during proposal'])
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(1)
    expect(await durableEvents('dispute.auto_resolution_contested', f.disputeId)).toBe(1)
    // Committed evidence takes part in auto-resolution exactly as the state machine allows: a new proposal
    // may now be made from EVIDENCE_SUBMITTED.
    expect((await getDisputeService().proposeAutoResolution(f.disputeId, 'RELEASE', 0.9, 'after new evidence'))!.status).toBe('AUTO_PROPOSED')
  })

  // ─── D. evidence vs appeal ───────────────────────────────────────────────────────────────────────────────

  it('D — a submission whose write lands after the dispute moved to APPEALED never reverts it', async () => {
    requirePostgres('D evidence vs appeal')
    const f = await makeDispute('d')

    const gate = holdNextEvidenceWrite()
    const stale = submit(f, f.buyerId, 'late note')
    await reachedOrSettled(gate, stale)
    await commitRuling(f)
    // appeal() itself refuses this rail (script-committed arbiter, asserted in the auto-resolution race tests),
    // so the transition it commits on appeal-capable rails is written here with appeal()'s own claim shape:
    // RESOLVED -> APPEALED, next round, previous ruling/arbiter captured.
    const appealed = await prisma.dispute.updateMany({
      where: { id: f.disputeId, status: 'RESOLVED', appealRound: 0 },
      data: { status: 'APPEALED', appealRound: 1, previousRuling: 'RELEASE', previousArbiterId: ARBITER_ID, ruling: null, resolvedAt: null },
    })
    expect(appealed.count).toBe(1)
    gate.release()

    await expect(stale).rejects.toThrow('cannot accept new evidence from status APPEALED')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('APPEALED')
    expect(row.appealRound).toBe(1)
    expect(await notes(f.disputeId)).toEqual(['opening evidence'])
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(0)
  })

  // ─── E. two concurrent submissions ───────────────────────────────────────────────────────────────────────

  it('E — buyer and seller submit at once, both validated against the same list: BOTH entries survive, and each emits once', async () => {
    requirePostgres('E two submissions')
    const f = await makeDispute('e')

    const gateBuyer = holdNextEvidenceWrite()
    const byBuyer = submit(f, f.buyerId, 'buyer receipt')
    await reachedOrSettled(gateBuyer, byBuyer)
    const gateSeller = holdNextEvidenceWrite()
    const bySeller = submit(f, f.sellerId, 'seller statement')
    await reachedOrSettled(gateSeller, bySeller)
    gateBuyer.release()
    gateSeller.release()
    await Promise.all([byBuyer, bySeller])

    expect((await notes(f.disputeId)).sort()).toEqual(['buyer receipt', 'opening evidence', 'seller statement'])
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })).status).toBe('EVIDENCE_SUBMITTED')
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(2)
  })

  // ─── F. N concurrent submissions ─────────────────────────────────────────────────────────────────────────

  it('F — eight submissions all validated against the same list and released together: all eight survive, eight events', async () => {
    requirePostgres('F N submissions')
    const f = await makeDispute('f')
    const N = 8

    const pending: Array<Promise<unknown>> = []
    const gates: Gate[] = []
    for (let i = 0; i < N; i++) {
      const gate = holdNextEvidenceWrite()
      const call = submit(f, i % 2 === 0 ? f.buyerId : f.sellerId, `entry ${i}`)
      await reachedOrSettled(gate, call)
      gates.push(gate)
      pending.push(call)
    }
    gates.forEach((g) => g.release())
    await Promise.all(pending)

    const stored = await notes(f.disputeId)
    expect(stored).toHaveLength(N + 1)
    expect(stored.sort()).toEqual(['opening evidence', ...Array.from({ length: N }, (_, i) => `entry ${i}`)].sort())
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(N)
  })

  // ─── I. restart ──────────────────────────────────────────────────────────────────────────────────────────

  it('I — after a ruling commits, a restarted process (fresh module graph, own PrismaClient) submitting evidence is refused and the ruling stands', async () => {
    requirePostgres('I restart')
    const f = await makeDispute('i')
    await commitRuling(f)

    let fresh!: { submit: () => Promise<unknown>; shutdown: () => Promise<void> }
    jest.isolateModules(() => {
      const service = require('../../src/modules/open-settlement/dispute.service').getDisputeService()
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      fresh = {
        submit: () => service.submitEvidence(f.disputeId, f.buyerId, { type: 'payment_receipt', note: 'after restart' }),
        shutdown: async () => { await db.prisma.$disconnect(); await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    try {
      await expect(fresh.submit()).rejects.toThrow('cannot accept new evidence from status RESOLVED')
    } finally {
      await fresh.shutdown()
    }
    await assertResolvedIntact(f)
    expect(await notes(f.disputeId)).toEqual(['opening evidence'])
  })

  // ─── J. duplicate / replayed submissions (existing idempotency contract) ──────────────────────────────────

  it('J — replaying an idempotency key appends once; a concurrent replay while the first is still in flight is refused; submissions without a key are independent (the existing contract)', async () => {
    requirePostgres('J replay')
    const f = await makeDispute('j')
    const key = `evidence-${randomUUID()}`

    const gate = holdNextEvidenceWrite()
    const first = submit(f, f.buyerId, 'keyed receipt', key)
    await reachedOrSettled(gate, first)
    await expect(submit(f, f.buyerId, 'keyed receipt', key)).rejects.toThrow(/already being processed/)
    gate.release()
    await first
    await submit(f, f.buyerId, 'keyed receipt', key) // sequential replay: recovered, not re-applied

    await submit(f, f.sellerId, 'unkeyed note')
    await submit(f, f.sellerId, 'unkeyed note')

    expect((await notes(f.disputeId)).sort()).toEqual(['keyed receipt', 'opening evidence', 'unkeyed note', 'unkeyed note'])
    expect(await durableEvents('dispute.evidence_submitted', f.disputeId)).toBe(3)
  })
})
