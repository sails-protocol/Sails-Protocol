-- Issue #298 - durable delivery/replay identity for event-derived projections.
--
-- One row = "this projection effect (projectionKey) for this subject was
-- applied because of this durable event (eventId)". The claim and the state
-- mutation it guards commit in the SAME PostgreSQL transaction
-- (applyEventProjectionOnce), so a crash before commit leaves neither and a
-- redelivery (same event, N processes, N times) collides on the unique
-- identity and becomes a no-op. Correctness never depends on Redis or
-- process-local state.
--
-- eventId deliberately has NO foreign key to durable_events: the event bus
-- also runs on non-Postgres stores (in-memory, Redis Streams) whose ids never
-- appear in durable_events, and the claim must work for whichever store
-- delivered the event.
--
-- Reversal (not applied automatically):
--   DROP TABLE "event_projection_claims";
CREATE TABLE "event_projection_claims" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "projectionKey" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_projection_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_projection_claim_identity_key"
ON "event_projection_claims"("eventId", "projectionKey", "subjectId");

CREATE INDEX "event_projection_claims_projectionKey_subjectId_idx"
ON "event_projection_claims"("projectionKey", "subjectId");
