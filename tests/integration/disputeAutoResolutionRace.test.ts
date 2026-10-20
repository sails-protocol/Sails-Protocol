// tests/integration/disputeAutoResolutionRace.test.ts
//
// Dispute auto-resolution stale-overwrite — real PostgreSQL proof that the durable conditional transition,
// not whoever happens to write last, decides every race around AUTO_PROPOSED.
//
// sweepExpiredAutoResolutions() and contestAutoResolution() both read a dispute, decide, then write. Each
// test below forces the dangerous interleaving deterministically: a barrier holds the service right after
// its read, the competing transition (a real authoritative ruling commit, another sweep, another contest,
// a new proposal) commits while it waits, then the stale caller resumes. Before the fix, the resumed write
// was an update by id alone and overwrote whatever had committed meanwhile. Every test asserts the final
// durable status, the ruling fields, the number of dispute.auto_resolution_contested durable events, and
// what the recovery paths can still see.

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

describe('Dispute auto-resolution — stale-overwrite races decided by the durable transition (real Postgres)', () => {
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

  const ARBITER_ID = 'auto-resolution-race-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')
  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'
  const SWEEPER_ACTOR = 'window-expired-advisory-only'

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
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'auto-resolution-race-seed'
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
    // Projections complete as in production (handlers are registered at boot), so fixtures leave nothing
    // claimed-but-unprojected behind for later PASS 3 runs to re-drive.
    require('../../src/common/events/handlers').registerEventHandlers()

    await prisma.user.upsert({
      where: { id: ARBITER_ID },
      update: { publicKey: arbiterPublicKeyHex },
      create: { id: ARBITER_ID, publicKey: arbiterPublicKeyHex, displayName: 'Auto-resolution race arbiter' },
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

  interface Fixture { disputeId: string; escrowId: string; tradeId: string; buyerId: string; sellerId: string; fundingTxid: string; deadline: Date }

  // A real MULTISIG escrow, funded, disputed (arbiter assigned by the real trusted-list provider), with a real
  // proposeAutoResolution() proposal on it. The proposal's contest deadline is then pinned to
  // `deadlineOffsetMs` from the moment the fixture is ready (the only thing a fixture overrides, standing in
  // for QVAC_AUTO_RESOLUTION_WINDOW_HOURS). Relative to readiness, not to the call, so a slow machine cannot
  // spend a short window on building the fixture.
  async function makeAutoProposedDispute(suffix: string, deadlineOffsetMs: number): Promise<Fixture> {
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
    const fundingTxid = createHash('sha256').update(`auto-race-${suffix}-${Date.now()}-${Math.random()}`).digest('hex')
    mockExplorerWithFundedOutpoints([fundingTxid])
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `auto-resolution race — ${suffix}`)
    expect(dispute.arbiterId).toBe(ARBITER_ID)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`auto-race-${suffix}-buyer-${Date.now()}`))

    const proposed = await getDisputeService().proposeAutoResolution(dispute.id, 'RELEASE', 0.97, 'fixture proposal')
    expect(proposed!.status).toBe('AUTO_PROPOSED')
    const deadline = new Date(Date.now() + deadlineOffsetMs)
    await prisma.dispute.update({ where: { id: dispute.id }, data: { autoResolutionDeadline: deadline } })

    return { disputeId: dispute.id, escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, fundingTxid, deadline }
  }

  // The real authoritative ruling commit an arbiter's resolveDispute() performs (signature verified, State
  // claimed, durable SemanticTransitionRecord written — one transaction), stopping before dispatch: exactly
  // the durable C4 state recovery exists for.
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

  // ─── deterministic interleaving ──────────────────────────────────────────────────────────────────────────

  interface Gate { reached: Promise<void>; release: () => void }

  // Holds the NEXT call to prisma.dispute.<method> right after its real read returns, until release().
  // Everything else about that call — the real query, its result — is untouched. Used for the sweep, whose
  // decision is fully taken from that read.
  function holdAfterNextRead(method: 'findMany' | 'findUnique'): Gate {
    const delegate = prisma.dispute as any
    const original = delegate[method].bind(delegate)
    let signalReached!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { signalReached = r })
    const released = new Promise<void>((r) => { release = r })
    jest.spyOn(delegate, method).mockImplementationOnce(async (args: unknown) => {
      const result = await original(args)
      signalReached()
      await released
      return result
    })
    return { reached, release }
  }

  // Holds the contest's conditional write (its raw `UPDATE disputes ...`) BEFORE it executes, until release():
  // the contest has already read and validated, and its write is pending. This is the exact window the
  // contest's in-memory checks (party, status, deadline) cannot close: they ran against the read, the write
  // lands later. Only `UPDATE disputes` statements are held, one per gate, in the order gates were created;
  // every other raw statement (event store, advisory locks) passes straight through.
  const writeGates: Array<{ signalReached: () => void; released: Promise<void> }> = []
  let writeInterceptorInstalled = false
  afterEach(() => { writeGates.length = 0; writeInterceptorInstalled = false })

  function holdBeforeNextWrite(): Gate {
    let signalReached!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { signalReached = r })
    const released = new Promise<void>((r) => { release = r })
    writeGates.push({ signalReached, released })
    if (!writeInterceptorInstalled) {
      writeInterceptorInstalled = true
      const client = prisma as any
      const original = client.$executeRaw.bind(client)
      jest.spyOn(client, '$executeRaw').mockImplementation(async (...args: unknown[]) => {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]]
        if (Array.isArray(strings) && strings.join('?').includes('UPDATE disputes') && writeGates.length > 0) {
          const gate = writeGates.shift()!
          gate.signalReached()
          await gate.released
        }
        return original(strings, ...values)
      })
    }
    return { reached, release }
  }

  // Waits for a held caller to reach its gate; if the caller settles first instead (it was refused before its
  // write), fail at once with that outcome rather than waiting out the test timeout.
  async function reachedOrSettled(gate: Gate, caller: Promise<unknown>): Promise<void> {
    await Promise.race([
      gate.reached,
      caller.then(
        () => { throw new Error('the held call completed before reaching its write') },
        (err) => { throw new Error(`the held call was refused before reaching its write: ${err instanceof Error ? err.message : String(err)}`) },
      ),
    ])
  }

  // ─── observations ────────────────────────────────────────────────────────────────────────────────────────

  async function contestedEvents(disputeId: string): Promise<Array<{ contestedBy: string }>> {
    const rows = await prisma.$queryRaw<Array<{ payload: any }>>`
      SELECT payload FROM durable_events WHERE "eventName" = 'dispute.auto_resolution_contested' AND payload->>'disputeId' = ${disputeId}`
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload))
  }

  async function c4Queue(): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ escrowId: string }>>`
      SELECT d."escrowId" FROM disputes d JOIN escrows e ON e.id = d."escrowId"
      WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG' AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
        -- #239: same predicate as claimCandidates() - a dead cooperative round (not fully signed, no ruling) is no dispatch
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
          AND (p."disputeId" IS NOT NULL OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))
        AND EXISTS (SELECT 1 FROM semantic_transition_records r WHERE r."interactionId" = d."escrowId"
          AND r."transitionType" = 'escrow.dispute.rule' AND r."appealRound" = d."appealRound" AND r."outcomeContent" IS NOT NULL)`
    return rows.map((r) => r.escrowId)
  }

  // C4 recovery really resumes the dispatch (bounded sweeps, starvation bound from the real queue).
  async function c4ResumesDispatch(f: Fixture): Promise<void> {
    expect(await c4Queue()).toContain(f.escrowId)
    mockExplorerWithFundedOutpoints([f.fundingTxid])
    const bound = Math.ceil((await c4Queue()).length / DISPATCH_RECOVERY_BATCH)
    for (let i = 0; i < bound; i++) {
      const report = await reconcileMissingDispatch()
      if (report.claimed.includes(f.escrowId)) {
        expect(report.resumed.map((r) => r.escrowId)).toContain(f.escrowId)
        break
      }
    }
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
  }

  // Ruling-finalization recovery really finalizes it, exactly once (bounded by its own backlog).
  async function finalizationRecovers(f: Fixture): Promise<void> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM disputes d WHERE d.status = 'RESOLVED' AND NOT EXISTS (
        SELECT 1 FROM event_projection_claims c WHERE c."eventId" = d.id AND c."projectionKey" = 'dispute.ruling-finalized' AND c."subjectId" = d."appealRound"::text)`
    const bound = Math.ceil(Number(n) / 200) + 1
    let recovered = false
    for (let i = 0; i < bound && !recovered; i++) recovered = (await getDisputeService().recoverMissingRulingFinalization()).recovered.includes(f.disputeId)
    expect(recovered).toBe(true)
    expect((await getDisputeService().recoverMissingRulingFinalization()).recovered).not.toContain(f.disputeId)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: f.disputeId, projectionKey: 'dispute.ruling-finalized' } })).toBe(1)
  }

  async function assertResolvedIntact(f: Fixture): Promise<void> {
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('RESOLVED')
    expect(row.ruling).toBe('RELEASE')
    expect(row.authoritySignature).not.toBeNull()
    expect(row.resolvedAt).not.toBeNull()
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: f.escrowId, transitionType: 'escrow.dispute.rule' } })).toBe(1)
  }

  // ─── A. expiration sweeper vs arbiter ruling ────────────────────────────────────────────────────────────

  it('A — a sweep that read the proposal as expired, then resumes after the arbiter\'s ruling committed, overwrites nothing and emits nothing; C4 and ruling-finalization recovery still see and recover the ruling', async () => {
    requirePostgres('A sweeper vs ruling')
    const f = await makeAutoProposedDispute('a', -60_000)

    const gate = holdAfterNextRead('findMany')
    const sweep = getDisputeService().sweepExpiredAutoResolutions()
    await gate.reached
    await commitRuling(f)
    gate.release()
    const result = await sweep

    expect(result.superseded).toContain(f.disputeId)
    expect(result.revertedToHuman).not.toContain(f.disputeId)
    await assertResolvedIntact(f)
    expect(await contestedEvents(f.disputeId)).toEqual([])
    await c4ResumesDispatch(f)
    await finalizationRecovers(f)
  })

  // ─── B. expiration sweeper vs contest ───────────────────────────────────────────────────────────────────

  it('B1 — a contest validated inside its window, whose write lands after the window closed and the sweep reverted the proposal, changes nothing and emits nothing: exactly one contested event (the sweep\'s)', async () => {
    requirePostgres('B1 sweeper wins over a stale contest')
    const f = await makeAutoProposedDispute('b1', 3_000)

    const gate = holdBeforeNextWrite()
    const contest = getDisputeService().contestAutoResolution(f.disputeId, f.buyerId)
    await reachedOrSettled(gate, contest) // fails fast (with the contest's own error) if it never reaches its write
    await new Promise((r) => setTimeout(r, Math.max(0, f.deadline.getTime() - Date.now()) + 50)) // the window really closes
    const sweep = await getDisputeService().sweepExpiredAutoResolutions()
    expect(sweep.revertedToHuman).toContain(f.disputeId)
    gate.release()

    await expect(contest).rejects.toThrow('no pending automated resolution to contest (status: EVIDENCE_SUBMITTED)')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('EVIDENCE_SUBMITTED')
    expect(row.autoResolutionDeadline).toBeNull()
    expect(row.autoResolutionRecommendation).toBe('RELEASE') // the sweep keeps QVAC's context for the arbiter; a contest would have cleared it
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([SWEEPER_ACTOR])
  })

  it('B2 — a contest validated inside the window whose write lands after it closed is refused by the write itself (deadline >= now in the claim); the sweep then reverts the proposal once', async () => {
    requirePostgres('B2 closed window beats a stale contest')
    const f = await makeAutoProposedDispute('b2', 3_000)

    const gate = holdBeforeNextWrite()
    const contest = getDisputeService().contestAutoResolution(f.disputeId, f.buyerId)
    await reachedOrSettled(gate, contest) // fails fast (with the contest's own error) if it never reaches its write
    await new Promise((r) => setTimeout(r, Math.max(0, f.deadline.getTime() - Date.now()) + 50))
    gate.release()
    await expect(contest).rejects.toThrow('contest window has already closed')
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })).status).toBe('AUTO_PROPOSED')

    const sweep = await getDisputeService().sweepExpiredAutoResolutions()
    expect(sweep.revertedToHuman).toContain(f.disputeId)
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([SWEEPER_ACTOR])
  })

  // ─── C. contest vs arbiter ruling ───────────────────────────────────────────────────────────────────────

  it('C1 — a contest that resumes after the arbiter\'s ruling committed overwrites nothing and emits nothing; the ruling stays visible to C4 recovery', async () => {
    requirePostgres('C1 ruling wins over a stale contest')
    const f = await makeAutoProposedDispute('c1', 3_600_000)

    const gate = holdBeforeNextWrite()
    const contest = getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
    await gate.reached
    await commitRuling(f)
    gate.release()

    await expect(contest).rejects.toThrow('no pending automated resolution to contest (status: RESOLVED)')
    await assertResolvedIntact(f)
    expect(await contestedEvents(f.disputeId)).toEqual([])
    expect(await c4Queue()).toContain(f.escrowId)
  })

  it('C2 — a contest that commits first is followed by a ruling from EVIDENCE_SUBMITTED (the state machine allows it): one contested event, one ruling', async () => {
    requirePostgres('C2 contest then ruling')
    const f = await makeAutoProposedDispute('c2', 3_600_000)

    await getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
    await commitRuling(f)

    await assertResolvedIntact(f)
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([f.sellerId])
  })

  // ─── D. two expiration workers ──────────────────────────────────────────────────────────────────────────

  it('D — two sweeps that both read the same expired proposal: exactly one reverts it and emits, the other is superseded', async () => {
    requirePostgres('D two sweepers')
    const f = await makeAutoProposedDispute('d', -60_000)

    const gateA = holdAfterNextRead('findMany')
    const sweepA = getDisputeService().sweepExpiredAutoResolutions()
    await gateA.reached
    const gateB = holdAfterNextRead('findMany')
    const sweepB = getDisputeService().sweepExpiredAutoResolutions()
    await gateB.reached
    gateA.release()
    gateB.release()
    const [a, b] = await Promise.all([sweepA, sweepB])

    const reverted = [a, b].filter((r) => r.revertedToHuman.includes(f.disputeId)).length
    const superseded = [a, b].filter((r) => r.superseded.includes(f.disputeId)).length
    expect([reverted, superseded]).toEqual([1, 1])
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })).status).toBe('EVIDENCE_SUBMITTED')
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([SWEEPER_ACTOR])
  })

  // ─── E. two contest attempts ────────────────────────────────────────────────────────────────────────────

  it('E — buyer and seller contest the same proposal at once: exactly one wins and emits; the other is refused', async () => {
    requirePostgres('E two contests')
    const f = await makeAutoProposedDispute('e', 3_600_000)

    const gateBuyer = holdBeforeNextWrite()
    const byBuyer = getDisputeService().contestAutoResolution(f.disputeId, f.buyerId)
    await gateBuyer.reached
    const gateSeller = holdBeforeNextWrite()
    const bySeller = getDisputeService().contestAutoResolution(f.disputeId, f.sellerId)
    await gateSeller.reached
    gateBuyer.release()
    gateSeller.release()
    const outcomes = await Promise.allSettled([byBuyer, bySeller])

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0].reason?.message)).toMatch(/no pending automated resolution to contest \(status: EVIDENCE_SUBMITTED\)/)
    const events = await contestedEvents(f.disputeId)
    expect(events).toHaveLength(1)
    expect([f.buyerId, f.sellerId]).toContain(events[0].contestedBy)
  })

  // ─── F + G. restart, and a delayed loser resuming after recovery already acted ──────────────────────────

  it('F/G — after the ruling wins, a fresh (restarted) sweeper graph never touches it; C4 recovery then resumes the dispatch; the original stale sweep, resuming only after all that, is still a no-op', async () => {
    requirePostgres('F/G restart and delayed loser')
    const f = await makeAutoProposedDispute('fg', -60_000)

    const gate = holdAfterNextRead('findMany')
    const staleSweep = getDisputeService().sweepExpiredAutoResolutions()
    await gate.reached
    await commitRuling(f)

    // F: a restarted process — its own module graph, PrismaClient and Redis client — sweeps from durable state.
    let restarted!: { sweep: () => Promise<{ revertedToHuman: string[]; superseded: string[] }>; shutdown: () => Promise<void> }
    jest.isolateModules(() => {
      const service = require('../../src/modules/open-settlement/dispute.service').getDisputeService()
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      restarted = {
        sweep: () => service.sweepExpiredAutoResolutions(),
        shutdown: async () => { await db.prisma.$disconnect(); await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    try {
      const fresh = await restarted.sweep()
      expect(fresh.revertedToHuman).not.toContain(f.disputeId)
      expect(fresh.superseded).not.toContain(f.disputeId) // not even selected: it is no longer AUTO_PROPOSED
    } finally {
      await restarted.shutdown()
    }

    // G: recovery acts first, the stale loser resumes last.
    await c4ResumesDispatch(f)
    gate.release()
    const late = await staleSweep
    expect(late.superseded).toContain(f.disputeId)

    await assertResolvedIntact(f)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } })).toBe(1)
    expect(await contestedEvents(f.disputeId)).toEqual([])
  })

  // ─── H. appeal / ruling-recovery interaction ────────────────────────────────────────────────────────────

  it('H — the ruling that beat a stale sweep keeps every RESOLVED-gated path: finalization recovers it once, and appeal() evaluates it as RESOLVED (refused only for this rail\'s script-committed arbiter, never for its status)', async () => {
    requirePostgres('H appeal and finalization')
    const f = await makeAutoProposedDispute('h', -60_000)

    const gate = holdAfterNextRead('findMany')
    const sweep = getDisputeService().sweepExpiredAutoResolutions()
    await gate.reached
    await commitRuling(f)
    gate.release()
    expect((await sweep).superseded).toContain(f.disputeId)

    await finalizationRecovers(f)
    await expect(getDisputeService().appeal(f.disputeId, f.buyerId)).rejects.toThrow(/immutable, script-committed arbiter identity/)
    await assertResolvedIntact(f)
  })

  // ─── ABA: a newer proposal is never acted on through a stale read of the older one ──────────────────────

  it('ABA sweep — a sweep holding an expired proposal P1, resuming after P1 was reverted and a new proposal P2 was made, leaves P2 untouched', async () => {
    requirePostgres('ABA sweep')
    const f = await makeAutoProposedDispute('aba-sweep', -60_000)

    const gate = holdAfterNextRead('findMany')
    const staleSweep = getDisputeService().sweepExpiredAutoResolutions()
    await gate.reached
    const other = await getDisputeService().sweepExpiredAutoResolutions() // P1 reverted by another sweep
    expect(other.revertedToHuman).toContain(f.disputeId)
    const p2 = await getDisputeService().proposeAutoResolution(f.disputeId, 'REFUND', 0.99, 'second proposal')
    expect(p2!.status).toBe('AUTO_PROPOSED')
    gate.release()
    const late = await staleSweep

    expect(late.superseded).toContain(f.disputeId)
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('AUTO_PROPOSED')
    expect(row.autoResolutionRecommendation).toBe('REFUND')
    expect(row.autoResolutionDeadline!.getTime()).toBe(p2!.autoResolutionDeadline!.getTime())
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([SWEEPER_ACTOR]) // P1's revert only
  })

  it('ABA contest — a contest holding proposal P1, resuming after P1 was contested and a new proposal P2 was made, never contests P2', async () => {
    requirePostgres('ABA contest')
    const f = await makeAutoProposedDispute('aba-contest', 3_600_000)

    const gate = holdBeforeNextWrite()
    const staleContest = getDisputeService().contestAutoResolution(f.disputeId, f.buyerId)
    await gate.reached
    await getDisputeService().contestAutoResolution(f.disputeId, f.sellerId) // P1 contested by the other party
    const p2 = await getDisputeService().proposeAutoResolution(f.disputeId, 'REFUND', 0.99, 'second proposal')
    expect(p2!.status).toBe('AUTO_PROPOSED')
    gate.release()

    await expect(staleContest).rejects.toThrow('replaced by a newer proposal')
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(row.status).toBe('AUTO_PROPOSED')
    expect(row.autoResolutionRecommendation).toBe('REFUND')
    expect((await contestedEvents(f.disputeId)).map((e) => e.contestedBy)).toEqual([f.sellerId])
  })
})
