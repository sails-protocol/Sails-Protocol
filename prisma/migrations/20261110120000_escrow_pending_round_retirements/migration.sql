-- Issue #239 - append-only record of a retired cooperative MULTISIG signing round (seller cancellation or
-- supersession by a valid ruling). Retired, not revoked: signatures already handed out stay valid for exactly
-- this transaction until the funding outpoint is spent by another one. The live round is deleted in the SAME
-- transaction that inserts this row (escrow-pending-tx.ts), so the row is deliberately not a child of
-- escrow_pending_transactions. Additive: no existing table or row is touched, nothing is back-filled.
--
-- Reversal (not applied automatically; drop the guards first, they also block TRUNCATE):
--   DROP TRIGGER escrow_pending_round_retirements_truncate_guard ON "escrow_pending_round_retirements";
--   DROP TRIGGER escrow_pending_round_retirements_immutability_guard ON "escrow_pending_round_retirements";
--   DROP FUNCTION escrow_pending_round_retirements_refuse_mutation();
--   DROP TABLE "escrow_pending_round_retirements";

CREATE TABLE "escrow_pending_round_retirements" (
    "id" TEXT NOT NULL,
    "pendingOperationId" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unsignedTxid" TEXT NOT NULL,
    "fundingTxid" TEXT NOT NULL,
    "fundingVout" INTEGER NOT NULL,
    "outpointCheckedAt" TIMESTAMP(3) NOT NULL,
    "operationDigest" TEXT NOT NULL,
    "requiredSigners" TEXT[],
    "signedBy" TEXT[],
    "signatureSetDigest" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "retiredBy" TEXT NOT NULL,
    "disputeId" TEXT,
    "appealRound" INTEGER,
    "supersedingPendingOperationId" TEXT,
    "prevRecordHash" TEXT NOT NULL,
    "recordHash" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_pending_round_retirements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "escrow_pending_round_retirements_kind_check" CHECK ("kind" IN ('release', 'refund', 'split')),
    CONSTRAINT "escrow_pending_round_retirements_reason_check" CHECK ("reason" IN ('CANCELLED', 'SUPERSEDED_BY_RULING')),
    CONSTRAINT "escrow_pending_round_retirements_hex_check" CHECK (
        "unsignedTxid" ~ '^[0-9a-f]{64}$'
        AND "fundingTxid" ~ '^[0-9a-f]{64}$'
        AND "operationDigest" ~ '^[0-9a-f]{64}$'
        AND "signatureSetDigest" ~ '^[0-9a-f]{64}$'
        AND "recordHash" ~ '^[0-9a-f]{64}$'
        AND ("prevRecordHash" = 'genesis' OR "prevRecordHash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "escrow_pending_round_retirements_vout_check" CHECK ("fundingVout" >= 0),
    -- A fully signed round is never retired (it may already have executed): impossible by construction.
    CONSTRAINT "escrow_pending_round_retirements_signers_check" CHECK (
        "requiredSigners" IS NOT NULL
        AND "signedBy" IS NOT NULL
        AND cardinality("requiredSigners") >= 1
        AND "signedBy" <@ "requiredSigners"
        AND cardinality("signedBy") < cardinality("requiredSigners")
    ),
    CONSTRAINT "escrow_pending_round_retirements_reason_coherence_check" CHECK (
        ("reason" = 'CANCELLED' AND "disputeId" IS NULL AND "appealRound" IS NULL AND "supersedingPendingOperationId" IS NULL)
        OR ("reason" = 'SUPERSEDED_BY_RULING' AND "disputeId" IS NOT NULL AND "appealRound" IS NOT NULL AND "supersedingPendingOperationId" IS NOT NULL)
    ),
    CONSTRAINT "escrow_pending_round_retirements_superseding_check" CHECK ("supersedingPendingOperationId" IS DISTINCT FROM "pendingOperationId")
);

CREATE UNIQUE INDEX "escrow_pending_round_retirements_pendingOperationId_key" ON "escrow_pending_round_retirements"("pendingOperationId");
CREATE UNIQUE INDEX "escrow_pending_round_retirements_recordHash_key" ON "escrow_pending_round_retirements"("recordHash");
CREATE INDEX "escrow_pending_round_retirements_escrowId_retiredAt_idx" ON "escrow_pending_round_retirements"("escrowId", "retiredAt");
CREATE INDEX "escrow_pending_round_retirements_unsignedTxid_idx" ON "escrow_pending_round_retirements"("unsignedTxid");

ALTER TABLE "escrow_pending_round_retirements" ADD CONSTRAINT "escrow_pending_round_retirements_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "escrows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "escrow_pending_round_retirements" ADD CONSTRAINT "escrow_pending_round_retirements_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: same DB-native model as escrow_participant_keys_enforce_arbiter_immutability() (20260822222605).
CREATE OR REPLACE FUNCTION escrow_pending_round_retirements_refuse_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'escrow_pending_round_retirements: retirement records are append-only (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrow_pending_round_retirements_immutability_guard
BEFORE UPDATE OR DELETE ON "escrow_pending_round_retirements"
FOR EACH ROW
EXECUTE FUNCTION escrow_pending_round_retirements_refuse_mutation();

CREATE TRIGGER escrow_pending_round_retirements_truncate_guard
BEFORE TRUNCATE ON "escrow_pending_round_retirements"
FOR EACH STATEMENT
EXECUTE FUNCTION escrow_pending_round_retirements_refuse_mutation();
