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
 */
import { readdirSync } from 'fs'
import { join } from 'path'

export interface MigrationRow {
  migration_name: string
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

/** Pure: which expected migrations are not cleanly applied or have an unfinished (failed) run. */
export function evaluateMigrationState(expected: string[], rows: MigrationRow[]): string[] {
  const problems: string[] = []
  const applied = new Set(rows.filter(r => r.finished_at !== null && r.rolled_back_at === null).map(r => r.migration_name))
  const shipped = new Set(expected)
  const failed = new Set(rows.filter(r => r.finished_at === null && r.rolled_back_at === null && shipped.has(r.migration_name)).map(r => r.migration_name))
  for (const name of failed) problems.push(`failed or interrupted: ${name}`)
  for (const name of expected) {
    if (!applied.has(name) && !failed.has(name)) problems.push(`pending: ${name}`)
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
  try {
    expected = listExpectedMigrations(dir)
  } catch {
    return refuse(`cannot read the migrations shipped with this build at ${dir}`)
  }
  if (expected.length === 0) return refuse(`no migrations found at ${dir}`)

  let rows: MigrationRow[]
  try {
    rows = await readRows()
  } catch {
    return refuse('the _prisma_migrations table cannot be read: the migration job has not run on this database')
  }

  const problems = evaluateMigrationState(expected, rows)
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ')
    return refuse(`${problems.length} problem(s): ${shown}${problems.length > 5 ? '; ...' : ''}`)
  }
}
