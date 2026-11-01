/**
 * #235 R7G F8C — read-only signing-round / escrow-state consistency preflight (SIGNING_ROUND_STATE_COMPATIBILITY).
 *
 * Reads the database inside a READ ONLY transaction. Never deletes a round, moves a status or touches a dispute,
 * and never consults a chain explorer (a transaction's network presence is out of its reach, and said so):
 *
 *   DATABASE_URL=postgres://… npm run signing-round:preflight
 *
 * Findings (each REVIEW_REQUIRED):
 *   TERMINAL_ESCROW_OPEN_DISPUTE   the escrow has a terminal transition record, yet a dispute of it is in an open
 *                                  status (OPENED / EVIDENCE_SUBMITTED / ARBITRATED / AUTO_PROPOSED) - the #239D
 *                                  half-state a failed ruling dispatch used to restore;
 *   ROUND_INCOMPATIBLE_WITH_STATE  a non-terminal escrow's pending round targets a transition its current status does
 *                                  not allow (e.g. a REFUND round under PAYMENT_PENDING). Dormant: neither the live
 *                                  path nor C8 executes it in that state. `fullySigned` says whether its transaction
 *                                  could already have been broadcast; whether it was is not verifiable here;
 *   TERMINAL_ROUND_KIND_MISMATCH   a terminal escrow still holds a round of another kind.
 * UNVERIFIABLE: a terminal escrow with no terminal transition record yet (PASS 3 owes it): whether its disputes are
 * consistent cannot be judged until the record exists. SAFE otherwise. Prints JSON, exits 1 on any non-SAFE row.
 */
import 'dotenv/config'
import { Client } from 'pg'

const TERMINAL = ['COMPLETED', 'REFUNDED', 'SPLIT']
const OPEN_DISPUTE = ['OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'AUTO_PROPOSED']
// escrow-lifecycle.ts VALID_TRANSITIONS, restricted to a round's targets
const ROUND_TARGET: Record<string, string> = { release: 'COMPLETED', refund: 'REFUNDED', split: 'SPLIT' }
const VALID_FROM: Record<string, string[]> = {
  COMPLETED: ['PAYMENT_PENDING', 'DISPUTED'],
  REFUNDED: ['CREATED', 'FUNDS_LOCKED', 'DISPUTED', 'EXPIRED'],
  SPLIT: ['DISPUTED'],
}

type Row = { id: string; type: string; status: string; terminalRecord: string | null; openDisputes: string[] | null; roundId: string | null; roundKind: string | null; requiredSigners: string[] | null; signers: string[] | null }

export async function runSigningRoundPreflight(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  let rows: Row[]
  try {
    await client.query('BEGIN READ ONLY')
    rows = (await client.query(`
      SELECT e.id, e.type::text AS type, e.status::text AS status,
             (SELECT ev.id FROM escrow_events ev WHERE ev."escrowId" = e.id AND ev."toStatus"::text = ANY($1) LIMIT 1) AS "terminalRecord",
             (SELECT array_agg(d.id || ':' || d.status::text) FROM disputes d WHERE d."escrowId" = e.id AND d.status::text = ANY($2)) AS "openDisputes",
             p.id AS "roundId", p.kind AS "roundKind", p."requiredSigners",
             (SELECT array_agg(s."participantId") FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id) AS signers
      FROM escrows e LEFT JOIN escrow_pending_transactions p ON p."escrowId" = e.id
      WHERE p.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM disputes d WHERE d."escrowId" = e.id AND d.status::text = ANY($2))
      ORDER BY e."createdAt"`, [TERMINAL, OPEN_DISPUTE])).rows
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
  const results = rows.map((r) => {
    const findings: Array<{ kind: string; detail: unknown }> = []
    const terminal = TERMINAL.includes(r.status)
    if (r.terminalRecord && r.openDisputes?.length) {
      findings.push({ kind: 'TERMINAL_ESCROW_OPEN_DISPUTE', detail: { status: r.status, terminalRecord: r.terminalRecord, disputes: r.openDisputes } })
    }
    if (r.roundKind) {
      const target = ROUND_TARGET[r.roundKind]
      const fullySigned = (r.requiredSigners ?? []).every((id) => (r.signers ?? []).includes(id))
      if (!terminal && !(VALID_FROM[target] ?? []).includes(r.status)) {
        findings.push({ kind: 'ROUND_INCOMPATIBLE_WITH_STATE', detail: { status: r.status, roundId: r.roundId, roundKind: r.roundKind, target, fullySigned, onChain: 'UNVERIFIABLE_WITHOUT_EXPLORER' } })
      }
      if (terminal && target !== r.status) {
        findings.push({ kind: 'TERMINAL_ROUND_KIND_MISMATCH', detail: { status: r.status, roundId: r.roundId, roundKind: r.roundKind } })
      }
    }
    const unverifiable = !findings.length && terminal && !r.terminalRecord
    return { escrowId: r.id, type: r.type, status: r.status, classification: findings.length ? 'REVIEW_REQUIRED' : unverifiable ? 'UNVERIFIABLE' : 'SAFE', findings }
  })
  return {
    escrowsInspected: results.length,
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
  runSigningRoundPreflight(url).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.reviewRequired + report.unverifiable > 0 ? 1 : 0)
  }, (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
