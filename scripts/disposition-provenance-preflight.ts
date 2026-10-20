/**
 * #235 R7G F8B — read-only disposition-provenance preflight (SIGNATURE_COLLECTION_DISPOSITION_AUTHORITY_V1).
 *
 * Reads the database inside a READ ONLY transaction. Never clears, rewrites or "repairs" a disposition field and
 * never touches an economic outcome:
 *
 *   DATABASE_URL=postgres://… npm run disposition:preflight
 *
 * Each escrow carrying a disposition slot is classified REVIEW_REQUIRED (any finding below), UNVERIFIABLE (a
 * terminal escrow whose slot names its own status but which has no settlement txid to check it against), or SAFE.
 * Findings:
 *   SIGNATURE_COLLECTION_DIRECT_DISPOSITION  a MULTISIG / LIGHTNING_HODL / SAFE_GUARD_EVM escrow carries
 *                                            cooperativeDisposition or arbitratedDisposition. On these rails the
 *                                            signing round is the only disposition authority and the direct call
 *                                            that wrote the field was always refused by the provider: the field is
 *                                            false provenance (before F8B a refused direct release / refund froze it);
 *   DISPOSITION_CONTRADICTS_OUTCOME          on any rail, a terminal escrow (COMPLETED / REFUNDED / SPLIT) whose
 *                                            deciding slot names a different terminal status. The deciding slot is
 *                                            arbitratedDisposition when set, else cooperativeDisposition: arbitration
 *                                            never rewrites the cooperative slot (#247/#248), so a cooperative intent
 *                                            that differs from an arbitrated outcome is history, not a contradiction.
 * Prints JSON and exits 1 when anything is REVIEW_REQUIRED or UNVERIFIABLE.
 */
import 'dotenv/config'
import { Client } from 'pg'

const SIGNATURE_COLLECTION = ['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM']
const TERMINAL = ['COMPLETED', 'REFUNDED', 'SPLIT']

export async function runDispositionProvenancePreflight(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  let rows: Array<{ id: string; type: string; status: string; txReleaseId: string | null; cooperativeDisposition: string | null; cooperativeTriggeredBy: string | null; arbitratedDisposition: string | null; arbitratedTriggeredBy: string | null; roundKind: string | null }>
  try {
    await client.query('BEGIN READ ONLY')
    rows = (await client.query(`
      SELECT e.id, e.type::text AS type, e.status::text AS status, e."txReleaseId",
             e."cooperativeDisposition"::text AS "cooperativeDisposition", e."cooperativeTriggeredBy",
             e."arbitratedDisposition"::text AS "arbitratedDisposition", e."arbitratedTriggeredBy",
             p.kind AS "roundKind"
      FROM escrows e LEFT JOIN escrow_pending_transactions p ON p."escrowId" = e.id
      WHERE e."cooperativeDisposition" IS NOT NULL OR e."arbitratedDisposition" IS NOT NULL
      ORDER BY e."createdAt"`)).rows
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
  const results = rows.map((r) => {
    const findings: Array<{ kind: string; detail: unknown }> = []
    if (SIGNATURE_COLLECTION.includes(r.type)) {
      findings.push({ kind: 'SIGNATURE_COLLECTION_DIRECT_DISPOSITION', detail: { cooperativeDisposition: r.cooperativeDisposition, cooperativeTriggeredBy: r.cooperativeTriggeredBy, arbitratedDisposition: r.arbitratedDisposition, arbitratedTriggeredBy: r.arbitratedTriggeredBy, roundKind: r.roundKind } })
    }
    if (TERMINAL.includes(r.status)) {
      const field = r.arbitratedDisposition ? 'arbitratedDisposition' as const : 'cooperativeDisposition' as const
      if (r[field] !== r.status) findings.push({ kind: 'DISPOSITION_CONTRADICTS_OUTCOME', detail: { field, disposition: r[field], status: r.status, txReleaseId: r.txReleaseId } })
    }
    const unverifiable = !findings.length && TERMINAL.includes(r.status) && !r.txReleaseId
    return { escrowId: r.id, type: r.type, status: r.status, classification: findings.length ? 'REVIEW_REQUIRED' : unverifiable ? 'UNVERIFIABLE' : 'SAFE', findings }
  })
  return {
    escrowsWithDisposition: results.length,
    reviewRequired: results.filter((r) => r.classification === 'REVIEW_REQUIRED').length,
    unverifiable: results.filter((r) => r.classification === 'UNVERIFIABLE').length,
    results,
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(2)
  }
  runDispositionProvenancePreflight(url).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.reviewRequired + report.unverifiable > 0 ? 1 : 0)
  }, (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
