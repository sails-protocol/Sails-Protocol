-- Issue #253 (Intent atomicity): IntentEvent doubles as the transactional outbox of the domain event
-- the transition owes. Additive and nullable; existing rows keep eventName NULL (nothing owed).
ALTER TABLE "intent_events" ADD COLUMN "eventName" TEXT,
ADD COLUMN "eventPayload" JSONB,
ADD COLUMN "publishedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "intent_events_publishedAt_createdAt_idx" ON "intent_events"("publishedAt", "createdAt");
