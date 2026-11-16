-- Runtime privilege matrix (CTO 221/225). Run as sails_migrator after every
-- `prisma migrate deploy` (scripts/migrate-deploy-safe.sh does it). Idempotent.
--
-- Every table in schema public has exactly one class below. The runtime role
-- (sails_runtime) gets only what its class allows; there are no default
-- privileges, so a table added by a new migration is unreachable by the
-- runtime until it is classified here, and this script refuses to run while
-- any table is unclassified (fail-closed). Classes:
--   read           SELECT                          (frozen by trigger)
--   append         SELECT, INSERT                  (append-only / write-once)
--   mutable        SELECT, INSERT, UPDATE          (column guards stay in triggers)
--   append_delete  SELECT, INSERT, DELETE          (rows written once, then retired)
--   mutable_delete SELECT, INSERT, UPDATE, DELETE  (none today)
-- TRUNCATE, REFERENCES, TRIGGER and any DDL are never granted. The class is
-- the least privilege the runtime code needs today (writes inventoried in
-- src/ on 2026-11-15); widening one is a reviewed change to this file.
-- A few append-only tables have a single column the runtime may set once; that
-- column alone gets UPDATE (runtime_column_update below), never the table.
-- The script fails if sails_runtime does not exist: scripts/migrate-deploy-safe.sh
-- only calls it once MIGRATION_DATABASE_URL marks the database as segregated.
--
-- The classification applied here is also recorded in schema sails_meta
-- (runtime_table_class, runtime_column_update), readable by the runtime: the
-- boot check (src/common/database/runtime-privileges.ts) compares the runtime's
-- EFFECTIVE table and column privileges against it, so there is one inventory
-- and a stray grant made between deploys is refused at the next boot.
DO $grants$
DECLARE
  runtime_role constant text := 'sails_runtime';
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'role % does not exist: run scripts/db/bootstrap-roles.js before the runtime grants', runtime_role;
  END IF;

  CREATE SCHEMA IF NOT EXISTS sails_meta;
  REVOKE ALL ON SCHEMA sails_meta FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS sails_meta.runtime_table_class (table_name text PRIMARY KEY, class text NOT NULL
    CHECK (class IN ('read', 'append', 'mutable', 'append_delete', 'mutable_delete')));
  CREATE TABLE IF NOT EXISTS sails_meta.runtime_column_update (table_name text, column_name text, PRIMARY KEY (table_name, column_name));
  DELETE FROM sails_meta.runtime_table_class;
  DELETE FROM sails_meta.runtime_column_update;
  INSERT INTO sails_meta.runtime_table_class VALUES
    -- frozen legacy fee distribution (20260823020000 write freeze)
    ('fee_distributions', 'read'),
    ('fee_distribution_batches', 'read'),
    ('fee_distribution_batch_items', 'read'),
    -- append-only / write-once records
    ('offer_envelopes', 'append'),
    ('escrow_pending_round_retirements', 'append'),
    ('entitlement_ledger_entries', 'append'),
    ('distribution_policy_recipients', 'append'),
    ('distribution_recipients', 'append'),
    ('fee_collection_evidence', 'append'),
    ('escrow_funding_evidence', 'append'),
    ('escrow_release_evidence', 'append'),
    ('escrow_events', 'append'),
    ('durable_events', 'append'),
    ('event_projection_claims', 'append'),
    ('correspondence_evaluations', 'append'),
    ('messages', 'append'),
    ('reputation_events', 'append'),
    ('capability_execution_authorizations', 'append'),
    ('economic_disposition_authorizations', 'append'),
    ('claims', 'append'),
    ('proofs', 'append'),
    ('verifications', 'append'),
    ('custody_attestations', 'append'), -- + UPDATE (supersededAt) only, see runtime_column_update
    ('intent_events', 'append'),        -- + UPDATE (publishedAt) only: hash-chained history, publication marker
    -- mutable state (write-once columns are still guarded by triggers)
    ('users', 'mutable'),
    ('offers', 'mutable'),
    ('trades', 'mutable'),
    ('escrows', 'mutable'),
    ('wdk_transfer_attempts', 'mutable'),
    ('signature_collection_finalization_attempts', 'mutable'),
    ('fee_policy_versions', 'mutable'),
    ('fee_obligations', 'mutable'),
    ('distribution_policy_versions', 'mutable'),
    ('disputes', 'mutable'),
    ('dispute_transition_outbox', 'mutable'),
    ('dispute_appeal_fees', 'mutable'),
    ('arbiter_profiles', 'mutable'),
    ('payment_accounts', 'mutable'),
    ('payout_addresses', 'mutable'),
    ('vouches', 'mutable'),
    ('intents', 'mutable'),
    ('capability_grants', 'mutable'),
    ('escrow_release_approvals', 'mutable'),
    ('escrow_participant_keys', 'mutable'),
    ('escrow_transaction_signatures', 'mutable'),
    ('evidence_references', 'mutable'),
    ('idempotency_keys', 'mutable'),
    -- rows the runtime creates and later deletes, never updates
    ('escrow_pending_transactions', 'append_delete'),
    ('semantic_transition_records', 'append_delete');

  -- One-time column transitions the trigger already constrains (NULL -> timestamp).
  INSERT INTO sails_meta.runtime_column_update VALUES
    ('custody_attestations', 'supersededAt'), -- custody-attestation-repository.ts create(): supersedes the previous attestation
    ('intent_events', 'publishedAt');         -- intent-repository.ts markEventPublished()/publishOwedEvent()

  FOR r IN
    SELECT t.tablename FROM pg_tables t
    WHERE t.schemaname = 'public' AND t.tablename <> '_prisma_migrations'
      AND NOT EXISTS (SELECT 1 FROM sails_meta.runtime_table_class c WHERE c.table_name = t.tablename)
  LOOP
    RAISE EXCEPTION 'table public.% has no runtime privilege class: add it to scripts/db/runtime-grants.sql', r.tablename;
  END LOOP;
  FOR r IN
    SELECT c.table_name FROM sails_meta.runtime_table_class c
    WHERE NOT EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = c.table_name)
  LOOP
    RAISE EXCEPTION 'classified table public.% does not exist: remove it from scripts/db/runtime-grants.sql', r.table_name;
  END LOOP;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', runtime_role);
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC';
  -- A table-level REVOKE also revokes every column-level grant on that table (PostgreSQL REVOKE semantics), so
  -- stale column grants are cleared here too; tests/integration/runtimePrivileges.test.ts proves it (MG1/MG2).
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', runtime_role);
  -- CTO 295/296: only the SECURITY DEFINER trigger draws fee_collection_evidence."seq"; a runtime that could call
  -- nextval() itself could exhaust it (migration 20261116120000).
  EXECUTE format('REVOKE ALL ON SEQUENCE public.fee_collection_evidence_seq_seq FROM %I', runtime_role);

  FOR r IN SELECT table_name, class FROM sails_meta.runtime_table_class LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I',
      CASE r.class
        WHEN 'read' THEN 'SELECT'
        WHEN 'append' THEN 'SELECT, INSERT'
        WHEN 'mutable' THEN 'SELECT, INSERT, UPDATE'
        WHEN 'append_delete' THEN 'SELECT, INSERT, DELETE'
        WHEN 'mutable_delete' THEN 'SELECT, INSERT, UPDATE, DELETE'
      END, r.table_name, runtime_role);
  END LOOP;
  FOR r IN SELECT u.table_name, u.column_name FROM sails_meta.runtime_column_update u LOOP
    EXECUTE format('GRANT UPDATE (%I) ON public.%I TO %I', r.column_name, r.table_name, runtime_role);
  END LOOP;
  -- Read-only for the runtime: the boot check reads the recorded classification.
  EXECUTE format('GRANT USAGE ON SCHEMA sails_meta TO %I', runtime_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sails_meta FROM %I', runtime_role);
  EXECUTE format('GRANT SELECT ON sails_meta.runtime_table_class, sails_meta.runtime_column_update TO %I', runtime_role);
END
$grants$;
