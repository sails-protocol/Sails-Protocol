-- Timelock expiry sweep: a durable round-robin position on the expired FUNDS_LOCKED escrow, replacing a
-- pass that loaded every expired FUNDS_LOCKED escrow on every tick (see schema.prisma).
-- AlterTable
ALTER TABLE "escrows" ADD COLUMN "expirySweepAttemptedAt" TIMESTAMP(3);

-- The claim walks FUNDS_LOCKED escrows in queue order: last attempt, or expiry if never attempted.
-- Every eligible row's key is <= now and a never-attempted row that is not yet due has key = expiresAt > now,
-- so an ordered walk of this index reaches the batch without visiting the rest of the backlog or the
-- escrow history. Expression and partial indexes have no Prisma schema syntax; the index is asserted by
-- tests/integration/timelockExpiryBoundedness.test.ts.
CREATE INDEX "escrows_expiry_sweep_queue_idx"
ON "escrows" ((COALESCE("expirySweepAttemptedAt", "expiresAt")), "id")
WHERE "status" = 'FUNDS_LOCKED';
