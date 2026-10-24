-- P4 / Gate 3 (iii-a): durable evidence for the disputed re-creation guard (docs/p4-gate3-unknown-outcome-contract.md,
-- section 5). Additive and nullable: an authorization committed before this migration carries none of it and is treated
-- as unproven (the guard refuses to re-create a round over it), never back-filled by inference.
--   unsignedTxid                    the txid of the round's unsigned transaction (a segwit txid does not commit to witnesses),
--                                   so a lost round can still be asked about on the network
--   intentDigest                    hash of the ruling generation + disposition, WITHOUT pendingOperationId / PSBT / fees
--   supersededAt / ...ByPendingOperationId   the authorization was replaced by a re-created round, in one transaction
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "unsignedTxid" TEXT;
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "intentDigest" TEXT;
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "supersededByPendingOperationId" TEXT;

-- Pre-flight, abort on a hit, no automatic repair: the index below cannot be created over a dispute generation that
-- already has more than one authorization. Resolve such a row by hand (and record why) before applying.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "economic_disposition_authorizations"
    GROUP BY "escrowId", "disputeId", "appealRound" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'P4 (iii-a): a dispute generation already has more than one economic disposition authorization; resolve it manually before this migration'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;

-- At most one LIVE (not superseded) authorization per (escrow, dispute, appeal round).
CREATE UNIQUE INDEX "economic_disposition_one_live_per_generation"
  ON "economic_disposition_authorizations" ("escrowId", "disputeId", "appealRound")
  WHERE "supersededAt" IS NULL;

-- Reversal (data-free; not applied automatically):
--   DROP INDEX "economic_disposition_one_live_per_generation";
--   ALTER TABLE "economic_disposition_authorizations"
--     DROP COLUMN "supersededByPendingOperationId", DROP COLUMN "supersededAt",
--     DROP COLUMN "intentDigest", DROP COLUMN "unsignedTxid";
