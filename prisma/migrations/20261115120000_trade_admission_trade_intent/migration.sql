-- E21 slice 1 (Issue #105, CTO 24 ratification 6811594078, CTO 223) - every newly admitted trade owns an Intent.
--
-- Until now a trade copied its Offer's Intent ("trades"."intentId"). The Intent state machine is single-shot, so the
-- second trade on an offer was persisted and then failed its Intent walk, and any trade's cancellation or escrow
-- transition moved the Intent its sibling trades shared. A trade admitted from now on gets its own Intent
-- ("tradeIntentId"), created in the same transaction as the trade (trade.service.ts createTrade()).
--
-- ADDITIVE, no backfill: every existing trade keeps "tradeIntentId" NULL (legacy, invariant 10) and "intentId" keeps
-- its published meaning (the originating Offer's Intent).
--   - UNIQUE: an Intent carries at most one trade (NULLs stay allowed).
--   - FOREIGN KEY ... ON DELETE RESTRICT: a trade's Intent cannot disappear under it.
--   - CHECK: a trade's own Intent, when present, is never its Offer's Intent (legacy rows are NULL/NULL).
--   - trades_trade_intent_guard: "tradeIntentId" is fixed at creation, a new trade's Intent is never an Offer's Intent
--     or a legacy trade's shared Intent, and no trade may adopt another trade's own Intent as its "intentId".
--   - "trades_intentId_idx": the by-intent lookup and the bound-Intent check filter on "intentId".
--
-- Reversal (manual, not applied automatically; Intents already created for trades stay as ordinary Intent rows):
--   DROP TRIGGER trades_trade_intent_guard ON "trades";
--   DROP FUNCTION trades_enforce_trade_intent_integrity();
--   ALTER TABLE "trades" DROP CONSTRAINT "trades_trade_intent_distinct_from_offer_intent";
--   ALTER TABLE "trades" DROP CONSTRAINT "trades_tradeIntentId_fkey";
--   DROP INDEX "trades_tradeIntentId_key";
--   DROP INDEX "trades_intentId_idx";
--   ALTER TABLE "trades" DROP COLUMN "tradeIntentId";
-- Reverting the application code without this reversal is safe: the old code never reads or writes the column.

ALTER TABLE "trades" ADD COLUMN "tradeIntentId" TEXT;

CREATE UNIQUE INDEX "trades_tradeIntentId_key" ON "trades"("tradeIntentId");
CREATE INDEX "trades_intentId_idx" ON "trades"("intentId");

ALTER TABLE "trades"
  ADD CONSTRAINT "trades_tradeIntentId_fkey"
  FOREIGN KEY ("tradeIntentId") REFERENCES "intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trades"
  ADD CONSTRAINT "trades_trade_intent_distinct_from_offer_intent"
  CHECK ("tradeIntentId" IS NULL OR "tradeIntentId" IS DISTINCT FROM "intentId");

CREATE OR REPLACE FUNCTION trades_enforce_trade_intent_integrity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."tradeIntentId" IS DISTINCT FROM OLD."tradeIntentId" THEN
    RAISE EXCEPTION 'trades: tradeIntentId is fixed at creation (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tradeIntentId" IS NOT NULL AND (
       EXISTS (SELECT 1 FROM "offers" WHERE "intentId" = NEW."tradeIntentId")
    OR EXISTS (SELECT 1 FROM "trades" WHERE "intentId" = NEW."tradeIntentId")) THEN
    RAISE EXCEPTION 'trades: tradeIntentId must be an Intent of its own, not an Offer or legacy trade Intent (id=%)', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."intentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."intentId" IS DISTINCT FROM OLD."intentId")
     AND EXISTS (SELECT 1 FROM "trades" WHERE "tradeIntentId" = NEW."intentId") THEN
    RAISE EXCEPTION 'trades: intentId cannot be another trade''s own Intent (id=%)', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_trade_intent_guard
BEFORE INSERT OR UPDATE OF "tradeIntentId", "intentId" ON "trades"
FOR EACH ROW
EXECUTE FUNCTION trades_enforce_trade_intent_integrity();
