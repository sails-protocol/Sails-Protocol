-- Issue #253 (CTO decision 2026-10-31): effect claims are keyed on the source transition, no longer on the durable
-- event id. Re-key the claims already recorded, so a redelivery after this deploy cannot apply an effect again.
-- Where two durable events of one transition each claimed the same effect, one claim survives: the durable events
-- themselves stay. This does NOT correct a counter that was already applied twice. Safe to run more than once.
WITH mapped AS (
  SELECT c.id, d.payload->>'transitionId' AS "transitionId",
    row_number() OVER (PARTITION BY d.payload->>'transitionId', c."projectionKey", c."subjectId" ORDER BY c."appliedAt", c.id) AS rank,
    EXISTS (SELECT 1 FROM "event_projection_claims" k WHERE k."eventId" = d.payload->>'transitionId' AND k."projectionKey" = c."projectionKey" AND k."subjectId" = c."subjectId") AS "alreadyKeyed"
  FROM "event_projection_claims" c
  JOIN "durable_events" d ON d.id = c."eventId"
  WHERE d.payload->>'transitionId' IS NOT NULL
), removed AS (
  DELETE FROM "event_projection_claims" c USING mapped m WHERE c.id = m.id AND (m.rank > 1 OR m."alreadyKeyed")
)
UPDATE "event_projection_claims" c SET "eventId" = m."transitionId"
FROM mapped m WHERE c.id = m.id AND m.rank = 1 AND NOT m."alreadyKeyed";
