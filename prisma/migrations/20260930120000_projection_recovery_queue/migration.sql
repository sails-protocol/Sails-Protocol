-- Settlement reconciliation PASS 3 (incomplete projections of a claimed escrow
-- transition): a durable round-robin queue over the 'transition.claimed'
-- markers, replacing a per-process in-memory cursor (see schema.prisma).
-- AlterTable
ALTER TABLE "event_projection_claims" ADD COLUMN "transitionProjectedAt" TIMESTAMP(3);
ALTER TABLE "event_projection_claims" ADD COLUMN "projectionRecoveryAttemptedAt" TIMESTAMP(3);

-- Backfill: every transition whose 'transition.projected' marker already
-- exists leaves the queue. Deterministic (the marker's own timestamp), and the
-- same fact the handlers record from now on in the marker's own transaction.
UPDATE "event_projection_claims" AS c
SET "transitionProjectedAt" = p."projectedAt"
FROM (
  SELECT "subjectId", MIN("appliedAt") AS "projectedAt"
  FROM "event_projection_claims"
  WHERE "projectionKey" = 'transition.projected'
  GROUP BY "subjectId"
) AS p
WHERE c."projectionKey" = 'transition.claimed'
  AND c."eventId" = p."subjectId";

-- The PASS 3 queue: claimed transitions not yet projected, in round-robin order
-- (a row's last visit, or its claim time if never visited). The claim reads
-- only this index, never the projected history. Partial and expression indexes
-- have no Prisma schema syntax; the index catalog is asserted by
-- tests/integration/projectionRecoveryQueue.test.ts.
CREATE INDEX "event_projection_claims_transition_recovery_queue_idx"
ON "event_projection_claims" ((COALESCE("projectionRecoveryAttemptedAt", "appliedAt")), "id")
WHERE "projectionKey" = 'transition.claimed' AND "transitionProjectedAt" IS NULL;
