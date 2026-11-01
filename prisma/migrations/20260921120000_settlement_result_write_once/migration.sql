-- Issue #291 - settlement result (provider evidence) is mechanically write-once.
--
-- The application-level compare-and-set in escrow-repository.ts
-- (persistSettlementResult) is the primary guard, but any writer that
-- bypasses it (a future code path, a manual UPDATE, a stale worker using a
-- different client) must still be unable to replace settlement evidence that
-- has already converged. This trigger is the final, database-level backstop.
--
-- Scope is deliberately only txReleaseId and releasedAt: every other Escrow
-- column is legitimately mutated throughout its lifecycle. NULL -> value is
-- allowed; value -> the same value is allowed (idempotent); value -> a
-- different value (including back to NULL) is rejected. Mirrors
-- escrows_enforce_fee_snapshot_immutability() (same table, same pattern).
--
-- Reversal (not applied automatically):
--   DROP TRIGGER escrows_settlement_result_write_once_guard ON "escrows";
--   DROP FUNCTION escrows_enforce_settlement_result_write_once();
CREATE OR REPLACE FUNCTION escrows_enforce_settlement_result_write_once()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."txReleaseId" IS NOT NULL AND NEW."txReleaseId" IS DISTINCT FROM OLD."txReleaseId" THEN
    RAISE EXCEPTION 'escrows: settlement result txReleaseId is write-once (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'escrows: releasedAt is write-once (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_settlement_result_write_once_guard
BEFORE UPDATE ON "escrows"
FOR EACH ROW
EXECUTE FUNCTION escrows_enforce_settlement_result_write_once();
