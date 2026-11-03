-- A ruling resolved before the 'dispute.ruling-finalized' claim existed has no claim, and being
-- RESOLVED does not prove its bookkeeping ran: the old finalization was a sequence of separate writes
-- after the RESOLVED write. Replaying it could repeat counters and slashes, skipping it could lose them.

-- Proven finalized: settling the appeal fee was the last write of that sequence, so a settled fee that
-- agrees with the ruling proves the earlier writes completed.
INSERT INTO "event_projection_claims" ("id", "eventId", "projectionKey", "subjectId")
SELECT gen_random_uuid()::text, d."id", 'dispute.ruling-finalized', d."appealRound"::text
FROM "disputes" d
JOIN "dispute_appeal_fees" f ON f."disputeId" = d."id" AND f."appealRound" = d."appealRound"
WHERE d."status" = 'RESOLVED'
  AND d."appealRound" > 0
  AND f."settledAt" IS NOT NULL
  AND f."outcome" = CASE WHEN d."previousRuling" IS NOT NULL AND d."previousRuling" <> d."ruling" THEN 'REFUNDED' ELSE 'FORFEITED' END
ON CONFLICT DO NOTHING;

-- Everything else is ambiguous: per-dispute evidence does not exist (arbiter counters are aggregates).
-- Held out of automatic recovery and reported for a human decision, never marked finalized.
INSERT INTO "event_projection_claims" ("id", "eventId", "projectionKey", "subjectId")
SELECT gen_random_uuid()::text, d."id", 'dispute.ruling-finalization-held', d."appealRound"::text
FROM "disputes" d
WHERE d."status" = 'RESOLVED'
  AND NOT EXISTS (
    SELECT 1 FROM "event_projection_claims" c
    WHERE c."eventId" = d."id" AND c."projectionKey" = 'dispute.ruling-finalized' AND c."subjectId" = d."appealRound"::text)
ON CONFLICT DO NOTHING;
