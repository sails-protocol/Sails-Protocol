import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertMigrationsApplied, evaluateMigrationState, MigrationRow } from '../src/common/database/migration-gate'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const SQL: Record<string, string> = { '20260101_a': 'CREATE TABLE a(id int);\n', '20260102_b': 'CREATE TABLE b(id int);\n' }
// A row as Prisma writes it: the checksum is the SHA-256 of the migration.sql it applied.
const done = (name: string, sql: string = SQL[name] ?? '-- newer\n'): MigrationRow => ({ migration_name: name, checksum: sha(sql), finished_at: new Date(), rolled_back_at: null })

describe('migration gate (production server refuses an unmigrated database)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'))
    for (const [name, sql] of Object.entries(SQL)) {
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, 'migration.sql'), sql)
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts a database with every shipped migration finished', async () => {
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b')], dir)).resolves.toBeUndefined()
  })

  it('accepts a database AHEAD of this build, so a server rollback keeps working', async () => {
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b'), done('20260103_newer')], dir)).resolves.toBeUndefined()
  })

  it('refuses a pending migration', async () => {
    await expect(assertMigrationsApplied(async () => [done('20260101_a')], dir)).rejects.toThrow(/pending: 20260102_b/)
  })

  it('refuses a failed or interrupted run of a migration this build ships', async () => {
    const failed: MigrationRow = { ...done('20260102_b'), finished_at: null }
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), failed], dir)).rejects.toThrow(/failed or interrupted: 20260102_b/)
  })

  it('ignores a failed run of a migration THIS build does not ship (a blocked newer update must not turn a restart into an outage)', async () => {
    const newerFailed: MigrationRow = { ...done('20260999_newer'), finished_at: null }
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b'), newerFailed], dir)).resolves.toBeUndefined()
  })

  it('refuses a rolled-back migration that was not re-applied, accepts it once re-applied', async () => {
    const rolledBack: MigrationRow = { ...done('20260102_b'), rolled_back_at: new Date() }
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), rolledBack], dir)).rejects.toThrow(/pending: 20260102_b/)
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), rolledBack, done('20260102_b')], dir)).resolves.toBeUndefined()
  })

  it('treats an unreadable _prisma_migrations table as NOT migrated (unknown fails closed)', async () => {
    await expect(assertMigrationsApplied(async () => { throw new Error('relation "_prisma_migrations" does not exist') }, dir)).rejects.toThrow(/Refusing to boot/)
  })

  it('refuses when the migrations shipped with the build cannot be read or are empty', async () => {
    await expect(assertMigrationsApplied(async () => [], join(dir, 'does-not-exist'))).rejects.toThrow(/cannot read the migrations shipped/)
    const empty = mkdtempSync(join(tmpdir(), 'migrations-empty-'))
    try {
      await expect(assertMigrationsApplied(async () => [], empty)).rejects.toThrow(/no migrations found/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  describe('applied migrations are immutable (checksums)', () => {
    it('refuses a migration applied from a DIFFERENT file than the one shipped (edited after apply)', async () => {
      const editedAfterApply = done('20260102_b', SQL['20260102_b'] + '-- sneaky edit\n')
      await expect(assertMigrationsApplied(async () => [done('20260101_a'), editedAfterApply], dir)).rejects.toThrow(/checksum mismatch.*20260102_b/)
    })

    it('does not normalise line endings: the same SQL with CRLF is a different file', async () => {
      const crlf = done('20260101_a', SQL['20260101_a'].replace(/\n/g, '\r\n'))
      await expect(assertMigrationsApplied(async () => [crlf, done('20260102_b')], dir)).rejects.toThrow(/checksum mismatch.*20260101_a/)
    })

    it('compares every applied row of a name, but not the rolled-back or unfinished ones', async () => {
      const staleRolledBack: MigrationRow = { ...done('20260102_b', '-- old attempt\n'), rolled_back_at: new Date() }
      await expect(assertMigrationsApplied(async () => [done('20260101_a'), staleRolledBack, done('20260102_b')], dir)).resolves.toBeUndefined()
      const twoApplied = [done('20260101_a'), done('20260102_b'), done('20260102_b', '-- applied twice from another file\n')]
      await expect(assertMigrationsApplied(async () => twoApplied, dir)).rejects.toThrow(/checksum mismatch.*20260102_b/)
    })

    it('ignores the checksum of a migration this build does not ship', async () => {
      await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b'), done('20260999_newer', '-- whatever\n')], dir)).resolves.toBeUndefined()
    })

    it('refuses when a shipped migration has no migration.sql (cannot verify, so unknown)', async () => {
      rmSync(join(dir, '20260102_b', 'migration.sql'))
      await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b')], dir)).rejects.toThrow(/cannot read 20260102_b\/migration\.sql/)
    })
  })

  it('evaluateMigrationState reports nothing for an exact match, with or without checksums', () => {
    expect(evaluateMigrationState(['a'], [done('a', 'x')])).toEqual([])
    expect(evaluateMigrationState(['a'], [done('a', 'x')], new Map([['a', sha('x')]]))).toEqual([])
  })
})
