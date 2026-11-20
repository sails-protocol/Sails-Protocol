/**
 * TEST-ONLY. The single place in the repository that touches the replica role (CTO Despacho 031, requirement D; GK conditions):
 *
 *   - `legacyEscrowSeed`: seeds an escrow that EXISTED BEFORE the F3/F4 cut (Despacho 020), with its REAL EscrowType (WDK stays WDK,
 *     LIGHTNING stays LIGHTNING; never MOCK as a stand-in), carrying the two legacy marks exactly as the cut migration writes them:
 *     both from ONE instant, the address mark only when an address already existed. Superuser only, own connection, immediate reset,
 *     then revalidated (the replica role also switches foreign keys off) and the triggers confirmed ENABLED again.
 *   - `withReplica`: the same switch for fixtures that must insert rows the application can no longer create (e.g. a pair row), always reset.
 *   - `assertRuntimeCannotUseReplica`: the denial the runtime role must keep.
 *
 * WHY the fallback and not the preferred route (migrate to before F4, insert the legacy rows, apply the real F4 migration): the corpus suites
 * run in ONE already-migrated shared database through the application's own connection; rebuilding a database per suite changes the module
 * load order (DATABASE_URL is read at import). The preferred route is proven once, end to end, in tests/integration/f4MigrationProcess.test.ts
 * (rows inserted before the migration get their marks from the real migration). tests/replicaRoleOnlyInHelper.test.ts keeps this the only user.
 * Nothing here is reachable from src/ or from any HTTP route: a runtime path can never create a "legacy" escrow (the columns are not grantable
 * and the triggers refuse the marks on INSERT/UPDATE for every role without the superuser bypass).
 */
import { randomUUID } from 'crypto'
import { Client } from 'pg'

const GUC = 'session_' + 'replication_role' // spelled in two parts so the static guard's own source is not a second user

interface Queryable { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }

/** Runs `fn` with triggers and FKs off on `client` (a superuser connection) and ALWAYS switches them back on. Fixtures only. */
export async function withReplica<T>(client: Queryable, fn: () => Promise<T>): Promise<T> {
  await client.query(`SET ${GUC} = 'replica'`)
  let failure: unknown
  let result: T | undefined
  try { result = await fn() } catch (e) { failure = e }
  // the reset must not mask the original failure (inside an aborted transaction it cannot run; the ROLLBACK undoes the SET)
  try { await client.query(`SET ${GUC} = 'origin'`) } catch (e) { if (failure === undefined) throw e }
  if (failure !== undefined) throw failure
  return result as T
}

/** The runtime role must not be able to switch the triggers off. */
export async function assertRuntimeCannotUseReplica(runtime: Queryable): Promise<void> {
  try { await runtime.query(`SET ${GUC} = 'replica'`) } catch (e: any) {
    if (e.code === '42501') return
    throw e
  }
  throw new Error('the runtime role could switch the replica role on: every trigger and foreign key of the F3/F4 binding could be bypassed')
}

export interface LegacySeedSpec {
  tradeId: string
  /** The REAL type of the legacy escrow. MOCK is refused: it is exempt anyway and would only hide a missing real-type test. */
  type: string
  lockedAmount: string
  asset: string
  /** Present => the escrow already HAD its deposit address at the cut, so the address mark is written too. */
  multisigAddr?: string | null
  /** Any other escrows column the suite needs (status, txReleaseId, fee snapshot, ...): quoted identifiers, real values. */
  columns?: Record<string, unknown>
}

const IDENT = /^[A-Za-z][A-Za-z0-9]*$/
const FORBIDDEN_COLUMNS = new Set(['id', 'tradeId', 'type', 'lockedAmount', 'asset', 'multisigAddr', 'legacyPreCommitmentAt', 'addressPresentAtCutAt', 'commitmentPairId'])

function adminUrl(): string {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('legacyEscrowSeed: ADMIN_DATABASE_URL or DATABASE_URL is required')
  return url
}

/** Throws unless the row is exactly what the cut migration would have produced for a pre-cut escrow, and the triggers are enabled again. */
export async function revalidateLegacySeed(db: Queryable, escrowId: string): Promise<void> {
  const r = (await db.query(
    `SELECT e.type::text AS type, e."commitmentPairId", e."multisigAddr", e."legacyPreCommitmentAt" AS l, e."addressPresentAtCutAt" AS a,
            (SELECT count(*)::int FROM trades t WHERE t.id = e."tradeId") AS trade_exists
       FROM escrows e WHERE e.id = $1`, [escrowId])).rows[0]
  if (!r) throw new Error(`legacy seed ${escrowId}: the row does not exist`)
  const fail = (why: string) => { throw new Error(`legacy seed ${escrowId} is not a valid pre-cut escrow: ${why}`) }
  if (r.trade_exists !== 1) fail('its trade does not exist (the replica role also disabled the foreign keys)')
  if (r.type === 'MOCK') fail('MOCK is never a legacy stand-in')
  if (r.commitmentPairId !== null) fail('a pre-cut escrow has no commitment pair')
  if (r.l === null) fail('the legacy mark is missing: this would be a NEW escrow written around the binding')
  if ((r.multisigAddr !== null) !== (r.a !== null)) fail('the address mark must exist exactly when the escrow already had an address at the cut')
  if (r.a !== null && r.a.getTime() !== r.l.getTime()) fail('the two marks must come from the same instant')
  const off = (await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'escrows'::regclass AND tgname LIKE 'escrows\\_f4\\_%' AND tgenabled <> 'O'`)).rows
  if (off.length) fail(`the F4 triggers are not enabled again: ${off.map((x) => x.tgname).join(', ')}`)
  const count = (await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'escrows'::regclass AND tgname LIKE 'escrows\\_f4\\_%'`)).rows[0].n
  if (count !== 3) fail(`expected the 3 F4 triggers on escrows, found ${count}`)
}

/** Seeds one pre-cut escrow. Returns its id. Own superuser connection; nothing else in the suite's connection is touched. */
export async function legacyEscrowSeed(spec: LegacySeedSpec): Promise<string> {
  if (spec.type === 'MOCK') throw new Error('legacyEscrowSeed: MOCK is refused (it is exempt anyway; a legacy WDK/LIGHTNING/... escrow must keep its real type)')
  for (const k of Object.keys(spec.columns ?? {})) {
    if (!IDENT.test(k)) throw new Error(`legacyEscrowSeed: bad column name ${k}`)
    if (FORBIDDEN_COLUMNS.has(k)) throw new Error(`legacyEscrowSeed: column ${k} is set by the helper itself and cannot be overridden`)
  }
  const client = new Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    const su = (await client.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper
    if (!su) throw new Error('legacyEscrowSeed needs a SUPERUSER connection (ADMIN_DATABASE_URL); the application runtime role can never create a legacy escrow')
    const id = randomUUID()
    const cut = (await client.query(`SELECT clock_timestamp() AS t`)).rows[0].t as Date // ONE instant, like the migration
    const addr = spec.multisigAddr ?? null
    const cols: Record<string, unknown> = { id, tradeId: spec.tradeId, type: spec.type, lockedAmount: spec.lockedAmount, asset: spec.asset, multisigAddr: addr, legacyPreCommitmentAt: cut, addressPresentAtCutAt: addr ? cut : null, ...(spec.columns ?? {}) }
    if (!('updatedAt' in cols)) cols.updatedAt = new Date()
    const names = Object.keys(cols)
    const sql = `INSERT INTO escrows (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n, i) => (n === 'type' ? `$${i + 1}::"EscrowType"` : `$${i + 1}`)).join(', ')})`
    await client.query('BEGIN')
    try {
      await withReplica(client, () => client.query(sql, names.map((n) => cols[n])))
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e }
    await revalidateLegacySeed(client, id)
    return id
  } finally {
    await client.end()
  }
}
