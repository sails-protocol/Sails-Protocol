-- C9 (Issue #105, CTO 24 GO 6807565034) - stored OfferEnvelope facts are append-only.
--
-- Every row is a signed fact this node verified before inserting it (offer-envelope-repository.ts ingest()), and
-- the current state of an offer is derived from the whole set (getLatest()): rewriting or deleting a row could
-- otherwise change that state, e.g. deleting a CANCELLED tombstone resurrects the ACTIVE revision under it.
-- INSERT is unchanged (idempotency stays on the existing unique index). Same DB-native model as
-- escrow_pending_round_retirements_refuse_mutation() (20261110120000).
--
-- Limit: a role that owns the table (or a superuser) can still DISABLE TRIGGER. Tampering by such a role is caught
-- at read time (getLatest() re-verifies every row of the highest revision and fails closed); deleting a row is not.
-- Closing that needs a runtime role without ownership (SELECT/INSERT only), a deployment decision outside this file.
--
-- Reversal (not applied automatically; drop the guards first, they also block TRUNCATE):
--   DROP TRIGGER offer_envelopes_truncate_guard ON "offer_envelopes";
--   DROP TRIGGER offer_envelopes_immutability_guard ON "offer_envelopes";
--   DROP FUNCTION offer_envelopes_refuse_mutation();

CREATE OR REPLACE FUNCTION offer_envelopes_refuse_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'offer_envelopes: signed offer facts are append-only (%)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_envelopes_immutability_guard
BEFORE UPDATE OR DELETE ON "offer_envelopes"
FOR EACH ROW
EXECUTE FUNCTION offer_envelopes_refuse_mutation();

CREATE TRIGGER offer_envelopes_truncate_guard
BEFORE TRUNCATE ON "offer_envelopes"
FOR EACH STATEMENT
EXECUTE FUNCTION offer_envelopes_refuse_mutation();
