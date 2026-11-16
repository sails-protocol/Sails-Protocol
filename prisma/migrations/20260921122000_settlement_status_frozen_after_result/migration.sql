-- Issue #291 hardening - the economic disposition (status) is frozen once the
-- settlement result exists.
--
-- A terminal status WITHOUT a result is a legitimate transient claim (the
-- claim is reverted when the provider fails before moving funds). Once
-- txReleaseId is persisted the funds have moved: the disposition may no longer
-- be converted (COMPLETED -> REFUNDED, REFUNDED -> COMPLETED, ...), not even
-- by a direct UPDATE that bypasses the repository. Replaces the function body
-- of the write-once guard (same trigger).
--
-- Reversal (not applied automatically): re-apply the function body from
-- 20260921120000_settlement_result_write_once.
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
  IF OLD."txReleaseId" IS NOT NULL AND OLD.status IN ('COMPLETED', 'REFUNDED', 'SPLIT')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'escrows: status is frozen once the settlement result exists (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
