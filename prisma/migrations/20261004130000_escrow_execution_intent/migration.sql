-- #247/#248 (R1 restack of #324) - frozen economic intent of direct-call execution, kept separate from
-- current execution authority.
--
-- Two immutable slots, one per authority phase of the escrow state machine:
--   cooperative* - frozen by the first direct-call RELEASE/REFUND claim from a non-DISPUTED state
--                  (disposition + the cooperative actor who authorized it);
--   arbitrated*  - frozen by the first direct-call claim from DISPUTED (disposition + SPLIT allocation).
-- A provider failure reverts only the status, never a slot. A retry in the same phase must present the
-- identical intent. Moving into arbitration transfers execution AUTHORITY (not intent) to the current
-- assigned arbiter, enforced by the application's dispute-authority check: "arbitratedTriggeredBy"
-- records the authorized arbiter of the latest successful arbitrated claim (so a reassigned arbiter may
-- retry the frozen arbitrated intent), and filling the arbitrated slot never touches the cooperative
-- one - prior economic provenance is never erased or rewritten.
ALTER TABLE "escrows"
  ADD COLUMN "cooperativeDisposition" TEXT,
  ADD COLUMN "cooperativeTriggeredBy" TEXT,
  ADD COLUMN "arbitratedDisposition" TEXT,
  ADD COLUMN "arbitratedTriggeredBy" TEXT,
  ADD COLUMN "splitBuyerBps" INTEGER;

ALTER TABLE "escrows" ADD CONSTRAINT "escrows_cooperative_intent_check" CHECK (
  ("cooperativeDisposition" IS NULL AND "cooperativeTriggeredBy" IS NULL)
  OR ("cooperativeDisposition" IN ('COMPLETED', 'REFUNDED') AND "cooperativeTriggeredBy" IS NOT NULL)
);

ALTER TABLE "escrows" ADD CONSTRAINT "escrows_arbitrated_intent_check" CHECK (
  ("arbitratedDisposition" IS NULL AND "arbitratedTriggeredBy" IS NULL AND "splitBuyerBps" IS NULL)
  OR ("arbitratedDisposition" IN ('COMPLETED', 'REFUNDED') AND "arbitratedTriggeredBy" IS NOT NULL AND "splitBuyerBps" IS NULL)
  OR ("arbitratedDisposition" = 'SPLIT' AND "arbitratedTriggeredBy" IS NOT NULL AND "splitBuyerBps" > 0 AND "splitBuyerBps" < 10000)
);

-- Once frozen, a slot is historical economic truth: no retry, revert, recovery or later phase may
-- rewrite or clear it.
CREATE OR REPLACE FUNCTION escrows_enforce_execution_intent_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD."cooperativeDisposition" IS NOT NULL AND (
       NEW."cooperativeDisposition" IS DISTINCT FROM OLD."cooperativeDisposition"
    OR NEW."cooperativeTriggeredBy" IS DISTINCT FROM OLD."cooperativeTriggeredBy"
  ) THEN
    RAISE EXCEPTION 'cooperative execution intent of escrow % is immutable once frozen', OLD."id";
  END IF;
  IF OLD."arbitratedDisposition" IS NOT NULL AND (
       NEW."arbitratedDisposition" IS DISTINCT FROM OLD."arbitratedDisposition"
    OR NEW."splitBuyerBps" IS DISTINCT FROM OLD."splitBuyerBps"
  ) THEN
    RAISE EXCEPTION 'arbitrated execution intent of escrow % is immutable once frozen', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "escrows_execution_intent_immutable"
BEFORE UPDATE ON "escrows"
FOR EACH ROW
EXECUTE FUNCTION escrows_enforce_execution_intent_immutability();
