/**
 * #235 R7G F8A — read-only MULTISIG residual-value preflight.
 *
 * For every MULTISIG escrow with a persisted funding address: reads the database inside a READ ONLY transaction and
 * the explorer with GETs only. Never moves funds, never creates a recovery, never chooses a destination or a
 * recipient, never signs, broadcasts or repairs anything:
 *
 *   DATABASE_URL=postgres://… MULTISIG_EXPLORER_API_URL=… npm run multisig:residual-preflight
 *
 * Each escrow is classified with its evidence:
 *   SAFE              nothing on its script beyond what its own state accounts for;
 *   REVIEW_REQUIRED   one or more findings below need a human (and, for value, the two participants);
 *   UNVERIFIABLE      the explorer could not be read, or an output is not confirmed at the policy depth yet.
 * Findings:
 *   SCRIPT_ADDRESS_MISMATCH        its persisted keys no longer derive its persisted address;
 *   SHARED_FUNDING_ADDRESS         another escrow has the same address (ownership of its outputs is ambiguous);
 *   STATE_WITHOUT_FUNDING          past FUNDS_LOCKED with no canonical funding outpoint (refused from now on);
 *   ADDRESSED_CREATED_HOLDS_VALUE  CREATED, and its address holds confirmed value (a funding candidate or residual);
 *   RESIDUAL_VALUE                 confirmed value on the script that is not canonical funding (recoverable only by
 *                                  both original participants, MULTISIG_RESIDUAL_VALUE_RECOVERY_V1);
 *   CANONICAL_OUTPOINT_MISSING     locked but not terminal, and its canonical outpoint is no longer unspent;
 *   RECOVERY_OUTPOINT_GONE         a live recovery's outpoint is no longer unspent and it has no confirmed spend;
 *   CANONICAL_OUTPOINT_VOUT_UNKNOWN (#235 R7G F8G) a legacy lock recorded its funding txid but no vout: canonical
 *                                  authority cannot be uniquely identified from durable state. Runtime treats every
 *                                  output of that txid at the script as canonical, so none of them is ever residual;
 *                                  each one the explorer shows is listed, none is chosen. Raised from the database
 *                                  alone, so an explorer outage never turns it into SAFE.
 * Prints JSON and exits 1 when anything is not SAFE.
 */
import 'dotenv/config'
import { Client } from 'pg'

type Output = { txid: string; vout: number; valueSats: number; confirmations: number; classification: string }
export type Observe = (input: Record<string, unknown>) => Promise<Output[]>

const TERMINAL = ['COMPLETED', 'REFUNDED', 'SPLIT']

export async function runMultisigResidualPreflight(connectionString: string, observe?: Observe) {
  const look: Observe = observe ?? (async (input) => require('../src/modules/open-settlement/multisig.provider').multisigProvider.observeScriptOutputs(input))
  const client = new Client({ connectionString })
  await client.connect()
  let escrows: any[]
  let keys: any[]
  let recoveries: any[]
  try {
    await client.query('BEGIN READ ONLY')
    escrows = (await client.query(`
      SELECT e.id, e."tradeId", e.status::text AS status, e."lockedAmount"::text AS "lockedAmount", e."multisigAddr", e."txLockId", e."txLockVout",
             e."feePolicyVersionId", e."snapshotProtocolFeeRate"::text AS "snapshotProtocolFeeRate", e."snapshotFeeCollectionAddress", e."snapshotFeeCollectionWaivedPreFunding",
             (SELECT count(*)::int FROM escrows o WHERE o."multisigAddr" = e."multisigAddr" AND o.id <> e.id) AS "sharedWith"
      FROM escrows e WHERE e.type::text = 'MULTISIG' AND e."multisigAddr" IS NOT NULL ORDER BY e."createdAt"`)).rows
    keys = (await client.query(`SELECT "escrowId", role, pubkey FROM escrow_participant_keys WHERE "escrowId" = ANY($1)`, [escrows.map((e) => e.id)])).rows
    const hasRecoveries = (await client.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'escrow_residual_recoveries'`)).rowCount === 1
    recoveries = hasRecoveries ? (await client.query(`SELECT id, "escrowId", status::text AS status, "outpointTxid", "outpointVout" FROM escrow_residual_recoveries WHERE status::text NOT IN ('CANCELLED', 'CONFIRMED')`)).rows : []
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }

  const results = []
  for (const e of escrows) {
    const findings: Array<{ kind: string; detail?: unknown }> = []
    let unverifiable = false
    if (e.sharedWith > 0) findings.push({ kind: 'SHARED_FUNDING_ADDRESS', detail: { otherEscrows: e.sharedWith } })
    if (!['CREATED', 'FUNDS_LOCKED'].includes(e.status) && !e.txLockId) findings.push({ kind: 'STATE_WITHOUT_FUNDING', detail: { status: e.status } })
    const voutUnknown = e.txLockId !== null && e.txLockVout === null
    const key = (role: string) => keys.find((k) => k.escrowId === e.id && k.role === role)?.pubkey
    let outputs: Output[] = []
    try {
      outputs = await look({
        tradeId: e.tradeId, lockedAmount: e.lockedAmount, status: e.status, multisigAddr: e.multisigAddr, txLockId: e.txLockId, txLockVout: e.txLockVout,
        buyerPubkey: key('buyer'), sellerPubkey: key('seller'), arbiterPubkey: key('arbiter'), feePolicyVersionId: e.feePolicyVersionId,
        snapshotProtocolFeeRate: e.snapshotProtocolFeeRate, snapshotFeeCollectionAddress: e.snapshotFeeCollectionAddress, snapshotFeeCollectionWaivedPreFunding: e.snapshotFeeCollectionWaivedPreFunding,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/no longer derive its persisted funding address|public keys are the same key|requires a submitted|arbiter public-key commitment/.test(message)) findings.push({ kind: 'SCRIPT_ADDRESS_MISMATCH', detail: message })
      else { unverifiable = true; findings.push({ kind: 'EXPLORER_UNAVAILABLE', detail: message }) }
    }
    if (outputs.some((o) => o.classification === 'UNCONFIRMED')) unverifiable = true
    const confirmedValue = outputs.filter((o) => o.classification !== 'UNCONFIRMED')
    if (e.status === 'CREATED' && confirmedValue.length) findings.push({ kind: 'ADDRESSED_CREATED_HOLDS_VALUE', detail: confirmedValue })
    for (const o of outputs.filter((x) => x.classification === 'RESIDUAL')) findings.push({ kind: 'RESIDUAL_VALUE', detail: o })
    if (voutUnknown) {
      findings.push({
        kind: 'CANONICAL_OUTPOINT_VOUT_UNKNOWN',
        detail: {
          txLockId: e.txLockId,
          reason: 'funding txid recorded without a vout: the canonical outpoint cannot be uniquely identified from durable state; no output is chosen',
          // every unspent output of that txid at the script, as observed now (empty when the explorer was not read)
          outputsSharingTxid: outputs.filter((o) => o.txid === e.txLockId).map(({ txid, vout, valueSats, confirmations }) => ({ txid, vout, valueSats, confirmations })),
        },
      })
    }
    if (e.txLockId && !TERMINAL.includes(e.status) && !unverifiable && !outputs.some((o) => o.classification === 'CANONICAL')) {
      findings.push({ kind: 'CANONICAL_OUTPOINT_MISSING', detail: { txLockId: e.txLockId, txLockVout: e.txLockVout } })
    }
    for (const r of recoveries.filter((x) => x.escrowId === e.id && x.status === 'PROPOSED')) {
      if (!unverifiable && !outputs.some((o) => o.txid === r.outpointTxid && o.vout === r.outpointVout)) findings.push({ kind: 'RECOVERY_OUTPOINT_GONE', detail: r })
    }
    const classification = findings.some((f) => f.kind !== 'EXPLORER_UNAVAILABLE') ? 'REVIEW_REQUIRED' : unverifiable ? 'UNVERIFIABLE' : 'SAFE'
    results.push({ escrowId: e.id, status: e.status, fundingAddress: e.multisigAddr, classification, findings, outputs })
  }
  return {
    escrows: results.length,
    safe: results.filter((r) => r.classification === 'SAFE').length,
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
  runMultisigResidualPreflight(url).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.reviewRequired + report.unverifiable > 0 ? 1 : 0)
  }, (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
