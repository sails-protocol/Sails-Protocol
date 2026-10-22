-- #235 R7G F8B — SIGNATURE_COLLECTION_DISPOSITION_AUTHORITY_V1 at the database.
--
-- On a signature-collection rail (MULTISIG, LIGHTNING_HODL, SAFE_GUARD_EVM) the disposition authority is the
-- persisted signing round (escrow_pending_transactions). The direct-execution intent slots — cooperativeDisposition /
-- cooperativeTriggeredBy, arbitratedDisposition / arbitratedTriggeredBy / splitBuyerBps — belong to direct-execution
-- rails only (WDK_USDT_EVM, MOCK, ...), and nothing legitimate writes them for a signature-collection escrow.
--
-- This guard refuses CREATING or CHANGING any of those slots on a signature-collection row (insert, update, or a type
-- change onto such a rail while a slot is set). It does not touch direct-execution rails and does not rewrite or block
-- a pre-F8B row that already carries a value: such a row keeps settling (status updates leave the slots unchanged)
-- and is reported by `npm run disposition:preflight`, never repaired here.
CREATE OR REPLACE FUNCTION escrows_signature_collection_no_direct_disposition() RETURNS trigger AS $$
BEGIN
  IF NEW.type::text IN ('MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM')
     AND (NEW."cooperativeDisposition" IS NOT NULL OR NEW."cooperativeTriggeredBy" IS NOT NULL
          OR NEW."arbitratedDisposition" IS NOT NULL OR NEW."arbitratedTriggeredBy" IS NOT NULL OR NEW."splitBuyerBps" IS NOT NULL)
     AND (TG_OP = 'INSERT'
          OR NEW.type IS DISTINCT FROM OLD.type
          OR (NEW."cooperativeDisposition", NEW."cooperativeTriggeredBy", NEW."arbitratedDisposition", NEW."arbitratedTriggeredBy", NEW."splitBuyerBps")
             IS DISTINCT FROM (OLD."cooperativeDisposition", OLD."cooperativeTriggeredBy", OLD."arbitratedDisposition", OLD."arbitratedTriggeredBy", OLD."splitBuyerBps")) THEN
    RAISE EXCEPTION 'escrows: % escrow % settles only through its signing round — a direct-execution disposition is never recorded for it', NEW.type, NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_signature_collection_no_direct_disposition_guard
  BEFORE INSERT OR UPDATE OF "type", "cooperativeDisposition", "cooperativeTriggeredBy", "arbitratedDisposition", "arbitratedTriggeredBy", "splitBuyerBps" ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION escrows_signature_collection_no_direct_disposition();
