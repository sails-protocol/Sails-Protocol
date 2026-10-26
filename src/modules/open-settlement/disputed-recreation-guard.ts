/**
 * P4 / Gate 3 (iii-a) - narrow guard on re-creating a disputed MULTISIG signing round whose pending row was LOST after
 * its Economic Disposition Authorization was committed (docs/p4-gate3-unknown-outcome-contract.md, section 5).
 *
 * Why not the authorization's operation digest: it binds pendingOperationId and the PSBT bytes, so a re-created round
 * can never reproduce it. The discriminator is instead a set of durable facts recorded at commit time
 * (unsignedTxid, intentDigest) plus what the network says now.
 *
 * Two phases, because the network must never be read inside a transaction that holds the dispute (D) and escrow (E)
 * advisory locks:
 *   1. assessDisputedRecreation()  - BEFORE the round is built and outside any lock: decides from the durable facts and
 *      from definitive external reads, or refuses. Returns the authorization it cleared for supersession (or null when
 *      no authorization is involved).
 *   2. applyDisputedRecreationSupersession() - INSIDE the D -> E transaction that persists the new round: re-reads the
 *      authorizations, requires exactly the cleared one to still be live and its pending still absent, and marks it
 *      superseded by the new round. A change in between (a competing re-creation, a new commit) is refused.
 * The residual window between the external read and the write is bounded by consensus, not by this guard: every round
 * of one escrow spends the same canonical outpoint, so at most one can confirm (section 5.2).
 *
 * Fail closed everywhere: an unreadable network, an unset window, a legacy authorization, a different intent, a public
 * transaction or a spent outpoint all refuse, with a machine-readable cause in the message.
 */
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { economicIntentDigest } from './economic-disposition-authority'
import { fetchTransactionExistence, multisigProvider } from './multisig.provider'

const log = childLogger('disputed-recreation-guard')

export type RecreationRefusalCause =
  | 'WINDOW' | 'TXID_PUBLIC' | 'OUTPOINT_SPENT' | 'CHAIN_UNREADABLE' | 'LEGACY_EDA' | 'INTENT_MISMATCH' | 'CONCURRENT_CHANGE' | 'SPLIT_UNSUPPORTED'

export function recreationRefusal(cause: RecreationRefusalCause, detail: string): EscrowError {
  return new EscrowError(`DISPUTED_RECREATION_REFUSED[${cause}]: ${detail}`)
}

export interface RecreationClearance { authorizationId: string; authorizedAtMs: number; pendingOperationId: string }

type Generation = { id: string; appealRound: number; arbiterId: string | null; ruling: string | null; authoritySignature: string | null }

/** Live (not superseded) authorizations of this generation whose pending operation no longer exists. */
async function lostLiveAuthorizations(db: Pick<typeof prisma, 'economicDispositionAuthorization' | 'escrowPendingTransaction'>, escrowId: string, g: Generation) {
  const live = await db.economicDispositionAuthorization.findMany({
    where: { escrowId, disputeId: g.id, appealRound: g.appealRound, supersededAt: null },
    orderBy: { authorizedAt: 'desc' },
  })
  const lost = []
  for (const row of live) {
    const pending = await db.escrowPendingTransaction.findUnique({ where: { id: row.pendingOperationId }, select: { id: true } })
    if (!pending) lost.push(row)
  }
  return lost
}

/** Phase 1 - see the header. `escrowRecord` is the provider input (keys, funding outpoint) the round is built from. */
export async function assessDisputedRecreation(input: {
  escrowId: string; escrowRecord: any; generation: Generation; kind: string; buyerBps: number | null
}): Promise<RecreationClearance | null> {
  const { escrowId, escrowRecord, generation: g } = input
  const lost = await lostLiveAuthorizations(prisma, escrowId, g)
  if (lost.length === 0) return null // no authorization lost its pending: the pre-existing rules apply unchanged
  const eda = lost[0]

  // Option B1 of docs/p4-gate3-unknown-outcome-contract.md 6.11: automatic re-creation covers RELEASE and REFUND only. A SPLIT has
  // no end-to-end evidence yet (re-creation, PASS 0b convergence, fee obligation, both outputs against the ruling), so it is refused
  // and handled manually. Placed before every external read: nothing is asked of the network for a round that is refused anyway.
  if (input.kind === 'split') {
    throw recreationRefusal('SPLIT_UNSUPPORTED', `authorization ${eda.id} of escrow ${escrowId} is for a SPLIT: a lost SPLIT round is not re-created automatically (manual handling)`)
  }

  // A row that cannot name its transaction or its intent cannot be proven: refused, never inferred.
  if (!eda.unsignedTxid || !eda.intentDigest) {
    throw recreationRefusal('LEGACY_EDA', `authorization ${eda.id} of escrow ${escrowId} predates the re-creation evidence (no recorded transaction identity)`)
  }
  const intent = economicIntentDigest({
    escrowId, disputeId: g.id, appealRound: g.appealRound, arbiterId: g.arbiterId, ruling: g.ruling,
    authoritySignature: g.authoritySignature, kind: input.kind, buyerBps: input.buyerBps,
  })
  if (eda.intentDigest !== intent) {
    throw recreationRefusal('INTENT_MISMATCH', `a ${input.kind} round does not match what authorization ${eda.id} was committed for`)
  }

  // External truth, definitive reads only - any failure to read is "unknown", which refuses.
  let publicTx: boolean
  try {
    publicTx = (await fetchTransactionExistence(eda.unsignedTxid)).exists
  } catch (err) {
    throw recreationRefusal('CHAIN_UNREADABLE', `the network could not be asked about transaction ${eda.unsignedTxid} (${err instanceof Error ? err.message : String(err)})`)
  }
  if (publicTx) {
    throw recreationRefusal('TXID_PUBLIC', `transaction ${eda.unsignedTxid} of the lost round is already on the network - converge to it, never build another`)
  }

  const windowMs = config.trade.disputedRecreationSettleWindowMs
  const ageMs = Date.now() - eda.authorizedAt.getTime()
  if (windowMs === undefined || ageMs < windowMs) {
    throw recreationRefusal('WINDOW', windowMs === undefined
      ? 'DISPUTED_RECREATION_SETTLE_WINDOW_MS is not configured: a lost disputed round is not re-created automatically'
      : `authorization ${eda.id} was committed ${ageMs} ms ago, inside the ${windowMs} ms settle window - the lost round may still be in flight`)
  }

  let outpoint: 'UNSPENT' | 'SPENT'
  try {
    outpoint = await multisigProvider.canonicalOutpointState(escrowRecord)
  } catch (err) {
    throw recreationRefusal('CHAIN_UNREADABLE', `the funding outpoint could not be read (${err instanceof Error ? err.message : String(err)})`)
  }
  if (outpoint === 'SPENT') {
    throw recreationRefusal('OUTPOINT_SPENT', `the canonical funding outpoint of escrow ${escrowId} is no longer unspent - manual review, nothing to build`)
  }
  return { authorizationId: eda.id, authorizedAtMs: eda.authorizedAt.getTime(), pendingOperationId: eda.pendingOperationId }
}

/** Phase 2 - inside the D -> E transaction, before the new round is created. */
export async function assertRecreationStillCleared(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], escrowId: string, g: Generation, clearance: RecreationClearance | null,
): Promise<void> {
  const lost = await lostLiveAuthorizations(tx, escrowId, g)
  if (!clearance) {
    if (lost.length > 0) {
      throw recreationRefusal('CONCURRENT_CHANGE', `an authorization of escrow ${escrowId} lost its pending operation after this request was assessed`)
    }
    return
  }
  if (lost.length !== 1 || lost[0].id !== clearance.authorizationId || lost[0].authorizedAt.getTime() !== clearance.authorizedAtMs) {
    throw recreationRefusal('CONCURRENT_CHANGE', `the authorizations of escrow ${escrowId} changed between the assessment and the write (a competing re-creation?)`)
  }
}

/** Phase 2 - after the new round exists: the cleared authorization is superseded by it, in the same transaction. */
export async function supersedeClearedAuthorization(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], clearance: RecreationClearance, newPendingOperationId: string,
): Promise<void> {
  const updated = await tx.economicDispositionAuthorization.updateMany({
    where: { id: clearance.authorizationId, supersededAt: null },
    data: { supersededAt: new Date(), supersededByPendingOperationId: newPendingOperationId },
  })
  if (updated.count !== 1) {
    throw recreationRefusal('CONCURRENT_CHANGE', `authorization ${clearance.authorizationId} could not be superseded (already superseded)`)
  }
  log.warn({
    msg: 'A lost disputed signing round was re-created: its authorization is superseded by the new round (the old transaction identity stays recorded)',
    authorizationId: clearance.authorizationId, supersededPendingOperationId: clearance.pendingOperationId, newPendingOperationId,
  })
}
