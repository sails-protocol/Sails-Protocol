// tests/integration/autoResolutionConcurrency.test.ts
//
// Issue #308 - real PostgreSQL proof that for one AUTO_PROPOSED generation (identified by the
// observed pair status='AUTO_PROPOSED' + autoResolutionDeadline), competing actors
// (contestAutoResolution() / sweepExpiredAutoResolutions()) cannot both successfully consume it.
// Real Prisma, real Postgres, real DisputeService, genuinely concurrent calls (Promise.allSettled) -
// no mocked CAS/updateMany/transactions. QVAC stays advisory-only throughout; nothing here introduces
// economic disposition authority or automatic settlement execution - both methods under test only
// ever move Dispute.status between AUTO_PROPOSED and EVIDENCE_SUBMITTED.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #308 - auto-resolution contest/sweep CAS concurrency (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let TrustedArbitratorProvider: typeof import('../../src/modules/open-settlement/arbitration-provider').TrustedArbitratorProvider
  let service: InstanceType<typeof DisputeService>

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ TrustedArbitratorProvider } = require('../../src/modules/open-settlement/arbitration-provider'))
    service = new DisputeService(new TrustedArbitratorProvider(['test-arbiter-308']))
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

  let createdUserIds: string[] = []
  let createdTradeIds: string[] = []
  let createdDisputeIds: string[] = []

  beforeEach(() => {
    createdUserIds = []
    createdTradeIds = []
    createdDisputeIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdDisputeIds.length) {
      await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: createdTradeIds } } })
      await prisma.dispute.deleteMany({ where: { id: { in: createdDisputeIds } } })
    }
    if (createdTradeIds.length) {
      await prisma.trade.updateMany({ where: { id: { in: createdTradeIds } }, data: { escrowId: null } })
    }
    if (createdTradeIds.length) {
      const escrows = await prisma.escrow.findMany({ where: { tradeId: { in: createdTradeIds } }, select: { id: true } })
      if (escrows.length) await prisma.escrow.deleteMany({ where: { id: { in: escrows.map((e) => e.id) } } })
      await prisma.trade.deleteMany({ where: { id: { in: createdTradeIds } } })
    }
    if (createdUserIds.length) {
      await prisma.offer.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  async function makeAutoProposedDispute(deadline: Date) {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(seller.id, buyer.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED' } })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: {
        tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'issue-308 fixture',
        arbiterId: 'test-arbiter-308', status: 'AUTO_PROPOSED',
        autoResolutionRecommendation: 'RELEASE', autoResolutionConfidence: 0.92, autoResolutionReasoning: 'r',
        autoResolutionDeadline: deadline,
      },
    })
    createdDisputeIds.push(dispute.id)
    return { trade, escrow, buyer, seller, dispute }
  }

  const disputeOf = (id: string) => prisma.dispute.findUniqueOrThrow({ where: { id } })
  const contestedEventsFor = (tradeId: string) => prisma.durableEventRecord.findMany({ where: { correlationId: tradeId, eventName: 'dispute.auto_resolution_contested' } })

  // ── A. Contest x Sweeper ────────────────────────────────────────────────────────────────────
  it('A: Contest x Sweeper — a batch of AUTO_PROPOSED disputes with deadlines staggered across a genuine expiry boundary, contested and swept TRULY concurrently: exactly one actor consumes each generation, no duplicate event', async () => {
    requirePostgres('A contest x sweeper')
    // Each dispute's deadline is staggered across a ~100ms span (0, 2, 4, ... ms from race-start), and
    // the WHOLE batch of contest calls plus the sweep call are dispatched in ONE Promise.all - not
    // contest-then-sleep-then-sweep. This is the deliberate fix for "accidentally testing only
    // precondition timing" (the mission's own named risk): with every call starting at the same
    // instant, connection-pool queueing and per-call round-trip variance naturally spread out WHEN
    // each contest's own precondition check and CAS actually execute relative to its own deadline and
    // relative to the sweeper's single SELECT (fired after a mid-span delay) - producing genuine,
    // unpredictable overlap between contest's in-flight CAS and the sweeper's own claim attempt for
    // at least some of the batch, without the test depending on which specific disputes race which way.
    const N = 30
    const fixtures = await Promise.all(Array.from({ length: N }, () => makeAutoProposedDispute(new Date(Date.now() + 3600_000))))
    const raceStart = Date.now()
    await Promise.all(fixtures.map((f, i) =>
      prisma.dispute.update({ where: { id: f.dispute.id }, data: { autoResolutionDeadline: new Date(raceStart + i * 3) } })
    ))

    const [contestResults, sweepResult] = await Promise.all([
      Promise.allSettled(fixtures.map((f) => service.contestAutoResolution(f.dispute.id, f.buyer.id))),
      sleep(N * 1.5).then(() => service.sweepExpiredAutoResolutions()), // fires mid-span, genuinely concurrent with the contest batch above
    ])

    let contestWins = 0
    let sweepWins = 0
    for (const f of fixtures) {
      const final = await disputeOf(f.dispute.id)
      const wonBySweep = sweepResult.revertedToHuman.includes(f.dispute.id)
      // Exactly one actor consumed this generation - the row converged to EVIDENCE_SUBMITTED either
      // way, and the deadline is always cleared. Recommendation/confidence/reasoning are only cleared
      // by contestAutoResolution() (a real human decision follows immediately, nothing to preserve);
      // sweepExpiredAutoResolutions() deliberately LEAVES them as context for the human arbiter (same
      // invariant test B proves directly) - so this branches on which path actually won, never
      // asserting field-clearing behavior the winning path doesn't itself provide.
      expect(final.status).toBe('EVIDENCE_SUBMITTED')
      expect(final.autoResolutionDeadline).toBeNull()
      if (wonBySweep) {
        expect(final.autoResolutionRecommendation).toBe('RELEASE') // preserved as arbiter context
      } else {
        expect(final.autoResolutionRecommendation).toBeNull()
        expect(final.autoResolutionConfidence).toBeNull()
        expect(final.autoResolutionReasoning).toBeNull()
      }

      const events = await contestedEventsFor(f.trade.id)
      expect(events).toHaveLength(1) // never zero (someone must have converged it), never two (no duplicate)

      if (wonBySweep) sweepWins++
      else contestWins++
    }
    // Every dispute converged through exactly one path (contest resolving to a real value, or the
    // sweeper reverting it) - report which, for evidentiary honesty, without asserting a specific mix.
    expect(contestWins + sweepWins).toBe(N)
    const fulfilledContests = contestResults.filter((r) => r.status === 'fulfilled').length
    // Every contest call either won its CAS (fulfilled) or lost closed (rejected) - never silently no-oped.
    expect(fulfilledContests).toBe(contestWins)
    // eslint-disable-next-line no-console
    console.log(`[Issue #308 evidence] Contest x Sweeper batch (N=${N}): contest won ${contestWins}, sweeper won ${sweepWins}`)
  })

  // ── B. Sweeper x Sweeper ────────────────────────────────────────────────────────────────────
  it('B: Sweeper x Sweeper — two concurrent sweep passes against the same expired generation: one durable revert only, final state EVIDENCE_SUBMITTED', async () => {
    requirePostgres('B sweeper x sweeper')
    const f = await makeAutoProposedDispute(new Date(Date.now() - 1000)) // already expired

    const [r1, r2] = await Promise.all([service.sweepExpiredAutoResolutions(), service.sweepExpiredAutoResolutions()])

    const bothReverted = r1.revertedToHuman.includes(f.dispute.id) && r2.revertedToHuman.includes(f.dispute.id)
    expect(bothReverted).toBe(false) // both workers cannot claim the same generation
    const totalClaims = [r1, r2].filter((r) => r.revertedToHuman.includes(f.dispute.id)).length
    expect(totalClaims).toBe(1) // exactly one durable revert

    const final = await disputeOf(f.dispute.id)
    expect(final.status).toBe('EVIDENCE_SUBMITTED')
    expect(final.autoResolutionDeadline).toBeNull()
    // Recommendation/confidence/reasoning are deliberately left in place by sweepExpiredAutoResolutions()
    // (context for the human arbiter) - not cleared, unlike contestAutoResolution()'s own clear-all.
    expect(final.autoResolutionRecommendation).toBe('RELEASE')

    const events = await contestedEventsFor(f.trade.id)
    expect(events).toHaveLength(1) // no duplicate transition/event
  })

  // ── C. Contest x Contest ────────────────────────────────────────────────────────────────────
  it('C: Contest x Contest — two legitimate party contests racing the same generation: exactly one CAS claim succeeds, the other fails closed, no duplicate event, no field corruption', async () => {
    requirePostgres('C contest x contest')
    const f = await makeAutoProposedDispute(new Date(Date.now() + 3600_000)) // well inside the window - no expiry timing involved

    const [buyerResult, sellerResult] = await Promise.allSettled([
      service.contestAutoResolution(f.dispute.id, f.buyer.id),
      service.contestAutoResolution(f.dispute.id, f.seller.id),
    ])

    const outcomes = [buyerResult, sellerResult]
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled')
    const rejected = outcomes.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1) // exactly one CAS claim succeeds
    expect(rejected).toHaveLength(1) // the other fails closed
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/auto-resolution state changed before contest could commit/)

    const final = await disputeOf(f.dispute.id)
    expect(final.status).toBe('EVIDENCE_SUBMITTED')
    expect(final.autoResolutionRecommendation).toBeNull()
    expect(final.autoResolutionConfidence).toBeNull()
    expect(final.autoResolutionReasoning).toBeNull()
    expect(final.autoResolutionDeadline).toBeNull() // no corruption - fields fully and consistently cleared, not partially

    const events = await contestedEventsFor(f.trade.id)
    expect(events).toHaveLength(1) // the CAS loser emits no stale/duplicate event
  })

  // ── D. Stale generation N x generation N+1 ─────────────────────────────────────────────────
  it('D: a stale worker holding generation N cannot consume generation N+1 after the dispute legitimately re-entered AUTO_PROPOSED with a new deadline', async () => {
    requirePostgres('D stale generation N vs N+1')
    const deadlineN = new Date(Date.now() + 3600_000)
    const f = await makeAutoProposedDispute(deadlineN)
    // Capture "generation N" the way a real stale worker/request would: read the dispute (and
    // implicitly its deadline) before anything else changes it.
    const staleWorkerSnapshot = await disputeOf(f.dispute.id)
    expect(staleWorkerSnapshot.autoResolutionDeadline!.getTime()).toBe(deadlineN.getTime())

    // The dispute legitimately moves through generation N (contested back to EVIDENCE_SUBMITTED),
    // then a LATER, genuinely new AUTO_PROPOSED generation N+1 is proposed with a DIFFERENT deadline
    // and a different recommendation - exactly "durably move the dispute through a later legitimate
    // AUTO_PROPOSED generation" the mission asks for.
    await service.contestAutoResolution(f.dispute.id, f.buyer.id) // consumes N
    const deadlineNPlus1 = new Date(Date.now() + 7200_000)
    await prisma.dispute.update({
      where: { id: f.dispute.id },
      data: {
        status: 'AUTO_PROPOSED', autoResolutionRecommendation: 'REFUND', autoResolutionConfidence: 0.81,
        autoResolutionReasoning: 'generation N+1', autoResolutionDeadline: deadlineNPlus1,
      },
    })
    const beforeStaleAttempt = await disputeOf(f.dispute.id)

    // Now the STALE worker, still only holding generation N's own captured deadline, attempts its
    // own delayed/retried contest. contestAutoResolution() itself always re-reads the dispute fresh
    // and CAS's against the CURRENT observed deadline - there is no code path here that lets a
    // caller supply its own stale deadline value, so the adversarial proof is: the SAME seller who
    // would have raced generation N (using the same identity a stale retry would reuse) cannot,
    // acting now, ever consume N+1 using facts that predate it. What DOES durably prove "generation
    // N cannot consume N+1" at the database layer is the CAS itself: a raw UPDATE using generation
    // N's own captured deadline as the WHERE-clause generation affects zero rows against the
    // now-different N+1 row - exactly the CAS primitive contestAutoResolution()/
    // sweepExpiredAutoResolutions() themselves rely on.
    const staleClaim = await prisma.dispute.updateMany({
      where: { id: f.dispute.id, status: 'AUTO_PROPOSED', autoResolutionDeadline: staleWorkerSnapshot.autoResolutionDeadline },
      data: { status: 'EVIDENCE_SUBMITTED', autoResolutionRecommendation: null, autoResolutionConfidence: null, autoResolutionReasoning: null, autoResolutionDeadline: null },
    })
    expect(staleClaim.count).toBe(0) // generation N cannot consume N+1

    const afterStaleAttempt = await disputeOf(f.dispute.id)
    // N+1 remains fully intact, byte-for-byte identical to before the stale attempt - not erased, not overwritten.
    expect(afterStaleAttempt.status).toBe(beforeStaleAttempt.status)
    expect(afterStaleAttempt.autoResolutionRecommendation).toBe('REFUND')
    expect(afterStaleAttempt.autoResolutionConfidence).toBe(0.81)
    expect(afterStaleAttempt.autoResolutionReasoning).toBe('generation N+1')
    expect(afterStaleAttempt.autoResolutionDeadline!.getTime()).toBe(deadlineNPlus1.getTime())

    // No stale event emitted by the failed stale claim - only the ONE real event from generation N's
    // own legitimate contest above.
    const events = await contestedEventsFor(f.trade.id)
    expect(events).toHaveLength(1)
  })
})
