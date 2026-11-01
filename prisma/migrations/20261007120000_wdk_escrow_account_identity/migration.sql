-- #235 R7G-F6A-1 - WDK escrow account identity (WDK_ESCROW_ACCOUNT_IDENTITY_V1,
-- WDK_ESCROW_ACCOUNT_UNIQUENESS_V1, WDK_ESCROW_ACCOUNT_STABILITY_V1, WDK_LEGACY_ACCOUNT_AUTHORITY_V1).
--
-- A WDK_USDT_EVM escrow's account was derived at every use as m/44'/60'/0'/0/<i> with
-- i = sha256(tradeId) % (2^31-1). Different trades can map to the same i (a pair was found after
-- ~50k random trade ids), and that namespace is also the treasury's (i = 0) and the buyer accounts'
-- (buyerIndexFor). From now on the account is a persisted, unique, immutable path:
--   * escrows that exist before this migration keep exactly their historical account:
--     wdkAccountScheme = LEGACY_TRADE_HASH_V0, wdkAccountPath = 0'/0/<legacy i>;
--   * every new WDK_USDT_EVM escrow is allocated by the database on INSERT:
--     wdkAccountScheme = ALLOCATED_V1, wdkAccountPath = 1'/0/<n>, n from
--     wdk_escrow_account_index_seq (0..2^31-1, the non-hardened BIP-32 range; NO CYCLE, so exhaustion
--     fails the insert instead of wrapping). Branch 1' is used by no other WDK account.
--   * the path is unique, set by the database only, and immutable together with the escrow id,
--     tradeId and type it is bound to. No balance, key or address moves.
--
-- PREFLIGHT. Before any DDL, the legacy account of every existing WDK_USDT_EVM escrow is computed. If
-- two escrows share one, or an escrow's is the treasury's (i = 0), this migration aborts before
-- anything is changed: which escrow owns that account needs manual review, never an automatic choice.
-- `npm run wdk:account-preflight` (scripts/wdk-escrow-account-preflight.ts) reports the same checks
-- read-only, with escrow ids, plus collisions with buyer accounts - run it against production first.
--
-- Rollback (manual, if ever needed; restores runtime derivation from tradeId only together with the
-- previous application code):
--   DROP TRIGGER escrows_wdk_account_identity_guard ON "escrows";
--   DROP FUNCTION escrows_enforce_wdk_account_identity();
--   ALTER TABLE "escrows" DROP CONSTRAINT "escrows_wdk_account_identity_check";
--   DROP INDEX "escrows_wdkAccountPath_key";
--   ALTER TABLE "escrows" DROP COLUMN "wdkAccountPath", DROP COLUMN "wdkAccountScheme";
--   DROP TYPE "WdkAccountScheme"; DROP SEQUENCE "wdk_escrow_account_index_seq";

-- --- preflight (read-only; session-local helper) --------------------------------

-- Byte-for-byte the historical escrowIndexFor(): first 4 bytes of sha256(utf8(tradeId)) as an
-- unsigned 32-bit big-endian integer, modulo 2^31-1.
CREATE FUNCTION pg_temp.sails_wdk_legacy_index(trade_id text) RETURNS bigint AS $$
  SELECT ('x' || encode(substring(sha256(convert_to(trade_id, 'UTF8')) from 1 for 4), 'hex'))::bit(32)::bigint % 2147483647
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
  shared text;
  treasury text;
BEGIN
  SELECT string_agg(i || ': ' || ids, '; ') INTO shared FROM (
    SELECT pg_temp.sails_wdk_legacy_index("tradeId") AS i, string_agg(id, ',' ORDER BY id) AS ids
    FROM "escrows" WHERE "type" = 'WDK_USDT_EVM'
    GROUP BY 1 HAVING count(*) > 1) d;
  IF shared IS NOT NULL THEN
    RAISE EXCEPTION 'R7G-F6A-1 preflight: WDK escrows share one legacy account (index: escrow ids) - manual review required, nothing changed: %', shared;
  END IF;
  SELECT string_agg(id, ',') INTO treasury FROM "escrows"
  WHERE "type" = 'WDK_USDT_EVM' AND pg_temp.sails_wdk_legacy_index("tradeId") = 0;
  IF treasury IS NOT NULL THEN
    RAISE EXCEPTION 'R7G-F6A-1 preflight: WDK escrows whose legacy account is the treasury (index 0) - manual review required, nothing changed: %', treasury;
  END IF;
END $$;

-- --- schema ------------------------------------------------------------------------

CREATE TYPE "WdkAccountScheme" AS ENUM ('LEGACY_TRADE_HASH_V0', 'ALLOCATED_V1');

ALTER TABLE "escrows" ADD COLUMN "wdkAccountScheme" "WdkAccountScheme", ADD COLUMN "wdkAccountPath" TEXT;

-- Legacy authority persisted exactly as it was derived; no other column is touched.
UPDATE "escrows"
SET "wdkAccountScheme" = 'LEGACY_TRADE_HASH_V0', "wdkAccountPath" = '0''/0/' || pg_temp.sails_wdk_legacy_index("tradeId")
WHERE "type" = 'WDK_USDT_EVM';

CREATE UNIQUE INDEX "escrows_wdkAccountPath_key" ON "escrows"("wdkAccountPath");

ALTER TABLE "escrows" ADD CONSTRAINT "escrows_wdk_account_identity_check" CHECK (
  (("type" = 'WDK_USDT_EVM') = ("wdkAccountPath" IS NOT NULL))
  AND (("wdkAccountPath" IS NULL) = ("wdkAccountScheme" IS NULL))
  AND (
    "wdkAccountPath" IS NULL
    OR ("wdkAccountScheme" = 'LEGACY_TRADE_HASH_V0' AND "wdkAccountPath" ~ '^0''/0/[1-9][0-9]{0,9}$')
    OR ("wdkAccountScheme" = 'ALLOCATED_V1' AND "wdkAccountPath" ~ '^1''/0/(0|[1-9][0-9]{0,9})$')
  )
  AND ("wdkAccountPath" IS NULL OR split_part("wdkAccountPath", '/', 3)::bigint <= 2147483647)
);

CREATE SEQUENCE "wdk_escrow_account_index_seq" AS bigint MINVALUE 0 MAXVALUE 2147483647 START WITH 0 NO CYCLE;

CREATE OR REPLACE FUNCTION escrows_enforce_wdk_account_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."wdkAccountPath" IS NOT NULL OR NEW."wdkAccountScheme" IS NOT NULL THEN
      RAISE EXCEPTION 'escrows: a WDK account identity is allocated by the database only (id=%)', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."type" = 'WDK_USDT_EVM' THEN
      NEW."wdkAccountScheme" := 'ALLOCATED_V1';
      NEW."wdkAccountPath" := '1''/0/' || nextval('wdk_escrow_account_index_seq');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."wdkAccountPath" IS DISTINCT FROM OLD."wdkAccountPath" OR NEW."wdkAccountScheme" IS DISTINCT FROM OLD."wdkAccountScheme" THEN
    RAISE EXCEPTION 'escrows: the WDK account identity is immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."wdkAccountPath" IS NOT NULL AND (NEW.id IS DISTINCT FROM OLD.id OR NEW."tradeId" IS DISTINCT FROM OLD."tradeId" OR NEW."type" IS DISTINCT FROM OLD."type") THEN
    RAISE EXCEPTION 'escrows: the escrow bound to a WDK account identity cannot change id, tradeId or type (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_wdk_account_identity_guard
  BEFORE INSERT OR UPDATE ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION escrows_enforce_wdk_account_identity();
