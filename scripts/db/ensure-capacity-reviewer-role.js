#!/usr/bin/env node
/**
 * Creates the NOLOGIN reviewer role of the M-1b capacity unblock when it is missing (idempotent). For TEST/CI databases that are
 * migrated as a superuser WITHOUT scripts/db/bootstrap-roles.js running first; real installations get the role from bootstrap-roles.js.
 * The M-1b migration itself never creates a cluster role: it requires this one to exist.
 *
 *   ADMIN_DATABASE_URL   superuser URL of the target database
 */
const { Client } = require('pg')

async function ensureCapacityReviewerRole() {
  const url = process.env.ADMIN_DATABASE_URL
  if (!url) throw new Error('ADMIN_DATABASE_URL is required')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['sails_capacity_reviewer'])).rowCount) {
      await client.query('CREATE ROLE sails_capacity_reviewer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    }
  } finally { await client.end() }
}

if (require.main === module) ensureCapacityReviewerRole().then(() => console.log('sails_capacity_reviewer role present'), (e) => { console.error(e.message); process.exit(1) })
module.exports = { ensureCapacityReviewerRole }
