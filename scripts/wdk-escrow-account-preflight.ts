/**
 * #235 R7G-F6A-1 — read-only WDK escrow account preflight.
 *
 * Run against a database BEFORE applying migration 20261007120000_wdk_escrow_account_identity (which
 * refuses to install while two WDK escrows share a legacy account or one uses the treasury's), and
 * again afterwards. Reads only, inside a READ ONLY transaction, and never changes anything:
 *
 *   DATABASE_URL=postgres://… npm run wdk:account-preflight
 *
 * The legacy account of a WDK_USDT_EVM escrow is m/44'/60'/0'/0/<i>, i = sha256(tradeId) % (2^31-1),
 * computed here independently of the application. Blocking findings (the migration refuses them):
 *   SHARED_LEGACY_ACCOUNT    two or more WDK escrows derive the same account;
 *   TREASURY_LEGACY_ACCOUNT  an escrow's account is the treasury's (i = 0);
 *   PERSISTED_IDENTITY       (after the migration) a legacy row whose persisted path is not its
 *                            historical derivation, or a malformed / duplicated path.
 * Review findings (same 0'/0/<i> namespace; buyer accounts are only used by the AUTO_SETTLE_ON_MATCH
 * path, and whether one ever held funds is a chain question):
 *   ESCROW_BUYER_ACCOUNT     an escrow's legacy account is also some user's buyerIndexFor() account;
 *   SHARED_BUYER_ACCOUNT     two users share a buyer account;
 *   TREASURY_BUYER_ACCOUNT   a user's buyer account is the treasury's.
 * Every finding lists escrow / user ids and whether the escrow may already carry economic activity.
 * Prints JSON and exits 1 when anything is found. Nothing is repaired or reassigned.
 */
import 'dotenv/config'
import { createHash } from 'crypto'
import { Client } from 'pg'

const ACCOUNT_PATH: Record<string, RegExp> = {
  LEGACY_TRADE_HASH_V0: /^0'\/0\/[1-9][0-9]{0,9}$/,
  ALLOCATED_V1: /^1'\/0\/(0|[1-9][0-9]{0,9})$/,
}

/** The historical escrowIndexFor() / buyerIndexFor() derivation. */
export function legacyIndex(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0) % 0x7fffffff
}

export type WdkEscrowRow = {
  id: string
  tradeId: string
  status: string
  scheme: string | null
  path: string | null
  economicActivity: boolean
}
export type Finding = { kind: string; blocking: boolean; index?: number; escrows?: Array<{ id: string; status: string; economicActivity: boolean }>; users?: string[]; detail?: string }

/** Pure classification; `migrated` = the identity columns exist. `indexOf` is replaceable only for tests. */
export function classifyWdkAccounts(escrows: WdkEscrowRow[], userIds: string[], migrated: boolean, indexOf: (input: string) => number = legacyIndex): Finding[] {
  const findings: Finding[] = []
  const brief = (e: WdkEscrowRow) => ({ id: e.id, status: e.status, economicActivity: e.economicActivity })
  // Rows whose authority is the legacy derivation: every WDK escrow before the migration, LEGACY rows after it.
  const legacy = escrows.filter((e) => !migrated || e.scheme === 'LEGACY_TRADE_HASH_V0')
  const byIndex = new Map<number, WdkEscrowRow[]>()
  for (const e of legacy) byIndex.set(indexOf(e.tradeId), [...(byIndex.get(indexOf(e.tradeId)) ?? []), e])
  for (const [index, group] of byIndex) {
    if (group.length > 1) findings.push({ kind: 'SHARED_LEGACY_ACCOUNT', blocking: true, index, escrows: group.map(brief) })
    if (index === 0) findings.push({ kind: 'TREASURY_LEGACY_ACCOUNT', blocking: true, index, escrows: group.map(brief) })
  }
  if (migrated) {
    const seen = new Map<string, string>()
    for (const e of escrows) {
      const pattern = e.scheme ? ACCOUNT_PATH[e.scheme] : undefined
      const valid = !!e.path && !!pattern && pattern.test(e.path) && Number(e.path.split('/')[2]) <= 0x7fffffff
      const legacyMismatch = e.scheme === 'LEGACY_TRADE_HASH_V0' && e.path !== `0'/0/${indexOf(e.tradeId)}`
      const duplicate = !!e.path && seen.has(e.path)
      if (!valid || legacyMismatch || duplicate) {
        findings.push({ kind: 'PERSISTED_IDENTITY', blocking: true, escrows: [brief(e)], detail: `scheme=${e.scheme} path=${e.path}${duplicate ? ` duplicates escrow ${seen.get(e.path!)}` : ''}${legacyMismatch ? ' is not the historical derivation' : ''}` })
      }
      if (e.path) seen.set(e.path, e.id)
    }
  }
  const usersByIndex = new Map<number, string[]>()
  for (const u of userIds) usersByIndex.set(indexOf(`buyer:${u}`), [...(usersByIndex.get(indexOf(`buyer:${u}`)) ?? []), u])
  for (const [index, group] of byIndex) {
    const users = usersByIndex.get(index)
    if (users) findings.push({ kind: 'ESCROW_BUYER_ACCOUNT', blocking: false, index, escrows: group.map(brief), users })
  }
  for (const [index, users] of usersByIndex) {
    if (users.length > 1) findings.push({ kind: 'SHARED_BUYER_ACCOUNT', blocking: false, index, users })
    if (index === 0) findings.push({ kind: 'TREASURY_BUYER_ACCOUNT', blocking: false, index, users })
  }
  return findings
}

export async function runWdkAccountPreflight(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const migrated = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'escrows' AND column_name = 'wdkAccountPath'`)).rowCount === 1
    const identity = migrated ? `e."wdkAccountScheme"::text AS scheme, e."wdkAccountPath" AS path` : 'NULL::text AS scheme, NULL::text AS path'
    const { rows } = await client.query<WdkEscrowRow>(`
      SELECT e.id, e."tradeId", e.status::text AS status, ${identity},
        (e.status <> 'CREATED' OR e."multisigAddr" IS NOT NULL OR e."txLockId" IS NOT NULL
          OR EXISTS (SELECT 1 FROM wdk_transfer_attempts a WHERE a."escrowId" = e.id)) AS "economicActivity"
      FROM escrows e WHERE e.type = 'WDK_USDT_EVM'`)
    const userIds: string[] = []
    let after = ''
    for (;;) {
      const batch = await client.query<{ id: string }>('SELECT id FROM users WHERE id > $1 ORDER BY id LIMIT 10000', [after])
      if (batch.rows.length === 0) break
      for (const r of batch.rows) userIds.push(r.id)
      after = batch.rows[batch.rows.length - 1].id
    }
    await client.query('ROLLBACK')
    const findings = classifyWdkAccounts(rows, userIds, migrated)
    return {
      migrated,
      wdkEscrows: rows.length,
      withEconomicActivity: rows.filter((r) => r.economicActivity).length,
      bySchemes: rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.scheme ?? 'NONE']: (m[r.scheme ?? 'NONE'] ?? 0) + 1 }), {}),
      usersChecked: userIds.length,
      blocking: findings.filter((f) => f.blocking).length,
      review: findings.filter((f) => !f.blocking).length,
      findings,
    }
  } finally {
    await client.end()
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(2)
  }
  runWdkAccountPreflight(url).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.findings.length > 0 ? 1 : 0)
  }, (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
