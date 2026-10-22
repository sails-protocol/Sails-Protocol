-- #235 R7H-NF-E3C-5 (B2) — a Trade-scoped Intent: one independent Intent per newly admitted trade.
--
-- Until now every trade taken from an Offer shared that Offer's single Intent ("Trade.intentId", copied from
-- "Offer.intentId", RFC-018). The Intent state machine is single-shot, so the second and later trades on an offer
-- failed their post-commit Intent walk (a false error for a live trade), and any trade's lifecycle transition
-- (cancel, escrow lock, settle, refund) rewrote the Intent every sibling trade depended on.
--
-- This migration is ADDITIVE and touches no existing row:
--   - "tradeIntentId": nullable, so every historical trade keeps NULL (no Intent history is back-filled or
--     fabricated). New trades are admitted with their own Intent in the same transaction (trade-repository.ts).
--   - UNIQUE: one Intent belongs to at most one trade (multiple NULLs stay allowed).
--   - FOREIGN KEY ... ON DELETE RESTRICT: a trade's Intent cannot vanish under it.
--   - "Trade.intentId" and "Offer.intentId" keep their published meaning (the originating Offer's Intent).
--   - trades_trade_intent_guard: "tradeIntentId" is fixed at creation (never set, changed or cleared later), and a
--     new trade's Intent must be an Intent of its own — never an offer's Intent or a legacy trade's shared Intent.
--     Together with the CHECK below the database itself forbids the shared-Intent reuse this fixes.
--   - "trades_intentId_idx": lookups by the legacy Intent (by-intent resolution, the bound-Intent cancellation
--     check) previously scanned the table.
--
-- Rollback (manual; trade Intents already created stay as ordinary Intent rows):
--   DROP TRIGGER trades_trade_intent_guard ON "trades";
--   DROP FUNCTION trades_enforce_trade_intent_integrity();
--   ALTER TABLE "trades" DROP CONSTRAINT "trades_trade_intent_distinct_from_offer_intent";
--   ALTER TABLE "trades" DROP CONSTRAINT "trades_tradeIntentId_fkey";
--   DROP INDEX "trades_tradeIntentId_key";
--   DROP INDEX "trades_intentId_idx";
--   ALTER TABLE "trades" DROP COLUMN "tradeIntentId";

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
  IF TG_OP = 'INSERT' AND NEW."tradeIntentId" IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "offers" WHERE "intentId" = NEW."tradeIntentId")
       OR EXISTS (SELECT 1 FROM "trades" WHERE "intentId" = NEW."tradeIntentId") THEN
      RAISE EXCEPTION 'trades: tradeIntentId must be an Intent of its own, not an offer or legacy trade Intent (id=%)', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_trade_intent_guard
BEFORE INSERT OR UPDATE OF "tradeIntentId" ON "trades"
FOR EACH ROW
EXECUTE FUNCTION trades_enforce_trade_intent_integrity();
