// Migration lint (CI gate). Reads prisma/migrations/*/migration.sql and checks, WITHOUT any database:
//   1. well-formed directories (14-digit UTC timestamp prefix, migration.sql present, unique, in order);
//   2. immutability: a migration listed in the baseline must still have the exact SHA-256 recorded for it
//      (the server compares Prisma's stored checksum with these bytes, so an edited applied migration is an outage);
//   3. classification of every migration NOT in the baseline as additive / potentially-destructive / destructive,
//      and a refusal to accept a non-additive one that does not carry an explicit, reasoned annotation:
//          -- migration-class: contract: <why this is safe, which release stopped using the old shape (>= 20 chars)>
//      The annotation is the author's statement that the expand/contract steps in docs/MIGRATIONS.md were followed.
// Adding a migration to the baseline is a reviewed change (`--write-baseline`); it freezes the file's bytes.
//
//   node scripts/migration-lint.js [--dir prisma/migrations] [--baseline scripts/migration-lint.baseline.json]
//                                  [--write-baseline] [--json]
// Exit: 0 clean, 1 violations, 2 the lint could not run.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ADDITIVE = 'additive'
const POTENTIAL = 'potentially-destructive'
const DESTRUCTIVE = 'destructive'
const RANK = { [ADDITIVE]: 0, [POTENTIAL]: 1, [DESTRUCTIVE]: 2 }

// Dollar-quoted bodies (trigger functions) and string literals hold text, not DDL: blank them before matching.
function stripNoise(sql) {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}
function dropParens(statement) {
  let s = statement
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/\([^()]*\)/g, ' ') }
  return s
}

// [class, regex, label, optional table-capture], matched per statement (parenthesised groups removed so `DECIMAL(10,2)` cannot split an action).
const RULES = [
  [DESTRUCTIVE, /\bDROP\s+TABLE\b/i, 'DROP TABLE'],
  [DESTRUCTIVE, /\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
  [DESTRUCTIVE, /\bDROP\s+(SCHEMA|TYPE|DATABASE)\b/i, 'DROP SCHEMA/TYPE'],
  [DESTRUCTIVE, /\bTRUNCATE\b/i, 'TRUNCATE'],
  [DESTRUCTIVE, /\bDELETE\s+FROM\b/i, 'DELETE FROM'],
  [POTENTIAL, /\bDROP\s+(INDEX|CONSTRAINT|TRIGGER|FUNCTION|VIEW|DEFAULT)\b/i, 'DROP INDEX/CONSTRAINT/TRIGGER/FUNCTION/VIEW/DEFAULT'],
  [POTENTIAL, /\bALTER\s+COLUMN\b[^,;]*\bTYPE\b/i, 'ALTER COLUMN TYPE'],
  [POTENTIAL, /\bSET\s+NOT\s+NULL\b/i, 'SET NOT NULL'],
  [POTENTIAL, /\bRENAME\b/i, 'RENAME'],
  [POTENTIAL, /\bADD\s+COLUMN\b(?![^,;]*\bDEFAULT\b)[^,;]*\bNOT\s+NULL\b/i, 'ADD COLUMN NOT NULL without DEFAULT'],
  // Only a table that already existed can hold rows the new constraint rejects: a table created by this very migration is empty.
  [POTENTIAL, /\bCREATE\s+UNIQUE\s+INDEX\b/i, 'new UNIQUE constraint over existing rows', /\bON\s+"?(\w+)"?/i],
  [POTENTIAL, /\bALTER\s+TABLE\b[^;]*?\bADD\s+(CONSTRAINT\s+\S+\s+)?UNIQUE\b/i, 'new UNIQUE constraint over existing rows', /\bALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?/i],
  [POTENTIAL, /\bALTER\s+TABLE\b[^;]*?\bADD\s+(CONSTRAINT\s+\S+\s+)?(FOREIGN\s+KEY|CHECK)\b/i, 'new FOREIGN KEY/CHECK over existing rows', /\bALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?/i],
  [POTENTIAL, /(^|\s)UPDATE\s+\S+\s+SET\b/i, 'UPDATE'],
]

function classify(sql) {
  const reasons = new Set()
  let klass = ADDITIVE
  // An anonymous DO block runs arbitrary code that this text lint cannot read (it may EXECUTE dynamic DDL): never additive.
  if (/\bDO\s+(LANGUAGE\s+\w+\s+)?\$/i.test(sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '))) {
    reasons.add('DO block (unclassifiable)')
    klass = POTENTIAL
  }
  const clean = stripNoise(sql)
  const created = new Set([...clean.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map(m => m[1]))
  for (const raw of clean.split(';')) {
    const statement = dropParens(raw)
    for (const [c, re, label, table] of RULES) {
      if (re.test(statement) && !(table && created.has((statement.match(table) || [])[1]))) {
        reasons.add(label)
        if (RANK[c] > RANK[klass]) klass = c
      }
    }
  }
  return { klass, reasons: [...reasons] }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const ANNOTATION = /^--\s*migration-class:\s*contract:\s*(.{20,})$/
// Only the leading comment block counts: the same text inside a block comment, a string or a function body is not a statement by the author.
const hasAnnotation = (sql) => {
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    if (!t.startsWith('--')) return false
    if (ANNOTATION.test(t)) return true
  }
  return false
}

function lint({ dir, baseline }) {
  const violations = []
  const rows = []
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  let previous = ''
  for (const name of names) {
    if (!/^\d{14}_[a-z0-9_]+$/i.test(name)) { violations.push(`${name}: directory name is not <14-digit timestamp>_<name>`); continue }
    if (name.slice(0, 14) === previous.slice(0, 14)) violations.push(`${name}: same timestamp as ${previous}`)
    previous = name
    const file = path.join(dir, name, 'migration.sql')
    if (!fs.existsSync(file)) { violations.push(`${name}: migration.sql is missing`); continue }
    const bytes = fs.readFileSync(file)
    const sql = bytes.toString('utf8')
    const { klass, reasons } = classify(sql)
    const hash = sha256(bytes)
    const frozen = baseline.migrations[name]
    const row = { name, klass, reasons, sha256: hash, baseline: Boolean(frozen), annotated: false }
    if (frozen) {
      if (frozen.sha256 !== hash) violations.push(`${name}: applied migration was EDITED (sha256 ${hash.slice(0, 12)} != baseline ${frozen.sha256.slice(0, 12)}); write a new migration instead`)
    } else if (klass !== ADDITIVE) {
      row.annotated = hasAnnotation(sql)
      if (!row.annotated) {
        violations.push(`${name}: ${klass} (${reasons.join(', ')}) without "-- migration-class: contract: <reason>"; follow the expand/contract steps in docs/MIGRATIONS.md`)
      }
    }
    rows.push(row)
  }
  for (const name of Object.keys(baseline.migrations)) {
    if (!names.includes(name)) violations.push(`${name}: in the baseline but its directory is gone (a shipped migration must never be removed)`)
  }
  return { rows, violations }
}

function main(argv, out = console) {
  const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt }
  const dir = arg('--dir', 'prisma/migrations')
  const baselineFile = arg('--baseline', 'scripts/migration-lint.baseline.json')
  try {
    if (argv.includes('--write-baseline')) {
      const { rows, violations } = lint({ dir, baseline: { migrations: {} } })
      const structural = violations.filter(v => !/without "-- migration-class/.test(v))
      if (structural.length) { structural.forEach(v => out.error(v)); return 1 }
      const migrations = {}
      for (const r of rows) migrations[r.name] = { class: r.klass, sha256: r.sha256 }
      fs.writeFileSync(baselineFile, JSON.stringify({ schema: 1, migrations }, null, 2) + '\n')
      out.log(`baseline written: ${rows.length} migrations -> ${baselineFile}`)
      return 0
    }
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
    if (baseline.schema !== 1 || typeof baseline.migrations !== 'object') throw new Error(`${baselineFile}: unexpected schema`)
    const { rows, violations } = lint({ dir, baseline })
    if (argv.includes('--json')) out.log(JSON.stringify({ rows, violations }, null, 2))
    else {
      const counts = rows.reduce((a, r) => ({ ...a, [r.klass]: (a[r.klass] || 0) + 1 }), {})
      out.log(`migration lint: ${rows.length} migrations (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}); ${rows.filter(r => !r.baseline).length} new since the baseline`)
      for (const r of rows.filter(r => !r.baseline)) out.log(`  NEW ${r.name}: ${r.klass}${r.reasons.length ? ` (${r.reasons.join(', ')})` : ''}${r.annotated ? ' [annotated]' : ''}`)
      violations.forEach(v => out.error(`VIOLATION ${v}`))
    }
    return violations.length ? 1 : 0
  } catch (error) {
    out.error(`migration lint COULD NOT RUN: ${error.message}`)
    return 2
  }
}

module.exports = { classify, lint, main, ADDITIVE, POTENTIAL, DESTRUCTIVE }
if (require.main === module) process.exit(main(process.argv.slice(2)))
