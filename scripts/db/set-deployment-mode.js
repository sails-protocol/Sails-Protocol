#!/usr/bin/env node
/**
 * Writes the single deployment_mode row (F4, CTO Despacho 030 gate 3). ADMIN action: run it with the database admin or sails_migrator, never with
 * the runtime role (it has SELECT only). Only 'development' and 'test' exist; there is no 'production' value: a production database has NO row.
 * The production boot check refuses to start when the row exists.
 *
 *   ADMIN_DATABASE_URL=postgresql://... node scripts/db/set-deployment-mode.js <development|test>
 *
 * Idempotent: the same mode again changes nothing; a different mode replaces the row (audited by created_by = the connected role).
 */
const { Client } = require('pg')

const MODES = ['development', 'test']

async function setDeploymentMode(client, mode) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')} (there is no 'production' value: production is the absence of the row)`)
  await client.query('BEGIN')
  try {
    await client.query('DELETE FROM deployment_mode WHERE mode <> $1', [mode])
    await client.query('INSERT INTO deployment_mode (mode) VALUES ($1) ON CONFLICT (singleton) DO NOTHING', [mode])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function main() {
  const url = process.env.ADMIN_DATABASE_URL
  if (!url) throw new Error('ADMIN_DATABASE_URL is required')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await setDeploymentMode(client, process.argv[2])
    console.log(`deployment_mode = ${process.argv[2]}`)
  } finally {
    await client.end()
  }
}

if (require.main === module) main().catch((e) => { console.error(`set-deployment-mode failed: ${e.message}`); process.exit(1) })
module.exports = { setDeploymentMode, MODES }
