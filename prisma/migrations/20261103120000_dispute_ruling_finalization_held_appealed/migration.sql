-- Extends the 20261102120000 baseline: a dispute appealed before the 'dispute.ruling-finalized' claim
-- existed left RESOLVED, so that baseline never saw it, yet recovery now also inspects APPEALED disputes.
-- Replaying round 0 could repeat its counters, so it is held for a human decision like any other ambiguity.
INSERT INTO "event_projection_claims" ("id", "eventId", "projectionKey", "subjectId")
SELECT gen_random_uuid()::text, d."id", 'dispute.ruling-finalization-held', (d."appealRound" - 1)::text
FROM "disputes" d
WHERE d."status" = 'APPEALED'
  AND d."appealRound" >= 1
  AND NOT EXISTS (
    SELECT 1 FROM "event_projection_claims" c
    WHERE c."eventId" = d."id" AND c."projectionKey" = 'dispute.ruling-finalized' AND c."subjectId" = (d."appealRound" - 1)::text)
ON CONFLICT DO NOTHING;
