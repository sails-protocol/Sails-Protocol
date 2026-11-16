/**
 * Prisma 7 config (Dependabot major-version bump, 2026-07-19) — the CLI
 * (migrate/generate/studio)'s replacement for schema.prisma's now-removed
 * `datasource { url = env("DATABASE_URL") } ` line. The runtime client
 * (common/database/index.ts) gets its connection separately, via an
 * explicit driver adapter passed to `new PrismaClient({ adapter })` —
 * this file only covers the CLI side.
 * See https://pris.ly/d/config-datasource.
 */
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// prisma/config's own env() helper throws if the variable is unset, with
// no fallback param — this repo has never required a real .env to exist
// (config/index.ts's required() falls back to a local default for exactly
// this reason, e.g. running `npm test`/`npm run build` with no live
// Postgres). Matching that same fallback here so the CLI config doesn't
// hard-fail in the same environments the app itself tolerates.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // CTO 225 - the CLI (migrations) connects as sails_migrator when MIGRATION_DATABASE_URL is set;
    // DATABASE_URL is the application's (sails_runtime) and stays the fallback.
    url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/sails_protocol',
  },
})
