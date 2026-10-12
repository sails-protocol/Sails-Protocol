/**
 * ST1-R2: read-only diagnostic snapshots for CI's PostgreSQL preflight.
 *
 * Run against an explicitly authorized, disposable test database only.
 * This script does NOT repair or delete rows, change production preflight
 * semantics, or substitute for P1-P8 assertions.
 *
 * Example checkpoints (same DATABASE_URL for each):
 *   npx ts-node --transpile-only scripts/st1-r2-preflight-snapshot.ts after-migrations
 *   npm run test:unit
 *   npx ts-node --transpile-only scripts/st1-r2-preflight-snapshot.ts after-unit
 *   npm run test:integration:postgres
 *   npx ts-node --transpile-only scripts/st1-r2-preflight-snapshot.ts after-postgres
 *
 * Run suite 67 alone and suites 1–66 separately on independently reset
 * databases to attribute violations; never delete unidentified rows.
 */
import { assertTestDatabaseAuthorized } from '../tests/integration/postgresTestHarness'
import { runPreflight } from './multisig-script-authority-preflight'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  assertTestDatabaseAuthorized(url)
  const checkpoint = process.argv[2] ?? 'unspecified'
  const report = await runPreflight(url)
  console.log(JSON.stringify({ checkpoint, ...report }, null, 2))
  if (report.violating !== 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
