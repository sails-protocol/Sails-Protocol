-- Settlement reconciliation PASS 0 (a fully-signed MULTISIG operation whose escrow never claimed its
-- transition): a durable round-robin position on the pending operation, replacing a pass that loaded
-- every pending row of every open MULTISIG escrow on every run (see schema.prisma).
-- AlterTable
ALTER TABLE "escrow_pending_transactions" ADD COLUMN "unclaimedRecoveryAttemptedAt" TIMESTAMP(3);

-- PASS 0 candidates live only on open (non-terminal) MULTISIG escrows. Without this index the claim
-- scans every escrow ever created to find them; with it, only the open ones. Partial indexes have no
-- Prisma schema syntax; the index is asserted by tests/integration/unclaimedSignedRecoveryQueue.test.ts.
CREATE INDEX "escrows_open_multisig_idx"
ON "escrows" ("id")
WHERE "type" = 'MULTISIG' AND "status" NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT');
