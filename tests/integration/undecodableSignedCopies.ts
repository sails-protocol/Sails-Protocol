// tests/integration/undecodableSignedCopies.ts
//
// P4 / Gate 3 test hygiene for the shared PostgreSQL lane, second class (the first is lostPendingCandidates.ts).
//
// The AUD1X-H1 legacy inventory (scripts/aud1x-h1-legacy-inventory.sql, exercised by aud1xBearerCapability I1) is deliberately
// STRICT: Q7 decodes `escrow_transaction_signatures."signedPsbtBase64"` of every client signature copy that belongs to a MULTISIG
// escrow with an arbiter key, and a row that is not base64 makes the whole read-only transaction fail instead of being skipped -
// on production data that is the correct behaviour (a corrupt copy must be seen, not hidden). Some lane suites write placeholder
// text such as 'st1-e2-race-proof' as a signed copy of a real MULTISIG round and leave it behind; run later in the same database,
// I1 then fails with `invalid symbol "-" found while decoding base64 sequence`. Reproduced: st1TemporalCleanupAuthority and
// m9rDispatchRecovery, each followed by aud1xBearerCapability in one database.
//
// A producer suite calls removeUndecodableSignedCopies() from afterAll. It removes only signed copies whose text is not base64 at
// all (so never a real PSBT) AND whose escrow was created by that suite (database clock). The inventory, its decoder and its
// assertions are not touched.

import type { PrismaClient } from '@prisma/client'

/**
 * Delete the signed copies of escrows created at or after `since` whose text contains a character outside the base64 alphabet.
 * Returns how many were removed.
 */
export async function removeUndecodableSignedCopies(prisma: PrismaClient, since: Date): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM escrow_transaction_signatures s
    USING escrow_pending_transactions p, escrows e
    WHERE p.id = s."pendingTxId" AND e.id = p."escrowId" AND e."createdAt" >= ${since}
      AND s."signedPsbtBase64" !~ '^[A-Za-z0-9+/]*={0,2}$'`
}
