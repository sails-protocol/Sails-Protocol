-- E21 R1 (CTO 28 Despacho 029, D026 item 5) - the exact offer-envelope revision a trade accepted.
--
-- "acceptedEnvelopeId" names ONE row of the append-only, write-once "offer_envelopes" (migration
-- 20261111120000), so the accepted identity, revision and canonical digest are fixed by construction. It is
-- written by the E21 admission in the same transaction as the trade (trade.service.ts admit()) and never after.
-- ADDITIVE, no backfill: every existing trade keeps NULL (legacy: it accepted a legacy Offer, not a revision).
--   - FOREIGN KEY ... ON DELETE RESTRICT: the accepted revision cannot disappear under the trade.
--   - trades_accepted_envelope_guard: write-once (fixed at creation), and at the INSERT the revision must be
--     owned by the Offer's owner, RESOLVED (no other row of the same revision with another digest, no later
--     revision), ACTIVE and not expired on the database clock, and economically the trade's terms (asset, side,
--     priceUsd, paymentMethod, amount within its limits).
--
-- Reversal (manual, not applied automatically):
--   DROP TRIGGER trades_accepted_envelope_guard ON "trades";
--   DROP FUNCTION trades_enforce_accepted_envelope();
--   ALTER TABLE "trades" DROP CONSTRAINT "trades_acceptedEnvelopeId_fkey";
--   ALTER TABLE "trades" DROP COLUMN "acceptedEnvelopeId";
-- Reverting the application code without this reversal is safe: the old code never reads or writes the column.

-- The ALTERs take an ACCESS EXCLUSIVE lock on "trades": give up instead of queueing behind live traffic.
SET lock_timeout = '5s';

ALTER TABLE "trades" ADD COLUMN "acceptedEnvelopeId" TEXT;

ALTER TABLE "trades"
  ADD CONSTRAINT "trades_acceptedEnvelopeId_fkey"
  FOREIGN KEY ("acceptedEnvelopeId") REFERENCES "offer_envelopes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION trades_enforce_accepted_envelope()
RETURNS TRIGGER AS $$
DECLARE
  e record;
  o record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."acceptedEnvelopeId" IS DISTINCT FROM OLD."acceptedEnvelopeId" THEN
      RAISE EXCEPTION 'trades: acceptedEnvelopeId is fixed at creation (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."acceptedEnvelopeId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO e FROM "offer_envelopes" WHERE "id" = NEW."acceptedEnvelopeId";
  SELECT f."side"::text AS side, f."paymentMethod"::text AS "paymentMethod", u."publicKey" AS owner
    INTO o FROM "offers" f JOIN "users" u ON u."id" = f."userId" WHERE f."id" = NEW."offerId";
  -- No such envelope: the FOREIGN KEY refuses it. IS NOT TRUE: any unknown (NULL) value is a refusal, never a pass.
  IF e."id" IS NOT NULL AND (
       e."ownerPublicKey" = o.owner
   AND e."status"::text = 'ACTIVE'
   AND e."expiresAt" > clock_timestamp()
   AND NOT EXISTS (SELECT 1 FROM "offer_envelopes" x
                   WHERE x."ownerPublicKey" = e."ownerPublicKey" AND x."logicalOfferId" = e."logicalOfferId"
                     AND (x."revision" > e."revision" OR (x."revision" = e."revision" AND x."contentDigest" <> e."contentDigest")))
   AND e."asset"::text = NEW."asset"::text
   AND e."side"::text = o.side
   AND e."paymentMethod"::text = o."paymentMethod"
   AND e."priceUsd" = NEW."priceUsd"
   AND NEW."amount" BETWEEN e."minAmount" AND e."maxAmount") IS NOT TRUE THEN
    RAISE EXCEPTION 'trades: acceptedEnvelopeId must be a resolved, active revision of this Offer owner matching the trade terms (id=%)', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_accepted_envelope_guard
BEFORE INSERT OR UPDATE OF "acceptedEnvelopeId" ON "trades"
FOR EACH ROW
EXECUTE FUNCTION trades_enforce_accepted_envelope();

RESET lock_timeout;
