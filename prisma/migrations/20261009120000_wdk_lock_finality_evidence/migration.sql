-- #235 R7G-F6B-P - WDK LOCK finality evidence, single-RPC anomaly and nonce-lane authority hardening.
--
--   * A SIGNED_RAW_V1 attempt may be CONFIRMED / REVERTED only together with the evidence that made its
--     receipt final: the receipt's block number and hash, the observed head, the rule applied
--     ("CONFIRMATIONS:<n>", which the head and block must satisfy) and when. That evidence is immutable.
--     A terminal state without evidence (e.g. written by hand) is refused.
--   * NONCE_CONSUMED_ELSEWHERE is no longer a signed-raw transition: a single RPC's view cannot prove it and
--     no Day-0 configuration provides corroborated evidence. A suspicion halts the lane instead (application).
--   * wdk_nonce_lanes."nextNonce" moves only by exactly one, and only in a transaction that persists the
--     signed transaction using the nonce it releases (deferred check) - never advanced or skipped by hand.
-- No existing row changes value. The CHECK refuses to install over a signed-raw CONFIRMED / REVERTED row
-- without evidence (none can exist where R7G-F6B has not run; such a row needs manual review).
--
-- Rollback (manual, with the previous application code): drop wdk_nonce_lanes_allocation_guard and its
-- function, restore the two trigger functions from 20261008120000, drop the CHECK and the five columns.

ALTER TABLE "wdk_transfer_attempts"
  ADD COLUMN "receiptBlockNumber" BIGINT,
  ADD COLUMN "receiptBlockHash" TEXT,
  ADD COLUMN "finalityHeadBlock" BIGINT,
  ADD COLUMN "finalityRule" TEXT,
  ADD COLUMN "finalizedAt" TIMESTAMP(3);

ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_finality_evidence_check" CHECK (
  ("receiptBlockNumber" IS NULL OR "receiptBlockNumber" >= 0)
  AND (
    "authority"::text <> 'SIGNED_RAW_V1'
    OR "status"::text NOT IN ('CONFIRMED', 'REVERTED')
    OR (
      "receiptBlockNumber" IS NOT NULL
      AND "receiptBlockHash" ~ '^0x[0-9a-f]{64}$'
      AND "finalityHeadBlock" IS NOT NULL
      AND "finalityRule" ~ '^CONFIRMATIONS:[1-9][0-9]{0,5}$'
      AND "finalizedAt" IS NOT NULL
      AND "finalityHeadBlock" - "receiptBlockNumber" + 1 >= substring("finalityRule" from 15)::bigint
    )
  )
);

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
    RETURN NEW;
  END IF;
  IF NEW."authority" IS DISTINCT FROM OLD."authority" THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: authority is immutable (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."signedRawTx" IS NOT NULL AND (
    NEW."escrowId", NEW."operationType", NEW."destination", NEW."amount", NEW."chainId", NEW."fromAddress",
    NEW."tokenContract", NEW."nonce", NEW."signedRawTx", NEW."txHash"
  ) IS DISTINCT FROM (
    OLD."escrowId", OLD."operationType", OLD."destination", OLD."amount", OLD."chainId", OLD."fromAddress",
    OLD."tokenContract", OLD."nonce", OLD."signedRawTx", OLD."txHash"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: a signed transaction and the intent it encodes are immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."receiptBlockNumber" IS NOT NULL AND (
    NEW."receiptBlockNumber", NEW."receiptBlockHash", NEW."finalityHeadBlock", NEW."finalityRule", NEW."finalizedAt"
  ) IS DISTINCT FROM (
    OLD."receiptBlockNumber", OLD."receiptBlockHash", OLD."finalityHeadBlock", OLD."finalityRule", OLD."finalizedAt"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: finality evidence is immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."authority"::text = 'SIGNED_RAW_V1' AND NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status"::text = 'NONCE_CONSUMED_ELSEWHERE' THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: NONCE_CONSUMED_ELSEWHERE needs corroborated evidence, which no Day-0 configuration provides (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."authority"::text = 'SIGNED_RAW_V1' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status"::text = 'PREPARED' AND NEW."status"::text IN ('SIGNED', 'FAILED_BEFORE_SUBMISSION'))
    OR (OLD."status"::text = 'SIGNED' AND NEW."status"::text IN ('SUBMITTED', 'CONFIRMED', 'REVERTED'))
    OR (OLD."status"::text = 'SUBMITTED' AND NEW."status"::text IN ('CONFIRMED', 'REVERTED'))
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: % -> % is not a signed-raw transition (id=%)', OLD."status", NEW."status", OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION wdk_nonce_lanes_enforce_monotonic()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: a nonce lane cannot be deleted (chainId=%, account=%)', OLD."chainId", OLD."account"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."chainId" IS DISTINCT FROM OLD."chainId" OR NEW."account" IS DISTINCT FROM OLD."account" THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: the lane key is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."nextNonce" <> OLD."nextNonce" AND NEW."nextNonce" <> OLD."nextNonce" + 1 THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: nextNonce only moves by one allocation (% -> %)', OLD."nextNonce", NEW."nextNonce"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Checked at commit: the nonce a lane released belongs to a signed transaction persisted in the same
-- transaction (the allocation in wdk-lock-authority.ts), so nextNonce cannot be advanced by hand.
CREATE OR REPLACE FUNCTION wdk_nonce_lanes_enforce_allocation()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "wdk_transfer_attempts"
    WHERE "chainId" = NEW."chainId" AND "fromAddress" = NEW."account" AND "nonce" = NEW."nextNonce" - 1 AND "signedRawTx" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: nonce % of (%, %) was released without a signed transaction using it', NEW."nextNonce" - 1, NEW."chainId", NEW."account"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER wdk_nonce_lanes_allocation_guard
  AFTER UPDATE ON "wdk_nonce_lanes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."nextNonce" IS DISTINCT FROM OLD."nextNonce")
  EXECUTE FUNCTION wdk_nonce_lanes_enforce_allocation();
