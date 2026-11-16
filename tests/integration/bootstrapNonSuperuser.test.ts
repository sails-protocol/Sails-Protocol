/**
 * CTO 316/332 - scripts/db/bootstrap-roles.js with a NON-superuser administrator (a managed-PostgreSQL master that only
 * has CREATEROLE/CREATEDB), on a disposable database created and migrated by that administrator.
 *
 * Proves: first run hands everything to sails_migrator (database, schema public, every relation and routine,
 * including the SECURITY DEFINER-capable trigger functions); a re-run is idempotent; the grant step and the production
 * boot check then accept the runtime; rows, `fee_collection_evidence.seq` per id, the sequence position and every
 * trigger (enabled) are untouched; and an existing role with BYPASSRLS is refused instead of silently kept.
 *
 * The cluster-wide roles sails_migrator / sails_runtime may already exist (created by a superuser in other suites);
 * a CREATEROLE administrator may alter only roles it holds ADMIN OPTION on, so the superuser grants that first - the
 * state of a managed cluster whose master created both roles.
 */
import { execFileSync, spawnSync } from 'child_process'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { inspectRuntimePrivileges } from '../../src/common/database/runtime-privileges'

const ROOT = join(__dirname, '..', '..')
const id = randomUUID().replace(/-/g, '').slice(0, 10)
const ADMIN_ROLE = `sails_boot_admin_${id}`
const ADMIN_PASSWORD = `admin-${randomUUID()}`
const MIGRATOR_PASSWORD = `migrator-${randomUUID()}`
const RUNTIME_PASSWORD = `runtime-${randomUUID()}`
const dbName = `sails_boot_${id}`

function withUser(url: string, user: string, password: string, db: string): string {
  const u = new URL(url)
  u.username = user
  u.password = password
  u.pathname = `/${db}`
  return u.toString()
}

// Minimal FK-valid fixture: one row per required parent, filled from the catalog (FKs and triggers stay on).
async function seedEvidence(client: Client, obligations: number, evidencePerObligation: number) {
  const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows
  const cols = (t: string) => q(`SELECT column_name c, udt_name u, is_nullable n, column_default d FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t])
  const fks = (t: string) => q(`SELECT a.attname col, cf.relname parent FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_class cf ON cf.oid=k.confrelid JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
    WHERE k.contype='f' AND c.relname=$1 AND cardinality(k.conkey)=1`, [t])
  const firstEnum = async (u: string) => (await q(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1 ORDER BY enumsortorder LIMIT 1`, [u]))[0]?.enumlabel
  const done = new Set<string>()
  const ensure = async (t: string, k: number, overrides: Record<string, unknown> = {}): Promise<string> => {
    const rowId = `${t}-${k}`
    if (done.has(rowId)) return rowId
    done.add(rowId)
    const vals: Record<string, unknown> = { id: rowId, ...overrides }
    const tableCols = await cols(t)
    for (const f of await fks(t)) {
      if (f.col in vals || tableCols.find((c) => c.c === f.col)?.n === 'YES') continue
      vals[f.col] = f.parent === t ? rowId : await ensure(f.parent, k)
    }
    for (const c of tableCols) {
      if (c.c in vals || c.n === 'YES' || c.d !== null) continue
      vals[c.c] = /^(int|float|numeric)/.test(c.u) ? 1 : c.u === 'bool' ? false : /^timestamp/.test(c.u) ? new Date()
        : /^jsonb?$/.test(c.u) ? {} : c.u === 'text' || c.u === 'varchar' ? `${c.c}-${k}` : c.u.startsWith('_') ? [] : await firstEnum(c.u)
    }
    const keys = Object.keys(vals)
    await client.query(`INSERT INTO public."${t}" (${keys.map((x) => `"${x}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((x) => vals[x]))
    return rowId
  }
  for (let k = 1; k <= obligations; k++) {
    const ob = await ensure('fee_obligations', k, { collectionStatus: 'IN_PROGRESS' })
    for (let e = 1; e <= evidencePerObligation; e++) {
      await client.query(`INSERT INTO fee_collection_evidence (id, "feeObligationId", kind, txid) VALUES ($1, $2, 'BROADCAST', $3)`, [`ev-${k}-${e}`, ob, `tx-${k}-${e}`])
    }
  }
}

async function snapshot(client: Client) {
  const q = async (sql: string) => (await client.query(sql)).rows
  return {
    seqById: (await q(`SELECT id, seq FROM fee_collection_evidence ORDER BY id`)).map((r) => `${r.id}=${r.seq}`),
    sequence: (await q(`SELECT last_value::text AS v FROM public.fee_collection_evidence_seq_seq`))[0].v,
    triggers: (await q(`SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`)).map((r) => `${r.tgname}=${r.tgenabled}`),
    rows: (await q(`SELECT (SELECT count(*) FROM fee_obligations)::int AS o, (SELECT count(*) FROM fee_collection_evidence)::int AS e`))[0],
  }
}

jest.setTimeout(120_000) // each case spawns the real scripts (node, sh, prisma)

describe('CTO 316/332 - bootstrap-roles.js with a non-superuser administrator (disposable PostgreSQL)', () => {
  const pg = createPostgresIntegrationHarness()
  let superuser: Client
  let adminUrl = ''
  let migratorUrl = ''
  let runtimeUrl = ''
  let pg16 = false

  const bootstrap = () => spawnSync(process.execPath, ['scripts/db/bootstrap-roles.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ADMIN_DATABASE_URL: adminUrl, SAILS_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD, SAILS_RUNTIME_PASSWORD: RUNTIME_PASSWORD },
  })
  const asClient = async <T>(url: string, fn: (c: Client) => Promise<T>) => {
    const c = new Client({ connectionString: url })
    await c.connect()
    try { return await fn(c) } finally { await c.end() }
  }

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('bootstrap with a non-superuser administrator')
    const base = pg.getUrl()
    superuser = new Client({ connectionString: base })
    await superuser.connect()
    pg16 = Number((await superuser.query(`SELECT current_setting('server_version_num') AS v`)).rows[0].v) >= 160000
    await superuser.query(`CREATE ROLE ${ADMIN_ROLE} LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD '${ADMIN_PASSWORD}'`)
    for (const role of ['sails_migrator', 'sails_runtime']) {
      const exists = (await superuser.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount
      // ADMIN only, as a CREATEROLE creator gets by default (createrole_self_grant empty): no SET, no INHERIT, so the
      // script's own membership grant is what lets it hand objects over.
      if (exists) await superuser.query(`GRANT ${role} TO ${ADMIN_ROLE} WITH ${pg16 ? 'ADMIN OPTION, SET FALSE, INHERIT FALSE' : 'ADMIN OPTION'}`)
    }
    await asClient(withUser(base, ADMIN_ROLE, ADMIN_PASSWORD, 'postgres'), (c) => c.query(`CREATE DATABASE ${dbName}`))
    adminUrl = withUser(base, ADMIN_ROLE, ADMIN_PASSWORD, dbName)
    migratorUrl = withUser(base, 'sails_migrator', MIGRATOR_PASSWORD, dbName)
    runtimeUrl = withUser(base, 'sails_runtime', RUNTIME_PASSWORD, dbName)
    // The administrator builds the schema itself (legacy single credential), so it owns every object.
    execFileSync('sh', ['scripts/migrate-deploy-safe.sh'], {
      cwd: ROOT, stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: adminUrl, MIGRATION_DATABASE_URL: '', SAILS_LEGACY_SINGLE_CREDENTIAL: '1' },
    })
    await asClient(adminUrl, (c) => seedEvidence(c, 5, 4))
  }, 300_000)

  afterAll(async () => {
    if (!superuser) return
    await superuser.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await superuser.query(`ALTER ROLE sails_runtime NOBYPASSRLS`).catch(() => {})
    await superuser.query(`DROP OWNED BY ${ADMIN_ROLE}`).catch(() => {})
    await superuser.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`).catch(() => {})
    await superuser.end()
  })

  it('the administrator is not a superuser and owns everything before the bootstrap', async () => {
    const r = await asClient(adminUrl, async (c) => (await c.query(
      `SELECT r.rolsuper, r.rolcreaterole,
              (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace AND pg_get_userbyid(relowner) <> current_user) AS foreign_owned
         FROM pg_roles r WHERE r.rolname = current_user`)).rows[0])
    expect(r).toEqual({ rolsuper: false, rolcreaterole: true, foreign_owned: 0 })
  })

  it('first run hands the database, schema public and every object to sails_migrator, leaving rows, seq and triggers untouched', async () => {
    const before = await asClient(adminUrl, snapshot)
    expect(before.rows).toEqual({ o: 5, e: 20 })
    const first = bootstrap()
    expect(first.stderr).toBe('')
    expect(first.status).toBe(0)
    expect(first.stdout).toMatch(/ownership moved for [1-9]\d* object\(s\)/)

    const owners = await asClient(adminUrl, async (c) => (await c.query(
      `SELECT (SELECT array_agg(DISTINCT pg_get_userbyid(relowner)::text) FROM pg_class WHERE relnamespace = 'public'::regnamespace) AS relations,
              (SELECT array_agg(DISTINCT pg_get_userbyid(proowner)::text) FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS routines,
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema,
              (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database`)).rows[0])
    expect(owners).toEqual({ relations: ['sails_migrator'], routines: ['sails_migrator'], schema: 'sails_migrator', database: 'sails_migrator' })

    const membership = (await superuser.query(
      `SELECT ${pg16 ? 'm.set_option AS set, m.inherit_option AS inherit' : 'true AS set, true AS inherit'}
         FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE g.rolname = 'sails_migrator' AND u.rolname = $1`, [ADMIN_ROLE])).rows
    expect(membership).toContainEqual({ set: true, inherit: true })
    const runtimeMemberOf = (await superuser.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'sails_runtime'`)).rows[0].n
    expect(runtimeMemberOf).toBe(0)

    expect(await asClient(adminUrl, snapshot)).toEqual(before)
  })

  it('a re-run by the same administrator is idempotent (it can still connect, and moves nothing)', async () => {
    const before = await asClient(adminUrl, snapshot)
    const again = bootstrap()
    expect(again.stderr).toBe('')
    expect(again.status).toBe(0)
    expect(again.stdout).toMatch(/ownership moved for 0 object\(s\); 0 runtime membership\(s\) revoked/)
    expect(await asClient(adminUrl, snapshot)).toEqual(before)
  })

  it('the grant step as sails_migrator succeeds and the production boot check accepts the runtime', async () => {
    execFileSync('sh', ['scripts/migrate-deploy-safe.sh'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl } })
    const findings = await asClient(runtimeUrl, async (c) => {
      const query = async (sql: TemplateStringsArray, ...values: unknown[]) =>
        (await c.query(sql.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), ''), values)).rows
      return inspectRuntimePrivileges(query)
    })
    expect(findings).toEqual([])
    const after = await asClient(adminUrl, snapshot)
    expect(after.rows).toEqual({ o: 5, e: 20 })
    expect(after.triggers.every((t) => t.endsWith('=O'))).toBe(true)
  })

  it('refuses an existing role that carries BYPASSRLS (only a superuser can remove it), and writes nothing', async () => {
    await superuser.query('ALTER ROLE sails_runtime BYPASSRLS')
    try {
      const before = await asClient(adminUrl, snapshot)
      const refused = bootstrap()
      expect(refused.status).toBe(1)
      expect(refused.stderr).toMatch(/sails_runtime has SUPERUSER, REPLICATION or BYPASSRLS; only a superuser can remove it/)
      expect(await asClient(adminUrl, snapshot)).toEqual(before)
    } finally {
      await superuser.query('ALTER ROLE sails_runtime NOBYPASSRLS')
    }
  })
})
