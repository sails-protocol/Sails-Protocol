/**
 * AUD1X-R2 - the two decisions that make a disputed MULTISIG ruling's dispatch idempotent and keep a technical
 * dispatch failure from revoking an economic authority that was already committed.
 *
 * Background (AUD1X-H1 independent review, AR-01 / AR-03): three executors can build the signing round of one
 * committed ruling - the live resolve flow, the C4 dispatch recovery and the assigned arbiter's own initiate-*. They
 * are serialized by the dispute lock (D) and then the escrow lock (E), but the live flow treated "someone else
 * already built it" as ITS failure and reverted the signed ruling (and deleted its Outcome) - leaving the other
 * executor's round stranded, or erasing the authority of an execution that had already been authorized.
 *
 * This module states the rule in one place. It creates no authority: it only RECOGNISES a dispatch that the existing
 * construction boundary (AUD-1 binding under the dispute lock) produced - or an authorization the ADR-005 gate already
 * committed - and REFUSES to undo what the durable ledger already shows.
 *
 *   proveRoundIsThisDispatch()  - a round that already exists is this ruling's dispatch only if it is, field by field,
 *                                 the round the ruling decided (generation, signed ruling, kind, destinations, bps,
 *                                 initiator) AND the AUD-1 binding passes against the locked dispute and the durable
 *                                 Outcome. Anything else is refused with the reasons, never accepted by id or kind.
 *   decideRulingRevert()        - what an operational failure of the live dispatch may do to the ruling, decided under
 *                                 the dispute and escrow locks: ADOPT (the dispatch exists: success), PRESERVE (a
 *                                 round of this generation exists but is not this dispatch: keep the ruling, refuse
 *                                 it, leave it to the guarded cleanup) or REVERT (nothing durable depends on it).
 */
import type { Prisma } from '@prisma/client'
import { assertRoundBoundToDisputeAuthority } from './disputed-outcome-binding'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'

const log = childLogger('ruling-dispatch-authority')

type Tx = Prisma.TransactionClient

/** The dispute row, read FOR UPDATE under the dispute and escrow locks. */
export interface LockedDispute {
  id: string
  escrowId: string
  status: string
  appealRound: number
  arbiterId: string | null
  ruling: string | null
  authoritySignature: string | null
  authorityIssuedAt: Date | null
  authorityBuyerBps: number | null
}

/** What THIS caller is about to persist (what the construction would have created). */
export interface DispatchIntent {
  escrowId: string
  escrowType: string
  kind: 'release' | 'refund' | 'split'
  triggeredBy: string
  toAddress: string | null
  toAddressSecondary: string | null
  buyerBps: number | null
  /** undefined = not known by this caller, not compared */
  feeCollectionSats?: number | null
  feeCollectionWaived?: boolean | null
}

/** The persisted round (the columns that matter; read through the locked transaction). */
export interface ExistingRound {
  id: string
  escrowId: string
  kind: string
  toAddress: string
  toAddressSecondary: string | null
  buyerBps: number | null
  feeCollectionSats: number | null
  feeCollectionWaived: boolean | null
  minerFeeSats: number | null
  unsignedPsbtBase64: string
  triggeredBy: string
  disputeId: string | null
  rulingAppealRound: number | null
  rulingArbiterId: string | null
  rulingOutcome: string | null
  rulingAuthoritySignature: string | null
  rulingAuthorityIssuedAt: Date | null
}

export type DispatchProof = { ok: true } | { ok: false; reasons: string[] }

const same = <T>(a: T | null | undefined, b: T | null | undefined) => (a ?? null) === (b ?? null)

/**
 * Is `existing` exactly the dispatch of `dispute`'s current ruling that `intent` describes? Called inside the
 * construction's locked transaction (dispute lock, escrow lock, dispute row FOR UPDATE), so what is compared cannot move.
 */
export async function proveRoundIsThisDispatch(tx: Tx, existing: ExistingRound, dispute: LockedDispute, intent: DispatchIntent): Promise<DispatchProof> {
  const reasons: string[] = []
  const need = (ok: boolean, why: string) => { if (!ok) reasons.push(why) }

  need(existing.escrowId === intent.escrowId && dispute.escrowId === intent.escrowId, 'round or dispute belongs to another escrow')
  need(dispute.status === 'RESOLVED' && !!dispute.ruling, `dispute is not resolved (status ${dispute.status})`)
  need(existing.disputeId === dispute.id, `round records dispute ${existing.disputeId ?? 'none'}, not ${dispute.id}`)
  need(existing.rulingAppealRound === dispute.appealRound, `round records appeal round ${existing.rulingAppealRound ?? 'none'}, the dispute is at ${dispute.appealRound}`)
  need(!!existing.rulingArbiterId && existing.rulingArbiterId === dispute.arbiterId, 'round records another arbiter than the ruling\'s')
  need(!!existing.rulingOutcome && existing.rulingOutcome === dispute.ruling, `round records ruling ${existing.rulingOutcome ?? 'none'}, the dispute's is ${dispute.ruling ?? 'none'}`)
  need(!!existing.rulingAuthoritySignature && existing.rulingAuthoritySignature === dispute.authoritySignature, 'round records another signed authority than the ruling\'s')
  need(!!existing.rulingAuthorityIssuedAt && !!dispute.authorityIssuedAt && existing.rulingAuthorityIssuedAt.getTime() === dispute.authorityIssuedAt.getTime(), 'round records another authority issue time')
  need(existing.kind === intent.kind, `round is a ${existing.kind}, this dispatch is a ${intent.kind}`)
  need(existing.triggeredBy === intent.triggeredBy, 'round was initiated by another identity')
  need(same(existing.toAddress, intent.toAddress), 'round pays another primary destination')
  need(same(existing.toAddressSecondary, intent.toAddressSecondary), 'round pays another secondary destination')
  need(same(existing.buyerBps, intent.buyerBps), 'round carries another SPLIT allocation')
  if (intent.feeCollectionSats !== undefined || intent.feeCollectionWaived !== undefined) {
    need(same(existing.feeCollectionSats, intent.feeCollectionSats) && same(existing.feeCollectionWaived, intent.feeCollectionWaived), 'round carries another protocol-fee decision')
  }

  if (reasons.length === 0) {
    // Destinations, amounts, output count, execution-cost ceiling, kind and bps against the durable Outcome and the
    // live ruling: the same AUD-1 check the construction and the gate use, judged on the STORED round.
    try {
      await assertRoundBoundToDisputeAuthority(tx, {
        escrowId: existing.escrowId,
        escrowType: intent.escrowType,
        kind: existing.kind,
        unsignedPsbtBase64: existing.unsignedPsbtBase64,
        minerFeeSats: existing.minerFeeSats,
        buyerBps: existing.buyerBps,
        disputeId: existing.disputeId,
        rulingAppealRound: existing.rulingAppealRound,
        rulingOutcome: existing.rulingOutcome,
      }, {
        id: dispute.id, escrowId: dispute.escrowId, status: dispute.status, ruling: dispute.ruling, authorityBuyerBps: dispute.authorityBuyerBps,
      })
    } catch (err) {
      reasons.push(`AUD-1 binding: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

export type RulingRevertDecision =
  | { action: 'ADOPT'; reason: 'AUTHORIZATION_COMMITTED' | 'EQUIVALENT_ROUND' }
  | { action: 'PRESERVE'; error: Error }
  | { action: 'REVERT' }

/**
 * What may an operational failure of THIS call's dispatch do to the ruling? Decided inside the failure handler's own
 * transaction, after the dispute lock (D) and with the escrow lock (E) taken here - the order of every other holder.
 *
 * "This ruling" is the signed generation: dispute, appeal round AND the signed authority the round recorded - a round
 * left by an earlier, reverted ruling of the same appeal round is not this ruling's.
 *
 * Distinguished states (AUD1X-R2 policy; not equivalent, not collapsed):
 *   1. no round of this ruling and no executed disposition        -> REVERT (the arbiter re-submits; unchanged)
 *   2. a round of this ruling exists and is, proven, its dispatch
 *      (built by C4 or an initiate-*, signed or not, authorized
 *      or not, claimed or not: each only moves the same round on)  -> ADOPT: the dispatch is done, the call succeeds
 *   3. a round of this ruling exists but is NOT its dispatch       -> PRESERVE: the ruling and its Outcome stay, the
 *      (divergent legacy or foreign round)                            round is refused with the reasons; the guarded
 *                                                                    cleanup removes it if the guard fails and C4
 *                                                                    re-dispatches (reverting would strand it)
 *   4. no round any more, the escrow is terminal and an Economic
 *      Disposition Authorization of this generation was committed  -> ADOPT: the round was executed to the end
 * A terminal escrow with NO authorization of this generation is the #239D bilateral case and keeps its existing
 * handling (the revert restores MOOT through rulingRevertTarget()).
 */
export async function decideRulingRevert(
  tx: Tx,
  ids: { escrowId: string; disputeId: string; appealRound: number; authoritySignature: string },
  intent: DispatchIntent,
): Promise<RulingRevertDecision> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ids.escrowId})::bigint)`
  const logIds = { escrowId: ids.escrowId, disputeId: ids.disputeId, appealRound: ids.appealRound }
  const round = await tx.escrowPendingTransaction.findUnique({ where: { escrowId: ids.escrowId } })
  if (round && round.disputeId === ids.disputeId && round.rulingAppealRound === ids.appealRound && round.rulingAuthoritySignature === ids.authoritySignature) {
    const [dispute] = await tx.$queryRaw<LockedDispute[]>`
      SELECT id, "escrowId", status::text AS status, "appealRound", "arbiterId", ruling::text AS ruling,
             "authoritySignature", "authorityIssuedAt", "authorityBuyerBps"
      FROM disputes WHERE id = ${ids.disputeId} FOR UPDATE`
    const proof: DispatchProof = dispute
      ? await proveRoundIsThisDispatch(tx, round, dispute, intent)
      : { ok: false, reasons: ['the dispute row is missing'] }
    if (proof.ok) {
      log.warn({ msg: 'AUD1X-R2: a dispatch failure did not revert the ruling - its dispatch exists and is proven to be exactly this round', ...logIds, roundId: round.id })
      return { action: 'ADOPT', reason: 'EQUIVALENT_ROUND' }
    }
    log.error({ msg: 'AUD1X-R2: a round of this ruling exists but is not its dispatch - refused, ruling preserved for reconciliation', ...logIds, roundId: round.id, reasons: proof.reasons })
    return {
      action: 'PRESERVE',
      error: new EscrowError(
        `Escrow ${ids.escrowId} has a pending ${round.kind} transaction of this ruling that is not the dispatch of the ruling ` +
        `(${proof.reasons.join('; ')}); the ruling and its Outcome are preserved and the round is not adopted.`
      ),
    }
  }
  const escrow = await tx.escrow.findUnique({ where: { id: ids.escrowId }, select: { status: true } })
  if (escrow && ['COMPLETED', 'REFUNDED', 'SPLIT'].includes(escrow.status)) {
    const authorization = await tx.economicDispositionAuthorization.findFirst({
      where: { escrowId: ids.escrowId, disputeId: ids.disputeId, appealRound: ids.appealRound }, select: { id: true },
    })
    if (authorization) {
      log.warn({ msg: 'AUD1X-R2: a dispatch failure did not revert the ruling - its round was already authorized and executed', ...logIds, escrowStatus: escrow.status })
      return { action: 'ADOPT', reason: 'AUTHORIZATION_COMMITTED' }
    }
  }
  return { action: 'REVERT' }
}
