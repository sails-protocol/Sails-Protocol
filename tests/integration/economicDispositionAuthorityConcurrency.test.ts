// tests/integration/economicDispositionAuthorityConcurrency.test.ts
//
// ADR-005 / #218, CTO Gate R2 (#222) — real-Postgres evidence for the two
// properties the R1 unit tests could only prove against mocked
// `prisma.$transaction`: genuine `pg_advisory_xact_lock` serialization
// between `appeal()` and `authorizeDisputedPendingExecution()` on the
// shared `economic-disposition:<disputeId>` domain, and durable
// persistence of both ruling-generation provenance and the committed
// `EconomicDispositionAuthorization` record across an independent
// PrismaClient connection (the closest this suite gets to "restart" — a
// fresh process reading only what was durably committed, never anything
// held in the writer's own connection/memory).
//
// Fixture rows (User/Trade/Escrow/Dispute/EscrowPendingTransaction) are
// created directly, bypassing the provider/PSBT layer entirely — this
// file tests the Economic Disposition Commit Gate and its lock/claim
// mechanism, not settlement-provider wiring (already covered elsewhere,
// e.g. tests/integration/disputeOutcomeMultisigLive.test.ts,
// tests/integration/m9rDispatchRecovery.test.ts).

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('ADR-005 Economic Disposition Commit Gate — real Postgres concurrency and persistence', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let authorizeDisputedPendingExecution: typeof import('../../src/modules/open-settlement/economic-disposition-authority').authorizeDisputedPendingExecution
  let economicDispositionLockKey: typeof import('../../src/modules/open-settlement/economic-disposition-authority').economicDispositionLockKey
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ authorizeDisputedPendingExecution, economicDispositionLockKey } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await (global as any).__prisma?.$disconnect() // #748: the client the cold reload created
    }
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // No settlement provider is exercised — a bare stub satisfying
  // DisputeService's ArbitrationProvider interface for appeal() alone
  // (assignAppealPanel + name). Real DisputeService, real escrowRepository,
  // real Postgres for everything else.
  function appealOnlyProvider(newArbiterId: string) {
    return {
      name: 'test-appeal-only',
      arbitrators: [] as string[],
      async assign(): Promise<string> {
        throw new Error('not used by this fixture')
      },
      async assignAppealPanel(): Promise<string> {
        return newArbiterId
      },
    }
  }

  let seq = 0
  async function makeFixture(suffix: string) {
    seq += 1
    const uniq = `${suffix}-${Date.now()}-${seq}`
    const seller = await prisma.user.create({ data: { id: `seller-${uniq}`, publicKey: `pk-seller-${uniq}` } })
    const buyer = await prisma.user.create({ data: { id: `buyer-${uniq}`, publicKey: `pk-buyer-${uniq}` } })
    const oldArbiter = await prisma.user.create({ data: { id: `arbiter-old-${uniq}`, publicKey: `pk-arbiter-old-${uniq}` } })
    const newArbiter = await prisma.user.create({ data: { id: `arbiter-new-${uniq}`, publicKey: `pk-arbiter-new-${uniq}` } })

    const offer = await prisma.offer.create({
      data: {
        id: `offer-${uniq}`, userId: seller.id, asset: 'BTC', side: 'SELL',
        priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE',
      },
    })
    const trade = await prisma.trade.create({
      data: {
        id: `trade-${uniq}`, offerId: offer.id, buyerId: buyer.id, sellerId: seller.id,
        amount: '0.001', asset: 'BTC', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED',
      },
    })
    const escrow = await prisma.escrow.create({
      data: {
        id: `escrow-${uniq}`, tradeId: trade.id, type: 'MOCK', status: 'DISPUTED',
        lockedAmount: '0.001', asset: 'BTC', feeCharged: '0',
      },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })

    const dispute = await prisma.dispute.create({
      data: {
        id: `dispute-${uniq}`, tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'concurrency test',
        arbiterId: oldArbiter.id, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date(),
        appealRound: 0, authoritySignature: `sig-${uniq}`, authorityIssuedAt: new Date('2026-09-18T00:00:00.000Z'),
      },
    })

    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        id: `pending-${uniq}`, escrowId: escrow.id, kind: 'release', toAddress: 'bc1qtest',
        unsignedPsbtBase64: 'stub', requiredSigners: [buyer.id], triggeredBy: oldArbiter.id,
        disputeId: dispute.id, rulingAppealRound: 0, rulingArbiterId: oldArbiter.id,
        rulingOutcome: 'RELEASE', rulingAuthoritySignature: `sig-${uniq}`,
        rulingAuthorityIssuedAt: new Date('2026-09-18T00:00:00.000Z'),
      },
    })

    const disputeService = new DisputeService(appealOnlyProvider(newArbiter.id))

    return { trade, escrow, dispute, pending, buyer, seller, oldArbiter, newArbiter, disputeService }
  }

  describe('deterministic ordering — both legitimate winners', () => {
    it('appeal completing first makes the stale pending operation permanently unable to newly commit (real advisory lock, real conditional claim)', async () => {
      requirePostgres('appeal-first ordering')
      const { dispute, pending, buyer, disputeService } = await makeFixture('appeal-first')

      const appealResult = await disputeService.appeal(dispute.id, buyer.id)
      expect(appealResult.dispute.status).toBe('APPEALED')
      expect(appealResult.dispute.appealRound).toBe(1)

      await expect(authorizeDisputedPendingExecution(pending)).rejects.toThrow(/no longer current/)

      const eda = await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } })
      expect(eda).toBeNull()
    })

    it('economic disposition commit completing first is preserved — a later appeal does not retroactively erase it, and retry reuses the same committed authorization', async () => {
      requirePostgres('commit-first ordering')
      const { dispute, pending, buyer, disputeService } = await makeFixture('commit-first')

      const committed = await authorizeDisputedPendingExecution(pending)
      expect(committed).not.toBeNull()
      expect(committed).toMatchObject({ disputeId: dispute.id, appealRound: 0, arbiterId: expect.any(String), ruling: 'RELEASE' })

      // A later appeal must still succeed — the commit never touched the
      // Dispute row, so appeal()'s own conditional claim still matches.
      const appealResult = await disputeService.appeal(dispute.id, buyer.id)
      expect(appealResult.dispute.status).toBe('APPEALED')

      // Retry for the SAME immutable pending operation reuses the
      // already-committed authorization without re-consulting the (now
      // superseded) live dispute state, and without rebinding to the new
      // generation (ADR-005 §4).
      const retried = await authorizeDisputedPendingExecution(pending)
      expect(retried).toEqual(committed)
    })
  })

  it('true concurrent race — exactly one self-consistent final state, never a corrupted or partially-applied authorization', async () => {
    requirePostgres('true concurrent race')
    const { dispute, pending, buyer, disputeService } = await makeFixture('true-race')

    const [edaOutcome, appealOutcome] = await Promise.allSettled([
      authorizeDisputedPendingExecution(pending),
      disputeService.appeal(dispute.id, buyer.id),
    ])

    // appeal() has no conditional dependency on EconomicDispositionAuthorization
    // and is therefore never blocked by a concurrent commit — by design
    // (ADR-005 §4), so it must always succeed regardless of interleaving.
    expect(appealOutcome.status).toBe('fulfilled')

    const eda = await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } })
    if (edaOutcome.status === 'fulfilled') {
      // The commit won its lock acquisition before appeal's write
      // committed — the durable record must reflect EXACTLY the original
      // generation, never a value influenced by the concurrent appeal.
      expect(eda).not.toBeNull()
      expect(eda).toMatchObject({ disputeId: dispute.id, appealRound: 0, ruling: 'RELEASE' })
    } else {
      // appeal's write committed first — the commit must have observed
      // the superseded generation and failed closed, leaving no record.
      expect(String((edaOutcome as PromiseRejectedResult).reason)).toMatch(/no longer current/)
      expect(eda).toBeNull()
    }
  })

  describe('restart/persistence — durable across an independent connection', () => {
    it('ruling-generation provenance and a committed authorization survive being read back by a totally independent PrismaClient', async () => {
      requirePostgres('restart persistence')
      const { dispute, pending } = await makeFixture('restart')

      const committed = await authorizeDisputedPendingExecution(pending)
      expect(committed).not.toBeNull()

      // A fresh, independent client — never the writer's own connection or
      // in-process memory — proves this is real durable Postgres state,
      // not something only visible within the writing process (same
      // "restart safety" standard tests/integration/escrowFundingConcurrency.test.ts
      // already established for withEscrowFundingLock()).
      const independentClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getUrl() }) })
      try {
        const rereadPending = await independentClient.escrowPendingTransaction.findUnique({ where: { id: pending.id } })
        expect(rereadPending).toMatchObject({
          disputeId: dispute.id,
          rulingAppealRound: 0,
          rulingArbiterId: pending.rulingArbiterId,
          rulingOutcome: 'RELEASE',
          rulingAuthoritySignature: pending.rulingAuthoritySignature,
        })

        const rereadAuth = await independentClient.economicDispositionAuthorization.findUnique({
          where: { pendingOperationId: pending.id },
        })
        expect(rereadAuth).toMatchObject({ disputeId: dispute.id, appealRound: 0, ruling: 'RELEASE' })
      } finally {
        await independentClient.$disconnect()
      }
    })

    it('retry after independent-connection reload still reuses the same committed authorization, never minting a new one or rebinding to a later generation', async () => {
      requirePostgres('restart persistence retry')
      const { dispute, pending, buyer, disputeService } = await makeFixture('restart-retry')

      const firstCommit = await authorizeDisputedPendingExecution(pending)
      expect(firstCommit).not.toBeNull()

      // Cold-module reload: disconnect the singleton writer, clear the
      // database + gate modules from Jest's require cache, then load a new
      // Prisma singleton and a fresh copy of the gate. This is stronger
      // than merely reading through an independent client: the retry path
      // itself now executes through newly-instantiated module state and a
      // newly-created Prisma connection pool, with only durable Postgres
      // rows carrying authority across the boundary.
      await prisma.$disconnect()
      // #748: database/index.ts reuses global.__prisma across jest.resetModules(); without clearing it the restarted modules
      // pair a NEW @prisma/client (their Prisma.sql fragments) with the OLD client, and nested fragments are sent as values.
      ;(global as any).__prisma = undefined
      jest.resetModules()
      const { prisma: restartedPrisma } = require('../../src/common/database') as typeof import('../../src/common/database')
      const { authorizeDisputedPendingExecution: restartedAuthorize } =
        require('../../src/modules/open-settlement/economic-disposition-authority') as typeof import('../../src/modules/open-settlement/economic-disposition-authority')

      const observedBeforeRetry = await restartedPrisma.economicDispositionAuthorization.findUnique({
        where: { pendingOperationId: pending.id },
      })
      expect(observedBeforeRetry).not.toBeNull()

      // Advance the live dispute using the already-created service before
      // the retry. Its Prisma import resolves to the same durable database;
      // the committed generation-0 authorization must remain reusable.
      await disputeService.appeal(dispute.id, buyer.id)

      const restartedPending = await restartedPrisma.escrowPendingTransaction.findUnique({ where: { id: pending.id } })
      expect(restartedPending).not.toBeNull()
      const retried = await restartedAuthorize(restartedPending!)
      expect(retried).toEqual(firstCommit)
      expect(retried!.appealRound).toBe(0)
      expect(retried!.disputeId).toBe(dispute.id)

      // Exactly one authorization row ever exists for this pending
      // operation — retry never minted a second one.
      const allForPending = await prisma.economicDispositionAuthorization.findMany({
        where: { pendingOperationId: pending.id },
      })
      expect(allForPending).toHaveLength(1)
    })
  })

  // CTO Gate R2 (#222) finding R2-1 — a stale ruling revert (a settlement
  // provider failure caught inside applyRuling()/applyRulingCoreAuthoritative())
  // used to write `prisma.dispute.update({ where: { id } })` unconditionally,
  // AFTER the resolve-write's own lock had already released. If a
  // concurrent appeal() won that same `economic-disposition:<disputeId>`
  // lock and advanced the generation before the revert ran, the revert
  // would silently overwrite the newer generation's status/arbiter/ruling
  // back to the stale call's own pre-resolve values.
  //
  // The fix re-acquires the SAME lock and reverts via a conditional claim
  // (status/ruling/arbiter/appealRound[/authoritySignature]) that proves
  // the row still IS the exact generation being reverted. This test proves
  // that exact SQL-level mechanism against real Postgres: it reproduces
  // "appeal already won" durably (a real appeal() call, real lock, real
  // commit), then issues the identical conditional-claim shape
  // applyRuling()'s catch block uses and proves it is a real no-op — not
  // by re-invoking the private method (which requires the full settlement/
  // signature-verification call chain covered elsewhere), but by proving
  // the underlying CAS predicate itself is sound under real Postgres
  // semantics, coordinated with (not duplicating) the deterministic-ordering
  // suite above.
  it('R2-1 Case C — a stale ruling revert cannot overwrite a newer appeal generation (real lock, real conditional claim, real Postgres)', async () => {
    requirePostgres('R2-1 Case C')
    const { dispute, buyer, disputeService } = await makeFixture('r2-1-case-c')

    // Generation 0 is exactly what makeFixture() already committed:
    // RESOLVED, appealRound 0, the original arbiter, ruling RELEASE, a
    // real recorded authoritySignature. A real appeal() now durably wins
    // the lock and advances the generation, exactly as if it raced a
    // concurrent settlement-provider failure for generation 0.
    const appealResult = await disputeService.appeal(dispute.id, buyer.id)
    expect(appealResult.dispute.status).toBe('APPEALED')
    expect(appealResult.dispute.appealRound).toBe(1)

    // The exact conditional-claim shape applyRuling()'s catch block uses
    // to revert generation 0 — issued directly here (not through the
    // private method) to prove the CAS predicate itself, under the same
    // real lock, correctly observes that generation 0 is no longer
    // current and refuses to touch the row.
    const revertClaim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(dispute.id)})::bigint)`
      return tx.dispute.updateMany({
        where: {
          id: dispute.id,
          status: 'RESOLVED',
          ruling: 'RELEASE',
          arbiterId: dispute.arbiterId!,
          appealRound: 0,
          authoritySignature: dispute.authoritySignature!,
        },
        data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null },
      })
    })

    expect(revertClaim.count).toBe(0)

    const finalDispute = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    expect(finalDispute).toMatchObject({
      status: 'APPEALED',
      appealRound: 1,
      arbiterId: appealResult.dispute.arbiterId,
    })
    expect(finalDispute!.status).not.toBe('OPENED')
  })
})
