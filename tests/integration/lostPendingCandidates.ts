// tests/integration/lostPendingCandidates.ts
//
// P4 / Gate 3 test hygiene for the shared PostgreSQL lane. PASS 0b of the settlement reconciler
// (reconcileLostPendingPublicTransactions) converges ANY DISPUTED MULTISIG escrow that holds a live Economic Disposition
// Authorization naming an unsigned txid and has no pending operation - a deliberate, database-wide sweep. A suite that
// fault-injects "the pending operation was lost" therefore leaves a recovery candidate behind; in the CI lane all suites
// share one database, so a LATER suite that asserts a global reconciliation report under a permissive explorer mock
// (signatureCollectionRestartConvergence) would see it recovered. Reproduced: st1TemporalCleanupAuthority (5 candidates)
// and pendingRoundSupersession (1) followed by signatureCollectionRestartConvergence in one database.
//
// A producer suite calls these two functions from beforeAll / afterAll. It removes only the authorizations of escrows it
// created itself (by database clock), so it cannot touch another suite's rows, and it asserts nothing on behalf of the
// consumer - the consumer's expectations stay exactly as written.

import type { PrismaClient } from '@prisma/client'

/** The database's own clock, so the bound is not skewed by the test process's. */
export async function databaseClock(prisma: PrismaClient): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ t: Date }>>`SELECT clock_timestamp() AS t`
  return rows[0].t
}

/**
 * Delete the live authorizations that would make an escrow created at or after `since` a PASS 0b candidate (same
 * predicate as the reconciler's candidate query). Returns how many were removed.
 */
export async function removeLostPendingCandidates(prisma: PrismaClient, since: Date): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM economic_disposition_authorizations a
    USING escrows e
    WHERE e.id = a."escrowId" AND e."createdAt" >= ${since}
      AND a."supersededAt" IS NULL AND a."unsignedTxid" IS NOT NULL
      AND e.type = 'MULTISIG' AND e.status = 'DISPUTED' AND e."txReleaseId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p.id = a."pendingOperationId")
      AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p2 WHERE p2."escrowId" = e.id)`
}
