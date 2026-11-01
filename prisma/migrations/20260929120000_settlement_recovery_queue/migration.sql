-- Settlement reconciliation PASS 1/2 boundedness: a durable round-robin queue
-- position and a durable "completion verified" marker (see schema.prisma).
-- AlterTable
ALTER TABLE "escrows" ADD COLUMN "settlementRecoveryAttemptedAt" TIMESTAMP(3);
ALTER TABLE "escrows" ADD COLUMN "completionVerifiedAt" TIMESTAMP(3);

-- Each pass claims from its own partial index in queue order, so the claim
-- reads only that pass's queue, never the settled history. Partial indexes
-- have no Prisma schema syntax; the index catalog is asserted by
-- tests/integration/settlementReconciliationBoundedness.test.ts.
-- PASS 1: terminal, no settlement result yet.
CREATE INDEX "escrows_settlement_result_recovery_queue_idx"
ON "escrows" ("settlementRecoveryAttemptedAt" ASC NULLS FIRST, "updatedAt" DESC, "id")
WHERE "status" IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND "txReleaseId" IS NULL;

-- PASS 2: settlement result written, completion not yet verified.
CREATE INDEX "escrows_completion_verification_queue_idx"
ON "escrows" ("settlementRecoveryAttemptedAt" ASC NULLS FIRST, "updatedAt" DESC, "id")
WHERE "status" IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND "txReleaseId" IS NOT NULL AND "completionVerifiedAt" IS NULL;
