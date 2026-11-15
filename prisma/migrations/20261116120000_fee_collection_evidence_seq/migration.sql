-- CTO 239 - deterministic "latest evidence" for fee collection.
--
-- recordedAt is timestamp(3) DEFAULT now(); two evidence rows of one obligation (e.g. BROADCAST then DROPPED)
-- often share a millisecond, so ORDER BY "recordedAt" DESC LIMIT 1 picked either row. "seq" is an
-- insertion-order tie-break: every reader orders by ("recordedAt", "seq"). recordedAt keeps its meaning and
-- stays the primary key of the order; seq only decides exact ties.
--
-- Additive only. ADD COLUMN with a volatile default rewrites the table under ACCESS EXCLUSIVE (small table)
-- and does not fire row triggers: the existing BEFORE UPDATE guard
-- fee_collection_evidence_distribution_policy_immutability_guard is neither fired nor changed. Existing rows
-- get values in physical order; for historical same-millisecond ties that order is arbitrary but is now fixed.
--
-- Reversal (not applied automatically): ALTER TABLE "fee_collection_evidence" DROP COLUMN "seq";

ALTER TABLE "fee_collection_evidence" ADD COLUMN     "seq" SERIAL NOT NULL;
