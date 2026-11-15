/**
 * Runtime database privilege check (CTO 221/225/230).
 *
 * The write-once guarantees (offer_envelopes, escrow_pending_round_retirements,
 * ...) are triggers. A role that owns a table can disable its trigger, and a
 * superuser can bypass it with session_replication_role = replica, so they only
 * hold if the application's own connection is neither. This check runs once at
 * boot (startServer) and, in production, refuses to start when the connected
 * role could bypass them or holds any privilege beyond its classification.
 * Roles and grants come from scripts/db/bootstrap-roles.js and
 * scripts/db/runtime-grants.sql; the latter records the classification it
 * applied in schema sails_meta, which is the one inventory read here.
 */
import { prisma } from '.'
import { config } from '../../config'
import { childLogger } from '../logger'

export type PrivilegeCheckMode = 'enforce' | 'warn' | 'off'

type Query = (sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

interface ExcessPrivilege { name: string; privilege: string; col: string | null; class: string | null }

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

  // One inventory (N1): every EFFECTIVE privilege of this role, grants to PUBLIC included, table- or column-level
  // (N2), must be allowed by its table's recorded class or be a recorded one-column UPDATE. Unclassified allows nothing.
  const [{ installed }] = (await query`
    SELECT to_regclass('sails_meta.runtime_table_class') IS NOT NULL
       AND to_regclass('sails_meta.runtime_column_update') IS NOT NULL
       AND has_table_privilege('sails_meta.runtime_table_class', 'SELECT')
       AND has_table_privilege('sails_meta.runtime_column_update', 'SELECT') AS installed`) as Array<{ installed: boolean }>
  if (!installed) {
    findings.push('has no readable privilege classification (sails_meta; run scripts/db/runtime-grants.sql as the migrator)')
  } else {
    const excess = (await query`
      WITH cls AS (SELECT table_name, class FROM sails_meta.runtime_table_class),
      allowed(class, privilege) AS (VALUES
        ('read', 'SELECT'), ('append', 'SELECT'), ('append', 'INSERT'),
        ('mutable', 'SELECT'), ('mutable', 'INSERT'), ('mutable', 'UPDATE'),
        ('append_delete', 'SELECT'), ('append_delete', 'INSERT'), ('append_delete', 'DELETE'),
        ('mutable_delete', 'SELECT'), ('mutable_delete', 'INSERT'), ('mutable_delete', 'UPDATE'), ('mutable_delete', 'DELETE')),
      tbl AS (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p'))
      SELECT t.relname::text AS name, p.privilege, NULL::text AS col, k.class
        FROM tbl t
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(privilege)
        LEFT JOIN cls k ON k.table_name = t.relname
       WHERE has_table_privilege(t.oid, p.privilege)
         AND NOT EXISTS (SELECT 1 FROM allowed a WHERE a.class = k.class AND a.privilege = p.privilege)
      UNION ALL
      SELECT t.relname::text, p.privilege, a.attname::text, k.class
        FROM tbl t
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
        LEFT JOIN cls k ON k.table_name = t.relname
       WHERE has_column_privilege(t.oid, a.attnum, p.privilege)
         AND NOT has_table_privilege(t.oid, p.privilege)
         AND NOT EXISTS (SELECT 1 FROM allowed al WHERE al.class = k.class AND al.privilege = p.privilege)
         AND NOT (p.privilege = 'UPDATE' AND EXISTS (SELECT 1 FROM sails_meta.runtime_column_update u
                                                       WHERE u.table_name = t.relname AND u.column_name = a.attname))
       ORDER BY 1, 2, 3`) as ExcessPrivilege[]
    for (const e of excess) {
      findings.push(`has ${e.privilege} on ${e.name}${e.col ? '.' + e.col : ''} beyond its privilege class (${e.class ?? 'unclassified'})`)
    }
  }
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
