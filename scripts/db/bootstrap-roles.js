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
 * On Amazon RDS the master is rds_superuser, not a real superuser: grant it
 * membership in sails_migrator first (GRANT sails_migrator TO <master>) so it
 * may transfer ownership. Never point the application at the master.
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

async function upsertRole(client, role, password, extra) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
  const verb = exists.rowCount ? 'ALTER' : 'CREATE'
  await client.query(`${verb} ROLE ${client.escapeIdentifier(role)} WITH LOGIN ${LOCKDOWN} ${extra} PASSWORD ${client.escapeLiteral(password)}`)
}

async function bootstrap() {
  const client = new Client({ connectionString: required('ADMIN_DATABASE_URL') })
  await client.connect()
  try {
    const migratorPassword = required('SAILS_MIGRATOR_PASSWORD')
    const runtimePassword = required('SAILS_RUNTIME_PASSWORD')
    if (migratorPassword === runtimePassword) throw new Error('migrator and runtime passwords must differ')

    await upsertRole(client, MIGRATOR, migratorPassword, 'INHERIT')
    await upsertRole(client, RUNTIME, runtimePassword, 'NOINHERIT')

    // The runtime must not be able to SET ROLE to anything (migrator, admin, pg_* roles).
    const memberships = await client.query(
      `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = $1`, [RUNTIME])
    for (const { rolname } of memberships.rows) {
      await client.query(`REVOKE ${client.escapeIdentifier(rolname)} FROM ${client.escapeIdentifier(RUNTIME)}`)
    }

    const { rows: [{ db }] } = await client.query('SELECT current_database() AS db')
    const m = client.escapeIdentifier(MIGRATOR)
    await client.query('BEGIN')
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
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
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
