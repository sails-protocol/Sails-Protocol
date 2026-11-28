-- G3 (CTO 38, Despacho 069): the fee policy document signed by the economic authority (2-of-3 Ed25519), stored next to
-- its own row. Additive: a new nullable column; existing rows are not rewritten. Legacy PUBLISHED rows keep a NULL
-- document and are refused for any NEW use by the application (fail closed); open escrows settle from their frozen
-- snapshot, untouched.
ALTER TABLE "fee_policy_versions" ADD COLUMN "signedDocument" JSONB;

-- The document is frozen with the other economic/identity fields once the row leaves DRAFT, so an operator cannot swap
-- it after publication. CREATE OR REPLACE of the same function (20260822210746), with one more column.
CREATE OR REPLACE FUNCTION fee_policy_versions_enforce_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- A published policy only ever moves forward (historical rows stay read-only, Despacho 069): PUBLISHED -> RETIRED is
  -- the one transition out of PUBLISHED, and a RETIRED row never changes status again. Without this, PUBLISHED -> DRAFT
  -- would reopen every field below for editing.
  IF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'fee_policy_versions: a PUBLISHED policy can only be retired (id=%, % -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN
    RAISE EXCEPTION 'fee_policy_versions: a RETIRED policy never changes status (id=%, % -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF NEW."protocolFeeRate" IS DISTINCT FROM OLD."protocolFeeRate"
      OR NEW."payerModel" IS DISTINCT FROM OLD."payerModel"
      OR NEW."economicBasis" IS DISTINCT FROM OLD."economicBasis"
      OR NEW."nodeOperatorPct" IS DISTINCT FROM OLD."nodeOperatorPct"
      OR NEW."treasuryPct" IS DISTINCT FROM OLD."treasuryPct"
      OR NEW."walletRebatePct" IS DISTINCT FROM OLD."walletRebatePct"
      OR NEW."arbitratorReservePct" IS DISTINCT FROM OLD."arbitratorReservePct"
      OR NEW."smallTradeRule" IS DISTINCT FROM OLD."smallTradeRule"
      OR NEW."triggerSemantics" IS DISTINCT FROM OLD."triggerSemantics"
      OR NEW."railScope" IS DISTINCT FROM OLD."railScope"
      OR NEW."label" IS DISTINCT FROM OLD."label"
      OR NEW."requiredConfirmations" IS DISTINCT FROM OLD."requiredConfirmations"
      OR NEW."signedDocument" IS DISTINCT FROM OLD."signedDocument"
    THEN
      RAISE EXCEPTION 'fee_policy_versions: economic/identity fields are immutable once status != DRAFT (id=%, status=%)', OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A row becomes PUBLISHED only with a document: on the DRAFT -> PUBLISHED transition and on a row inserted already
-- PUBLISHED (closes the raw-insert bypass). Legacy PUBLISHED rows are never updated into this state, so they stay as
-- they are. The signature itself is verified by the application (the pinned authority keys live in the release).
CREATE OR REPLACE FUNCTION fee_policy_versions_require_signed_document()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'PUBLISHED' AND NEW."signedDocument" IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'PUBLISHED') THEN
    RAISE EXCEPTION 'fee_policy_versions: a policy is published only with its signed document (id=%)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_policy_versions_require_signed_document
BEFORE INSERT OR UPDATE ON "fee_policy_versions"
FOR EACH ROW EXECUTE FUNCTION fee_policy_versions_require_signed_document();

-- Only a DRAFT row can be deleted. A published or retired policy is history even when nothing references it yet (the
-- foreign keys protect only referenced rows).
CREATE OR REPLACE FUNCTION fee_policy_versions_refuse_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'fee_policy_versions: a % policy is never deleted (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_policy_versions_refuse_delete
BEFORE DELETE ON "fee_policy_versions"
FOR EACH ROW EXECUTE FUNCTION fee_policy_versions_refuse_delete();
