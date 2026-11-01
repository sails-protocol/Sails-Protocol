-- #239D (R3) - signature confidentiality, complete bilateral intent, MOOT disputes.

-- A dispute that ceased to be actionable because a prior authoritative economic disposition became final
-- without an arbitral ruling deciding it. Terminal; never a ruling, winner, appeal or auto-resolution.
ALTER TYPE "DisputeStatus" ADD VALUE 'MOOT';
ALTER TABLE "disputes"
  ADD COLUMN "mootedAt" TIMESTAMP(3),
  -- The escrow's terminal transition (escrow_events.id) whose disposition made the dispute moot.
  ADD COLUMN "mootedByTransitionId" TEXT;

-- X1: a round whose counterparty signatures Sails never returned to anyone while it was incomplete.
-- Every round that already exists was readable under the old contract, so it is backfilled as NOT
-- confidential (potentially exposed); only rounds created from now on default to confidential.
ALTER TABLE "escrow_pending_transactions" ADD COLUMN "signaturesConfidential" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "escrow_pending_transactions" ALTER COLUMN "signaturesConfidential" SET DEFAULT true;

-- D1/H1: set, under the escrow lock, when the signature completing a cooperative round is accepted while
-- no dispute exists for the escrow - the durable proof that bilateral authority was complete BEFORE any
-- dispute (opening a dispute takes the same lock). Null for every round completed otherwise or before this.
ALTER TABLE "escrow_pending_transactions" ADD COLUMN "bilateralAuthorityAt" TIMESTAMP(3);
