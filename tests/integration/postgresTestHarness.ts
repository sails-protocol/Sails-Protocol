// tests/integration/postgresTestHarness.ts
//
// Missão 11 Fase 6.3B.1 — single source of truth for every real-Postgres
// integration test's connectivity + safety bootstrap. Replaces 11
// independently-copied beforeAll() probes (7 of which fell back to a
// hardcoded, permanently-unreachable ":5433" connection string and
// silently reported "passed" with zero assertions run — confirmed,
// reproduced false-green, Fase 6.3B §B) with one obvious, canonical path.
//
// Two responsibilities, deliberately not three:
// 1. Fail-CLOSED authorization — a real-Postgres integration test must
//    never run destructive operations against a database nobody
//    explicitly approved for that. No single weak signal (NODE_ENV,
//    a "test" substring in the name, or "it's on localhost") is treated
//    as sufficient alone; all three plus an explicit opt-in are required
//    together. This runs before the connectivity probe, so a missing
//    authorization is itself a test FAILURE, not a skip.
// 2. Fail-LOUD connectivity — once authorized, an unreachable Postgres
//    fails the tests that need it (requirePostgres() throws inside the
//    `it()` body, the same call-site shape every existing caller already
//    uses) rather than quietly no-op'ing while Jest reports green.
//
// Deliberately NOT a framework: no retry policies, no connection
// pooling, no generic "test context" abstraction. One probe, one
// authorization check, one throw helper.

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

export class TestDatabaseSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestDatabaseSafetyError'
  }
}

const AUTHORIZATION_ENV_VAR = 'SAILS_INTEGRATION_TEST_DB_CONFIRMED'
const AUTHORIZATION_VALUE = 'yes-i-am-sure'
const DEFAULT_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Never echo a raw connection string in an error — it may carry a real
// password. This is the only place in this file allowed to touch the
// url's credentials.
function redact(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.password) parsed.password = '***'
    if (parsed.username) parsed.username = '***'
    return parsed.toString()
  } catch {
    return '<connection string could not be parsed>'
  }
}

/**
 * Fails closed. Throws TestDatabaseSafetyError unless ALL of the
 * following hold at once — deliberately layered so that no single
 * factor (env name, host, db name) is ever, by itself, "proof enough":
 *
 *  1. SAILS_INTEGRATION_TEST_DB_CONFIRMED is set to the exact expected
 *     value (not just "truthy" — a stray `=1` left in a shared CI
 *     env-var group must not silently authorize this).
 *  2. The resolved DATABASE_URL parses as a valid URL.
 *  3. Its host is on the explicit allowlist (localhost/127.0.0.1/::1,
 *     or an operator-provided SAILS_TEST_DB_EXTRA_HOSTS for CI service
 *     containers reached by a non-localhost hostname).
 *  4. Its database name is non-empty and does not look like a
 *     production database (contains "prod"/"production").
 */
export function assertTestDatabaseAuthorized(rawUrl: string): void {
  if (process.env[AUTHORIZATION_ENV_VAR] !== AUTHORIZATION_VALUE) {
    throw new TestDatabaseSafetyError(
      `Destructive integration tests were BLOCKED.\n` +
        `Safety condition failed: explicit test-database authorization is missing.\n` +
        `${AUTHORIZATION_ENV_VAR} must be set to "${AUTHORIZATION_VALUE}".\n` +
        `To intentionally run this suite: set ${AUTHORIZATION_ENV_VAR}=${AUTHORIZATION_VALUE} ` +
        `in an environment whose DATABASE_URL points at a database you own and are ` +
        `willing to have destructively mutated by tests (e.g. your local dev Postgres, ` +
        `started via "npm run db:local:start").`,
    )
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new TestDatabaseSafetyError(
      `Destructive integration tests were BLOCKED.\n` +
        `Safety condition failed: DATABASE_URL is not a valid connection URL.`,
    )
  }

  // WHATWG URL keeps the brackets in .hostname for an IPv6 literal
  // (e.g. "[::1]") — strip them so "::1" compares equal to itself
  // regardless of which form a caller's connection string used.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const extraHosts = (process.env.SAILS_TEST_DB_EXTRA_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  const allowedHosts = new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts])
  if (!allowedHosts.has(host)) {
    throw new TestDatabaseSafetyError(
      `Destructive integration tests were BLOCKED.\n` +
        `Safety condition failed: host "${host}" is not an approved test-database host ` +
        `(allowed: localhost, 127.0.0.1, ::1, or a host listed in SAILS_TEST_DB_EXTRA_HOSTS).\n` +
        `Target: ${redact(rawUrl)}`,
    )
  }

  const dbName = parsed.pathname.replace(/^\//, '')
  if (!dbName || /prod|production/i.test(dbName)) {
    throw new TestDatabaseSafetyError(
      `Destructive integration tests were BLOCKED.\n` +
        `Safety condition failed: database name "${dbName || '(empty)'}" looks unsafe for tests.\n` +
        `Target: ${redact(rawUrl)}`,
    )
  }
}

export interface PostgresIntegrationHarness {
  /** Call once, inside beforeAll(). Throws TestDatabaseSafetyError if unauthorized. */
  probe(): Promise<void>
  isAvailable(): boolean
  getUrl(): string
  /** Same call-site shape every existing test file already uses: requirePostgres('Test name'). */
  requirePostgres(name: string): void
}

export function createPostgresIntegrationHarness(): PostgresIntegrationHarness {
  let available = false
  let url = ''

  return {
    async probe() {
      // Canonical resolution path only (Fase 6.3B §B1/A5) — never a
      // second, independently-guessed fallback.
      const { config } = require('../../src/config')
      url = config.database.url

      // Fails closed before any connection is even attempted.
      assertTestDatabaseAuthorized(url)

      const probeClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
      try {
        await probeClient.$queryRaw`SELECT 1`
        available = true
        // F4 gate 3 (CTO Despacho 030): the MOCK exemption of the escrow trigger exists only while deployment_mode has its row. A test database
        // is a 'test' environment, so the harness (already guarded by SAILS_INTEGRATION_TEST_DB_CONFIRMED + the host/name allowlist above)
        // writes it. As the restricted runtime role the INSERT is refused (SELECT only): CI then sets the row as ADMIN before it switches
        // to the runtime (scripts/db/set-deployment-mode.js), and a failure here is deliberately ignored (also on a pre-F4 database).
        await probeClient.$executeRaw`INSERT INTO deployment_mode (mode) VALUES ('test') ON CONFLICT (singleton) DO NOTHING`.catch(() => undefined)
      } catch {
        available = false
      } finally {
        await probeClient.$disconnect()
      }
    },

    isAvailable: () => available,
    getUrl: () => url,

    requirePostgres(name: string): void {
      if (!available) {
        throw new Error(
          `"${name}" requires a real Postgres connection, unreachable at ${redact(url)} — ` +
            `start it (npm run db:local:start) before running this suite.`,
        )
      }
    },
  }
}
