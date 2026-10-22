-- #235 R7C - payment-account <-> trade binding and peer-attestation authority.
--
-- A PaymentAccount is the fiat receiver's (seller's) rail. The seller binds it to a trade at creation
-- (Offer.paymentAccountId on a SELL offer, the taker's selection on a BUY offer); only the buyer of a
-- clean COMPLETED trade bound to that exact account may then attest it (PEER). RFC-021 D7 vouching is
-- recorded as VOUCHER. Rows signed before this migration have no recorded provenance: LEGACY.
-- CreateEnum
CREATE TYPE "PaymentAccountAttestationSource" AS ENUM ('PEER', 'VOUCHER', 'LEGACY');

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "paymentAccountId" TEXT;

-- AlterTable
ALTER TABLE "payment_accounts" ADD COLUMN     "attestationSource" "PaymentAccountAttestationSource",
ADD COLUMN     "attestedTradeId" TEXT;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "sellerPaymentAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_sellerPaymentAccountId_fkey" FOREIGN KEY ("sellerPaymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_attestedTradeId_fkey" FOREIGN KEY ("attestedTradeId") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: every row already signed was signed before provenance existed. Whether a given row came
-- from a vouch or from the old unrestricted /sign route cannot be told apart reliably, so none is
-- labelled PEER or VOUCHER after the fact.
UPDATE "payment_accounts" SET "attestationSource" = 'LEGACY' WHERE "signed" = true;

-- Provenance is set together with `signed` and is complete: a PEER attestation names its trade, the
-- other sources never do.
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_attestation_check" CHECK (
  ("signed" = false AND "attestationSource" IS NULL AND "attestedTradeId" IS NULL)
  OR ("signed" = true AND "attestationSource" = 'PEER' AND "attestedTradeId" IS NOT NULL AND "signedBy" IS NOT NULL AND "signedAt" IS NOT NULL)
  OR ("signed" = true AND "attestationSource" IN ('VOUCHER', 'LEGACY') AND "attestedTradeId" IS NULL)
);

-- Write-once, enforced by the database as well as the service (same shape as
-- escrows_enforce_settlement_result_write_once): once an account is signed, nothing about that
-- attestation changes; a trade's bound account is fixed at insert and never set, changed or cleared later.
-- Rollback (manual):
--   DROP TRIGGER payment_accounts_attestation_write_once_guard ON "payment_accounts";
--   DROP FUNCTION payment_accounts_enforce_attestation_write_once();
--   DROP TRIGGER trades_seller_payment_account_write_once_guard ON "trades";
--   DROP FUNCTION trades_enforce_seller_payment_account_write_once();
CREATE OR REPLACE FUNCTION payment_accounts_enforce_attestation_write_once()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."signed" = true AND (
    NEW."signed" IS DISTINCT FROM OLD."signed"
    OR NEW."signedBy" IS DISTINCT FROM OLD."signedBy"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
    OR NEW."attestationSource" IS DISTINCT FROM OLD."attestationSource"
    OR NEW."attestedTradeId" IS DISTINCT FROM OLD."attestedTradeId"
  ) THEN
    RAISE EXCEPTION 'payment_accounts: attestation is write-once (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_accounts_attestation_write_once_guard
BEFORE UPDATE ON "payment_accounts"
FOR EACH ROW
EXECUTE FUNCTION payment_accounts_enforce_attestation_write_once();

CREATE OR REPLACE FUNCTION trades_enforce_seller_payment_account_write_once()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."sellerPaymentAccountId" IS DISTINCT FROM OLD."sellerPaymentAccountId" THEN
    RAISE EXCEPTION 'trades: sellerPaymentAccountId is fixed at creation (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_seller_payment_account_write_once_guard
BEFORE UPDATE ON "trades"
FOR EACH ROW
EXECUTE FUNCTION trades_enforce_seller_payment_account_write_once();
