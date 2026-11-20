-- F4a / invariant 3b (CTO Despacho 030, gate 3): the environment marker table, split from the F4 escrow cut so it lands first.
--
-- INERT ON ITS OWN: nothing reads this table until the F4b migration (20261122122000_f4_escrow_commitment_binding) creates
-- escrows_f4_pair_required(), which consults it to decide whether MOCK is exempt. The production boot check
-- (src/common/database/deployment-mode.ts) refuses to start when the row exists.
--
-- Reversal (not applied automatically):
--   DROP TABLE "deployment_mode";
--   (reverse F4b first: its function escrows_f4_pair_required() references this table)

-- THE EXEMPTION IS ENVIRONMENT-BOUND IN THE DATABASE (CTO Despacho 030, gate 3; GK): MOCK is exempt ONLY while the table
-- deployment_mode has its single row (development or test). The migration inserts NOTHING, so a database with no row is PRODUCTION
-- and MOCK needs a COMMITTED pair there like every other type. There is no 'production' value to set: production is the absence.
-- Only the database admin can insert the row (the runtime role has SELECT only, see scripts/db/runtime-grants.sql), and the production
-- boot check refuses to start if the row exists (src/common/database/deployment-mode.ts). Risk, documented: an admin inserting 'test'
-- in production is a trusted, audited action (created_by = current_user), not something the application can do.
CREATE TABLE "deployment_mode" (
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "mode" TEXT NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT current_user,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "deployment_mode_pkey" PRIMARY KEY ("singleton"),
    CONSTRAINT "deployment_mode_singleton_check" CHECK ("singleton"),
    CONSTRAINT "deployment_mode_mode_check" CHECK ("mode" IN ('development', 'test'))
);
