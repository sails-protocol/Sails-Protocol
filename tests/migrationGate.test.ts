import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertMigrationsApplied, evaluateMigrationState, MigrationRow } from '../src/common/database/migration-gate'

const done = (name: string): MigrationRow => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null })

describe('migration gate (production server refuses an unmigrated database)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'))
    for (const name of ['20260101_a', '20260102_b']) mkdirSync(join(dir, name))
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
    const failed: MigrationRow = { migration_name: '20260102_b', finished_at: null, rolled_back_at: null }
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), failed], dir)).rejects.toThrow(/failed or interrupted: 20260102_b/)
  })

  it('ignores a failed run of a migration THIS build does not ship (a blocked newer update must not turn a restart into an outage)', async () => {
    const newerFailed: MigrationRow = { migration_name: '20260999_newer', finished_at: null, rolled_back_at: null }
    await expect(assertMigrationsApplied(async () => [done('20260101_a'), done('20260102_b'), newerFailed], dir)).resolves.toBeUndefined()
  })

  it('refuses a rolled-back migration that was not re-applied, accepts it once re-applied', async () => {
    const rolledBack: MigrationRow = { migration_name: '20260102_b', finished_at: new Date(), rolled_back_at: new Date() }
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

  it('evaluateMigrationState reports nothing for an exact match', () => {
    expect(evaluateMigrationState(['a'], [done('a')])).toEqual([])
  })
})
