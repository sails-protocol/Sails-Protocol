-- One committed MULTISIG address per escrow (CTO 25, funding binding). Two escrows whose participants submitted the same
-- keys (with the same arbiter) derive the same 2-of-3 P2WSH address, and then no UTXO there can be attributed to either
-- of them. escrow.service.ts submitParticipantKey() maps a violation to 409 MULTISIG_ADDRESS_ALREADY_COMMITTED; this
-- index, not that code path, is what settles two concurrent commits.
--
-- Partial: MULTISIG rows only (other escrow types may store a non-unique placeholder in this column), NULL excluded.
-- Not representable in schema.prisma (partial index), same as fee_policy_versions_single_published_per_rail_key.
--
-- Fails with the duplicated addresses listed, instead of a bare unique violation, when a database already holds two
-- MULTISIG escrows on one address (possible in development/test databases). Nothing is altered or removed here: such
-- rows need a decision, not a silent fix.
--
-- Reversal (not applied automatically):
--   DROP INDEX "escrows_multisig_addr_key";
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg("multisigAddr" || ' x' || n, ', ') INTO dup FROM (
    SELECT "multisigAddr", count(*) AS n FROM "escrows"
    WHERE "type" = 'MULTISIG' AND "multisigAddr" IS NOT NULL
    GROUP BY "multisigAddr" HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'escrows_multisig_addr_key: MULTISIG escrows already share an address: %', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "escrows_multisig_addr_key" ON "escrows"("multisigAddr")
WHERE "type" = 'MULTISIG' AND "multisigAddr" IS NOT NULL;
