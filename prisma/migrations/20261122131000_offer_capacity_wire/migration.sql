-- M-1b step 2 (CTO 28 Despacho 029 item 5 = R1; v4.3): attach the atomic capacity reservation to the COMMITTED transition of a pair.
--
-- "commitment_pairs_reserve_capacity()" (created, isolated, by 20261122130000_offer_capacity) runs in the SAME transaction as the
-- transition, so a refused reservation (E2501-E2505) aborts the COMMITTED write: no COMMITTED pair without its reservation.
-- Trigger order is by NAME: "commitment_pairs_reserve_capacity" sorts AFTER the F3 guard "commitment_pairs_guard_update"
-- (g < r), so the F3 invariants (immutable trade JSON, signature rules) are enforced before any capacity is taken
-- (proved by reading pg_trigger in tests/integration/offerCapacityWiring.test.ts; mutant: a name that sorts first).
-- The WHEN clause is narrow: only the transition INTO COMMITTED fires it.
--
-- Effect on callers: every COMMITTED transition now needs a declared, unblocked, sufficient capacity for the Offer the trade
-- accepted (R1). Fixtures that commit pairs declare one first (tests/integration/helpers/committedPairFixture.ts).
--
-- Reversal (manual, not applied automatically):
--   DROP TRIGGER "commitment_pairs_reserve_capacity" ON "commitment_pairs";

SET lock_timeout = '5s';

CREATE TRIGGER "commitment_pairs_reserve_capacity"
  BEFORE UPDATE OF "state" ON "commitment_pairs"
  FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM 'COMMITTED' AND NEW."state" = 'COMMITTED')
  EXECUTE FUNCTION commitment_pairs_reserve_capacity();

RESET lock_timeout;
