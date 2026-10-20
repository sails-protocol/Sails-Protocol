/**
 * #235 R7G F8A — MULTISIG_RESIDUAL_VALUE_RECOVERY_V1.
 *
 * Value that reaches a MULTISIG escrow's original 2-of-3 script but is not, and can no longer become, that escrow's
 * canonical funding outpoint (a wrong or partial amount while CREATED, an extra or duplicate deposit, anything that
 * arrives after COMPLETED / REFUNDED / SPLIT) stays under the authority of the escrow's two ORIGINAL participants.
 * Sails never attributes it to the seller, the buyer, the treasury, the operator or the arbiter, and it never enters
 * normal settlement. Instead, per outpoint:
 *
 *   PROPOSED   either participant records the intent: one residual outpoint, the destination THEY choose, the fee —
 *              all committed in the unsigned PSBT before anyone signs (the database freezes it);
 *   SIGNED     the buyer AND the seller have each signed that exact PSBT with their own persisted escrow key
 *              (LOCAL_SIGNATURE_VALIDATION_V1); the single transaction those two signatures produce and its txid are
 *              persisted in the same write. The server never adds the arbiter signature;
 *   SUBMITTED  the network accepted those exact bytes (retries rebroadcast the same bytes — never a transaction B);
 *   CONFIRMED  that transaction is confirmed at the MULTISIG confirmation policy depth.
 *   CANCELLED  either participant may withdraw an intent until both have signed (a fully signed recovery is bearer
 *              authority and is executed, never withdrawn); the outpoint is then free for a new intent.
 *
 * The canonical escrow (status, funding outpoint, settlement result, events) is never read for authority beyond its
 * persisted script and participants, and never written: a COMPLETED escrow stays COMPLETED while its late residual
 * value is recovered. Explorer observation is evidence only; a counterparty's partial signature is never returned.
 */
import { prisma } from '../../common/database'
import { EscrowError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { config } from '../../config'
import { escrowFundingEvidenceService } from './escrow-funding-evidence.service'
import {
  multisigProvider, fetchChainTipHeight, fetchOutpointSpendStatus, fetchTransactionConfirmationStatus, fetchTransactionExistence,
  type MultisigEscrowInput,
} from './multisig.provider'

const log = childLogger('multisig-residual-recovery')

type Role = 'buyer' | 'seller'
type RecoveryRow = NonNullable<Awaited<ReturnType<typeof prisma.escrowResidualRecovery.findUnique>>>

/** The escrow, its trade parties and its persisted participant keys — the only authority a recovery reads. */
async function loadEscrowAuthority(escrowId: string) {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId }, include: { trade: { select: { buyerId: true, sellerId: true } }, participantKeys: true } })
  if (!escrow) throw new NotFoundError('Escrow', escrowId)
  if (escrow.type !== 'MULTISIG' || !escrow.multisigAddr) {
    throw new EscrowError(`Escrow ${escrowId} has no MULTISIG funding script — there is no residual value to recover`)
  }
  const key = (role: string) => escrow.participantKeys.find((k) => k.role === role)?.pubkey
  const input: MultisigEscrowInput = {
    tradeId: escrow.tradeId, lockedAmount: escrow.lockedAmount.toFixed(), status: escrow.status,
    buyerPubkey: key('buyer'), sellerPubkey: key('seller'), arbiterPubkey: key('arbiter'), multisigAddr: escrow.multisigAddr,
    txLockId: escrow.txLockId, txLockVout: escrow.txLockVout,
    feePolicyVersionId: escrow.feePolicyVersionId, snapshotProtocolFeeRate: escrow.snapshotProtocolFeeRate?.toString() ?? null,
    snapshotFeeCollectionAddress: escrow.snapshotFeeCollectionAddress, snapshotFeeCollectionWaivedPreFunding: escrow.snapshotFeeCollectionWaivedPreFunding,
  }
  return { escrow, input, buyerId: escrow.trade.buyerId, sellerId: escrow.trade.sellerId, key }
}

/** Only the escrow's two original participants act on its residual value — never the arbiter, the operator or a node. */
function roleOf(auth: { buyerId: string; sellerId: string }, participantId: string, escrowId: string): Role {
  if (participantId === auth.buyerId) return 'buyer'
  if (participantId === auth.sellerId) return 'seller'
  throw new ForbiddenError(`${participantId} is not an original participant of escrow ${escrowId}: residual value is recovered only by its buyer and seller together`)
}

/** What a participant may see: never the counterparty's (or their own) signed PSBT. */
function view(r: RecoveryRow) {
  return {
    id: r.id, escrowId: r.escrowId, status: r.status, outpoint: { txid: r.outpointTxid, vout: r.outpointVout }, valueSats: r.valueSats.toString(),
    destination: r.destination, feeSats: r.feeSats.toString(), unsignedPsbtBase64: r.unsignedPsbtBase64, proposedBy: r.proposedBy,
    buyerSigned: r.buyerSignedAt !== null, sellerSigned: r.sellerSignedAt !== null, txid: r.txid,
    submittedAt: r.submittedAt, confirmedAt: r.confirmedAt, confirmedBlockHeight: r.confirmedBlockHeight, cancelledAt: r.cancelledAt,
  }
}

async function assertFundingCertain(escrowId: string): Promise<void> {
  // A canonical funding outpoint whose evidence is currently uncertain (reorg) may be replaced by an output now at
  // the address: no output there is classified residual until the canonical funding is certain again.
  if (await escrowFundingEvidenceService.isFundingUncertain(escrowId)) {
    throw new EscrowError(`Escrow ${escrowId}'s canonical funding evidence is currently uncertain (reorg) — no output at its address is treated as residual until it is certain again`)
  }
}

/** The escrow's script outputs, classified, with the live recovery (if any) that claims each one. Read-only. */
export async function observeResidualValue(escrowId: string, participantId: string) {
  const auth = await loadEscrowAuthority(escrowId)
  roleOf(auth, participantId, escrowId)
  await assertFundingCertain(escrowId)
  const outputs = await multisigProvider.observeScriptOutputs(auth.input)
  const recoveries = await prisma.escrowResidualRecovery.findMany({ where: { escrowId }, orderBy: { createdAt: 'asc' } })
  const live = recoveries.filter((r) => r.status !== 'CANCELLED')
  return {
    escrowId, fundingAddress: auth.escrow.multisigAddr, escrowStatus: auth.escrow.status,
    outputs: outputs.map((o) => ({ ...o, claimedBy: live.find((r) => r.outpointTxid === o.txid && r.outpointVout === o.vout)?.id ?? null })),
    recoveries: recoveries.map(view),
  }
}

/**
 * Records a recovery intent for one residual outpoint, with the destination the participant chose (never derived from
 * a payout address, the treasury or the arbiter). The outpoint must be observed confirmed and RESIDUAL now; the
 * database refuses it if it is canonical funding or already claimed by a live recovery.
 */
export async function proposeResidualRecovery(escrowId: string, participantId: string, intent: { txid: string; vout: number; destination: string }) {
  if (!/^[0-9a-f]{64}$/.test(intent.txid) || !Number.isInteger(intent.vout) || intent.vout < 0) throw new ValidationError('A residual outpoint is a 64-hex txid and a non-negative vout')
  if (!intent.destination) throw new ValidationError('A residual recovery needs an explicit destination chosen by the participants')
  const auth = await loadEscrowAuthority(escrowId)
  roleOf(auth, participantId, escrowId)
  await assertFundingCertain(escrowId)
  const output = (await multisigProvider.observeScriptOutputs(auth.input)).find((o) => o.txid === intent.txid && o.vout === intent.vout)
  if (!output) throw new EscrowError(`${intent.txid}:${intent.vout} is not an unspent output of escrow ${escrowId}'s funding script`)
  if (output.classification !== 'RESIDUAL') {
    throw new EscrowError(`${intent.txid}:${intent.vout} is ${output.classification}, not residual value — ${output.classification === 'UNCONFIRMED' ? 'it is not confirmed at the MULTISIG confirmation policy depth' : 'it belongs to the escrow\'s canonical funding authority'}`)
  }
  const { psbtBase64, feeSats } = await multisigProvider.buildResidualRecoveryPsbt(auth.input, output, intent.destination)
  try {
    const created = await prisma.escrowResidualRecovery.create({
      data: {
        escrowId, fundingAddress: auth.escrow.multisigAddr!, outpointTxid: intent.txid, outpointVout: intent.vout, valueSats: BigInt(output.valueSats),
        destination: intent.destination, feeSats, unsignedPsbtBase64: psbtBase64, proposedBy: participantId,
      },
    })
    return view(created)
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new EscrowError(`${intent.txid}:${intent.vout} is already claimed by a live residual recovery of escrow ${escrowId}`)
    throw err
  }
}

/**
 * One participant's signature over the recovery's exact PSBT. Validated against the stored round and that
 * participant's persisted escrow key; the second participant's signature completes it: the one transaction both
 * signatures produce is persisted with its txid in the same write, then broadcast. Idempotent per participant.
 */
export async function submitResidualRecoverySignature(recoveryId: string, participantId: string, signedPsbtBase64: string) {
  const recovery = await prisma.escrowResidualRecovery.findUnique({ where: { id: recoveryId } })
  if (!recovery) throw new NotFoundError('EscrowResidualRecovery', recoveryId)
  const auth = await loadEscrowAuthority(recovery.escrowId)
  const role = roleOf(auth, participantId, recovery.escrowId)
  const column = role === 'buyer' ? 'buyerSignedPsbtBase64' : 'sellerSignedPsbtBase64'
  if (recovery[column] !== null) {
    if (recovery[column] === signedPsbtBase64) return view(recovery) // the same submission again
    throw new EscrowError(`The ${role} already signed residual recovery ${recoveryId} — a signature is never replaced`)
  }
  if (recovery.status !== 'PROPOSED') throw new EscrowError(`Residual recovery ${recoveryId} is ${recovery.status}: it takes no new signature`)
  const pubkey = auth.key(role)
  if (!pubkey) throw new EscrowError(`Escrow ${recovery.escrowId} has no persisted ${role} key`)
  multisigProvider.validatePartialSignature(auth.input, recovery.unsignedPsbtBase64, signedPsbtBase64, pubkey)

  const now = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<RecoveryRow[]>`SELECT * FROM escrow_residual_recoveries WHERE id = ${recoveryId} FOR UPDATE`
    if (locked.status !== 'PROPOSED' || locked[column] !== null) throw new EscrowError(`Residual recovery ${recoveryId} changed while being signed (${locked.status})`)
    const other = role === 'buyer' ? locked.sellerSignedPsbtBase64 : locked.buyerSignedPsbtBase64
    const own = role === 'buyer' ? { buyerSignedPsbtBase64: signedPsbtBase64, buyerSignedAt: now } : { sellerSignedPsbtBase64: signedPsbtBase64, sellerSignedAt: now }
    if (!other) return tx.escrowResidualRecovery.update({ where: { id: recoveryId }, data: own })
    // Both participants: the one spend their two signatures produce, under the original script (no arbiter key).
    const { txid, rawTxHex } = multisigProvider.finalizeResidualRecovery(auth.input, locked.unsignedPsbtBase64, [other, signedPsbtBase64])
    return tx.escrowResidualRecovery.update({ where: { id: recoveryId }, data: { ...own, status: 'SIGNED', signedTxHex: rawTxHex, txid } })
  })
  if (updated.status === 'SIGNED') {
    await driveResidualRecovery(recoveryId).catch((err) => log.warn({ msg: 'residual recovery signed; broadcast left to reconciliation', recoveryId, err: err instanceof Error ? err.message : String(err) }))
    return view(await prisma.escrowResidualRecovery.findUniqueOrThrow({ where: { id: recoveryId } }))
  }
  return view(updated)
}

/** Withdraws an intent before both participants signed; the outpoint is then free for a new intent. */
export async function cancelResidualRecovery(recoveryId: string, participantId: string) {
  const recovery = await prisma.escrowResidualRecovery.findUnique({ where: { id: recoveryId } })
  if (!recovery) throw new NotFoundError('EscrowResidualRecovery', recoveryId)
  roleOf(await loadEscrowAuthority(recovery.escrowId), participantId, recovery.escrowId)
  const res = await prisma.escrowResidualRecovery.updateMany({
    where: { id: recoveryId, status: 'PROPOSED', OR: [{ buyerSignedPsbtBase64: null }, { sellerSignedPsbtBase64: null }] },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: participantId },
  })
  if (res.count !== 1) {
    const now = await prisma.escrowResidualRecovery.findUniqueOrThrow({ where: { id: recoveryId } })
    if (now.status === 'CANCELLED') return view(now)
    throw new EscrowError(`Residual recovery ${recoveryId} is ${now.status}: both participants signed it, so it is executed, never withdrawn`)
  }
  return view(await prisma.escrowResidualRecovery.findUniqueOrThrow({ where: { id: recoveryId } }))
}

export async function getResidualRecovery(recoveryId: string, participantId: string) {
  const recovery = await prisma.escrowResidualRecovery.findUnique({ where: { id: recoveryId } })
  if (!recovery) throw new NotFoundError('EscrowResidualRecovery', recoveryId)
  roleOf(await loadEscrowAuthority(recovery.escrowId), participantId, recovery.escrowId)
  return view(recovery)
}

export type ResidualDriveOutcome = 'SUBMITTED' | 'CONFIRMED' | 'PENDING' | 'REVIEW'

/**
 * Moves a signed recovery toward chain truth with its ONE persisted transaction: known to the network -> SUBMITTED,
 * CONFIRMED once at the MULTISIG confirmation policy depth; not known (never accepted, or evicted / reorged out) and
 * its outpoint spent by anything else -> REVIEW (nothing is rebuilt); otherwise rebroadcast the same bytes.
 */
export async function driveResidualRecovery(recoveryId: string): Promise<{ outcome: ResidualDriveOutcome; reason?: string }> {
  const r = await prisma.escrowResidualRecovery.findUniqueOrThrow({ where: { id: recoveryId } })
  if (r.status === 'CONFIRMED') return { outcome: 'CONFIRMED' }
  if (r.status !== 'SIGNED' && r.status !== 'SUBMITTED') return { outcome: 'PENDING', reason: `recovery is ${r.status}` }
  const txid = r.txid!
  const known = await fetchTransactionExistence(txid)
  if (known.exists) {
    if (known.confirmed) {
      const status = await fetchTransactionConfirmationStatus(txid)
      if (status.blockHeight !== null && (await fetchChainTipHeight()) - status.blockHeight + 1 >= config.multisig.requiredConfirmations) {
        await prisma.escrowResidualRecovery.updateMany({ where: { id: recoveryId, status: { in: ['SIGNED', 'SUBMITTED'] } }, data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBlockHeight: status.blockHeight } })
        return { outcome: 'CONFIRMED' }
      }
    }
    if (r.status === 'SIGNED') return markSubmitted(recoveryId)
    return { outcome: 'PENDING', reason: 'submitted, not confirmed at policy depth yet' }
  }
  const spend = await fetchOutpointSpendStatus(r.outpointTxid, r.outpointVout)
  if (spend.spent && spend.spendingTxid !== txid) {
    log.error({ msg: 'residual outpoint spent by a transaction other than its signed recovery — manual review, nothing rebuilt', recoveryId, spendingTxid: spend.spendingTxid })
    return { outcome: 'REVIEW', reason: `outpoint ${r.outpointTxid}:${r.outpointVout} was spent by ${spend.spendingTxid}, not by recovery ${txid}` }
  }
  try {
    await multisigProvider.broadcastResidualRecovery(r.signedTxHex!)
  } catch (err) {
    return { outcome: 'PENDING', reason: `broadcast not confirmed accepted (the same bytes are retried): ${err instanceof Error ? err.message : String(err)}` }
  }
  return markSubmitted(recoveryId)
}

async function markSubmitted(recoveryId: string): Promise<{ outcome: ResidualDriveOutcome }> {
  await prisma.escrowResidualRecovery.updateMany({ where: { id: recoveryId, status: 'SIGNED' }, data: { status: 'SUBMITTED', submittedAt: new Date() } })
  return { outcome: 'SUBMITTED' }
}

/** Background convergence of signed recoveries (bounded batch, oldest first). Never signs, never rebuilds. */
export async function reconcileResidualRecoveries(limit = 50): Promise<{ confirmed: string[]; submitted: string[]; pending: string[]; review: Array<{ id: string; reason: string }>; failed: Array<{ id: string; error: string }> }> {
  const report = { confirmed: [] as string[], submitted: [] as string[], pending: [] as string[], review: [] as Array<{ id: string; reason: string }>, failed: [] as Array<{ id: string; error: string }> }
  const rows = await prisma.escrowResidualRecovery.findMany({ where: { status: { in: ['SIGNED', 'SUBMITTED'] } }, orderBy: { updatedAt: 'asc' }, take: limit, select: { id: true } })
  for (const { id } of rows) {
    try {
      const { outcome, reason } = await driveResidualRecovery(id)
      if (outcome === 'CONFIRMED') report.confirmed.push(id)
      else if (outcome === 'SUBMITTED') report.submitted.push(id)
      else if (outcome === 'REVIEW') report.review.push({ id, reason: reason ?? '' })
      else report.pending.push(id)
    } catch (err) {
      report.failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
