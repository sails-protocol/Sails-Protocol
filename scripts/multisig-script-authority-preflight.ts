/**
 * #235 R7G-B2A — read-only MULTISIG script-authority preflight.
 *
 * Run against a database BEFORE applying migration
 * 20261006120000_multisig_script_authority (which refuses to install while any
 * of these violations exist). Reads only, inside a READ ONLY transaction, and
 * never changes anything:
 *
 *   DATABASE_URL=postgres://… npm run multisig:preflight
 *
 * For every MULTISIG escrow with a persisted funding address it checks that the
 * buyer, seller and arbiter keys exist (P1-P3), are well-formed compressed
 * secp256k1 keys (P4), are pairwise distinct (P5-P7), and derive exactly the
 * persisted address (P8) — the same checks as the migration's own preflight,
 * computed independently here with bitcoinjs-lib. Prints a JSON report with the
 * escrow ids for manual review and exits 1 if anything is found. Nothing is
 * repaired: a violating escrow needs a human decision.
 *
 * Also listed, for information (not a violation): open LIGHTNING_HODL /
 * SAFE_GUARD_EVM escrows. Those rails have no local signature validator, so
 * after this release they refuse signature submissions (LOCAL_SIGNATURE_
 * VALIDATION_V1) — any such escrow needs a decision before deployment.
 */
import 'dotenv/config'
import { Client } from 'pg'
import * as bitcoin from 'bitcoinjs-lib'

const PUBKEY = /^0[23][0-9a-fA-F]{64}$/

export type PreflightRow = { id: string; status: string; multisigAddr: string; buyer: string | null; seller: string | null; arbiter: string | null }
export type PreflightViolation = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8'

/** The first violation of an escrow, in the same order as the migration's preflight; null when it is sound. */
export function classifyMultisigRow(row: PreflightRow): PreflightViolation | null {
  if (!row.buyer) return 'P1'
  if (!row.seller) return 'P2'
  if (!row.arbiter) return 'P3'
  if (![row.buyer, row.seller, row.arbiter].every((k) => PUBKEY.test(k))) return 'P4'
  const [b, s, a] = [row.buyer, row.seller, row.arbiter].map((k) => Buffer.from(k, 'hex'))
  if (b.equals(s)) return 'P5'
  if (b.equals(a)) return 'P6'
  if (s.equals(a)) return 'P7'
  let program: Buffer
  try {
    program = Buffer.from(bitcoin.address.fromBech32(row.multisigAddr).data)
  } catch {
    return 'P8'
  }
  const witnessScript = bitcoin.payments.p2ms({ m: 2, pubkeys: [b, s, a].sort(Buffer.compare) }).output!
  const expected = bitcoin.crypto.sha256(Buffer.from(witnessScript))
  return Buffer.from(expected).equals(program) ? null : 'P8'
}

export async function runPreflight(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const { rows } = await client.query<PreflightRow>(`
      SELECT e.id, e.status, e."multisigAddr",
        max(CASE WHEN k.role = 'buyer' THEN k.pubkey END) AS buyer,
        max(CASE WHEN k.role = 'seller' THEN k.pubkey END) AS seller,
        max(CASE WHEN k.role = 'arbiter' THEN k.pubkey END) AS arbiter
      FROM escrows e LEFT JOIN escrow_participant_keys k ON k."escrowId" = e.id
      WHERE e.type = 'MULTISIG' AND e."multisigAddr" IS NOT NULL
      GROUP BY e.id, e.status, e."multisigAddr"`)
    const unvalidatedRails = await client.query<{ id: string; type: string; status: string }>(`
      SELECT id, type, status FROM escrows
      WHERE type IN ('LIGHTNING_HODL', 'SAFE_GUARD_EVM') AND status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')`)
    await client.query('ROLLBACK')
    const violations: Record<string, Array<{ id: string; status: string }>> = {}
    for (const row of rows) {
      const v = classifyMultisigRow(row)
      if (v) (violations[v] ??= []).push({ id: row.id, status: row.status })
    }
    return {
      checked: rows.length,
      violating: Object.values(violations).reduce((n, l) => n + l.length, 0),
      violations,
      openEscrowsOnRailsWithoutSignatureValidation: unvalidatedRails.rows,
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
  runPreflight(url).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.violating > 0 ? 1 : 0)
  }, (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
