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
import { Client } from 'pg'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  assertTestDatabaseAuthorized(url)
  const checkpoint = process.argv[2] ?? 'unspecified'
  const report = await runPreflight(url)
  // Attribution is diagnostic only: do not change the global preflight query.
  const violatingIds = [...new Set(Object.values(report.violations).flat().map((row) => row.id))]
  let attribution: Array<{
    escrowId: string
    tradeId: string | null
    buyerFixture: string | null
    sellerFixture: string | null
  }> = []
  if (violatingIds.length) {
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const result = await client.query<{
        escrowId: string
        tradeId: string | null
        buyerFixture: string | null
        sellerFixture: string | null
      }>(`
        SELECT e.id AS "escrowId", t.id AS "tradeId",
               buyer."displayName" AS "buyerFixture",
               seller."displayName" AS "sellerFixture"
        FROM escrows e
        LEFT JOIN trades t ON t.id = e."tradeId"
        LEFT JOIN users buyer ON buyer.id = t."buyerId"
        LEFT JOIN users seller ON seller.id = t."sellerId"
        WHERE e.id = ANY($1::text[])
        ORDER BY e.id
      `, [violatingIds])
      attribution = result.rows
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  }
  console.log(JSON.stringify({ checkpoint, ...report, attribution }, null, 2))
  if (report.violating !== 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
