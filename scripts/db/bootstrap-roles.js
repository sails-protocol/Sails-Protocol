#!/usr/bin/env node
/**
 * Database role bootstrap (CTO 221/225). Run ONCE per database by the cluster
 * administrator, before `prisma migrate deploy`; safe to re-run (idempotent).
 *
 *   ADMIN_DATABASE_URL       superuser (or RDS master) URL of the target database
 *   SAILS_MIGRATOR_PASSWORD  password for sails_migrator (owns the schema, runs migrations)
 *   SAILS_RUNTIME_PASSWORD   password for sails_runtime (the application)
 *
 * Creates/realigns both login roles with no elevated attributes, removes every
 * role membership from the runtime, makes sails_migrator the owner of the
 * database, of schema public and of every object already in it (an existing
 * installation created by `postgres` is handed over in place: ownership only,
 * no row is read or changed), and revokes the default PUBLIC rights on the
 * database and on schema public. Table privileges for the runtime are NOT set
 * here: scripts/db/runtime-grants.sql does that as sails_migrator after each
 * migration run.
 *
 * A non-superuser administrator (a managed-PostgreSQL master with only
 * CREATEROLE/CREATEDB) is supported: the script makes it a member of
 * sails_migrator (SET, INHERIT) so it may transfer ownership and re-run, and
 * verifies (instead of naming) SUPERUSER, REPLICATION and BYPASSRLS on roles
 * that already exist. Never point the application at the administrator.
 */
const { Client } = require('pg')

const MIGRATOR = 'sails_migrator'
const RUNTIME = 'sails_runtime'
const LOCKDOWN = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function upsertRole(client, role, password, extra, adminIsSuperuser) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
  const verb = exists.rowCount ? 'ALTER' : 'CREATE'
  // A non-superuser may not name SUPERUSER, REPLICATION or BYPASSRLS in ALTER ROLE, not even to deny them; it cannot
  // grant them either, so it re-asserts the rest and verifies those three below instead.
  const lockdown = verb === 'ALTER' && !adminIsSuperuser ? 'NOCREATEDB NOCREATEROLE' : LOCKDOWN
  await client.query(`${verb} ROLE ${client.escapeIdentifier(role)} WITH LOGIN ${lockdown} ${extra} PASSWORD ${client.escapeLiteral(password)}`)
  const { rows: [r] } = await client.query('SELECT rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [role])
  if (r.rolsuper || r.rolreplication || r.rolbypassrls) {
    throw new Error(`${role} has SUPERUSER, REPLICATION or BYPASSRLS; only a superuser can remove it - fix the role before bootstrapping`)
  }
}

async function bootstrap() {
  const client = new Client({ connectionString: required('ADMIN_DATABASE_URL') })
  await client.connect()
  try {
    const migratorPassword = required('SAILS_MIGRATOR_PASSWORD')
    const runtimePassword = required('SAILS_RUNTIME_PASSWORD')
    if (migratorPassword === runtimePassword) throw new Error('migrator and runtime passwords must differ')

    // Keep the passwords out of the server log (statement logging); a non-superuser admin (RDS) may not change it.
    await client.query("SET log_statement = 'none'").catch(() => {})
    await client.query('SET log_min_error_statement = panic').catch(() => {})
    const { rows: [admin] } = await client.query(
      `SELECT rolsuper, current_setting('server_version_num')::int >= 160000 AS pg16 FROM pg_roles WHERE rolname = current_user`)
    // The non-superuser path is tested on PostgreSQL 16 only (tests/integration/bootstrapNonSuperuser.test.ts).
    if (!admin.rolsuper && !admin.pg16) {
      throw new Error('a non-superuser administrator needs PostgreSQL 16 or later; on an older server run this as a superuser')
    }
    // Roles, memberships and ownership commit together or not at all.
    await client.query('BEGIN')
    await upsertRole(client, MIGRATOR, migratorPassword, 'INHERIT', admin.rolsuper)
    await upsertRole(client, RUNTIME, runtimePassword, 'NOINHERIT', admin.rolsuper)

    // The runtime must not be able to SET ROLE to anything (migrator, admin, pg_* roles).
    const memberships = await client.query(
      `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = $1`, [RUNTIME])
    for (const { rolname } of memberships.rows) {
      await client.query(`REVOKE ${client.escapeIdentifier(rolname)} FROM ${client.escapeIdentifier(RUNTIME)}`)
    }

    const { rows: [{ db }] } = await client.query('SELECT current_database() AS db')
    const m = client.escapeIdentifier(MIGRATOR)
    // A non-superuser administrator (managed PostgreSQL master: CREATEROLE/CREATEDB only) may hand objects to the
    // migrator only if it can SET ROLE to it (PostgreSQL 16+), and after the hand-over it reaches the database
    // (CONNECT) and re-runs this script only through the migrator's privileges: make it a member of the migrator
    // (SET and INHERIT; the documented "GRANT sails_migrator TO <master>"). The administrator is already above the
    // migrator, so this adds nothing it could not do; the runtime never gets any membership (revoked above).
    if (!admin.rolsuper) {
      await client.query(`GRANT ${m} TO CURRENT_USER WITH SET TRUE, INHERIT TRUE`)
    }
    await client.query(`ALTER DATABASE ${client.escapeIdentifier(db)} OWNER TO ${m}`)
    await client.query(`REVOKE ALL ON DATABASE ${client.escapeIdentifier(db)} FROM PUBLIC`)
    await client.query(`ALTER SCHEMA public OWNER TO ${m}`)
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')

    // Every object in public not yet owned by the migrator; extension members are left to their extension.
    const owned = await client.query(
      `SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind,
              format('%I.%I', n.nspname, c.relname) AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
          AND pg_get_userbyid(c.relowner) <> $1
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e', 'a')) -- extension members; sequences owned by a column follow their table
       UNION ALL
       SELECT 'ROUTINE', p.oid::regprocedure::text
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> $1
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       UNION ALL
       SELECT 'TYPE', format('%I.%I', n.nspname, t.typname)
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) <> $1
          AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')`, [MIGRATOR])
    for (const { kind, name } of owned.rows) {
      await client.query(`ALTER ${kind} ${name} OWNER TO ${m}`)
    }
    await client.query('COMMIT')
    console.log(`bootstrap-roles: ${MIGRATOR} and ${RUNTIME} ready on ${db}; ownership moved for ${owned.rowCount} object(s); ${memberships.rowCount} runtime membership(s) revoked`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(`bootstrap-roles failed: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { bootstrap, MIGRATOR, RUNTIME }
