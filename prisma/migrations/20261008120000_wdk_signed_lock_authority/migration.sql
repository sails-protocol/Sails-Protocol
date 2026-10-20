-- #235 R7G-F6B - WDK signed LOCK authority (WDK_SIGNED_TRANSACTION_IDENTITY_V1,
-- TREASURY_NONCE_AUTHORITY_V1, WDK_LOCK_EXACTLY_ONE_TRANSACTION_V1).
--
-- A WDK LOCK is no longer submitted through WDK transfer() (nonce chosen by the RPC, hash known only
-- after broadcast). Sails allocates the treasury nonce from wdk_nonce_lanes, signs the exact transaction
-- locally and persists it (raw bytes, hash, nonce, signer, token, chain) in the same transaction, and only
-- then broadcasts - always that persisted transaction, never a new one.
--
--   * wdk_transfer_attempts.authority: LEGACY_TRANSFER_V0 for every existing row (unchanged meaning),
--     SIGNED_RAW_V1 for signed-raw attempts.
--   * Two new statuses: SIGNED (signed transaction durable; may already be broadcast) and
--     NONCE_CONSUMED_ELSEWHERE (its nonce is final on-chain with another transaction).
--   * A signed transaction is immutable together with the intent it encodes, cannot be deleted, and its
--     status only moves forward; txHash and (chainId, fromAddress, nonce) are unique among signed rows.
--   * wdk_nonce_lanes: the next nonce per (chainId, account), never decreasing.
-- No existing row changes value. Legacy LOCK attempts keep their status and are handled fail-closed by
-- the application (never re-signed, never reconstructed); `npm run wdk:lock-preflight` lists them.
--
-- New enum values are only compared as text below (a value added by ALTER TYPE cannot be used as an
-- enum literal in the transaction that adds it).
--
-- Rollback (manual, if ever needed, together with the previous application code):
--   DROP TRIGGER wdk_nonce_lanes_guard ON "wdk_nonce_lanes"; DROP FUNCTION wdk_nonce_lanes_enforce_monotonic();
--   DROP TABLE "wdk_nonce_lanes";
--   DROP TRIGGER wdk_transfer_attempts_signed_identity_guard ON "wdk_transfer_attempts";
--   DROP FUNCTION wdk_transfer_attempts_enforce_signed_identity();
--   DROP INDEX "wdk_transfer_attempts_signed_tx_hash_key"; DROP INDEX "wdk_transfer_attempts_signed_nonce_key";
--   ALTER TABLE "wdk_transfer_attempts" DROP CONSTRAINT "wdk_transfer_attempts_signed_identity_check",
--     DROP COLUMN "authority", DROP COLUMN "fromAddress", DROP COLUMN "tokenContract", DROP COLUMN "nonce",
--     DROP COLUMN "signedRawTx";
--   DROP TYPE "WdkAttemptAuthority"; (enum values SIGNED / NONCE_CONSUMED_ELSEWHERE cannot be dropped)

ALTER TYPE "WdkTransferAttemptStatus" ADD VALUE 'SIGNED';
ALTER TYPE "WdkTransferAttemptStatus" ADD VALUE 'NONCE_CONSUMED_ELSEWHERE';

CREATE TYPE "WdkAttemptAuthority" AS ENUM ('LEGACY_TRANSFER_V0', 'SIGNED_RAW_V1');

ALTER TABLE "wdk_transfer_attempts"
  ADD COLUMN "authority" "WdkAttemptAuthority" NOT NULL DEFAULT 'LEGACY_TRANSFER_V0',
  ADD COLUMN "fromAddress" TEXT,
  ADD COLUMN "tokenContract" TEXT,
  ADD COLUMN "nonce" BIGINT,
  ADD COLUMN "signedRawTx" TEXT;

ALTER TABLE "wdk_transfer_attempts" ADD CONSTRAINT "wdk_transfer_attempts_signed_identity_check" CHECK (
  ("nonce" IS NULL OR "nonce" >= 0)
  AND ("signedRawTx" IS NULL OR "authority"::text = 'SIGNED_RAW_V1')
  AND (
    "authority"::text <> 'SIGNED_RAW_V1'
    OR "status"::text IN ('PREPARED', 'FAILED_BEFORE_SUBMISSION')
    OR ("signedRawTx" IS NOT NULL AND "txHash" IS NOT NULL AND "nonce" IS NOT NULL AND "chainId" IS NOT NULL
        AND "fromAddress" IS NOT NULL AND "tokenContract" IS NOT NULL)
  )
  AND ("authority"::text <> 'SIGNED_RAW_V1' OR "status"::text NOT IN ('PREPARED', 'FAILED_BEFORE_SUBMISSION') OR "signedRawTx" IS NULL)
);

CREATE UNIQUE INDEX "wdk_transfer_attempts_signed_tx_hash_key" ON "wdk_transfer_attempts" ("txHash") WHERE "signedRawTx" IS NOT NULL;
CREATE UNIQUE INDEX "wdk_transfer_attempts_signed_nonce_key" ON "wdk_transfer_attempts" ("chainId", "fromAddress", "nonce") WHERE "signedRawTx" IS NOT NULL;

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

CREATE TRIGGER wdk_transfer_attempts_signed_identity_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "wdk_transfer_attempts"
  FOR EACH ROW EXECUTE FUNCTION wdk_transfer_attempts_enforce_signed_identity();

CREATE TABLE "wdk_nonce_lanes" (
  "chainId" INTEGER NOT NULL,
  "account" TEXT NOT NULL,
  "nextNonce" BIGINT NOT NULL,
  "haltedAt" TIMESTAMP(3),
  "haltedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wdk_nonce_lanes_pkey" PRIMARY KEY ("chainId", "account"),
  CONSTRAINT "wdk_nonce_lanes_next_nonce_check" CHECK ("nextNonce" >= 0)
);

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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wdk_nonce_lanes_guard
  BEFORE UPDATE OR DELETE ON "wdk_nonce_lanes"
  FOR EACH ROW EXECUTE FUNCTION wdk_nonce_lanes_enforce_monotonic();
