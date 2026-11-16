/**
 * CTO 225 - PostgreSQL role segregation, adversarial proof on a disposable database.
 *
 * A fresh database is created next to the integration database, bootstrapped by
 * scripts/db/bootstrap-roles.js (administrator), migrated and granted by
 * scripts/migrate-deploy-safe.sh (sails_migrator), and then driven as
 * sails_runtime - the role the application uses. The suite proves that the
 * runtime can do its legitimate writes but can neither mutate nor delete
 * append-only rows, nor switch off or replace the triggers that guard them,
 * nor escalate to the migrator or administrator; that a privileged control
 * connection on the same database CAN resurrect a cancelled offer (the gap
 * this closes); that the privilege matrix matches its classification; that an
 * unclassified table blocks the grant step; and that the production boot check
 * refuses privileged connections.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { signOfferEnvelope, type OfferEnvelopeContent } from '../../src/modules/open-liquidity/offer-envelope'

const ROOT = join(__dirname, '..', '..')
const MIGRATOR_PASSWORD = `migrator-${randomUUID()}`
const RUNTIME_PASSWORD = `runtime-${randomUUID()}`
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const
const CLASS_PRIVILEGES: Record<string, string[]> = {
  read: ['SELECT'],
  append: ['SELECT', 'INSERT'],
  mutable: ['SELECT', 'INSERT', 'UPDATE'],
  append_delete: ['SELECT', 'INSERT', 'DELETE'],
  mutable_delete: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
}

function withUser(url: string, user: string | null, password: string | null, db: string): string {
  const u = new URL(url)
  if (user !== null) u.username = user
  if (password !== null) u.password = password
  u.pathname = `/${db}`
  return u.toString()
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function classification(): Map<string, string> {
  const sql = readFileSync(join(ROOT, 'scripts', 'db', 'runtime-grants.sql'), 'utf8')
  return new Map([...sql.matchAll(/\('([a-z_]+)', '(read|append|mutable|append_delete|mutable_delete)'\)/g)].map((m) => [m[1], m[2]]))
}

async function expectSqlError(client: Client, sql: string, code = '42501'): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({ code })
}

describe('CTO 225 - runtime role cannot bypass write-once guarantees (disposable PostgreSQL)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  const dbName = `sails_priv_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  let adminBase: Client
  let admin: Client
  let runtime: Client
  let adminUrl = ''
  let adminUser = ''
  let migratorUrl = ''
  let runtimeUrl = ''
  // Application modules loaded with DATABASE_URL = sails_runtime (their own prisma singleton).
  let app: {
    repo: import('../../src/modules/open-liquidity/offer-envelope-repository').OfferEnvelopeRepository
    eventStore: import('../../src/common/events/event-store').PostgresEventStore
    withIdempotency: typeof import('../../src/common/idempotency').withIdempotency
    privileges: typeof import('../../src/common/database/runtime-privileges')
    prisma: import('@prisma/client').PrismaClient
  }

  function grant(env: Record<string, string>) {
    return execFileSync('npx', ['prisma', 'db', 'execute', '--file', 'scripts/db/runtime-grants.sql'], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32',
    })
  }

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('runtime privilege segregation')
    const base = pg.getUrl()
    adminBase = new Client({ connectionString: base })
    await adminBase.connect()
    await adminBase.query(`CREATE DATABASE ${dbName}`)
    adminUrl = withUser(base, null, null, dbName)
    adminUser = decodeURIComponent(new URL(base).username)
    migratorUrl = withUser(base, 'sails_migrator', MIGRATOR_PASSWORD, dbName)
    runtimeUrl = withUser(base, 'sails_runtime', RUNTIME_PASSWORD, dbName)

    const env = { ...process.env, ADMIN_DATABASE_URL: adminUrl, SAILS_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD, SAILS_RUNTIME_PASSWORD: RUNTIME_PASSWORD }
    execFileSync(process.execPath, ['scripts/db/bootstrap-roles.js'], { cwd: ROOT, env, stdio: 'pipe' })
    execFileSync('sh', ['scripts/migrate-deploy-safe.sh'], { cwd: ROOT, env: { ...env, MIGRATION_DATABASE_URL: migratorUrl }, stdio: 'pipe' })

    admin = new Client({ connectionString: adminUrl })
    runtime = new Client({ connectionString: runtimeUrl })
    await admin.connect()
    await runtime.connect()

    const previousUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = runtimeUrl
    delete (global as { __prisma?: unknown }).__prisma
    jest.isolateModules(() => {
      const { OfferEnvelopeRepository } = require('../../src/modules/open-liquidity/offer-envelope-repository')
      const { PostgresEventStore } = require('../../src/common/events/event-store')
      app = {
        repo: new OfferEnvelopeRepository(),
        eventStore: new PostgresEventStore(),
        withIdempotency: require('../../src/common/idempotency').withIdempotency,
        privileges: require('../../src/common/database/runtime-privileges'),
        prisma: require('../../src/common/database').prisma,
      }
    })
    process.env.DATABASE_URL = previousUrl
  })

  afterAll(async () => {
    await app?.prisma.$disconnect().catch(() => {})
    await runtime?.end().catch(() => {})
    await admin?.end().catch(() => {})
    if (adminBase) {
      await adminBase.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
      await adminBase.end()
    }
  })

  function envelope(owner: { publicKeyHex: string; secretKeyHex: string }, logicalOfferId: string, revision: number, status: 'ACTIVE' | 'CANCELLED') {
    const content: OfferEnvelopeContent = {
      logicalOfferId, ownerPublicKey: owner.publicKeyHex, asset: 'BTC', side: 'SELL', priceUsd: '65000.00000000',
      minAmount: '0.00100000', maxAmount: '0.50000000', paymentMethod: 'PIX', revision,
      createdAt: '2026-11-15T00:00:00.000Z', revisedAt: `2026-11-15T00:0${revision}:00.000Z`, expiresAt: '2099-01-01T00:00:00.000Z', status,
    }
    return { ...content, signature: signOfferEnvelope(content, owner.secretKeyHex) }
  }

  async function offerWithTombstone() {
    const kp = nacl.sign.keyPair()
    const owner = { publicKeyHex: hex(kp.publicKey), secretKeyHex: hex(kp.secretKey) }
    const logicalOfferId = `priv-${randomUUID()}`
    await app.repo.ingest(envelope(owner, logicalOfferId, 1, 'ACTIVE'))
    await app.repo.ingest(envelope(owner, logicalOfferId, 2, 'CANCELLED'))
    return { owner, logicalOfferId }
  }

  it('the runtime role has no elevated attribute, owns nothing and is a member of no role', async () => {
    const { rows: [r] } = await admin.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
         FROM pg_roles r WHERE rolname = 'sails_runtime'`)
    expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false, memberships: 0, owned: 0 })
    const { rows: [m] } = await admin.query(`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = 'sails_migrator'`)
    expect(m).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false })
    const { rows: [{ owners }] } = await admin.query(
      `SELECT array_agg(DISTINCT pg_get_userbyid(c.relowner)::text) AS owners FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`)
    expect(owners).toEqual(['sails_migrator'])
  })

  it('the privilege matrix matches the classification for every table, and no table is unclassified', async () => {
    const classes = classification()
    const { rows: tables } = await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`)
    expect(tables.map((t) => t.tablename).sort()).toEqual([...classes.keys()].sort())
    const mismatches: string[] = []
    for (const [table, cls] of classes) {
      for (const privilege of PRIVILEGES) {
        const { rows: [{ has }] } = await admin.query(`SELECT has_table_privilege('sails_runtime', $1, $2) AS has`, [`public.${table}`, privilege])
        if (has !== CLASS_PRIVILEGES[cls].includes(privilege)) mismatches.push(`${table}.${privilege}=${has} (class ${cls})`)
      }
    }
    expect(mismatches).toEqual([])
    const { rows: [{ migrations }] } = await admin.query(`SELECT has_table_privilege('sails_runtime', 'public._prisma_migrations', 'SELECT') AS migrations`)
    expect(migrations).toBe(false)
    // The only column-level grant: custody_attestations."supersededAt" (one-time NULL -> timestamp, trigger-guarded).
    const { rows: writes } = await admin.query(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = 'sails_runtime' AND table_schema = 'public' AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`)
    const columnGrants = writes.filter((w) => !CLASS_PRIVILEGES[classes.get(w.table_name)!].includes(w.privilege_type))
    expect(columnGrants.sort((a, b) => a.table_name.localeCompare(b.table_name))).toEqual([
      { table_name: 'custody_attestations', column_name: 'supersededAt', privilege_type: 'UPDATE' },
      { table_name: 'intent_events', column_name: 'publishedAt', privilege_type: 'UPDATE' },
    ])
    // The one inventory the boot check reads (N1) is exactly the applied classification.
    const { rows: recorded } = await admin.query('SELECT table_name, class FROM sails_meta.runtime_table_class ORDER BY 1')
    expect(recorded).toEqual([...classes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([table_name, cls]) => ({ table_name, class: cls })))
    const { rows: recordedColumns } = await admin.query('SELECT table_name, column_name FROM sails_meta.runtime_column_update ORDER BY 1, 2')
    expect(recordedColumns).toEqual([
      { table_name: 'custody_attestations', column_name: 'supersededAt' },
      { table_name: 'intent_events', column_name: 'publishedAt' },
    ])
  })

  it('N4: the runtime can read but never modify the sails_meta inventory, and the boot check refuses any grant that would let it', async () => {
    const { rows } = await runtime.query('SELECT count(*)::int AS n FROM sails_meta.runtime_table_class')
    expect(rows[0].n).toBe(classification().size)
    for (const sql of [
      "INSERT INTO sails_meta.runtime_table_class VALUES ('zz', 'mutable_delete')",
      "UPDATE sails_meta.runtime_table_class SET class = 'mutable_delete' WHERE table_name = 'offer_envelopes'",
      'DELETE FROM sails_meta.runtime_table_class',
      'TRUNCATE sails_meta.runtime_table_class',
      "INSERT INTO sails_meta.runtime_column_update VALUES ('offer_envelopes', 'status')",
      'DELETE FROM sails_meta.runtime_column_update',
      'ALTER TABLE sails_meta.runtime_table_class DROP CONSTRAINT runtime_table_class_class_check',
      'DROP TABLE sails_meta.runtime_column_update',
      'CREATE TABLE sails_meta.zz (id int)',
      'ALTER SCHEMA sails_meta RENAME TO zz_meta',
    ]) await expectSqlError(runtime, sql)
    const check = () => app.privileges.inspectRuntimePrivileges()
    expect(await check()).toEqual([])
    const breaches: Array<[string, string, RegExp]> = [
      ['GRANT UPDATE ON sails_meta.runtime_table_class TO sails_runtime', 'REVOKE UPDATE ON sails_meta.runtime_table_class FROM sails_runtime', /can modify the privilege classification \(runtime_table_class:UPDATE\)/],
      ['GRANT INSERT ON sails_meta.runtime_column_update TO PUBLIC', 'REVOKE INSERT ON sails_meta.runtime_column_update FROM PUBLIC', /can modify the privilege classification \(runtime_column_update:INSERT\)/],
      ['GRANT DELETE, TRUNCATE ON sails_meta.runtime_table_class TO PUBLIC', 'REVOKE DELETE, TRUNCATE ON sails_meta.runtime_table_class FROM PUBLIC', /runtime_table_class:DELETE, runtime_table_class:TRUNCATE/],
      ['GRANT UPDATE ("class") ON sails_meta.runtime_table_class TO sails_runtime', 'REVOKE UPDATE ("class") ON sails_meta.runtime_table_class FROM sails_runtime', /runtime_table_class:UPDATE/],
      ['GRANT CREATE ON SCHEMA sails_meta TO sails_runtime', 'REVOKE CREATE ON SCHEMA sails_meta FROM sails_runtime', /can CREATE in schema sails_meta/],
      ['ALTER TABLE sails_meta.runtime_column_update OWNER TO sails_runtime', 'ALTER TABLE sails_meta.runtime_column_update OWNER TO sails_migrator', /owns \d+ relation\(s\) in schema sails_meta/], // the table and its primary-key index
      ['GRANT sails_migrator TO sails_runtime', 'REVOKE sails_migrator FROM sails_runtime', /is a member of 1 other role/],
    ]
    for (const [breach, undo, expected] of breaches) {
      await admin.query(breach)
      try {
        expect((await check()).join('; ')).toMatch(expected)
      } finally {
        await admin.query(undo)
      }
    }
    grant({ MIGRATION_DATABASE_URL: migratorUrl }) // an ownership round trip drops the runtime's SELECT; the grant step restores the baseline
    expect(await check()).toEqual([])
  })

  it('MG1/MG2: re-running the grant step revokes stale table and column grants; the boot check refuses them in between (N2)', async () => {
    const check = () => app.privileges.inspectRuntimePrivileges()
    expect(await check()).toEqual([])
    await admin.query('GRANT UPDATE ("descriptor") ON custody_attestations TO sails_runtime') // stale column grant
    await admin.query('GRANT DELETE ON offer_envelopes TO sails_runtime') // stale table grant
    await admin.query('GRANT UPDATE ON fee_distributions TO sails_runtime') // stale table grant on a frozen table
    await admin.query('GRANT INSERT ("id") ON fee_distributions TO sails_runtime') // stale column grant on a read table
    const between = (await check()).join('\n')
    expect(between).toMatch(/has UPDATE on custody_attestations\.descriptor beyond its privilege class \(append\)/)
    expect(between).toMatch(/has DELETE on offer_envelopes beyond its privilege class \(append\)/)
    expect(between).toMatch(/has UPDATE on fee_distributions beyond its privilege class \(read\)/)
    expect(between).toMatch(/has INSERT on fee_distributions\.id beyond its privilege class \(read\)/)
    grant({ MIGRATION_DATABASE_URL: migratorUrl })
    const { rows: [after] } = await admin.query(
      `SELECT has_column_privilege('sails_runtime', 'public.custody_attestations', 'descriptor', 'UPDATE') AS col,
              has_table_privilege('sails_runtime', 'public.offer_envelopes', 'DELETE') AS del,
              has_table_privilege('sails_runtime', 'public.fee_distributions', 'UPDATE') AS upd,
              has_column_privilege('sails_runtime', 'public.fee_distributions', 'id', 'INSERT') AS ins,
              has_column_privilege('sails_runtime', 'public.custody_attestations', 'supersededAt', 'UPDATE') AS kept`)
    expect(after).toEqual({ col: false, del: false, upd: false, ins: false, kept: true })
    expect(await check()).toEqual([])
  })

  it('custody_attestations: the runtime may supersede (supersededAt) but cannot rewrite or delete an attestation', async () => {
    await expect(runtime.query(`UPDATE custody_attestations SET "supersededAt" = now() WHERE id = $1`, [randomUUID()])).resolves.toMatchObject({ rowCount: 0 })
    for (const column of ['descriptor', 'attestedBy', 'attestedAt', 'createdAt', 'id', 'recipientId']) {
      await expectSqlError(runtime, `UPDATE custody_attestations SET "${column}" = "${column}"`)
    }
    await expectSqlError(runtime, 'DELETE FROM custody_attestations')
    await expectSqlError(runtime, 'TRUNCATE custody_attestations')
  })

  it('the grant step fails when sails_runtime is missing; the legacy single credential is an explicit opt-in', async () => {
    const sql = readFileSync(join(ROOT, 'scripts', 'db', 'runtime-grants.sql'), 'utf8')
      .replace("runtime_role constant text := 'sails_runtime'", "runtime_role constant text := 'sails_runtime_absent'")
    const tmp = `runtime-grants-absent-${randomUUID()}.sql` // relative to ROOT: the prisma CLI path must not contain spaces on Windows
    require('fs').writeFileSync(join(ROOT, tmp), sql)
    let output = ''
    try {
      execFileSync('npx', ['prisma', 'db', 'execute', '--file', tmp], {
        cwd: ROOT, env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl }, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32',
      })
    } catch (err) {
      output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`
    } finally {
      require('fs').unlinkSync(join(ROOT, tmp))
    }
    expect(output).toMatch(/role sails_runtime_absent does not exist/)
    // Neither a migrator URL nor the legacy opt-in: refused before any migration runs.
    let refused = ''
    try {
      execFileSync('sh', ['scripts/migrate-deploy-safe.sh'], {
        cwd: ROOT, env: { ...process.env, MIGRATION_DATABASE_URL: '', SAILS_LEGACY_SINGLE_CREDENTIAL: '', DATABASE_URL: adminUrl }, encoding: 'utf8', stdio: 'pipe',
      })
    } catch (err) {
      refused = String((err as { stderr?: string }).stderr ?? '')
    }
    expect(refused).toMatch(/set MIGRATION_DATABASE_URL .* or, for a legacy single-credential database only, SAILS_LEGACY_SINGLE_CREDENTIAL=1/)
    const legacy = execFileSync('sh', ['scripts/migrate-deploy-safe.sh'], {
      cwd: ROOT, env: { ...process.env, MIGRATION_DATABASE_URL: '', SAILS_LEGACY_SINGLE_CREDENTIAL: '1', DATABASE_URL: adminUrl }, encoding: 'utf8', stdio: 'pipe',
    })
    expect(legacy).toMatch(/SAILS_LEGACY_SINGLE_CREDENTIAL=1: legacy single-credential database, runtime grants NOT applied/)
  })

  it('the runtime ingests and reads offers and tombstones through the real repository', async () => {
    const { owner, logicalOfferId } = await offerWithTombstone()
    const latest = await app.repo.getLatest(owner.publicKeyHex, logicalOfferId)
    expect(latest).toMatchObject({ status: 'RESOLVED', row: { revision: 2, status: 'CANCELLED' } })
  })

  it('UPDATE, DELETE and TRUNCATE on append-only tables are refused by privilege, before any trigger', async () => {
    const { logicalOfferId } = await offerWithTombstone()
    for (const table of ['offer_envelopes', 'escrow_pending_round_retirements']) {
      await expectSqlError(runtime, `UPDATE ${table} SET "id" = "id"`)
      await expectSqlError(runtime, `DELETE FROM ${table}`)
      await expectSqlError(runtime, `TRUNCATE ${table}`)
    }
    await expectSqlError(runtime, `DELETE FROM offer_envelopes WHERE "logicalOfferId" = '${logicalOfferId}' AND revision = 2`)
  })

  it('the runtime cannot switch off, drop or replace the guards, nor escalate to the migrator or administrator', async () => {
    const attempts = [
      'ALTER TABLE offer_envelopes DISABLE TRIGGER offer_envelopes_immutability_guard',
      'ALTER TABLE offer_envelopes DISABLE TRIGGER ALL',
      'DROP TRIGGER offer_envelopes_immutability_guard ON offer_envelopes',
      'CREATE OR REPLACE FUNCTION public.offer_envelopes_refuse_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      'ALTER TABLE offer_envelopes OWNER TO sails_runtime',
      'SET session_replication_role = replica',
      'SET ROLE sails_migrator',
      `SET ROLE "${adminUser}"`,
      'ALTER ROLE sails_runtime SUPERUSER',
      'CREATE TABLE public.zz_runtime_probe (id int)',
      'SELECT * FROM _prisma_migrations',
    ]
    for (const sql of attempts) await expectSqlError(runtime, sql)
    // A GRANT by a non-owner is only a warning in PostgreSQL; prove it granted nothing.
    await runtime.query('GRANT UPDATE, DELETE, TRUNCATE ON offer_envelopes TO sails_runtime').catch(() => {})
    const { rows: [{ has }] } = await runtime.query(`SELECT has_table_privilege('public.offer_envelopes', 'UPDATE, DELETE, TRUNCATE') AS has`)
    expect(has).toBe(false)
    const { rows: [{ enabled }] } = await admin.query(`SELECT tgenabled AS enabled FROM pg_trigger WHERE tgname = 'offer_envelopes_immutability_guard'`)
    expect(enabled).toBe('O')
  })

  it('after every attempt the tombstone still wins and the revisions are intact and verified', async () => {
    const { owner, logicalOfferId } = await offerWithTombstone()
    await runtime.query(`DELETE FROM offer_envelopes WHERE "logicalOfferId" = $1 AND revision = 2`, [logicalOfferId]).catch(() => {})
    await runtime.query(`UPDATE offer_envelopes SET status = 'ACTIVE' WHERE "logicalOfferId" = $1`, [logicalOfferId]).catch(() => {})
    const { rows } = await admin.query(`SELECT revision, status FROM offer_envelopes WHERE "logicalOfferId" = $1 ORDER BY revision`, [logicalOfferId])
    expect(rows).toEqual([{ revision: 1, status: 'ACTIVE' }, { revision: 2, status: 'CANCELLED' }])
    expect(await app.repo.getLatest(owner.publicKeyHex, logicalOfferId)).toMatchObject({ status: 'RESOLVED', row: { revision: 2, status: 'CANCELLED' } })
  })

  it('control: a privileged connection on the same disposable database CAN resurrect the cancelled offer', async () => {
    const { owner, logicalOfferId } = await offerWithTombstone()
    await admin.query('BEGIN')
    await admin.query('SET LOCAL session_replication_role = replica')
    await admin.query(`DELETE FROM offer_envelopes WHERE "logicalOfferId" = $1 AND revision = 2`, [logicalOfferId])
    await admin.query('COMMIT')
    expect(await app.repo.getLatest(owner.publicKeyHex, logicalOfferId)).toMatchObject({ status: 'RESOLVED', row: { revision: 1, status: 'ACTIVE' } })
  })

  it('regression as runtime: the durable event store publishes and reads its hash chain', async () => {
    const correlationId = `priv-${randomUUID()}`
    await app.eventStore.publish('negotiation.terms_agreed', { tradeId: correlationId }, correlationId)
    await app.eventStore.publish('negotiation.terms_agreed', { tradeId: correlationId }, correlationId)
    const events = await app.eventStore.getEvents(correlationId)
    expect(events).toHaveLength(2)
    expect(events[1].prevHash).toBe(events[0].entryHash)
  })

  it('regression as runtime: an idempotent operation claims, completes and replays its key', async () => {
    const key = `priv-${randomUUID()}`
    const participantId = `priv-${randomUUID()}`
    let runs = 0
    const params = { scope: 'cto225.probe', participantId, key, requestPayload: { n: 1 } }
    const persist = async () => { runs += 1; return { id: `result-${runs}` } }
    const first = await app.withIdempotency(params, persist, async () => {}, async (id) => ({ id }))
    const replay = await app.withIdempotency(params, persist, async () => {}, async (id) => ({ id }))
    expect(first).toEqual({ id: 'result-1' })
    expect(replay).toEqual({ id: 'result-1' })
    expect(runs).toBe(1)
  })

  it('regression as runtime: the C4 dispatch claim (UPDATE of the stamp, FOR UPDATE SKIP LOCKED) and the stale-translation cleanup run with the privileges the runtime already has', async () => {
    // CTO 341: no grant was added for them. Statements are planned and privilege-checked even when no row qualifies, so a
    // missing privilege on disputes / escrow_pending_transactions would fail here (SQLSTATE 42501) on an empty database too.
    const { reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery')
    const { reconcileStalePendingDisputeTranslations } = require('../../src/modules/open-settlement/dispute-pending-reconciliation')
    const dispatch = await reconcileMissingDispatch({ maxCandidates: 5, budgetMs: 10_000 })
    expect(dispatch.failed).toEqual([])
    expect(dispatch.budget.stoppedBy).toBe('SWEEP_COMPLETE')
    const stale = await reconcileStalePendingDisputeTranslations({ maxRows: 5, budgetMs: 10_000 })
    expect(stale.failed).toEqual([])
    const [{ dml }] = await app.prisma.$queryRaw<Array<{ dml: boolean }>>`SELECT has_table_privilege(current_user, 'disputes', 'UPDATE') AS dml`
    expect(dml).toBe(true) // the existing 'mutable' class, unchanged by this mission
  })

  it('production boot check: refuses the administrator and the migrator, accepts the runtime', async () => {
    const asClient = (client: Client) => async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '')
      return (await client.query(text, values)).rows
    }
    const migrator = new Client({ connectionString: migratorUrl })
    await migrator.connect()
    try {
      await expect(app.privileges.assertRuntimeDatabasePrivileges('enforce', asClient(admin))).rejects.toThrow(/is a superuser/)
      await expect(app.privileges.assertRuntimeDatabasePrivileges('enforce', asClient(migrator))).rejects.toThrow(/owns \d+ relation/)
      await expect(app.privileges.assertRuntimeDatabasePrivileges('enforce', asClient(runtime))).resolves.toBeUndefined()
      expect(await app.privileges.inspectRuntimePrivileges()).toEqual([]) // the app's own pool, as sails_runtime
    } finally {
      await migrator.end()
    }
  })

  it('boot check: PUBLIC grant, TRUNCATE, owned routine, TEMP (MG3), unreadable classification and an unclassified table are each refused', async () => {
    const check = () => app.privileges.inspectRuntimePrivileges()
    expect(await check()).toEqual([])
    try {
      await admin.query('GRANT UPDATE ON offer_envelopes TO PUBLIC')
      expect((await check()).join()).toMatch(/has UPDATE on offer_envelopes beyond its privilege class \(append\)/)
      await admin.query('REVOKE UPDATE ON offer_envelopes FROM PUBLIC')
      await admin.query('GRANT TRUNCATE ON trades TO sails_runtime')
      expect((await check()).join()).toMatch(/has TRUNCATE on trades beyond its privilege class \(mutable\)/)
      await admin.query('REVOKE TRUNCATE ON trades FROM sails_runtime')
      await admin.query("CREATE FUNCTION public.zz_runtime_owned() RETURNS int LANGUAGE sql AS 'SELECT 1'")
      await admin.query('ALTER FUNCTION public.zz_runtime_owned() OWNER TO sails_runtime')
      expect((await check()).join()).toMatch(/owns 1 routine/)
      await admin.query('DROP FUNCTION public.zz_runtime_owned()')
      await admin.query(`GRANT TEMP ON DATABASE ${dbName} TO sails_runtime`)
      expect((await check()).join()).toMatch(/can create TEMP tables/)
      await admin.query(`REVOKE TEMP ON DATABASE ${dbName} FROM sails_runtime`)
      await admin.query('REVOKE SELECT ON sails_meta.runtime_table_class FROM sails_runtime')
      expect((await check()).join()).toMatch(/has no readable privilege classification/)
      await admin.query('GRANT SELECT ON sails_meta.runtime_table_class TO sails_runtime')
      await admin.query('CREATE TABLE public.zz_unclassified_reachable (id int)')
      await admin.query('GRANT SELECT ON public.zz_unclassified_reachable TO sails_runtime')
      expect((await check()).join()).toMatch(/has SELECT on zz_unclassified_reachable beyond its privilege class \(unclassified\)/)
    } finally {
      await admin.query('REVOKE UPDATE ON offer_envelopes FROM PUBLIC')
      await admin.query('REVOKE TRUNCATE ON trades FROM sails_runtime')
      await admin.query('DROP FUNCTION IF EXISTS public.zz_runtime_owned()')
      await admin.query(`REVOKE TEMP ON DATABASE ${dbName} FROM sails_runtime`)
      await admin.query('GRANT SELECT ON sails_meta.runtime_table_class TO sails_runtime')
      await admin.query('DROP TABLE IF EXISTS public.zz_unclassified_reachable')
    }
    expect(await check()).toEqual([])
  })

  it('a table added by a migration without a privilege class blocks the grant step and stays unreachable to the runtime', async () => {
    const migrator = new Client({ connectionString: migratorUrl })
    await migrator.connect()
    try {
      await migrator.query('CREATE TABLE public.zz_unclassified (id int)')
      let output = ''
      try {
        grant({ MIGRATION_DATABASE_URL: migratorUrl })
      } catch (err) {
        output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`
      }
      expect(output).toMatch(/zz_unclassified has no runtime privilege class/)
      await expectSqlError(runtime, 'SELECT * FROM public.zz_unclassified')
    } finally {
      await migrator.query('DROP TABLE IF EXISTS public.zz_unclassified')
      await migrator.end()
    }
    expect(grant({ MIGRATION_DATABASE_URL: migratorUrl })).toBeDefined() // clean again once classified/removed
  })
})
