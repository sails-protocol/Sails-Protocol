-- CTO 239 / 245 / 246 - deterministic "latest evidence" for fee collection.
--
-- Problem: readers took the latest evidence of an obligation by ORDER BY "recordedAt" DESC LIMIT 1.
--   * recordedAt is timestamp(3), so two rows of one obligation (e.g. BROADCAST then DROPPED) often share a
--     millisecond and the pick was arbitrary (CI run 43748566359).
--   * recordedAt is not commit order. A DB-default insert gets its transaction's start (now()); Prisma Client
--     fills @default(now()) itself, with the app server's clock when the query is built. A transaction that
--     begins first, waits for the obligation's row lock and inserts last therefore carries the SMALLER
--     recordedAt (CTO 246 lock-wait inversion), and a (recordedAt, seq) order still picks the wrong row.
--
-- Rule: latest = the greatest "seq" among COMMITTED rows. recordedAt is informational only.
--   * "seq" is nextval() at INSERT, not commit order. A rolled-back insert leaves a gap and changes nothing.
--   * A row committed later with a lower seq never becomes latest. A row with a higher seq that commits after a
--     read does become latest on the next read: readers answer "latest among rows committed now".
--   * Writers serialized per obligation (row-lock CAS on fee_obligations.collectionStatus, same transaction):
--     BROADCAST (recordBroadcastAndAdvance: claim PENDING_COLLECTION -> IN_PROGRESS, then insert, so seq is
--     taken after the lock) and CONFIRMED (recognizeConfirmation: insert, then claim IN_PROGRESS -> COLLECTED;
--     seq is taken BEFORE the lock, but only the claim winner commits and the loser rolls back, so committed
--     CONFIRMED rows still follow the serialized order). Not serialized (bare autocommit inserts): REPLACED
--     (recordReplacement), DROPPED (recordDropped), REORGED_OUT (recordReorgAndRevert, whose
--     COLLECTED -> IN_PROGRESS revert is a separate later statement); for them seq is insertion order, and two
--     concurrent ones may commit in the opposite order of their nextval.
--   * Sufficient for money: the only money-bearing reader, allocate(), reads CONFIRMED rows only, and a new
--     CONFIRMED generation needs the obligation back in IN_PROGRESS (REORGED_OUT + revert) before it is
--     written, so CONFIRMED rows of one obligation are causally ordered and seq order equals commit order.
--     The unserialized kinds feed detect-only reconciliation readers.
--
-- Historical rows (before this migration) keep the seq that ADD COLUMN assigns, in physical order (CTO 249: no
-- automatic renumbering, it could invent economic precedence). Historical order is NOT economic evidence: for
-- those rows the old recordedAt order and the new seq order can disagree on the latest row, and ties are
-- broken by physical order. docs/DEPLOYMENT.md section 6.5 has a read-only inventory of every obligation whose
-- latest-evidence decision depends on historical rows, and the operator handling (review, no rewrite).
--
-- Effect on existing data: ADD COLUMN with a volatile default rewrites the table under ACCESS EXCLUSIVE (small
-- table) and does not fire row triggers; the existing BEFORE UPDATE guard
-- fee_collection_evidence_distribution_policy_immutability_guard (20260823182951) is neither fired nor changed.
--
-- seq is write-once: the trigger below refuses any UPDATE that changes it (same two-layer immutability style as
-- fee_collection_evidence_enforce_distribution_policy_immutability()).
--
-- Reversal (not applied automatically):
--   DROP TRIGGER fee_collection_evidence_seq_immutability_guard ON "fee_collection_evidence";
--   DROP FUNCTION fee_collection_evidence_enforce_seq_immutability();
--   ALTER TABLE "fee_collection_evidence" DROP COLUMN "seq";

ALTER TABLE "fee_collection_evidence" ADD COLUMN     "seq" SERIAL NOT NULL;

CREATE OR REPLACE FUNCTION fee_collection_evidence_enforce_seq_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."seq" IS DISTINCT FROM OLD."seq" THEN
    RAISE EXCEPTION 'fee_collection_evidence: seq is immutable once a row is created (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_collection_evidence_seq_immutability_guard
BEFORE UPDATE ON "fee_collection_evidence"
FOR EACH ROW
EXECUTE FUNCTION fee_collection_evidence_enforce_seq_immutability();
