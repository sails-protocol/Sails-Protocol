/**
 * Issue #239 - retiring a cooperative MULTISIG signing round: Sails stops collecting, combining, executing and
 * exposing it. Retired, NOT revoked - a SIGHASH_ALL signature already handed out stays valid for exactly this
 * transaction until the funding outpoint is spent by another one; reconcileExternalFundingSpends() watches that.
 *
 * Every function here runs inside the caller's withEscrowFundingLock() transaction (the lock signing, opening a
 * dispute and dispatching a ruling take), so the per-escrow hash chain and the "not fully signed" fact are read
 * and written with no concurrent writer. The retirement row and the deletion of the live round commit together.
 */
import { createHash, randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { EscrowError } from '../../common/errors'
import { capabilityOperationDigest } from './capability-execution-authorization'
import { roundUnsignedTxid } from './multisig-round-proofs'
import { networkFor } from './multisig.provider'
import { config } from '../../config'

type Tx = Prisma.TransactionClient
type RoundWithSignatures = Prisma.EscrowPendingTransactionGetPayload<{ include: { signatures: true } }>

export type RetirementReason = 'CANCELLED' | 'SUPERSEDED_BY_RULING'

/** The round can no longer be retired safely (it may have executed, or is not a cooperative round). */
export class RoundNotRetirable extends EscrowError {}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function signatureSetDigest(signatures: Array<{ participantId: string; signedPsbtBase64: string }>): string {
  return sha256(signatures.map((s) => `${s.participantId}:${sha256(s.signedPsbtBase64)}`).sort().join('\n'))
}

export function isFullySigned(round: RoundWithSignatures): boolean {
  const signed = new Set(round.signatures.map((s) => s.participantId))
  return round.requiredSigners.every((id) => signed.has(id))
}

/**
 * A cooperative round that provably never reached Sails' execution path: not fully signed (every execution path
 * needs every signature) and no durable execution evidence of any kind for it.
 */
export async function assertRetirable(tx: Tx, round: RoundWithSignatures): Promise<void> {
  if (round.disputeId) throw new RoundNotRetirable(`Pending round ${round.id} originates from a ruling, not a cooperative round (ADR-005)`)
  if (isFullySigned(round)) throw new RoundNotRetirable(`Pending round ${round.id} is fully signed and may already have executed`)
  const [capability, disposition, attempt] = await Promise.all([
    tx.capabilityExecutionAuthorization.findUnique({ where: { pendingOperationId: round.id }, select: { id: true } }),
    tx.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: round.id }, select: { id: true } }),
    tx.signatureCollectionFinalizationAttempt.findFirst({ where: { pendingTxId: round.id }, select: { id: true } }),
  ])
  if (capability || disposition || attempt) throw new RoundNotRetirable(`Pending round ${round.id} already has execution evidence`)
}

async function chainTip(tx: Tx, escrowId: string): Promise<string> {
  const rows = await tx.escrowPendingRoundRetirement.findMany({ where: { escrowId }, select: { recordHash: true, prevRecordHash: true } })
  const referenced = new Set(rows.map((r) => r.prevRecordHash))
  return rows.find((r) => !referenced.has(r.recordHash))?.recordHash ?? 'genesis'
}

function recordHashOf(fields: Record<string, unknown>): string {
  return sha256(JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]])))
}

export async function retireRound(tx: Tx, args: {
  round: RoundWithSignatures
  funding: { txid: string; vout: number; checkedAt: Date }
  reason: RetirementReason
  retiredBy: string
  ruling?: { disputeId: string; appealRound: number; supersedingPendingOperationId: string }
}) {
  const { round, funding, reason, retiredBy, ruling } = args
  await assertRetirable(tx, round)
  const fields = {
    pendingOperationId: round.id,
    escrowId: round.escrowId,
    kind: round.kind,
    unsignedTxid: roundUnsignedTxid(round.unsignedPsbtBase64, networkFor(config.multisig.network)),
    fundingTxid: funding.txid,
    fundingVout: funding.vout,
    outpointCheckedAt: funding.checkedAt.toISOString(),
    operationDigest: capabilityOperationDigest(round),
    requiredSigners: round.requiredSigners,
    signedBy: round.signatures.map((s) => s.participantId).sort(),
    signatureSetDigest: signatureSetDigest(round.signatures),
    reason,
    retiredBy,
    disputeId: ruling?.disputeId ?? null,
    appealRound: ruling?.appealRound ?? null,
    supersedingPendingOperationId: ruling?.supersedingPendingOperationId ?? null,
    prevRecordHash: await chainTip(tx, round.escrowId),
  }
  const retirement = await tx.escrowPendingRoundRetirement.create({
    data: { id: randomUUID(), ...fields, outpointCheckedAt: funding.checkedAt, recordHash: recordHashOf(fields) },
  })
  // Cascade-deletes the round's signatures: Sails will never combine or expose them again.
  const { count } = await tx.escrowPendingTransaction.deleteMany({ where: { id: round.id, escrowId: round.escrowId } })
  if (count !== 1) throw new EscrowError(`Pending round ${round.id} disappeared while it was being retired`)
  return retirement
}

/** Recomputes every record hash and the prevRecordHash links of one escrow's retirement chain. */
export async function verifyRetirementChain(client: Pick<Tx, 'escrowPendingRoundRetirement'>, escrowId: string): Promise<{ ok: boolean; problem?: string }> {
  const rows = await client.escrowPendingRoundRetirement.findMany({ where: { escrowId } })
  const byPrev = new Map(rows.map((r) => [r.prevRecordHash, r]))
  let prev = 'genesis'
  for (let i = 0; i < rows.length; i++) {
    const row = byPrev.get(prev)
    if (!row) return { ok: false, problem: `chain breaks after ${prev}` }
    const { id: _id, recordHash, retiredAt: _at, ...stored } = row
    const fields = { ...stored, outpointCheckedAt: stored.outpointCheckedAt.toISOString() }
    if (recordHashOf(fields) !== recordHash) return { ok: false, problem: `record ${row.id} does not match its hash` }
    prev = recordHash
  }
  return { ok: true }
}
