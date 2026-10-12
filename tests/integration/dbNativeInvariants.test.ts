// tests/integration/dbNativeInvariants.test.ts
//
// Missão 11 Fase 2.3 — CTO-mandated hardening gate.
//
// Fase 2.2 proved (manually, once) that `prisma validate` / `prisma migrate
// status` / `db:completeness-check` (`prisma migrate diff`) cannot detect a
// missing trigger — Prisma's diff engine only models tables/columns/
// indexes/constraints/enums, never trigger objects. That means an accidental
// `DROP TRIGGER` in production would leave every Prisma-native gate green
// while a financial-integrity defense silently disappeared. This file turns
// that one-time manual proof into a permanent, automated, real-Postgres
// regression gate.
//
// DESIGN DECISION (Fase 2.3 §3): a small declarative list
// (REQUIRED_DB_NATIVE_TRIGGERS) + one generic catalog-query helper
// (queryTriggerCatalog), not a standalone framework/package. Adding a
// future DB-native object Prisma doesn't model (another trigger, a
// check-constraint-via-function, etc.) means appending one entry to the
// array below — no new abstraction required. A dedicated registry/plugin
// system would be over-engineering for two objects; a single hardcoded
// `expect(name).toBe(...)` per trigger (no shared helper) would work today
// but wouldn't scale to a third object without copy-paste — this is the
// middle point the CTO asked for.
//
// Every check below queries pg_catalog directly (pg_trigger/pg_proc/
// pg_class), never a local TypeScript constant asserted against itself —
// the whole point is proving the REAL database's catalog agrees, not that
// this file agrees with itself.
//
// Docker-dependent sections (fresh-DB provisioning proof + negative-drop
// proof) follow tests/integration/docker.test.ts's own
// `execAsync('bash -c "docker info"')` skip-gracefully convention exactly —
// they never touch the persistent dev DB (Fase 2.3 §4's explicit
// instruction), and the normal `npx jest` run only requires Docker for
// these two sections, matching how docker.test.ts already skips when Docker
// isn't present.

import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const execAsync = promisify(exec)

// ─── The reusable gate surface ──────────────────────────────────────────────
interface RequiredTrigger {
  trigger: string
  table: string
  function: string
}

const REQUIRED_DB_NATIVE_TRIGGERS: RequiredTrigger[] = [
  { trigger: 'fee_policy_versions_immutability_guard', table: 'fee_policy_versions', function: 'fee_policy_versions_enforce_immutability' },
  { trigger: 'escrows_fee_snapshot_immutability_guard', table: 'escrows', function: 'escrows_enforce_fee_snapshot_immutability' },
  // Missão 11 Fase 6.5.2 — single-economic-authority cutover: Mechanism 1
  // (chargeProtocolFee()/FeeDistribution) and Mechanism 2
  // (FeeDistributionBatch/Item) are HISTORICAL / SUPERSEDED / WRITE-FROZEN.
  // Behavioral (INSERT/UPDATE/DELETE actually rejected) proof lives in
  // tests/integration/legacyFeeDistributionWriteFreeze.test.ts — this gate
  // only proves the guard trigger itself exists, is attached to the right
  // table, and is enabled, same division of labor as the two rows above.
  { trigger: 'fee_distributions_write_freeze_guard', table: 'fee_distributions', function: 'legacy_fee_distribution_enforce_write_freeze' },
  { trigger: 'fee_distribution_batches_write_freeze_guard', table: 'fee_distribution_batches', function: 'legacy_fee_distribution_enforce_write_freeze' },
  { trigger: 'fee_distribution_batch_items_write_freeze_guard', table: 'fee_distribution_batch_items', function: 'legacy_fee_distribution_enforce_write_freeze' },
  // Missão 11 Fase 7.3.2 §3 — append-only custody attestation. Behavioral
  // proof (reject edit/delete/un-supersede/double-supersede) lives in
  // tests/integration/custodyAttestationFoundation.test.ts — same
  // division of labor as every other row here.
  { trigger: 'custody_attestations_immutability_guard', table: 'custody_attestations', function: 'custody_attestations_enforce_immutability' },
  // #235 R7C — write-once payment-account attestation and trade ↔ account binding. Behavioral proof
  // lives in tests/integration/paymentAccountBindingAuthority.test.ts.
  { trigger: 'payment_accounts_attestation_write_once_guard', table: 'payment_accounts', function: 'payment_accounts_enforce_attestation_write_once' },
  { trigger: 'trades_seller_payment_account_write_once_guard', table: 'trades', function: 'trades_enforce_seller_payment_account_write_once' },
]

interface TriggerCatalogRow {
  trigger_name: string
  table_name: string
  function_name: string
  // pg_trigger.tgenabled: 'O' = enabled (origin), 'D' = disabled,
  // 'R' = enabled in replica mode, 'A' = always enabled. Anything other
  // than 'D' counts as enabled — checking `<> 'D'` rather than hardcoding
  // '= O' so this doesn't false-negative under a non-default
  // session_replication_role.
  tgenabled: string
}

/** Queries the REAL PostgreSQL system catalog for a single named trigger —
 *  no local constant is compared against itself anywhere in this function. */
async function queryTriggerCatalog(client: PrismaClient, triggerName: string): Promise<TriggerCatalogRow | null> {
  // t.tgenabled is Postgres's internal "char" pseudo-type — Prisma's raw
  // query deserializer refuses to guess a JS type for it (a real,
  // encountered error, not a hypothetical one: "Failed to deserialize
  // column of type 'char'"). Cast explicitly to text, same fix the error
  // message itself suggests.
  const rows = await client.$queryRaw<TriggerCatalogRow[]>(Prisma.sql`
    SELECT
      t.tgname AS trigger_name,
      c.relname AS table_name,
      p.proname AS function_name,
      t.tgenabled::text AS tgenabled
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_proc p ON t.tgfoid = p.oid
    WHERE t.tgname = ${triggerName}
      AND NOT t.tgisinternal
  `)
  return rows[0] ?? null
}

/** Runs the full REQUIRED_DB_NATIVE_TRIGGERS gate against a given client;
 *  returns the list of failures (empty = PASS). Used by all three sections
 *  below (upgraded-DB check, fresh-DB check, negative-drop proof) so the
 *  positive and negative proofs exercise the identical gate logic, not two
 *  slightly-different reimplementations. */
async function checkDbNativeInvariants(client: PrismaClient): Promise<string[]> {
  const failures: string[] = []
  for (const spec of REQUIRED_DB_NATIVE_TRIGGERS) {
    const row = await queryTriggerCatalog(client, spec.trigger)
    if (!row) {
      failures.push(`MISSING: trigger "${spec.trigger}" does not exist in pg_catalog at all`)
      continue
    }
    if (row.table_name !== spec.table) {
      failures.push(`WRONG TABLE: trigger "${spec.trigger}" is attached to "${row.table_name}", expected "${spec.table}"`)
    }
    if (row.function_name !== spec.function) {
      failures.push(`WRONG FUNCTION: trigger "${spec.trigger}" invokes "${row.function_name}", expected "${spec.function}"`)
    }
    if (row.tgenabled === 'D') {
      failures.push(`DISABLED: trigger "${spec.trigger}" exists but is disabled (tgenabled='D')`)
    }
  }
  return failures
}

// ─── Section 1 (mandate item F): the everyday regression gate, against ─────
// ─── whatever DB this Jest invocation already points at (the persistent ───
// ─── dev DB in normal use — the "upgraded from prior migrations" case) ─────
describe('DB-native invariants — required triggers (Missão 11 Fase 2.3, real Postgres)', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (dbAvailable) {
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getUrl() }) })
    }
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — delegates to the centralized harness
  // (tests/integration/postgresTestHarness.ts); throws instead of
  // silently skipping.
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  it.each(REQUIRED_DB_NATIVE_TRIGGERS)(
    'Test A/B/C/D/F: trigger "$trigger" exists on table "$table", invokes function "$function", and is enabled',
    async (spec) => {
      requirePostgres(spec.trigger)
      const row = await queryTriggerCatalog(prisma, spec.trigger)
      expect(row).not.toBeNull()
      expect(row!.table_name).toBe(spec.table)
      expect(row!.function_name).toBe(spec.function)
      expect(row!.tgenabled).not.toBe('D')
    }
  )

  it('full gate reports zero failures against the real database catalog', async () => {
    requirePostgres('full gate')
    const failures = await checkDbNativeInvariants(prisma)
    expect(failures).toEqual([])
  })
})

// ─── Section 2 (mandate item E + item 4's negative proof): a throwaway ─────
// ─── container, never the persistent dev DB. Positive proof (fresh-DB ─────
// ─── migration installs the objects correctly) followed by the negative ───
// ─── proof (dropping one trigger makes the SAME gate fail), then torn ──────
// ─── down. Skips gracefully if Docker isn't available — same convention ───
// ─── as tests/integration/docker.test.ts. ──────────────────────────────────
describe('DB-native invariants — fresh-DB provisioning + negative-drop proof (disposable container)', () => {
  // 300_000 (5 min) proved insufficient once, running this for real right
  // after a Docker Desktop restart (readiness took longer than usual under
  // host load) — 600_000 (10 min) gives real margin without approaching
  // docker.test.ts's own much-heavier 3_000_000 (that test builds a full
  // ~14GB application image; this one only starts a stock postgres:16-alpine
  // container and runs migrations against it).
  jest.setTimeout(600_000)

  const CONTAINER_NAME = 'sails-fase23-dbnative-gate-test'
  const HOST_PORT = 5435
  const FRESH_DB_URL = `postgresql://postgres:password@localhost:${HOST_PORT}/sails_protocol`

  let dockerAvailable = false

  beforeAll(async () => {
    try {
      await execAsync('bash -c "docker info"')
      dockerAvailable = true
    } catch {
      dockerAvailable = false
    }
  })

  afterAll(async () => {
    if (!dockerAvailable) return
    // Always tear the throwaway container down, pass or fail — never leaves
    // state behind, and never touches anything but this test's own
    // container name.
    await execAsync(`docker rm -f ${CONTAINER_NAME}`).catch(() => {})
  })

  it('fresh DB migrated from scratch installs both triggers correctly, then a manual drop makes the same gate fail (proving the gate actually detects the regression)', async () => {
    if (!dockerAvailable) {
      console.warn('Skipping fresh-DB provisioning + negative-drop proof — Docker is not available in this environment.')
      return
    }

    // 1. Provision a brand-new, empty Postgres container.
    await execAsync(
      `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=sails_protocol -p ${HOST_PORT}:5432 postgres:16-alpine`
    )

    // Wait for readiness. Real, reproduced-by-hand gap (Missão 11 Fase 2.3):
    // the official postgres image runs a brief, TRANSIENT bootstrap
    // instance to execute init scripts, shuts it down, then starts the real
    // long-running server — `pg_isready` can catch that brief bootstrap
    // window as a false "ready" signal (confirmed by manually running the
    // identical `docker run` and watching the logs: pg_isready succeeded at
    // ~2s, while the log timestamps showed the bootstrap-shutdown-restart
    // cycle still in progress at that exact moment). A single success is
    // not trustworthy — require two consecutive successes a few seconds
    // apart before trusting it, and use a generous bound (this container
    // startup competes with whatever else is running on the host, e.g.
    // right after a Docker Desktop restart).
    let ready = false
    let consecutiveSuccesses = 0
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        await execAsync(`docker exec ${CONTAINER_NAME} pg_isready -U postgres`)
        consecutiveSuccesses++
        if (consecutiveSuccesses >= 2) {
          ready = true
        } else {
          await new Promise((r) => setTimeout(r, 3000))
        }
      } catch {
        consecutiveSuccesses = 0
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    expect(ready).toBe(true)

    // Real gap found running this for real (Missão 11 Fase 2.3, right after
    // a Docker Desktop restart): `pg_isready` succeeding INSIDE the
    // container does not guarantee the HOST-side port mapping is already
    // accepting connections yet — a `prisma migrate deploy` fired
    // immediately afterward hit a real `P1001: Can't reach database server
    // at localhost:5435`. Bounded retry on an actual HOST-side connection
    // (not just the in-container check above) before trusting the mapping.
    let hostReachable = false
    for (let i = 0; i < 15 && !hostReachable; i++) {
      const probe = new PrismaClient({ adapter: new PrismaPg({ connectionString: FRESH_DB_URL }) })
      try {
        await probe.$queryRaw`SELECT 1`
        hostReachable = true
      } catch {
        await new Promise((r) => setTimeout(r, 2000))
      } finally {
        await probe.$disconnect()
      }
    }
    expect(hostReachable).toBe(true)

    // 2. Apply the FULL migration history from scratch (mandate item E).
    await execAsync('npx prisma migrate deploy', {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: FRESH_DB_URL },
    })

    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: FRESH_DB_URL }) })
    try {
      // 3. POSITIVE PROOF: gate passes on a correctly-migrated fresh DB.
      const positiveFailures = await checkDbNativeInvariants(client)
      expect(positiveFailures).toEqual([])

      // 4. NEGATIVE PROOF (mandate item 4): drop one trigger, rerun the
      //    IDENTICAL gate function, prove it now fails — this is the actual
      //    evidence that the gate would catch a real accidental regression,
      //    not just that it can read a name off a healthy database.
      await client.$executeRawUnsafe(`DROP TRIGGER fee_policy_versions_immutability_guard ON fee_policy_versions`)
      const negativeFailures = await checkDbNativeInvariants(client)
      expect(negativeFailures.length).toBeGreaterThan(0)
      expect(negativeFailures[0]).toMatch(/MISSING: trigger "fee_policy_versions_immutability_guard"/)
      // The untouched second trigger must still report clean — the gate
      // correctly isolates which specific object regressed, not a blanket
      // "something is wrong" signal.
      expect(negativeFailures.some((f) => f.includes('escrows_fee_snapshot_immutability_guard'))).toBe(false)
    } finally {
      await client.$disconnect()
      // Container itself is destroyed in afterAll — no attempt to "restore"
      // the dropped trigger in place, since this is a disposable container
      // being torn down entirely, never the persistent dev DB (Fase 2.3 §4).
    }
  })
})
