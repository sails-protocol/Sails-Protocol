-- #235 R7G F8A — MULTISIG_RESIDUAL_VALUE_RECOVERY_V1 and the minimal F8 status guard.
--
-- Value that reaches a MULTISIG escrow's original 2-of-3 script but is not (or can no longer be) that escrow's
-- canonical funding outpoint stays under the authority of the escrow's two original participants. It is recovered
-- through one EscrowResidualRecovery per outpoint: the unsigned PSBT (outpoint, value, script, destination, fee) is
-- frozen before anyone signs, both the buyer's and the seller's signatures are required, and the server never signs.
--
-- The database guarantees, independently of the service:
--   * one live recovery per residual outpoint (partial unique index);
--   * a canonical funding outpoint is never claimed as residual, and an outpoint claimed by a live recovery never
--     becomes canonical funding (both directions, serialized on the escrow row);
--   * a recovery is bound to its escrow's persisted funding address, which no other escrow shares;
--   * the intent (escrow, address, outpoint, value, destination, fee, unsigned PSBT, proposer) never changes;
--     signatures, the final transaction and the confirmation evidence are write-once; rows are never deleted;
--   * status moves only forward: PROPOSED -> SIGNED -> SUBMITTED -> CONFIRMED, or PROPOSED -> CANCELLED while not
--     both participants have signed.
-- And the minimal F8 status guard (MULTISIG_TERMINATION_AUTHORITY_V1, the forged-state part):
--   * a MULTISIG escrow never holds PAYMENT_PENDING / DISPUTED / EXPIRED / COMPLETED / REFUNDED / SPLIT without its
--     canonical funding outpoint (txLockId) — no economic state without funding authority;
--   * a trade whose MULTISIG / LIGHTNING_HODL escrow already has a funding address is CANCELLED only through its
--     escrow's REFUNDED projection (R7G-B1: a fundable surface is never manually cancelled).

-- CreateEnum
CREATE TYPE "EscrowResidualRecoveryStatus" AS ENUM ('PROPOSED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "escrow_residual_recoveries" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "fundingAddress" TEXT NOT NULL,
    "outpointTxid" TEXT NOT NULL,
    "outpointVout" INTEGER NOT NULL,
    "valueSats" BIGINT NOT NULL,
    "destination" TEXT NOT NULL,
    "feeSats" BIGINT NOT NULL,
    "unsignedPsbtBase64" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "status" "EscrowResidualRecoveryStatus" NOT NULL DEFAULT 'PROPOSED',
    "buyerSignedPsbtBase64" TEXT,
    "buyerSignedAt" TIMESTAMP(3),
    "sellerSignedPsbtBase64" TEXT,
    "sellerSignedAt" TIMESTAMP(3),
    "signedTxHex" TEXT,
    "txid" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedBlockHeight" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrow_residual_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "escrow_residual_recoveries_txid_key" ON "escrow_residual_recoveries"("txid");

-- CreateIndex
CREATE INDEX "escrow_residual_recoveries_escrowId_idx" ON "escrow_residual_recoveries"("escrowId");

-- CreateIndex
CREATE INDEX "escrow_residual_recoveries_status_idx" ON "escrow_residual_recoveries"("status");

-- AddForeignKey
ALTER TABLE "escrow_residual_recoveries" ADD CONSTRAINT "escrow_residual_recoveries_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "escrows"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One live recovery per residual outpoint.
CREATE UNIQUE INDEX "escrow_residual_recoveries_live_outpoint_key" ON "escrow_residual_recoveries"("outpointTxid", "outpointVout") WHERE "status" <> 'CANCELLED';

ALTER TABLE "escrow_residual_recoveries" ADD CONSTRAINT "escrow_residual_recoveries_shape_check" CHECK (
  "outpointTxid" ~ '^[0-9a-f]{64}$' AND "outpointVout" >= 0 AND "valueSats" > 0 AND "feeSats" > 0 AND "feeSats" < "valueSats"
  AND ("txid" IS NULL OR "txid" ~ '^[0-9a-f]{64}$')
  AND (("buyerSignedPsbtBase64" IS NULL) = ("buyerSignedAt" IS NULL))
  AND (("sellerSignedPsbtBase64" IS NULL) = ("sellerSignedAt" IS NULL))
  AND ("status" NOT IN ('SIGNED', 'SUBMITTED', 'CONFIRMED') OR (
        "buyerSignedPsbtBase64" IS NOT NULL AND "sellerSignedPsbtBase64" IS NOT NULL AND "signedTxHex" IS NOT NULL AND "txid" IS NOT NULL))
  AND ("status" NOT IN ('SUBMITTED', 'CONFIRMED') OR "submittedAt" IS NOT NULL OR "status" = 'CONFIRMED')
  AND (("status" = 'CONFIRMED') = ("confirmedAt" IS NOT NULL)) AND (("confirmedAt" IS NULL) = ("confirmedBlockHeight" IS NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND (("cancelledAt" IS NULL) = ("cancelledBy" IS NULL))
  AND ("status" <> 'CANCELLED' OR "buyerSignedPsbtBase64" IS NULL OR "sellerSignedPsbtBase64" IS NULL)
  AND ("status" <> 'PROPOSED' OR ("signedTxHex" IS NULL AND "txid" IS NULL))
);

CREATE OR REPLACE FUNCTION escrow_residual_recoveries_guard() RETURNS trigger AS $$
DECLARE
  esc RECORD;
  shared INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'escrow_residual_recoveries: a residual recovery cannot be deleted (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'PROPOSED' OR NEW."buyerSignedPsbtBase64" IS NOT NULL OR NEW."sellerSignedPsbtBase64" IS NOT NULL THEN
      RAISE EXCEPTION 'escrow_residual_recoveries: a recovery starts PROPOSED with no signature' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- serialized with funding recognition, which updates this same escrow row
    SELECT id, type::text AS type, "multisigAddr", "txLockId", "txLockVout" INTO esc FROM escrows WHERE id = NEW."escrowId" FOR UPDATE;
    IF esc.id IS NULL OR esc.type <> 'MULTISIG' OR esc."multisigAddr" IS NULL OR esc."multisigAddr" <> NEW."fundingAddress" THEN
      RAISE EXCEPTION 'escrow_residual_recoveries: a recovery is bound to its MULTISIG escrow''s persisted funding address (escrow %)', NEW."escrowId" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT count(*) INTO shared FROM escrows WHERE "multisigAddr" = NEW."fundingAddress" AND id <> NEW."escrowId";
    IF shared > 0 THEN
      RAISE EXCEPTION 'escrow_residual_recoveries: funding address % is shared by another escrow — residual ownership is ambiguous', NEW."fundingAddress" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM escrows WHERE "txLockId" = NEW."outpointTxid" AND ("txLockVout" IS NULL OR "txLockVout" = NEW."outpointVout")) THEN
      RAISE EXCEPTION 'escrow_residual_recoveries: %:% is a canonical funding outpoint, not residual value', NEW."outpointTxid", NEW."outpointVout" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the intent is frozen
  IF (NEW."escrowId", NEW."fundingAddress", NEW."outpointTxid", NEW."outpointVout", NEW."valueSats", NEW."destination", NEW."feeSats",
      NEW."unsignedPsbtBase64", NEW."proposedBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."escrowId", OLD."fundingAddress", OLD."outpointTxid", OLD."outpointVout", OLD."valueSats", OLD."destination", OLD."feeSats",
      OLD."unsignedPsbtBase64", OLD."proposedBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'escrow_residual_recoveries: a recovery intent (outpoint, value, destination, fee, PSBT) is immutable (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- evidence is write-once
  IF (OLD."buyerSignedPsbtBase64" IS NOT NULL AND (NEW."buyerSignedPsbtBase64", NEW."buyerSignedAt") IS DISTINCT FROM (OLD."buyerSignedPsbtBase64", OLD."buyerSignedAt"))
     OR (OLD."sellerSignedPsbtBase64" IS NOT NULL AND (NEW."sellerSignedPsbtBase64", NEW."sellerSignedAt") IS DISTINCT FROM (OLD."sellerSignedPsbtBase64", OLD."sellerSignedAt"))
     OR (OLD."txid" IS NOT NULL AND (NEW."txid", NEW."signedTxHex") IS DISTINCT FROM (OLD."txid", OLD."signedTxHex"))
     OR (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
     OR (OLD."confirmedAt" IS NOT NULL AND (NEW."confirmedAt", NEW."confirmedBlockHeight") IS DISTINCT FROM (OLD."confirmedAt", OLD."confirmedBlockHeight"))
     OR (OLD."cancelledAt" IS NOT NULL AND (NEW."cancelledAt", NEW."cancelledBy") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledBy")) THEN
    RAISE EXCEPTION 'escrow_residual_recoveries: signatures, the signed transaction and its evidence are write-once (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- no signature lands on a recovery that is no longer PROPOSED
  IF OLD."status"::text <> 'PROPOSED' AND ((OLD."buyerSignedPsbtBase64" IS NULL AND NEW."buyerSignedPsbtBase64" IS NOT NULL)
     OR (OLD."sellerSignedPsbtBase64" IS NULL AND NEW."sellerSignedPsbtBase64" IS NOT NULL)) THEN
    RAISE EXCEPTION 'escrow_residual_recoveries: a % recovery takes no new signature (id=%)', OLD."status", OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status"::text = 'PROPOSED' AND NEW."status"::text IN ('SIGNED', 'CANCELLED'))
    OR (OLD."status"::text = 'SIGNED' AND NEW."status"::text IN ('SUBMITTED', 'CONFIRMED'))
    OR (OLD."status"::text = 'SUBMITTED' AND NEW."status"::text = 'CONFIRMED')
  ) THEN
    RAISE EXCEPTION 'escrow_residual_recoveries: % -> % is not a recovery transition (id=%)', OLD."status", NEW."status", OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrow_residual_recoveries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "escrow_residual_recoveries"
  FOR EACH ROW EXECUTE FUNCTION escrow_residual_recoveries_guard();

-- Funding recognition never claims an outpoint a live recovery owns (the other direction of the exclusion).
CREATE OR REPLACE FUNCTION escrows_canonical_outpoint_not_residual() RETURNS trigger AS $$
BEGIN
  IF NEW."txLockId" IS NOT NULL AND (NEW."txLockId", NEW."txLockVout") IS DISTINCT FROM (OLD."txLockId", OLD."txLockVout")
     AND EXISTS (SELECT 1 FROM escrow_residual_recoveries r WHERE r."status"::text <> 'CANCELLED'
                 AND r."outpointTxid" = NEW."txLockId" AND (NEW."txLockVout" IS NULL OR r."outpointVout" = NEW."txLockVout")) THEN
    RAISE EXCEPTION 'escrows: %:% is claimed by a live residual recovery — it cannot become canonical funding (escrow %)', NEW."txLockId", NEW."txLockVout", NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_canonical_outpoint_not_residual_guard
  BEFORE UPDATE OF "txLockId", "txLockVout" ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION escrows_canonical_outpoint_not_residual();

-- Minimal F8 status guard: no MULTISIG economic state past FUNDS_LOCKED without the canonical funding outpoint.
-- (FUNDS_LOCKED itself is claimed before the outpoint is written and reverted on failure — escrow.service.ts.)
CREATE OR REPLACE FUNCTION escrows_multisig_state_requires_funding() RETURNS trigger AS $$
BEGIN
  IF NEW.type::text = 'MULTISIG' AND NEW."status"::text NOT IN ('CREATED', 'FUNDS_LOCKED') AND NEW."txLockId" IS NULL THEN
    RAISE EXCEPTION 'escrows: MULTISIG escrow % cannot be % without its canonical funding outpoint (txLockId)', NEW.id, NEW."status"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_multisig_state_requires_funding_guard
  BEFORE INSERT OR UPDATE OF "status", "txLockId", "type" ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION escrows_multisig_state_requires_funding();

-- R7G-B1 at the database: a trade whose MULTISIG / LIGHTNING_HODL escrow has a funding address is CANCELLED only
-- through its escrow's REFUNDED projection.
CREATE OR REPLACE FUNCTION trades_fundable_escrow_not_cancelled() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'CANCELLED' AND OLD."status"::text <> 'CANCELLED'
     AND EXISTS (SELECT 1 FROM escrows e WHERE e."tradeId" = NEW.id AND e.type::text IN ('MULTISIG', 'LIGHTNING_HODL')
                 AND e."multisigAddr" IS NOT NULL AND e."status"::text <> 'REFUNDED') THEN
    RAISE EXCEPTION 'trades: trade % has an escrow funding address that may hold funds — it is never cancelled manually', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_fundable_escrow_not_cancelled_guard
  BEFORE UPDATE OF "status" ON "trades"
  FOR EACH ROW EXECUTE FUNCTION trades_fundable_escrow_not_cancelled();
