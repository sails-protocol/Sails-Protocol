-- G3 (CTO 38, Despacho 069): the fee policy document signed by the economic authority (2-of-3 Ed25519), stored next to
-- its own row. Additive: a new nullable column; existing rows are not rewritten. Requiring the document on PUBLISHED and
-- refusing unsigned rows for new use belong to the D-E1 package (Despacho 069, option O3), not to this migration.
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
  -- The signed document is write-once (Despacho 069): once set it never changes, in any status; and a row that left
  -- DRAFT without one (a historical policy) can never receive one later (covered by the column guard below).
  IF OLD."signedDocument" IS NOT NULL AND NEW."signedDocument" IS DISTINCT FROM OLD."signedDocument" THEN
    RAISE EXCEPTION 'fee_policy_versions: the signed document is write-once (id=%)', OLD.id;
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
