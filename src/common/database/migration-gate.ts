/**
 * Migration gate — a production server refuses to start on a database that is not fully
 * migrated to the schema THIS build ships.
 *
 * Migrations are applied by a separate job (the Dockerfile's `migrate` target, see
 * docs/DEPLOYMENT.md 6.0), never by the server. That ordering is enforced by whatever starts
 * the containers; this gate is the platform-independent second line: if the job failed, did
 * not run, or its result is unknown, the new server version does not come up, whichever host
 * or orchestrator launched it. Unknown is treated as not migrated (fail closed).
 *
 * A database that is AHEAD of this build (extra rows) is accepted: a server rollback to the
 * previous image must keep working, which is why migrations have to stay backward compatible.
 * Likewise a failed run of a migration THIS build does not ship (it belongs to a newer version
 * whose update was blocked) is ignored: otherwise a blocked update would turn any restart of the
 * still-running older server into an outage.
 *
 * Applied migrations are immutable: for every shipped migration the checksum Prisma stored when it applied
 * the file must equal the SHA-256 of the migration.sql shipped in this image. Prisma stores exactly that hash
 * of the file's raw bytes, does NOT normalise line endings, and neither `migrate status` nor `migrate deploy`
 * ever re-checks it (measured on 7.10), so this gate is the only place an edited-after-apply migration is caught.
 * No normalisation here either: it would hide real edits. A refusal therefore also means the database was
 * migrated from different BYTES than this image ships (e.g. a CRLF checkout vs an LF one: .gitattributes pins
 * prisma/migrations to LF so a checkout on any OS produces the same bytes).
 */
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

export interface MigrationRow {
  migration_name: string
  checksum: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'prisma', 'migrations')
}

export function listExpectedMigrations(dir: string = migrationsDir()): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/** SHA-256 (lowercase hex) of each shipped migration.sql, the value Prisma stores in _prisma_migrations.checksum. */
export function shippedChecksums(dir: string = migrationsDir()): Map<string, string> {
  const checksums = new Map<string, string>()
  for (const name of listExpectedMigrations(dir)) {
    try {
      checksums.set(name, createHash('sha256').update(readFileSync(join(dir, name, 'migration.sql'))).digest('hex'))
    } catch {
      throw new Error(`cannot read ${name}/migration.sql`)
    }
  }
  return checksums
}

/**
 * Pure: which expected migrations are not cleanly applied, have an unfinished (failed) run, or were applied
 * from a file that differs from the shipped one (checksums given by name; omit to skip that check).
 */
export function evaluateMigrationState(expected: string[], rows: MigrationRow[], checksums?: ReadonlyMap<string, string>): string[] {
  const problems: string[] = []
  const applied = new Set(rows.filter(r => r.finished_at !== null && r.rolled_back_at === null).map(r => r.migration_name))
  const shipped = new Set(expected)
  const failed = new Set(rows.filter(r => r.finished_at === null && r.rolled_back_at === null && shipped.has(r.migration_name)).map(r => r.migration_name))
  for (const name of failed) problems.push(`failed or interrupted: ${name}`)
  for (const name of expected) {
    if (!applied.has(name) && !failed.has(name)) problems.push(`pending: ${name}`)
  }
  if (checksums) {
    const changed = new Set(rows.filter(r => r.finished_at !== null && r.rolled_back_at === null && checksums.has(r.migration_name) && r.checksum !== checksums.get(r.migration_name)).map(r => r.migration_name))
    for (const name of [...changed].sort()) problems.push(`checksum mismatch (applied from a different file): ${name}`)
  }
  return problems
}

export async function assertMigrationsApplied(
  readRows: () => Promise<MigrationRow[]>,
  dir: string = migrationsDir(),
): Promise<void> {
  const refuse = (why: string): never => {
    throw new Error(
      `FATAL: NODE_ENV=production but the database is not verifiably migrated (${why}). Refusing to boot — ` +
        'run the migration job for THIS version first (docs/DEPLOYMENT.md 6.0); the server never migrates on start.',
    )
  }

  let expected: string[]
  let checksums: Map<string, string>
  try {
    expected = listExpectedMigrations(dir)
    checksums = shippedChecksums(dir)
  } catch (error) {
    return refuse(error instanceof Error && error.message.startsWith('cannot read') ? error.message : `cannot read the migrations shipped with this build at ${dir}`)
  }
  if (expected.length === 0) return refuse(`no migrations found at ${dir}`)

  let rows: MigrationRow[]
  try {
    rows = await readRows()
  } catch {
    return refuse('the _prisma_migrations table cannot be read: the migration job has not run on this database')
  }

  const problems = evaluateMigrationState(expected, rows, checksums)
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ')
    return refuse(`${problems.length} problem(s): ${shown}${problems.length > 5 ? '; ...' : ''}`)
  }
}
