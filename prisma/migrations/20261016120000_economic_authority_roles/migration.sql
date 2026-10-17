-- #235 R7H-E2 — database writer-role separation for economic authority.
--
-- Two group roles (NOLOGIN; operators create login users and grant membership, never a password here):
--
--   sails_app              the application's runtime credential. Full DML on the application's tables, except the
--                          economic authority evidence: it reads valuation quotes, observations and policy rows but
--                          can never write them, and it may only insert (never rewrite) exposure reservations.
--   sails_quote_collector  the price collector's credential: reads the policy in force, inserts quotes and
--                          observations, and nothing else.
--
-- Migrations keep running as the schema owner (docs/DEPLOYMENT.md). A deployment whose application still connects
-- as the owner is not separated: the application logs that at startup (app.ts) until DATABASE_URL is switched to a
-- sails_app member. Neither role owns any table, so neither can disable a trigger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_app') THEN
    CREATE ROLE sails_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_quote_collector') THEN
    CREATE ROLE sails_quote_collector NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sails_app, sails_quote_collector;

-- Application: every table and sequence, now and in later migrations (default privileges of the migrating role).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sails_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sails_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sails_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sails_app;

-- ... except economic authority evidence, and migration history.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  "valuation_quotes", "price_observations",
  "trade_limit_policy_versions", "trade_limit_rail_policies", "trade_limit_method_policies",
  "_prisma_migrations"
FROM sails_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "exposure_reservations" FROM sails_app;
REVOKE ALL ON
  "valuation_quotes", "price_observations", "exposure_reservations",
  "trade_limit_policy_versions", "trade_limit_rail_policies", "trade_limit_method_policies"
FROM PUBLIC;

-- Collector: what publishing needs (the insert and completeness triggers read the policy rows), nothing more.
GRANT SELECT ON "trade_limit_policy_versions", "trade_limit_rail_policies", "valuation_quotes", "price_observations" TO sails_quote_collector;
GRANT INSERT ON "valuation_quotes", "price_observations" TO sails_quote_collector;
