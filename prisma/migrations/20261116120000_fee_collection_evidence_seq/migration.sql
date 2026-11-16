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
--     CONFIRMED rows still follow the serialized order) and REORGED_OUT from COLLECTED (recordReorgAndRevert,
--     CTO 261: claim COLLECTED -> IN_PROGRESS, then the txid must still be the latest CONFIRMED, then insert,
--     one transaction). Not serialized: REPLACED (recordReplacement) and DROPPED (recordDropped), bare
--     autocommit inserts, and REORGED_OUT from any other status (one transaction with the same latest-CONFIRMED
--     txid check, but no claim, so no obligation row lock); for them seq is insertion order, and two
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
--   DROP TRIGGER fee_collection_evidence_seq_assign ON "fee_collection_evidence";
--   DROP FUNCTION fee_collection_evidence_assign_seq();
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

-- CTO 255 G3 / CTO 261: "seq" is assigned by the database on every INSERT, whatever the client sent, so no role
-- (sails_runtime included) can choose its row's position: an explicit value (huge, duplicate, negative) is replaced.
--
-- CTO 295/296: the runtime has no privilege on the sequence, so it cannot call nextval() itself and exhaust the
-- int4 range (an availability attack). Only this trigger draws values:
--   * SECURITY DEFINER: runs with its owner's privileges (the role that ran the migration: sails_migrator, which
--     already owns every object, so this grants nothing new). search_path is pinned to pg_catalog, pg_temp and
--     every object is schema-qualified, so a caller cannot substitute a function or sequence. The body only
--     draws nextval and takes no caller input besides NEW. EXECUTE is revoked from PUBLIC (a trigger function
--     cannot be called directly anyway; triggers fire regardless of EXECUTE).
--   * The column DEFAULT becomes the constant 0: a nextval() DEFAULT is evaluated with the inserter's privileges
--     before the trigger runs, so it would refuse the runtime's insert. 0 never reaches a row (the trigger replaces
--     it). Prisma: @default(0). The SERIAL above still assigned the historical rows in physical order first.
--   * scripts/db/runtime-grants.sql revokes the runtime's privileges on this sequence after its
--     "ON ALL SEQUENCES" grant.
-- Each insert now consumes one value.
ALTER TABLE "fee_collection_evidence" ALTER COLUMN "seq" SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.fee_collection_evidence_assign_seq()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."seq" := pg_catalog.nextval('public.fee_collection_evidence_seq_seq'::pg_catalog.regclass);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fee_collection_evidence_assign_seq() FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.fee_collection_evidence_seq_seq FROM PUBLIC;

CREATE TRIGGER fee_collection_evidence_seq_assign
BEFORE INSERT ON "fee_collection_evidence"
FOR EACH ROW
EXECUTE FUNCTION fee_collection_evidence_assign_seq();
