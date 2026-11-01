-- #309 — QVAC evidence-generation binding (restacked from PR #357 onto #367's atomic append).
-- Every accepted evidence append increments this in the same statement that appends the entry, so a
-- QVAC assessment can be bound to the exact evidence snapshot it read. Existing disputes start at
-- generation 0; no historical evidence entry is reinterpreted.
ALTER TABLE "disputes"
  ADD COLUMN "evidenceGeneration" INTEGER NOT NULL DEFAULT 0;
