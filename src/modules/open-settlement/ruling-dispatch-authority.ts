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
 *                                 the round the ruling decided (generation, signed ruling, kind, bps, initiator) AND
 *                                 the AUD-1 binding passes against the locked dispute and the durable Outcome - which
 *                                 judges the destinations and amounts the transaction actually pays. Anything else is
 *                                 refused with the reasons, never accepted by id or kind. (The row's destination copy
 *                                 is metadata: a disagreement is reported, AUD1X-R3.)
 *   decideRulingRevert()        - what an operational failure of the live dispatch may do to the ruling, decided under
 *                                 the dispute and escrow locks: ADOPT (the dispatch exists: success), PRESERVE (a
 *                                 round of this generation exists but is not this dispatch: keep the ruling, refuse
 *                                 it, leave it to the guarded cleanup) or REVERT (nothing durable depends on it).
 *   revertCommittedRuling()     - AUD1X-R4: carrying a REVERT out. The dispute's authority is reverted only if the dispute
 *                                 still holds exactly this ruling, and the Outcome record is deleted only if it is the
 *                                 record of that same signed authority; otherwise nothing at all is changed.
 */
import type { DisputeRuling, Prisma } from '@prisma/client'
import { assertRoundBoundToDisputeAuthority } from './disputed-outcome-binding'
import { loadDisputeRulingRecord, revertDisputeRulingRecord } from './dispute-outcome'
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from './discretionary-authority'
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

/** `warnings`: row metadata that disagrees with the dispatch but moves no money (AUD1X-R3, AR2-03), reported, never a refusal. */
export type DispatchProof = { ok: true; warnings: string[] } | { ok: false; reasons: string[] }

const same = <T>(a: T | null | undefined, b: T | null | undefined) => (a ?? null) === (b ?? null)

/**
 * Is `existing` exactly the dispatch of `dispute`'s current ruling that `intent` describes? Called inside the
 * construction's locked transaction (dispute lock, escrow lock, dispute row FOR UPDATE), so what is compared cannot move.
 */
export async function proveRoundIsThisDispatch(tx: Tx, existing: ExistingRound, dispute: LockedDispute, intent: DispatchIntent): Promise<DispatchProof> {
  const reasons: string[] = []
  const warnings: string[] = []
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
  // AUD1X-R3 (AR2-03) - the row's toAddress/toAddressSecondary are a copy written at construction; no executor pays
  // from them. What the round pays is its transaction, judged below against the durable Outcome (destinations and
  // amounts). A disagreeing copy is reported, it neither proves nor refutes the dispatch.
  if (!same(existing.toAddress, intent.toAddress)) warnings.push('the round row records another primary destination than the Outcome (metadata only; the transaction is judged against the Outcome)')
  if (!same(existing.toAddressSecondary, intent.toAddressSecondary)) warnings.push('the round row records another secondary destination than the Outcome (metadata only; the transaction is judged against the Outcome)')
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
  return reasons.length === 0 ? { ok: true, warnings } : { ok: false, reasons }
}

/** A committed authorization of the decided generation, with the ruling identity the gate recorded (AUD1X-R3). */
export interface CommittedAuthorizationEvidence {
  id: string
  pendingOperationId: string
  arbiterId: string
  ruling: string
  rulingAuthoritySignature: string | null
  outcomeRecordId: string | null
  /** id of the durable Outcome record of that appeal round as it exists now (null: none) */
  currentOutcomeRecordId: string | null
}

const TERMINAL_STATUS_OF_RULING: Record<string, string> = { RELEASE: 'COMPLETED', REFUND: 'REFUNDED', SPLIT: 'SPLIT' }

/**
 * Is `authorization` the authorization of exactly the ruling being decided, and did the escrow end the way that ruling
 * decided? Identity is cryptographic and durable, never inferred from a generation number or a time: the authority
 * signature the gate recorded is this ruling's (it signs dispute, escrow, appeal round, arbiter, ruling, SPLIT bps and
 * issue time) and the durable Outcome record it judged is the one this ruling committed (destinations and amounts).
 *
 *   contradictions - the authorization is positively another ruling's (another signature, ruling or arbiter), or the
 *                    dispute no longer holds the ruling being decided;
 *   unproven       - nothing contradicts, but the identity cannot be proven: a row committed before the gate recorded
 *                    identity (legacy), or this very signed ruling judged against an Outcome record that is no longer
 *                    the current one (the Outcome was deleted and committed again);
 *   execution      - the identity holds, but the escrow did not end as this ruling decides, or no executed transaction
 *                    is recorded.
 */
export function authorizationIdentityGaps(
  authorization: CommittedAuthorizationEvidence,
  dispute: LockedDispute,
  escrow: { status: string; txReleaseId: string | null },
  authoritySignature: string,
): { contradictions: string[]; unproven: string[]; execution: string[] } {
  const contradictions: string[] = []
  const unproven: string[] = []
  const contradict = (ok: boolean, why: string) => { if (!ok) contradictions.push(why) }
  contradict(dispute.status === 'RESOLVED' && !!dispute.ruling && dispute.authoritySignature === authoritySignature, 'the dispute no longer holds the ruling being decided')
  contradict(authorization.ruling === dispute.ruling, `the authorization is for ruling ${authorization.ruling}, the dispute's is ${dispute.ruling ?? 'none'}`)
  contradict(authorization.arbiterId === dispute.arbiterId, 'the authorization was committed for another arbiter')
  if (authorization.rulingAuthoritySignature) {
    contradict(authorization.rulingAuthoritySignature === authoritySignature, 'the authorization was committed under another signed ruling')
  }
  if (!authorization.rulingAuthoritySignature || !authorization.outcomeRecordId) {
    unproven.push('the authorization predates recorded ruling identity (legacy): which ruling it authorized is not proven')
  } else if (authorization.outcomeRecordId !== authorization.currentOutcomeRecordId) {
    unproven.push('the authorization was judged against another durable Outcome record than the current one')
  }
  const execution: string[] = []
  if (escrow.status !== TERMINAL_STATUS_OF_RULING[dispute.ruling ?? '']) execution.push(`the escrow ended ${escrow.status}, not as ruling ${dispute.ruling ?? 'none'} decides`)
  if (!escrow.txReleaseId) execution.push('no executed transaction is recorded on the escrow')
  return { contradictions, unproven, execution }
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
 *      Disposition Authorization PROVEN to be this ruling's was
 *      committed (recorded authority signature and Outcome record
 *      equal to this ruling's; AUD1X-R3) and the escrow ended as
 *      this ruling decides, with an executed transaction            -> ADOPT: the round was executed to the end
 *      ... the same authorization, execution not proven, or an
 *      authorization that may be this ruling's but cannot be proven
 *      (legacy row without recorded identity; this signature judged
 *      against an Outcome record that is no longer current)          -> PRESERVE (reported, never success, nothing erased)
 *      ... only authorizations positively of another ruling
 *      (another signature, ruling or arbiter)                       -> REVERT (never adopted; their history untouched)
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
  const lockedDispute = async () => (await tx.$queryRaw<LockedDispute[]>`
      SELECT id, "escrowId", status::text AS status, "appealRound", "arbiterId", ruling::text AS ruling,
             "authoritySignature", "authorityIssuedAt", "authorityBuyerBps"
      FROM disputes WHERE id = ${ids.disputeId} FOR UPDATE`)[0]
  if (round && round.disputeId === ids.disputeId && round.rulingAppealRound === ids.appealRound && round.rulingAuthoritySignature === ids.authoritySignature) {
    const dispute = await lockedDispute()
    const proof: DispatchProof = dispute
      ? await proveRoundIsThisDispatch(tx, round, dispute, intent)
      : { ok: false, reasons: ['the dispute row is missing'] }
    if (proof.ok) {
      log.warn({ msg: 'AUD1X-R2: a dispatch failure did not revert the ruling - its dispatch exists and is proven to be exactly this round', ...logIds, roundId: round.id, ...(proof.warnings.length ? { metadataWarnings: proof.warnings } : {}) })
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
  const escrow = await tx.escrow.findUnique({ where: { id: ids.escrowId }, select: { status: true, txReleaseId: true } })
  if (escrow && ['COMPLETED', 'REFUNDED', 'SPLIT'].includes(escrow.status)) {
    // AUD1X-R3 (AR2-01) - an authorization of the same appeal round is not this ruling's by its generation number: a
    // ruling committed after an earlier one was executed (legacy revert) shares it. Each one is judged on the identity
    // the gate recorded; only an authorization proven to be THIS ruling's, on an escrow that ended as this ruling
    // decides, makes the dispatch done.
    const authorizations = await tx.$queryRaw<CommittedAuthorizationEvidence[]>`
      SELECT a.id, a."pendingOperationId", a."arbiterId", a.ruling::text AS ruling, a."rulingAuthoritySignature", a."outcomeRecordId",
             (SELECT r.id FROM semantic_transition_records r
              WHERE r."interactionId" = a."escrowId" AND r."transitionType" = ${ESCROW_DISPUTE_RULING_TRANSITION_TYPE}
                AND r."appealRound" = a."appealRound") AS "currentOutcomeRecordId"
      FROM economic_disposition_authorizations a
      WHERE a."escrowId" = ${ids.escrowId} AND a."disputeId" = ${ids.disputeId} AND a."appealRound" = ${ids.appealRound}
      ORDER BY a.id`
    if (authorizations.length > 0) {
      const dispute = await lockedDispute()
      const judged = authorizations.map((authorization) => ({
        authorization,
        gaps: dispute
          ? authorizationIdentityGaps(authorization, dispute, escrow, ids.authoritySignature)
          : { contradictions: ['the dispute row is missing'], unproven: [], execution: [] },
      }))
      const evidence = judged.map(({ authorization, gaps }) => ({ authorizationId: authorization.id, pendingOperationId: authorization.pendingOperationId, ruling: authorization.ruling, ...gaps }))
      const proven = judged.find(({ gaps }) => gaps.contradictions.length === 0 && gaps.unproven.length === 0)
      if (proven && proven.gaps.execution.length === 0) {
        log.warn({ msg: 'AUD1X-R3: a dispatch failure did not revert the ruling - an authorization proven to be this ruling\'s was executed', ...logIds, escrowStatus: escrow.status, authorizationId: proven.authorization.id })
        return { action: 'ADOPT', reason: 'AUTHORIZATION_COMMITTED' }
      }
      // Neither success nor revert: this ruling's own authority was committed but its execution is not proven, or an
      // authorization that may be this ruling's cannot be proven either way. Reverting would delete the Outcome of a
      // ruling that may be the executed one (the erasure AR-03 closed); adopting would report an unproven settlement.
      // The ruling, its Outcome and every authorization are kept; the call fails; reconciliation decides.
      const undecidable = proven ?? judged.find(({ gaps }) => gaps.contradictions.length === 0)
      if (undecidable) {
        const why = proven ? proven.gaps.execution : undecidable.gaps.unproven
        log.error({ msg: 'AUD1X-R3: the escrow was executed under an authorization that may be this ruling\'s but is not proven - ruling preserved, not reported as settled', ...logIds, escrowStatus: escrow.status, evidence })
        return {
          action: 'PRESERVE',
          error: new EscrowError(
            `Escrow ${ids.escrowId} was executed under a committed authorization that is not proven to be this ruling's executed dispatch ` +
            `(${why.join('; ')}); the ruling and its Outcome are preserved for reconciliation and are not reported as settled.`
          ),
        }
      }
      // Every authorization is positively another ruling's: the executed disposition belongs to another authority. This
      // ruling is not adopted; the revert below leaves every committed authorization and its history untouched.
      log.error({ msg: 'AUD1X-R3: the escrow was executed under another ruling\'s authorization - not adopted, ruling reverted', ...logIds, escrowStatus: escrow.status, evidence })
    }
  }
  return { action: 'REVERT' }
}

/** The ruling a failing call committed, as the dispute row and the Outcome record both identify it. */
export interface CommittedRuling {
  disputeId: string
  escrowId: string
  appealRound: number
  arbiterId: string
  ruling: DisputeRuling
  /** the signed authority: `disputes.authoritySignature` and the Outcome record's `attributionRawProof` */
  authoritySignature: string
}

/**
 * AUD1X-R4 - carries out a REVERT decided by decideRulingRevert(), inside the failure handler's transaction (dispute lock
 * D, then escrow lock E, already held). Two durable facts are changed together or not at all:
 *
 *   1. the dispute row leaves RESOLVED - only if it STILL holds exactly this ruling (status, ruling, arbiter, appeal round,
 *      authority signature). `count` must be exactly 1: anything else means this call no longer owns the dispute's
 *      authority (another ruling of the same round, a later generation, any other writer) and it must not undo, or
 *      delete the evidence of, a ruling that is not its own;
 *   2. the Outcome record of the same (escrow, round) is deleted - only if it is the record of that same signed
 *      authority. A record that exists and is another authority's is never deleted; the whole transaction (the dispute
 *      revert included) is rolled back by the error, so no partial revert survives.
 *
 * Every refusal is an error thrown from inside the transaction: nothing was written, no event is emitted, the original
 * failure of the dispatch is carried in the message. No signature, authorization, broadcast or lock is added: the caller
 * already holds D and E, and this reads and writes only the dispute row and the Outcome record.
 */
export async function revertCommittedRuling(
  tx: Tx,
  committed: CommittedRuling,
  restore: Prisma.DisputeUncheckedUpdateManyInput,
  dispatchFailure: unknown,
): Promise<void> {
  const failure = dispatchFailure instanceof Error ? dispatchFailure.message : String(dispatchFailure)
  const logIds = { disputeId: committed.disputeId, escrowId: committed.escrowId, appealRound: committed.appealRound }

  const claimed = await tx.dispute.updateMany({
    where: {
      id: committed.disputeId,
      status: 'RESOLVED',
      ruling: committed.ruling,
      arbiterId: committed.arbiterId,
      appealRound: committed.appealRound,
      authoritySignature: committed.authoritySignature,
    },
    data: restore,
  })
  if (claimed.count !== 1) {
    log.error({ msg: 'AUD1X-R4: the dispute no longer holds the ruling this call committed - revert not applied, no Outcome record deleted', ...logIds, matched: claimed.count })
    throw new EscrowError(
      `The dispute no longer holds the ruling this call committed (appeal round ${committed.appealRound}); its revert was not applied and ` +
      `no Outcome record was deleted. Original failure: ${failure}`
    )
  }

  const deleted = await revertDisputeRulingRecord(committed.escrowId, committed.appealRound, tx, committed.authoritySignature)
  if (deleted === 1) return

  const standing = await loadDisputeRulingRecord(committed.escrowId, committed.appealRound, tx)
  if (standing) {
    log.error({ msg: 'AUD1X-R4: the Outcome record of this appeal round is another authority\'s - revert rolled back, record kept', ...logIds })
    throw new EscrowError(
      `The Outcome record of appeal round ${committed.appealRound} is not the record of the ruling this call committed; the revert was rolled back ` +
      `and the record kept. Original failure: ${failure}`
    )
  }
  // The dispute carried this ruling and its record is already gone (an earlier code's revert): nothing left to delete.
  log.warn({ msg: 'AUD1X-R4: the dispute was reverted and no Outcome record existed for its ruling', ...logIds })
}
