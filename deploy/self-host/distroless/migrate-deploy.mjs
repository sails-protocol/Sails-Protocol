// EXPERIMENT (P3-R2.1): scripts/migrate-deploy.sh re-implemented in Node so the migration image
// can run on a base without a shell (Distroless). Same contract as the shell script:
//   - DATABASE_URL must be set (exit 64 otherwise; no localhost fallback for migrations);
//   - `prisma migrate deploy`, then `prisma migrate status` as proof;
//   - exit 0 ONLY when both succeeded; any failure exits non-zero;
//   - nothing derived from DATABASE_URL is printed by this script.
import { spawnSync } from 'node:child_process'

if (!process.env.DATABASE_URL) {
  console.error('migrate: DATABASE_URL is not set; refusing to run (no localhost fallback for migrations)')
  process.exit(64)
}

const prisma = 'node_modules/prisma/build/index.js'

function run(args) {
  const result = spawnSync(process.execPath, [prisma, ...args], { stdio: 'inherit' })
  if (result.error) {
    console.error(`migrate: could not start prisma: ${result.error.message}`)
    process.exit(70)
  }
  if (result.signal) {
    console.error(`migrate: prisma was terminated by ${result.signal}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('migrate: applying pending migrations')
run(['migrate', 'deploy'])
console.log('migrate: verifying')
run(['migrate', 'status'])
console.log('migrate: database is up to date')
