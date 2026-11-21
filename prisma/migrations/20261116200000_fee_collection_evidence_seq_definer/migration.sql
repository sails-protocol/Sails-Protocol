-- CTO 295/296/316 - the runtime role cannot draw fee_collection_evidence."seq" itself (forward-only follow-up to
-- 20261116120000_fee_collection_evidence_seq, which stays byte-identical so databases that already applied it keep
-- a valid checksum).
--
-- Problem: 20261116120000's BEFORE INSERT trigger draws seq with the inserter's privileges, so sails_runtime needs
-- USAGE on fee_collection_evidence_seq_seq, and with it can call nextval() in a loop and exhaust the int4 range
-- (every later fee evidence insert then fails: an availability attack; ordering itself stays database-assigned).
--
-- Change: only the trigger draws values.
--   * fee_collection_evidence_assign_seq() becomes SECURITY DEFINER: it runs with its owner's privileges (the role
--     that runs migrations: sails_migrator, which already owns every object, so this grants nothing new).
--     search_path is pinned to pg_catalog, pg_temp and every object is schema-qualified, so a caller cannot
--     substitute a function, sequence or cast. The body only assigns NEW."seq"; no dynamic SQL, no caller input
--     besides the row. EXECUTE is revoked from PUBLIC (a trigger function cannot be called directly anyway; triggers
--     fire regardless of EXECUTE).
--   * The column DEFAULT becomes the constant 0: a nextval() DEFAULT is evaluated with the inserter's privileges
--     before the trigger runs, so it would refuse the runtime's insert. 0 never reaches a row (the trigger replaces
--     it). Prisma: @default(0). Each insert now consumes one value (it consumed two).
--   * scripts/db/runtime-grants.sql revokes the runtime's privileges on fee_collection_evidence_seq_seq after its
--     "ON ALL SEQUENCES" grant (applied by the grant step right after this migration).
--
-- Writer description, corrected (D1, CTO 278/294; 20261116120000's header is left unchanged on purpose):
--   serialized per obligation (row-lock CAS on fee_obligations.collectionStatus, same transaction): BROADCAST,
--   CONFIRMED, and REORGED_OUT from COLLECTED (claim COLLECTED -> IN_PROGRESS, then the txid must still be the latest
--   CONFIRMED, then insert, one transaction). Not serialized: REPLACED and DROPPED, bare autocommit inserts, and
--   REORGED_OUT from any other status (one transaction with the same latest-CONFIRMED txid check, but no claim, so no
--   obligation row lock).
--
-- Effect on existing data: none. No row is read or written; seq values and the sequence position are unchanged.
-- Locks: ALTER COLUMN ... SET DEFAULT takes ACCESS EXCLUSIVE on fee_collection_evidence briefly (catalog-only, no
-- table rewrite); CREATE OR REPLACE FUNCTION and the REVOKEs take catalog locks only.
--
-- Reversal (not applied automatically): restore the 20261116120000 function body (SECURITY INVOKER, unqualified
-- nextval), ALTER COLUMN "seq" SET DEFAULT nextval('fee_collection_evidence_seq_seq'), and remove the REVOKE line from
-- scripts/db/runtime-grants.sql so the grant step gives the runtime USAGE on the sequence again.

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
