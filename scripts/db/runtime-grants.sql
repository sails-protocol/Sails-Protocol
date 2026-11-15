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
--   mutable_delete SELECT, INSERT, UPDATE, DELETE  (rows the runtime retires)
-- TRUNCATE, REFERENCES, TRIGGER and any DDL are never granted. The class is
-- the least privilege the runtime code needs today (writes inventoried in
-- src/ on 2026-11-15); widening one is a reviewed change to this file.
DO $grants$
DECLARE
  runtime_role constant text := 'sails_runtime';
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE NOTICE 'role % does not exist: runtime grants skipped (scripts/db/bootstrap-roles.js not run)', runtime_role;
    RETURN;
  END IF;

  CREATE TEMP TABLE runtime_table_class (table_name text PRIMARY KEY, class text NOT NULL
    CHECK (class IN ('read', 'append', 'mutable', 'mutable_delete'))) ON COMMIT DROP;
  INSERT INTO runtime_table_class VALUES
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
    -- mutable state (write-once columns are still guarded by triggers)
    ('users', 'mutable'),
    ('offers', 'mutable'),
    ('trades', 'mutable'),
    ('escrows', 'mutable'),
    ('wdk_transfer_attempts', 'mutable'),
    ('signature_collection_finalization_attempts', 'mutable'),
    ('fee_policy_versions', 'mutable'),
    ('fee_obligations', 'mutable'),
    ('custody_attestations', 'mutable'),
    ('distribution_policy_versions', 'mutable'),
    ('disputes', 'mutable'),
    ('dispute_transition_outbox', 'mutable'),
    ('dispute_appeal_fees', 'mutable'),
    ('arbiter_profiles', 'mutable'),
    ('payment_accounts', 'mutable'),
    ('payout_addresses', 'mutable'),
    ('vouches', 'mutable'),
    ('intents', 'mutable'),
    ('intent_events', 'mutable'),
    ('capability_grants', 'mutable'),
    ('escrow_release_approvals', 'mutable'),
    ('escrow_participant_keys', 'mutable'),
    ('escrow_transaction_signatures', 'mutable'),
    ('evidence_references', 'mutable'),
    ('idempotency_keys', 'mutable'),
    -- rows the runtime deletes
    ('escrow_pending_transactions', 'mutable_delete'),
    ('semantic_transition_records', 'mutable_delete');

  FOR r IN
    SELECT t.tablename FROM pg_tables t
    WHERE t.schemaname = 'public' AND t.tablename <> '_prisma_migrations'
      AND NOT EXISTS (SELECT 1 FROM runtime_table_class c WHERE c.table_name = t.tablename)
  LOOP
    RAISE EXCEPTION 'table public.% has no runtime privilege class: add it to scripts/db/runtime-grants.sql', r.tablename;
  END LOOP;
  FOR r IN
    SELECT c.table_name FROM runtime_table_class c
    WHERE NOT EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = c.table_name)
  LOOP
    RAISE EXCEPTION 'classified table public.% does not exist: remove it from scripts/db/runtime-grants.sql', r.table_name;
  END LOOP;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', runtime_role);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', runtime_role);

  FOR r IN SELECT table_name, class FROM runtime_table_class LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I',
      CASE r.class
        WHEN 'read' THEN 'SELECT'
        WHEN 'append' THEN 'SELECT, INSERT'
        WHEN 'mutable' THEN 'SELECT, INSERT, UPDATE'
        WHEN 'mutable_delete' THEN 'SELECT, INSERT, UPDATE, DELETE'
      END, r.table_name, runtime_role);
  END LOOP;
END
$grants$;
