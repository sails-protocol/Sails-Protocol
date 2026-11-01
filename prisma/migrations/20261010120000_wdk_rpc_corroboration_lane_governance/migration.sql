-- #235 R7G-F6B-P1 - WDK multi-RPC irreversible authority, governed lane halt / resume, stuck-nonce
-- backpressure (WDK_IRREVERSIBLE_RPC_CORROBORATION_V1, WDK_LANE_RESUME_AUTHORITY_V1,
-- WDK_LOWEST_UNRESOLVED_NONCE_BACKPRESSURE_V1).
--
--   * wdk_transfer_attempts: a signed-raw CONFIRMED / REVERTED also needs the corroborating source's
--     agreement (two distinct source labels, the corroborator's head satisfying the same rule); a
--     NONCE_CONSUMED_ELSEWHERE needs the same two sources, both heads and the final block at which the nonce
--     was consumed. That evidence and signedAtBlock are immutable.
--   * wdk_lane_halts replaces wdk_nonce_lanes.haltedAt/haltedReason: structured reasons, several at once,
--     never deleted, cleared once and only with an audit record in the same transaction; an economic reason
--     (not OPERATOR_PAUSE) clears only through RESUME and only while no signed transaction of the lane is
--     unresolved; an OPERATOR_PAUSE clears only through UNPAUSE and only while no economic halt is active.
--     Existing halts are carried over as SUSPECTED_EXTERNAL_NONCE_CONSUMPTION (the only reason R7G-F6B /
--     F6B-P wrote).
--   * wdk_lane_audit: append-only.
--   * wdk_nonce_lanes.nextNonce: besides +1 for a persisted signed transaction, it moves only in a RESUME
--     whose audit record in the same transaction names exactly that change (governed realignment).
-- Rollback (manual, with the previous application code): drop the two new tables and triggers, re-add
-- haltedAt/haltedReason, restore the trigger functions and CHECKs of 20261009120000.

CREATE TYPE "WdkLaneHaltReason" AS ENUM ('OPERATOR_PAUSE', 'STUCK_LOWEST_NONCE', 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', 'PROVEN_EXTERNAL_NONCE_CONSUMPTION');
CREATE TYPE "WdkLaneAuditAction" AS ENUM ('HALT', 'PAUSE', 'UNPAUSE', 'RESUME');

-- --- attempts: corroboration evidence ------------------------------------------------------------

ALTER TABLE "wdk_transfer_attempts"
  ADD COLUMN "primarySource" TEXT,
  ADD COLUMN "corroboratingSource" TEXT,
  ADD COLUMN "corroboratingHeadBlock" BIGINT,
  ADD COLUMN "nonceConsumedAtBlock" BIGINT,
  ADD COLUMN "signedAtBlock" BIGINT;

ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_corroboration_check" CHECK (
  "authority"::text <> 'SIGNED_RAW_V1'
  OR (
    "status"::text NOT IN ('CONFIRMED', 'REVERTED', 'NONCE_CONSUMED_ELSEWHERE')
    AND "primarySource" IS NULL AND "corroboratingSource" IS NULL AND "corroboratingHeadBlock" IS NULL AND "nonceConsumedAtBlock" IS NULL
  )
  OR (
    "status"::text IN ('CONFIRMED', 'REVERTED')
    AND "primarySource" IS NOT NULL AND "corroboratingSource" IS NOT NULL AND "primarySource" <> "corroboratingSource"
    AND "corroboratingHeadBlock" IS NOT NULL AND "nonceConsumedAtBlock" IS NULL
    AND "corroboratingHeadBlock" - "receiptBlockNumber" + 1 >= substring("finalityRule" from 15)::bigint
  )
  OR (
    "status"::text = 'NONCE_CONSUMED_ELSEWHERE'
    AND "primarySource" IS NOT NULL AND "corroboratingSource" IS NOT NULL AND "primarySource" <> "corroboratingSource"
    AND "finalityHeadBlock" IS NOT NULL AND "corroboratingHeadBlock" IS NOT NULL AND "nonceConsumedAtBlock" IS NOT NULL
    AND "finalityRule" ~ '^CONFIRMATIONS:[1-9][0-9]{0,5}$' AND "finalizedAt" IS NOT NULL
    AND "receiptBlockNumber" IS NULL AND "receiptBlockHash" IS NULL
    AND "finalityHeadBlock" - "nonceConsumedAtBlock" + 1 >= substring("finalityRule" from 15)::bigint
    AND "corroboratingHeadBlock" - "nonceConsumedAtBlock" + 1 >= substring("finalityRule" from 15)::bigint
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
    NEW."tokenContract", NEW."nonce", NEW."signedRawTx", NEW."txHash", NEW."signedAtBlock"
  ) IS DISTINCT FROM (
    OLD."escrowId", OLD."operationType", OLD."destination", OLD."amount", OLD."chainId", OLD."fromAddress",
    OLD."tokenContract", OLD."nonce", OLD."signedRawTx", OLD."txHash", OLD."signedAtBlock"
  ) THEN
    RAISE EXCEPTION 'wdk_transfer_attempts: a signed transaction and the intent it encodes are immutable (id=%)', OLD.id
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

-- --- audit -----------------------------------------------------------------------------------------

CREATE TABLE "wdk_lane_audit" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "account" TEXT NOT NULL,
  "action" "WdkLaneAuditAction" NOT NULL,
  "reason" "WdkLaneHaltReason",
  "actor" TEXT NOT NULL,
  "previousNextNonce" BIGINT,
  "newNextNonce" BIGINT,
  "detail" TEXT NOT NULL,
  "dbTxId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wdk_lane_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wdk_lane_audit_actor_check" CHECK (length(btrim("actor")) > 0)
);
CREATE INDEX "wdk_lane_audit_chainId_account_createdAt_idx" ON "wdk_lane_audit"("chainId", "account", "createdAt");

CREATE OR REPLACE FUNCTION wdk_lane_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wdk_lane_audit: audit records are append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wdk_lane_audit_append_only_guard
  BEFORE UPDATE OR DELETE ON "wdk_lane_audit"
  FOR EACH ROW EXECUTE FUNCTION wdk_lane_audit_append_only();

-- --- halts -----------------------------------------------------------------------------------------

CREATE TABLE "wdk_lane_halts" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "account" TEXT NOT NULL,
  "reason" "WdkLaneHaltReason" NOT NULL,
  "detail" TEXT NOT NULL,
  "raisedBy" TEXT NOT NULL,
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt" TIMESTAMP(3),
  "clearedBy" TEXT,
  CONSTRAINT "wdk_lane_halts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wdk_lane_halts_cleared_check" CHECK (("clearedAt" IS NULL) = ("clearedBy" IS NULL))
);
CREATE INDEX "wdk_lane_halts_chainId_account_idx" ON "wdk_lane_halts"("chainId", "account");
CREATE UNIQUE INDEX "wdk_lane_halts_active_reason_key" ON "wdk_lane_halts"("chainId", "account", "reason") WHERE "clearedAt" IS NULL;

CREATE OR REPLACE FUNCTION wdk_lane_halts_enforce_governance()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."clearedAt" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "wdk_lane_audit"
      WHERE "dbTxId" = txid_current() AND "chainId" = NEW."chainId" AND "account" = NEW."account" AND "reason" = NEW."reason"
        AND "action"::text = CASE WHEN NEW."reason"::text = 'OPERATOR_PAUSE' THEN 'PAUSE' ELSE 'HALT' END
    ) THEN
      RAISE EXCEPTION 'wdk_lane_halts: a halt is raised active and together with its audit record (lane %/%, %)', NEW."chainId", NEW."account", NEW."reason"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wdk_lane_halts: a halt is never deleted (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW."chainId", NEW."account", NEW."reason", NEW."detail", NEW."raisedBy", NEW."raisedAt")
     IS DISTINCT FROM (OLD.id, OLD."chainId", OLD."account", OLD."reason", OLD."detail", OLD."raisedBy", OLD."raisedAt") THEN
    RAISE EXCEPTION 'wdk_lane_halts: a halt is immutable; it can only be cleared (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."clearedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'wdk_lane_halts: a cleared halt is final (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."clearedAt" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "wdk_lane_audit"
      WHERE "dbTxId" = txid_current() AND "chainId" = OLD."chainId" AND "account" = OLD."account"
        AND "action"::text = CASE WHEN OLD."reason"::text = 'OPERATOR_PAUSE' THEN 'UNPAUSE' ELSE 'RESUME' END
    ) THEN
      RAISE EXCEPTION 'wdk_lane_halts: clearing a % halt needs its % audit record in the same transaction (id=%)', OLD."reason",
        CASE WHEN OLD."reason"::text = 'OPERATOR_PAUSE' THEN 'UNPAUSE' ELSE 'RESUME' END, OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."reason"::text = 'OPERATOR_PAUSE' AND EXISTS (
      SELECT 1 FROM "wdk_lane_halts"
      WHERE "chainId" = OLD."chainId" AND "account" = OLD."account" AND "clearedAt" IS NULL AND "reason"::text <> 'OPERATOR_PAUSE'
    ) THEN
      RAISE EXCEPTION 'wdk_lane_halts: an operator pause cannot be removed while an economic halt of the lane is active (id=%)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."reason"::text <> 'OPERATOR_PAUSE' AND EXISTS (
      SELECT 1 FROM "wdk_transfer_attempts"
      WHERE "chainId" = OLD."chainId" AND "fromAddress" = OLD."account" AND "signedRawTx" IS NOT NULL AND "status"::text IN ('SIGNED', 'SUBMITTED')
    ) THEN
      RAISE EXCEPTION 'wdk_lane_halts: an economic halt cannot clear while a signed transaction of the lane is unresolved (id=%)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wdk_lane_halts_governance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "wdk_lane_halts"
  FOR EACH ROW EXECUTE FUNCTION wdk_lane_halts_enforce_governance();

-- Existing halts (R7G-F6B / F6B-P wrote only foreign-nonce suspicions) carried over, with their audit record.
INSERT INTO "wdk_lane_audit" ("id", "chainId", "account", "action", "reason", "actor", "detail")
SELECT gen_random_uuid()::text, "chainId", "account", 'HALT', 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', 'migration:20261010120000', COALESCE("haltedReason", 'halted before structured reasons')
FROM "wdk_nonce_lanes" WHERE "haltedAt" IS NOT NULL;
INSERT INTO "wdk_lane_halts" ("id", "chainId", "account", "reason", "detail", "raisedBy", "raisedAt")
SELECT gen_random_uuid()::text, "chainId", "account", 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', COALESCE("haltedReason", 'halted before structured reasons'), 'migration:20261010120000', "haltedAt"
FROM "wdk_nonce_lanes" WHERE "haltedAt" IS NOT NULL;
ALTER TABLE "wdk_nonce_lanes" DROP COLUMN "haltedAt", DROP COLUMN "haltedReason";

-- --- lane: governed realignment -------------------------------------------------------------------

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
  IF NEW."nextNonce" < OLD."nextNonce" THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: nextNonce never decreases (% -> %)', OLD."nextNonce", NEW."nextNonce"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."nextNonce" > OLD."nextNonce" + 1 AND NOT EXISTS (
    SELECT 1 FROM "wdk_lane_audit"
    WHERE "dbTxId" = txid_current() AND "chainId" = OLD."chainId" AND "account" = OLD."account" AND "action"::text = 'RESUME'
      AND "previousNextNonce" = OLD."nextNonce" AND "newNextNonce" = NEW."nextNonce"
  ) THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: nextNonce only moves by one allocation, or by a governed RESUME realignment (% -> %)', OLD."nextNonce", NEW."nextNonce"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION wdk_nonce_lanes_enforce_allocation()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "wdk_transfer_attempts"
    WHERE "chainId" = NEW."chainId" AND "fromAddress" = NEW."account" AND "nonce" = NEW."nextNonce" - 1 AND "signedRawTx" IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM "wdk_lane_audit"
    WHERE "dbTxId" = txid_current() AND "chainId" = NEW."chainId" AND "account" = NEW."account" AND "action"::text = 'RESUME'
      AND "previousNextNonce" = OLD."nextNonce" AND "newNextNonce" = NEW."nextNonce"
  ) THEN
    RAISE EXCEPTION 'wdk_nonce_lanes: nonce % of (%, %) was released without a signed transaction using it or a governed RESUME', NEW."nextNonce" - 1, NEW."chainId", NEW."account"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
