/**
 * Issue #239 - the definitions every round-lifecycle decision uses. Dependency-free on purpose: the live
 * dispatch gate (dispute-dispatch.ts), C4 recovery (dispute-dispatch-recovery.ts), the supersession
 * (escrow-pending-tx.ts) and the D1 commit-gate exception (economic-disposition-authority.ts) all decide
 * by them.
 *
 * Meaningful only for an escrow under dispute, the only place a ruling dispatch happens. There, a
 * cooperative round (no ruling provenance) still missing a required signature has provably never reached
 * execution (which needs every one) and can never complete through Sails any more (#239D: once a dispute
 * exists, cooperative signatures are refused). A ruling's own round, or any fully signed round (it may
 * already have been submitted - an UNKNOWN outcome; under D1 it is the frozen economic intent), is a
 * dispatch in its own right.
 *
 * #239D X1: superseding a dead round is safe only if nobody outside Sails can complete its transaction.
 * A round created under the confidential read contract never had another participant's signature returned
 * while incomplete (signaturesConfidential); a round from before it may have, so it is never superseded -
 * the dispatch fails closed for manual review instead of racing a spend that may still be completable.
 *
 * A row without a recorded `disputeId` field at all (not null) is treated as a dispatch, never supersedable.
 */
export interface RoundSupersessionFacts {
  disputeId?: string | null
  requiredSigners: string[]
  signatures?: Array<{ participantId: string }>
  signaturesConfidential?: boolean
}

function isFullySigned(round: RoundSupersessionFacts): boolean {
  // Never decide "not fully signed" from signatures that were simply not loaded.
  if (!round.signatures) throw new Error('round predicates: the round must be read with its signatures')
  const signed = new Set(round.signatures.map((s) => s.participantId))
  return round.requiredSigners.every((id) => signed.has(id))
}

/** A ruling's round, or a fully signed round: a dispatch in its own right that no ruling may replace. */
export function blocksRulingDispatch(round: RoundSupersessionFacts): boolean {
  return round.disputeId !== null || isFullySigned(round)
}

/** A dead cooperative round whose signatures were never exposed: the one kind a ruling may supersede. */
export function isSupersedableByRuling(round: RoundSupersessionFacts): boolean {
  return !blocksRulingDispatch(round) && round.signaturesConfidential === true
}

/**
 * #239D D1 - complete bilateral cooperative intent: a cooperative round whose every required signer's
 * signature is stored for this exact round, and whose completion was accepted, under the escrow lock,
 * while no dispute existed (bilateralAuthorityAt). Its transaction is exactly what the persisted unsigned
 * transaction plus those signatures reconstruct (deterministic id); it is the frozen economic intent a
 * later dispute may not replace. A round completed any other way (or before this marker existed) is not.
 */
export function isCompleteBilateralIntent(round: RoundSupersessionFacts & { bilateralAuthorityAt?: Date | null }): boolean {
  return round.disputeId === null && !!round.bilateralAuthorityAt && isFullySigned(round)
}
