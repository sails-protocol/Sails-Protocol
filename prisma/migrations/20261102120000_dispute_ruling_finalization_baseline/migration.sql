-- A ruling resolved before the 'dispute.ruling-finalized' claim existed has no claim even when its
-- bookkeeping completed, and recoverMissingRulingFinalization() would apply it again. Those rows
-- count as finalized; only a ruling resolved after this migration can be recovered.
INSERT INTO "event_projection_claims" ("id", "eventId", "projectionKey", "subjectId")
SELECT gen_random_uuid()::text, "id", 'dispute.ruling-finalized', "appealRound"::text
FROM "disputes"
WHERE "status" = 'RESOLVED'
ON CONFLICT DO NOTHING;
