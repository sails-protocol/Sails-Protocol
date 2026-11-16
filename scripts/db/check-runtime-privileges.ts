/**
 * Read-only preflight of the production boot check (B3, CTO 306/316).
 *
 * Runs the same inspectRuntimePrivileges() the server runs at boot (src/common/database/runtime-privileges.ts),
 * against DATABASE_URL, without starting the application. Use it before a cutover, against the target database and
 * with the runtime credential, so a refusal shows up before the app is switched instead of at its first boot.
 *
 * Read-only by construction: the session is opened with default_transaction_read_only=on (verified before any check),
 * and the check itself only SELECTs from the catalog and sails_meta.
 *
 *   DATABASE_URL=postgresql://sails_runtime:...@host/db npm run db:check-runtime
 *   EXPECT_ROLE (default sails_runtime): refuse to run the check under any other role.
 *
 * Exit codes: 0 no finding; 3 findings (one per line); 4 connection, read-only or query error;
 * 5 the connected role is not EXPECT_ROLE.
 */
import { Client } from 'pg'
import { inspectRuntimePrivileges } from '../../src/common/database/runtime-privileges'

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('check-runtime-privileges: DATABASE_URL is required (the runtime credential of the target database)')
    return 4
  }
  const expectRole = process.env.EXPECT_ROLE || 'sails_runtime'
  const client = new Client({ connectionString: url, options: '-c default_transaction_read_only=on -c statement_timeout=30000' })
  try {
    await client.connect()
    const { rows: [session] } = await client.query(`SELECT current_user AS role, current_setting('default_transaction_read_only') AS ro`)
    if (session.ro !== 'on') {
      console.error('check-runtime-privileges: could not open a read-only session; refusing to run')
      return 4
    }
    if (session.role !== expectRole) {
      console.error(`check-runtime-privileges: connected as ${session.role}, expected ${expectRole}; refusing to run`)
      return 5
    }
    // The boot check's tagged-template queries, sent through this read-only connection.
    const query = async (sql: TemplateStringsArray, ...values: unknown[]) =>
      (await client.query(sql.reduce((text, part, i) => text + '$' + i + part), values)).rows
    const findings = await inspectRuntimePrivileges(query)
    if (findings.length === 0) {
      console.log(`check-runtime-privileges: OK - ${session.role} holds no privilege beyond its classification (read-only session)`)
      return 0
    }
    for (const finding of findings) console.log(finding)
    console.error(`check-runtime-privileges: ${findings.length} finding(s); the production boot check would refuse this connection`)
    return 3
  } catch (err) {
    console.error(`check-runtime-privileges: ${err instanceof Error ? err.message : String(err)}`)
    return 4
  } finally {
    await client.end().catch(() => undefined)
  }
}

main().then((code) => process.exit(code))
