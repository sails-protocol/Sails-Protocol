/**
 * AUD-1 - Disputed Economic Outcome Binding.
 *
 * A signed dispute ruling and its durable Outcome are the economic authority of a disputed escrow. ADR-005's gate
 * (economic-disposition-authority.ts) proves the GENERATION that authorized a pending round is still current; it
 * never compared WHAT the round does with what the ruling decided. An assigned arbiter holding only a session
 * could therefore start a REFUND round on an escrow whose current, signed ruling was RELEASE (initiate-refund
 * checks the arbiter's identity, not the ruling), and every later step - signature, gate, finalize, broadcast -
 * only re-checked the generation. This module is the one place that states the binding, and every boundary calls it:
 *
 *   - CONSTRUCTION (escrow-pending-tx.ts initiateSignatureCollectionCore(), before a round is persisted): a round
 *     that contradicts the ruling is never stored, so it cannot occupy the escrow's one pending slot either.
 *   - EXECUTION (the ADR-005 gate, inside its dispute-locked transaction, before any claim or provider call - live
 *     finalization and the C8 recovery both pass through it): the stored round is re-validated against the live
 *     ruling and the durable Outcome. It does not trust that construction ran, ran under this code, or ran at all
 *     (rounds persisted by earlier code, or written by anything else, are judged here).
 *
 * What is bound, from authority that already exists (nothing new is introduced, no Outcome is redefined):
 *   - every rail: the round's kind is the ruling's kind (RELEASE-release, REFUND-refund, SPLIT-split) and the
 *     ruling the round carries is the dispute's ruling; a SPLIT round carries the ruling's signed buyerBps; the
 *     dispute is the escrow's own;
 *   - MULTISIG (the only rail whose ruling commits a durable Outcome, dispute-outcome.ts): the Outcome of that very
 *     appeal round exists, is the RESOLVED transition of that very ruling, and the stored transaction pays exactly
 *     what it authorizes - destinations, amounts, output count, execution-cost ceiling - checked by the same
 *     translation guard the live dispatch and C4 recovery use (dispatch-translation-guard.ts), not a second copy.
 *
 * Fails closed. A ruling that cannot be proven to be what the round does is an error, never a pass.
 * The other signature-collection rails (LIGHTNING_HODL, SAFE_GUARD_EVM) commit no durable Outcome today, so only the
 * kind/ruling/bps binding applies to them; that boundary is stated here, not hidden.
 */
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import { loadDisputeRulingRecord, fromDisputeRulingRow } from './dispute-outcome'
import { assertTranslationMatchesOutcome } from './dispatch-translation-guard'
import { networkFor } from './multisig.provider'
import { assertDispositionMatchesRuling } from './disposition-ruling-binding'

/** What the round persists and does. All of it is immutable once the round exists. */
export interface DisputedRoundFacts {
  escrowId: string
  escrowType: string
  kind: string
  unsignedPsbtBase64: string
  minerFeeSats: number | null
  buyerBps: number | null
  disputeId: string | null
  rulingAppealRound: number | null
  rulingOutcome: string | null
}

/** The dispute row the round is judged against: the live row at execution, the row the provenance is copied from at construction. */
export interface BindingDispute {
  id: string
  escrowId: string
  status: string
  ruling: string | null
  authorityBuyerBps: number | null
}

/** The Prisma surface this check reads through (the shared client, or a transaction client). */
type OutcomeReader = Parameters<typeof loadDisputeRulingRecord>[2]

export async function assertRoundBoundToDisputeAuthority(
  client: OutcomeReader,
  round: DisputedRoundFacts,
  dispute: BindingDispute,
): Promise<void> {
  const where = `pending ${round.kind} round of escrow ${round.escrowId}`
  if (!round.disputeId || round.disputeId !== dispute.id) {
    throw new EscrowError(`AUD-1: ${where} does not belong to dispute ${dispute.id}; refusing to execute a disposition no ruling authorized.`)
  }
  if (dispute.escrowId !== round.escrowId) {
    throw new EscrowError(`AUD-1: ${where} records dispute ${dispute.id}, which belongs to another escrow; refusing.`)
  }
  if (dispute.status !== 'RESOLVED' || !dispute.ruling) {
    throw new EscrowError(`AUD-1: dispute ${dispute.id} has no resolved ruling (status ${dispute.status}); no disposition of ${where} is authorized.`)
  }
  if (round.rulingOutcome !== dispute.ruling) {
    throw new EscrowError(`AUD-1: ${where} carries ruling ${round.rulingOutcome ?? 'none'} but the dispute's ruling is ${dispute.ruling}; refusing.`)
  }
  assertDispositionMatchesRuling(round.kind, round.buyerBps, dispute, where)

  // Only MULTISIG commits a durable Outcome (dispute-outcome.ts's Core-authoritative path).
  if (round.escrowType !== 'MULTISIG') return

  if (round.rulingAppealRound === null) {
    throw new EscrowError(`AUD-1: ${where} records no appeal round; its Outcome cannot be identified. Refusing.`)
  }
  const row = await loadDisputeRulingRecord(round.escrowId, round.rulingAppealRound, client)
  if (!row || !row.outcomeContent) {
    throw new EscrowError(
      `AUD-1: no durable Core-authoritative Outcome exists for escrow ${round.escrowId} appeal round ${round.rulingAppealRound}; ` +
      `${where} has no economic authority to execute against. Refusing.`
    )
  }
  const content = row.outcomeContent as { ruling?: unknown } | null
  if (row.toState !== 'RESOLVED' || typeof content !== 'object' || content === null || Array.isArray(content) || content.ruling !== dispute.ruling) {
    throw new EscrowError(`AUD-1: the durable Outcome of escrow ${round.escrowId} appeal round ${round.rulingAppealRound} is not the RESOLVED ${dispute.ruling} transition; refusing.`)
  }
  const record = fromDisputeRulingRow(row)
  if (!record.outcome) {
    throw new EscrowError(`AUD-1: the durable record of escrow ${round.escrowId} appeal round ${round.rulingAppealRound} carries no Outcome; refusing.`)
  }
  // Destinations, amounts, output count, execution-cost ceiling: the shared guard, throws TranslationGuardError.
  assertTranslationMatchesOutcome(round.unsignedPsbtBase64, record.outcome, networkFor(config.multisig.network), round.minerFeeSats ?? undefined)
}
