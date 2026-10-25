// Migration controls: scripts/migration-lint.js (classification, immutability, annotation) and
// scripts/migration-compat-probe.js (previous server version vs the schema the new migrations produce).
// The probe's database test needs a throwaway PostgreSQL: set COMPAT_PROBE_DATABASE_URL (CI does); otherwise it is skipped.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lintLib = require('../scripts/migration-lint.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const probeLib = require('../scripts/migration-compat-probe.js')

const { classify, main: lintMain } = lintLib

describe('migration lint: classification', () => {
  const kind = (sql: string) => classify(sql).klass
  it('treats pure expansion as additive', () => {
    expect(kind('CREATE TABLE "a" ("id" TEXT NOT NULL, "n" DECIMAL(10,2) NOT NULL, CONSTRAINT "a_pkey" PRIMARY KEY ("id"));\nCREATE UNIQUE INDEX "a_n_key" ON "a"("n");')).toBe('additive')
    expect(kind('ALTER TABLE "a" ADD COLUMN "x" TEXT;\nALTER TABLE "a" ADD COLUMN "y" INTEGER NOT NULL DEFAULT 0;\nALTER TYPE "S" ADD VALUE \'NEW\';\nCREATE INDEX "i" ON "a"("x");')).toBe('additive')
  })
  it('flags destructive statements', () => {
    for (const sql of ['DROP TABLE "a";', 'ALTER TABLE "a" DROP COLUMN "x";', 'TRUNCATE "a";', 'DELETE FROM "a";', 'DROP TYPE "S";']) expect(kind(sql)).toBe('destructive')
  })
  it('flags potentially destructive statements', () => {
    for (const sql of [
      'DROP INDEX "i";', 'ALTER TABLE "a" ALTER COLUMN "x" TYPE json;', 'ALTER TABLE "a" ALTER COLUMN "x" SET NOT NULL;',
      'ALTER TABLE "a" RENAME COLUMN "x" TO "y";', 'ALTER TABLE "a" ADD COLUMN "x" TEXT NOT NULL;', 'UPDATE "a" SET "x" = 1;',
      'CREATE UNIQUE INDEX "i" ON "old_table"("x");', 'ALTER TABLE "old_table" ADD CONSTRAINT "f" FOREIGN KEY ("x") REFERENCES "b"("id");',
    ]) expect(kind(sql)).toBe('potentially-destructive')
  })
  it('does not flag a unique index or foreign key on a table created by the same migration', () => {
    expect(kind('CREATE TABLE "n" ("id" TEXT NOT NULL);\nCREATE UNIQUE INDEX "n_k" ON "n"("id");\nALTER TABLE "n" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "b"("id");')).toBe('additive')
  })
  it('ignores comments, string literals and trigger-function bodies', () => {
    expect(kind('-- DROP TABLE "a";\n/* TRUNCATE x; */\nCREATE TABLE "a" ("note" TEXT DEFAULT \'DELETE FROM x\');')).toBe('additive')
    expect(kind('CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM "x"; RETURN NEW; END $$ LANGUAGE plpgsql;')).toBe('additive')
  })
})

describe('migration lint: directory checks', () => {
  let dir: string
  let baselineFile: string
  const sha = (sql: string) => require('crypto').createHash('sha256').update(sql).digest('hex')
  const migration = (name: string, sql: string) => { mkdirSync(join(dir, 'migrations', name), { recursive: true }); writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql) }
  const run = (extra: string[] = []) => {
    const log: string[] = []; const error: string[] = []
    const code = lintMain(['--dir', join(dir, 'migrations'), '--baseline', baselineFile, ...extra], { log: (m: string) => log.push(m), error: (m: string) => error.push(m) })
    return { code, log, error }
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mig-lint-')); mkdirSync(join(dir, 'migrations')); baselineFile = join(dir, 'baseline.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes a clean tree, freezes it with --write-baseline, then catches an edit to a frozen migration', () => {
    migration('20260101000000_init', 'CREATE TABLE "a" ("id" TEXT NOT NULL);')
    expect(run(['--write-baseline']).code).toBe(0)
    expect(run().code).toBe(0)
    migration('20260101000000_init', 'CREATE TABLE "a" ("id" TEXT NOT NULL, "x" TEXT);')
    const r = run()
    expect(r.code).toBe(1)
    expect(r.error.join('\n')).toMatch(/was EDITED/)
  })
  it('refuses a new destructive migration without the annotation and accepts it with a reasoned one', () => {
    migration('20260101000000_init', 'CREATE TABLE "a" ("id" TEXT NOT NULL, "x" TEXT);')
    run(['--write-baseline'])
    migration('20260102000000_drop_x', 'ALTER TABLE "a" DROP COLUMN "x";')
    expect(run().code).toBe(1)
    migration('20260102000000_drop_x', '-- migration-class: contract: x unused since release 1.4, expand step shipped in 1.3\nALTER TABLE "a" DROP COLUMN "x";')
    expect(run().code).toBe(0)
    migration('20260102000000_drop_x', '-- migration-class: contract: ok\nALTER TABLE "a" DROP COLUMN "x";')
    expect(run().code).toBe(1)
  })
  it('refuses a removed baseline migration, a bad directory name and a missing migration.sql', () => {
    migration('20260101000000_init', 'CREATE TABLE "a" ("id" TEXT NOT NULL);')
    run(['--write-baseline'])
    rmSync(join(dir, 'migrations', '20260101000000_init'), { recursive: true })
    expect(run().error.join('\n')).toMatch(/directory is gone/)
    mkdirSync(join(dir, 'migrations', 'not_a_timestamp'))
    mkdirSync(join(dir, 'migrations', '20260103000000_empty'))
    const r = run()
    expect(r.code).toBe(1)
    expect(r.error.join('\n')).toMatch(/not <14-digit timestamp>/)
    expect(r.error.join('\n')).toMatch(/migration.sql is missing/)
  })
  it('exits 2 when the baseline cannot be read', () => {
    expect(run().code).toBe(2)
  })
})

describe('migration lint: the repository itself', () => {
  it('the committed migrations match their frozen baseline', () => {
    const out = { log: () => undefined, error: jest.fn() }
    expect(lintMain([], out)).toBe(0)
    expect(out.error).not.toHaveBeenCalled()
  })
})

describe('compat probe: rules', () => {
  const col = (type: string, notNull: boolean, hasDefault = false) => ({ type, notNull, hasDefault })
  const snap = (columns: Record<string, ReturnType<typeof col>>, enums: string[] = []) => ({ columns, enums: new Set(enums) })
  const base = snap({ 'a.id': col('text', true), 'a.x': col('text', false) }, ['S:OPEN'])
  it('accepts expansion: new table, new nullable or defaulted column, new enum value', () => {
    expect(probeLib.diff(base, snap({ 'a.id': col('text', true), 'a.x': col('text', false), 'a.y': col('text', false), 'a.z': col('int4', true, true), 'b.id': col('text', true) }, ['S:OPEN', 'S:NEW']))).toEqual([])
  })
  it('rejects removed column, type change, new NOT NULL, new required column and removed enum value', () => {
    const problems = probeLib.diff(base, snap({ 'a.id': col('int4', true), 'a.x': col('text', true), 'a.req': col('text', true) }, []))
    expect(problems.join('\n')).toMatch(/a\.id: type text -> int4/)
    expect(problems.join('\n')).toMatch(/a\.x: became NOT NULL/)
    expect(problems.join('\n')).toMatch(/a\.req: new NOT NULL column without DEFAULT/)
    expect(problems.join('\n')).toMatch(/enum S:OPEN: value removed/)
    expect(probeLib.diff(base, snap({ 'a.id': col('text', true) }, ['S:OPEN'])).join('\n')).toMatch(/a\.x: removed/)
  })
})

const url = process.env.COMPAT_PROBE_DATABASE_URL
;(url ? describe : describe.skip)('compat probe: against a throwaway PostgreSQL', () => {
  jest.setTimeout(30000) // CREATE DATABASE on a cold server is slow
  let dir: string
  const migration = (name: string, sql: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'migration.sql'), sql) }
  const run = async (names: string[]) => {
    const baselineFile = join(dir, 'baseline.json')
    writeFileSync(baselineFile, JSON.stringify({ schema: 1, migrations: Object.fromEntries(names.map(n => [n, { class: 'additive', sha256: '' }])) }))
    const errors: string[] = []
    const code = await probeLib.main(['--dir', dir, '--baseline', baselineFile], { DATABASE_URL: url }, { log: () => undefined, error: (m: string) => errors.push(m) })
    return { code, errors }
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mig-probe-')); migration('20260101000000_init', 'CREATE TABLE "a" ("id" TEXT NOT NULL, "x" TEXT);') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts an additive new migration', async () => {
    migration('20260102000000_more', 'ALTER TABLE "a" ADD COLUMN "y" TEXT;\nCREATE TABLE "b" ("id" TEXT NOT NULL);')
    expect((await run(['20260101000000_init'])).code).toBe(0)
  })
  it('rejects a new migration that drops a column the previous version uses', async () => {
    migration('20260102000000_drop', 'ALTER TABLE "a" DROP COLUMN "x";')
    const r = await run(['20260101000000_init'])
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toMatch(/a\.x: removed/)
  })
  it('rejects a new required column without DEFAULT on an existing table', async () => {
    migration('20260102000000_req', 'ALTER TABLE "a" ADD COLUMN "must" TEXT NOT NULL DEFAULT \'\';\nALTER TABLE "a" ALTER COLUMN "must" DROP DEFAULT;')
    expect((await run(['20260101000000_init'])).code).toBe(1)
  })
  it('exits 2 when the baseline file is missing', async () => {
    const errors: string[] = []
    const code = await probeLib.main(['--dir', dir, '--baseline', join(dir, 'missing.json')], { DATABASE_URL: url }, { log: () => undefined, error: (m: string) => errors.push(m) })
    expect(code).toBe(2)
  })
})
