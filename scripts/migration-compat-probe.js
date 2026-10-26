// Compatibility probe: can the PREVIOUS server version keep running against the schema the NEW migrations produce?
// (A rolling update and a rollback both run old code against a newer schema; see docs/MIGRATIONS.md.)
//   1. creates a throwaway database on the server DATABASE_URL points at (never touches an existing one);
//   2. applies the migrations frozen in scripts/migration-lint.baseline.json = what the previous release shipped,
//      and snapshots information_schema;
//   3. applies the remaining (new) migrations and snapshots again;
//   4. fails on any change that breaks an old reader/writer:
//        - table or column removed, column type changed,
//        - column that old code writes became NOT NULL, or a new NOT NULL column has no DEFAULT (old INSERTs fail),
//        - enum value removed.
//      New tables, new nullable/defaulted columns, new indexes and new enum values are compatible.
// The throwaway database is dropped at the end. Exit: 0 compatible, 1 incompatible, 2 could not run.
//
//   DATABASE_URL=postgresql://... node scripts/migration-compat-probe.js [--dir prisma/migrations] [--baseline <file>]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COLUMNS = `SELECT table_name, column_name, udt_name, is_nullable, column_default IS NOT NULL AS has_default, is_generated, is_identity
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`
const ENUMS = `SELECT t.typname AS type, e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'`

async function snapshot(client) {
  const columns = {}
  for (const r of (await client.query(COLUMNS)).rows) {
    columns[`${r.table_name}.${r.column_name}`] = { type: r.udt_name, notNull: r.is_nullable === 'NO', hasDefault: r.has_default || r.is_generated === 'ALWAYS' || r.is_identity === 'YES' }
  }
  const enums = new Set((await client.query(ENUMS)).rows.map(r => `${r.type}:${r.label}`))
  return { columns, enums }
}

// Pure: the compatibility rules over two snapshots.
function diff(before, after) {
  const problems = []
  for (const [name, old] of Object.entries(before.columns)) {
    const now = after.columns[name]
    if (!now) { problems.push(`${name}: removed (old code still reads/writes it)`); continue }
    if (now.type !== old.type) problems.push(`${name}: type ${old.type} -> ${now.type}`)
    if (now.notNull && !old.notNull) problems.push(`${name}: became NOT NULL (old code may write NULL)`)
  }
  for (const [name, now] of Object.entries(after.columns)) {
    if (!before.columns[name] && now.notNull && !now.hasDefault) {
      const table = name.split('.')[0]
      // a brand-new table is not written by old code; a new required column on an existing table is
      if (Object.keys(before.columns).some(c => c.startsWith(`${table}.`))) problems.push(`${name}: new NOT NULL column without DEFAULT (old INSERTs fail)`)
    }
  }
  for (const e of before.enums) if (!after.enums.has(e)) problems.push(`enum ${e}: value removed`)
  return problems
}

function listMigrations(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
}

async function probe({ url, dir, baseline, Client }) {
  const names = listMigrations(dir)
  const frozen = names.filter(n => baseline.migrations[n])
  const added = names.filter(n => !baseline.migrations[n])
  const firstAdded = names.findIndex(n => !baseline.migrations[n])
  if (added.length && frozen.some(n => names.indexOf(n) > firstAdded)) throw new Error('a baseline migration sorts after a new one; new migrations must be the newest')
  if (!added.length) return { problems: [], frozen: frozen.length, added: 0 }

  const admin = new Client({ connectionString: url })
  await admin.connect()
  const dbName = `compat_probe_${crypto.randomBytes(6).toString('hex')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const target = new URL(url)
  target.pathname = `/${dbName}`
  const client = new Client({ connectionString: target.toString() })
  try {
    await client.connect()
    const apply = async (list) => { for (const n of list) await client.query(fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8')) }
    await apply(frozen)
    const before = await snapshot(client)
    await apply(added)
    const after = await snapshot(client)
    return { problems: diff(before, after), frozen: frozen.length, added: added.length }
  } finally {
    await client.end().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
}

async function main(argv, env = process.env, out = console) {
  const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt }
  try {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set (a throwaway PostgreSQL server)')
    const baseline = JSON.parse(fs.readFileSync(arg('--baseline', 'scripts/migration-lint.baseline.json'), 'utf8'))
    const { Client } = require('pg')
    const result = await probe({ url: env.DATABASE_URL, dir: arg('--dir', 'prisma/migrations'), baseline, Client })
    out.log(`compat probe: ${result.frozen} shipped migrations, ${result.added} new`)
    result.problems.forEach(p => out.error(`INCOMPATIBLE ${p}`))
    if (!result.added) out.log('nothing new to probe')
    else if (!result.problems.length) out.log('the previous server version stays compatible with the new schema')
    return result.problems.length ? 1 : 0
  } catch (error) {
    out.error(`compat probe COULD NOT RUN: ${error.message}`)
    return 2
  }
}

module.exports = { diff, probe, main }
if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code))
