-- #235 R7G-F6C - WDK outbound settlement (RELEASE / REFUND / SPLIT) under the signed-transaction authority,
-- and its gas funding.
--
--   * An outbound leg (RELEASE, REFUND, SPLIT_BUYER, SPLIT_SELLER) with authority SIGNED_RAW_V1 is signed by the
--     escrow's own account from that account's nonce lane, persisted before any broadcast, and becomes terminal
--     only with corroborated evidence - the same identity, immutability and evidence rules as the F6B LOCK.
--   * GAS_FUNDING: a treasury transaction that sends native currency to an escrow account so one signed
--     outbound leg can pay for its gas. It names the leg it funds (fundsAttemptId, unique: one funding per
--     signed leg), carries its exact value in wei (valueWei), moves no token (amount 0), and has the same
--     signed-raw identity and evidence rules.
--   * One economic outbound family per escrow: RELEASE, REFUND and SPLIT legs never coexist economically
--     (rows that proved no transaction - FAILED_BEFORE_SUBMISSION, REVERTED - do not count), and a signed-raw
--     outbound row cannot be added to an escrow whose legacy transfer() outbound attempt may have moved funds.
-- Rollback (manual, with the previous application code): drop the trigger guard, the CHECK, the two columns and
-- restore wdk_transfer_attempts_enforce_signed_identity() from 20261010120000. The enum value stays.

ALTER TYPE "WdkTransferOperationType" ADD VALUE IF NOT EXISTS 'GAS_FUNDING';

ALTER TABLE "wdk_transfer_attempts"
  ADD COLUMN "fundsAttemptId" TEXT,
  ADD COLUMN "valueWei" NUMERIC(78, 0);

ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_fundsAttemptId_fkey"
  FOREIGN KEY ("fundsAttemptId") REFERENCES "wdk_transfer_attempts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "wdk_transfer_attempts_fundsAttemptId_key" ON "wdk_transfer_attempts"("fundsAttemptId");

ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_gas_funding_shape_check" CHECK (
  ("operationType"::text = 'GAS_FUNDING') = ("fundsAttemptId" IS NOT NULL)
  AND ("operationType"::text = 'GAS_FUNDING') = ("valueWei" IS NOT NULL)
  AND ("valueWei" IS NULL OR "valueWei" > 0)
  AND ("operationType"::text <> 'GAS_FUNDING' OR ("authority"::text = 'SIGNED_RAW_V1' AND "amount" = 0))
);

-- A signed transaction names its token contract, except a gas funding, which moves native currency only.
ALTER TABLE "wdk_transfer_attempts" DROP CONSTRAINT "wdk_transfer_attempts_signed_identity_check";
ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_signed_identity_check" CHECK (
  ("nonce" IS NULL OR "nonce" >= 0)
  AND ("signedRawTx" IS NULL OR "authority"::text = 'SIGNED_RAW_V1')
  AND (
    "authority"::text <> 'SIGNED_RAW_V1'
    OR "status"::text IN ('PREPARED', 'FAILED_BEFORE_SUBMISSION')
    OR ("signedRawTx" IS NOT NULL AND "txHash" IS NOT NULL AND "nonce" IS NOT NULL AND "chainId" IS NOT NULL
        AND "fromAddress" IS NOT NULL AND ("tokenContract" IS NOT NULL) = ("operationType"::text <> 'GAS_FUNDING'))
  )
  AND ("authority"::text <> 'SIGNED_RAW_V1' OR "status"::text NOT IN ('PREPARED', 'FAILED_BEFORE_SUBMISSION') OR "signedRawTx" IS NULL)
  AND ("operationType"::text <> 'GAS_FUNDING' OR "tokenContract" IS NULL)
);

CREATE OR REPLACE FUNCTION wdk_outbound_family(op TEXT) RETURNS TEXT AS $$
  SELECT CASE WHEN op IN ('SPLIT_BUYER', 'SPLIT_SELLER') THEN 'SPLIT' ELSE op END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION wdk_transfer_attempts_enforce_signed_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."signedRawTx" IS NOT NULL THEN
      RAISE EXCEPTION 'wdk_transfer_attempts: a signed transaction is economic evidence and cannot be deleted (id=%)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority"::text = 'SIGNED_RAW_V1' AND (NEW."status"::text <> 'PREPARED' OR NEW."signedRawTx" IS NOT NULL OR NEW."nonce" IS NOT NULL) THEN
      RAISE EXCEPTION 'wdk_transfer_attempts: a signed-raw attempt starts PREPARED; its signed transaction is written only by the nonce allocation (id=%)', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."authority"::text = 'SIGNED_RAW_V1' AND NEW."operationType"::text IN ('RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER') THEN
      IF EXISTS (
        SELECT 1 FROM "wdk_transfer_attempts" a
        WHERE a."escrowId" = NEW."escrowId" AND a."authority"::text = 'SIGNED_RAW_V1'
          AND a."operationType"::text IN ('RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER')
          AND wdk_outbound_family(a."operationType"::text) <> wdk_outbound_family(NEW."operationType"::text)
          AND a."status"::text NOT IN ('FAILED_BEFORE_SUBMISSION', 'REVERTED')
      ) THEN
        RAISE EXCEPTION 'wdk_transfer_attempts: escrow % already has an economic % outbound obligation; a % cannot be added (id=%)',
          NEW."escrowId", (SELECT wdk_outbound_family(a."operationType"::text) FROM "wdk_transfer_attempts" a
            WHERE a."escrowId" = NEW."escrowId" AND a."authority"::text = 'SIGNED_RAW_V1' AND a."operationType"::text IN ('RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER')
              AND a."status"::text NOT IN ('FAILED_BEFORE_SUBMISSION', 'REVERTED') LIMIT 1),
          wdk_outbound_family(NEW."operationType"::text), NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "wdk_transfer_attempts" a
        WHERE a."escrowId" = NEW."escrowId" AND a."authority"::text = 'LEGACY_TRANSFER_V0'
          AND a."operationType"::text IN ('RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER')
          AND a."status"::text NOT IN ('PREPARED', 'FAILED_BEFORE_SUBMISSION')
      ) THEN
        RAISE EXCEPTION 'wdk_transfer_attempts: escrow % has a legacy transfer() outbound attempt that may have moved funds; no signed outbound authority is added (id=%)', NEW."escrowId", NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    IF NEW."operationType"::text = 'GAS_FUNDING' AND NOT EXISTS (
      SELECT 1 FROM "wdk_transfer_attempts" f
      WHERE f.id = NEW."fundsAttemptId" AND f."escrowId" = NEW."escrowId" AND f."authority"::text = 'SIGNED_RAW_V1'
        AND f."signedRawTx" IS NOT NULL AND f."fromAddress" = NEW."destination"
        AND f."operationType"::text IN ('RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER')
    ) THEN
      RAISE EXCEPTION 'wdk_transfer_attempts: gas funding % must fund a signed outbound leg of the same escrow, sent to that leg''s account', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."authority" IS DISTINCT FROM OLD."authority" THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: authority is immutable (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."fundsAttemptId", NEW."valueWei") IS DISTINCT FROM (OLD."fundsAttemptId", OLD."valueWei") THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: a gas funding''s leg and value are immutable (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."signedRawTx" IS NOT NULL AND (
    NEW."escrowId", NEW."operationType", NEW."destination", NEW."amount", NEW."chainId", NEW."fromAddress",
    NEW."tokenContract", NEW."nonce", NEW."signedRawTx", NEW."txHash", NEW."signedAtBlock"
  ) IS DISTINCT FROM (
    OLD."escrowId", OLD."operationType", OLD."destination", OLD."amount", OLD."chainId", OLD."fromAddress",
    OLD."tokenContract", OLD."nonce", OLD."signedRawTx", OLD."txHash", OLD."signedAtBlock"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: a signed transaction and the intent it encodes are immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."authority"::text = 'SIGNED_RAW_V1' AND OLD."status"::text = 'PREPARED' AND (
    NEW."escrowId", NEW."operationType", NEW."destination", NEW."amount", NEW."chainId", NEW."fromAddress", NEW."tokenContract"
  ) IS DISTINCT FROM (
    OLD."escrowId", OLD."operationType", OLD."destination", OLD."amount", OLD."chainId", OLD."fromAddress", OLD."tokenContract"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: a prepared signed-raw obligation (recipient, amount, accounts) is frozen (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."finalizedAt" IS NOT NULL AND (
    NEW."receiptBlockNumber", NEW."receiptBlockHash", NEW."finalityHeadBlock", NEW."finalityRule", NEW."finalizedAt",
    NEW."primarySource", NEW."corroboratingSource", NEW."corroboratingHeadBlock", NEW."nonceConsumedAtBlock"
  ) IS DISTINCT FROM (
    OLD."receiptBlockNumber", OLD."receiptBlockHash", OLD."finalityHeadBlock", OLD."finalityRule", OLD."finalizedAt",
    OLD."primarySource", OLD."corroboratingSource", OLD."corroboratingHeadBlock", OLD."nonceConsumedAtBlock"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: finality evidence is immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."authority"::text = 'SIGNED_RAW_V1' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status"::text = 'PREPARED' AND NEW."status"::text IN ('SIGNED', 'FAILED_BEFORE_SUBMISSION'))
    OR (OLD."status"::text = 'SIGNED' AND NEW."status"::text IN ('SUBMITTED', 'CONFIRMED', 'REVERTED', 'NONCE_CONSUMED_ELSEWHERE'))
    OR (OLD."status"::text = 'SUBMITTED' AND NEW."status"::text IN ('CONFIRMED', 'REVERTED', 'NONCE_CONSUMED_ELSEWHERE'))
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: % -> % is not a signed-raw transition (id=%)', OLD."status", NEW."status", OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
