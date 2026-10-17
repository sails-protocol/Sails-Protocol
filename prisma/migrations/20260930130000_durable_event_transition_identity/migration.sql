-- One durable event per escrow transition. An escrow transition event carries the id of the
-- EscrowEvent claim that produced it (payload.transitionId, Issue #298); no other event carries one.
-- The event store already refuses to mint a second event for a published transition under the
-- publishing correlationId's lock (event-store.ts); this index is the backstop for any publisher that
-- does not share that lock. Events without a transitionId are unaffected.

-- Refuse to build it over existing duplicates, naming them, instead of failing on an opaque error.
DO $$
DECLARE dupes text;
BEGIN
  SELECT string_agg(t, ', ') INTO dupes FROM (
    SELECT payload->>'transitionId' AS t FROM "durable_events"
    WHERE payload->>'transitionId' IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1 LIMIT 20
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'durable_events already holds more than one event for escrow transition(s): % - resolve them before applying this migration', dupes;
  END IF;
END $$;

-- Expression and partial indexes have no Prisma schema syntax; the index is asserted by
-- tests/integration/transitionPublishAuthority.test.ts.
CREATE UNIQUE INDEX "durable_events_transition_id_key"
ON "durable_events" ((payload->>'transitionId'))
WHERE payload->>'transitionId' IS NOT NULL;
