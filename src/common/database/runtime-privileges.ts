/**
 * Runtime database privilege check (CTO 221/225).
 *
 * The write-once guarantees (offer_envelopes, escrow_pending_round_retirements,
 * ...) are triggers. A role that owns a table can disable its trigger, and a
 * superuser can bypass it with session_replication_role = replica, so they only
 * hold if the application's own connection is neither. This check runs once at
 * boot (startServer) and, in production, refuses to start when the connected
 * role could bypass them. Roles and grants come from scripts/db/bootstrap-roles.js
 * and scripts/db/runtime-grants.sql.
 */
import { prisma } from '.'
import { config } from '../../config'
import { childLogger } from '../logger'

export type PrivilegeCheckMode = 'enforce' | 'warn' | 'off'

// Tables the runtime may never UPDATE or DELETE as a whole (append-only or frozen in scripts/db/runtime-grants.sql;
// custody_attestations and intent_events keep a single column-level UPDATE, which this table-level check allows).
const APPEND_ONLY_TABLES = [
  'offer_envelopes', 'escrow_pending_round_retirements', 'entitlement_ledger_entries', 'distribution_policy_recipients',
  'distribution_recipients', 'custody_attestations', 'intent_events', 'fee_collection_evidence', 'escrow_funding_evidence',
  'escrow_release_evidence', 'escrow_events', 'durable_events', 'event_projection_claims', 'fee_distributions',
  'fee_distribution_batches', 'fee_distribution_batch_items',
]

type Query = (sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

/** Every reason the current connection could bypass a write-once guard; empty means it cannot. */
export async function inspectRuntimePrivileges(query: Query = prisma.$queryRaw.bind(prisma) as Query): Promise<string[]> {
  const [role] = (await query`
    SELECT current_user AS name, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owned_relations,
      (SELECT d.datdba = r.oid FROM pg_database d WHERE d.datname = current_database()) AS owns_database,
      (SELECT n.nspowner = r.oid FROM pg_namespace n WHERE n.nspname = 'public') AS owns_schema,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proowner = r.oid) AS owned_routines,
      has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create,
      has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create_schema,
      has_database_privilege(r.oid, current_database(), 'TEMP') AS can_temp
    FROM pg_roles r WHERE r.rolname = current_user`) as Array<Record<string, unknown>>
  const findings: string[] = []
  if (role.rolsuper) findings.push('is a superuser')
  if (role.rolbypassrls) findings.push('has BYPASSRLS')
  if (role.rolcreaterole) findings.push('has CREATEROLE')
  if (role.rolcreatedb) findings.push('has CREATEDB')
  if (role.rolreplication) findings.push('has REPLICATION')
  if (Number(role.memberships) > 0) findings.push(`is a member of ${role.memberships} other role(s)`)
  if (Number(role.owned_relations) > 0) findings.push(`owns ${role.owned_relations} relation(s) in schema public`)
  if (role.owns_database) findings.push('owns the database')
  if (role.owns_schema) findings.push('owns schema public')
  if (Number(role.owned_routines) > 0) findings.push(`owns ${role.owned_routines} routine(s) in schema public`)
  if (role.can_create) findings.push('can CREATE in schema public')
  if (role.can_create_schema) findings.push('can CREATE schemas in the database')
  if (role.can_temp) findings.push('can create TEMP tables')
  // Effective privileges, so a grant to PUBLIC counts too. TRUNCATE, TRIGGER and REFERENCES are never granted.
  const writable = (await query`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND (has_table_privilege(c.oid, 'TRUNCATE, TRIGGER, REFERENCES')
         OR (c.relname = ANY(${APPEND_ONLY_TABLES}::text[]) AND has_table_privilege(c.oid, 'UPDATE, DELETE')))
     ORDER BY 1`) as Array<{ name: string }>
  for (const { name } of writable) findings.push(`can UPDATE, DELETE, TRUNCATE, TRIGGER or REFERENCES protected table ${name}`)
  return findings.map((f) => `database role ${String(role.name)} ${f}`)
}

/** Production always enforces; elsewhere DB_PRIVILEGE_CHECK=enforce|warn opts in (default off). */
export function privilegeCheckMode(): PrivilegeCheckMode {
  if (config.isProduction) return 'enforce'
  const raw = process.env.DB_PRIVILEGE_CHECK
  return raw === 'enforce' || raw === 'warn' ? raw : 'off'
}

export async function assertRuntimeDatabasePrivileges(mode: PrivilegeCheckMode = privilegeCheckMode(), query?: Query): Promise<void> {
  if (mode === 'off') return
  const findings = await inspectRuntimePrivileges(query)
  if (findings.length === 0) return
  const message = `Refusing a privileged database connection for the runtime: ${findings.join('; ')}. ` +
    'Connect the application as sails_runtime (scripts/db/bootstrap-roles.js, docs/DEPLOYMENT.md).'
  if (mode === 'enforce') throw new Error(message)
  childLogger('database').warn({ msg: message })
}
