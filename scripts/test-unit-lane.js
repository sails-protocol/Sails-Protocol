// CTO Despacho 046: the unit lane never reaches a real database. DATABASE_URL is forced to an unroutable sentinel (no localhost
// fallback from src/config) and the integration-database confirmation is dropped, so any unit-lane suite that touches PostgreSQL
// fails loudly instead of running in parallel against a shared database. Usage: node scripts/test-unit-lane.js <jest args...>
const { spawnSync } = require('child_process')

const UNIT_LANE_DATABASE_URL = 'postgresql://unit-lane-has-no-database.invalid:5432/none'

function unitLaneEnv(base) {
  const env = { ...base, DATABASE_URL: UNIT_LANE_DATABASE_URL }
  delete env.SAILS_INTEGRATION_TEST_DB_CONFIRMED
  return env
}

module.exports = { UNIT_LANE_DATABASE_URL, unitLaneEnv }

if (require.main === module) {
  const r = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), ...process.argv.slice(2)], { stdio: 'inherit', env: unitLaneEnv(process.env) })
  if (r.error) throw r.error
  process.exit(r.status ?? 1)
}
