/**
 * E25/E26 F2 (CTO 28 Despacho 007, P33) - admission and execution readiness of a commitment pair, pure
 * (no I/O, no persistence, no authority granted).
 *
 * F2.1 `admitCommitmentPair`: the offer envelope's signature, shape and activity are verified FIRST and
 * the `AcceptedOffer` is derived from that verified envelope (never taken from the caller), so the
 * pair is only ever evaluated against a genuine offer (INV-INT-1). Eligibility (#235) runs after this,
 * in F4. F2.3: the capability comes from the real classification, `arbitrationCapabilityFor()`.
 * F2.2 `executionReadiness`: whether the commitment gate is passed. It is a NECESSARY condition only;
 * admission (E21), eligibility (#235), settlement binding and dispatch gates stay separate (spec §5).
 */
import { hashOfferEnvelope, isOfferEnvelopeEconomicallyActive, verifyOfferEnvelope, type SignedOfferEnvelope } from '../open-liquidity/offer-envelope'
import { arbitrationCapabilityFor } from '../open-settlement/arbitration-policy'
import type { E25Refusal, TradeCommitmentEvaluation } from './trade-commitment'
import { evaluateCommitmentPair, type CommitmentPairEvaluation, type CommitmentPairVerdict } from './arbitration-commitment'

export interface CommitmentPairAdmission {
  envelope: SignedOfferEnvelope
  /** The verifying server clock: the envelope must be economically active at this instant. */
  now: Date
  trade: Omit<TradeCommitmentEvaluation, 'offer'>
  arbitration: CommitmentPairEvaluation['arbitration']
}

export function admitCommitmentPair(i: CommitmentPairAdmission): CommitmentPairVerdict {
  const envelopeBad = (field: string): E25Refusal => ({ ok: false, code: 'E25_OFFER_ENVELOPE_INVALID', field })
  if (!verifyOfferEnvelope(i.envelope).valid) return envelopeBad('envelope')
  if (!isOfferEnvelopeEconomicallyActive(i.envelope, i.now)) return envelopeBad('envelope.active')
  const e = i.envelope
  const offer = {
    digest: hashOfferEnvelope(e).toString('hex'), logicalOfferId: e.logicalOfferId, revision: e.revision, ownerPublicKey: e.ownerPublicKey,
    side: e.side, asset: e.asset, priceUsd: e.priceUsd, paymentMethod: e.paymentMethod, minAmount: e.minAmount, maxAmount: e.maxAmount, expiresAt: e.expiresAt,
  }
  return evaluateCommitmentPair({ trade: { ...i.trade, offer }, arbitration: i.arbitration, deriveCapability: arbitrationCapabilityFor })
}

export type ExecutionReadiness =
  | { ok: true; gate: 'COMMITMENT_PAIR_COMMITTED'; commitmentDigest: string; arbitrationCommitmentDigest: string }
  | { ok: false; code: string; field?: string }

/**
 * Only a COMMITTED pair on a rail whose capability the real classification proves passes. The switch is
 * exhaustive over that classification: a new value (e.g. UNAVAILABLE, ADR-003/#580) fails to compile here
 * until its execution rule is decided (P32), instead of passing silently.
 */
export function executionReadiness(verdict: CommitmentPairVerdict, rail: string): ExecutionReadiness {
  if (!verdict.ok) return { ok: false, code: verdict.code, ...(verdict.field ? { field: verdict.field } : {}) }
  if ('executable' in verdict) return { ok: false, code: verdict.reason }
  if (verdict.state !== 'COMMITTED') return { ok: false, code: 'E25_NOT_COMMITTED' }
  const capability = arbitrationCapabilityFor(rail)
  switch (capability) {
    case 'FIXED_ARBITER_COMMITMENT':
    case 'DYNAMIC_REASSIGNABLE':
      return { ok: true, gate: 'COMMITMENT_PAIR_COMMITTED', commitmentDigest: verdict.commitmentDigest, arbitrationCommitmentDigest: verdict.arbitrationCommitmentDigest }
    case 'UNKNOWN':
      return { ok: false, code: 'E26_CAPABILITY_UNPROVEN' }
    default: {
      const unhandled: never = capability
      return { ok: false, code: `E26_CAPABILITY_UNHANDLED:${String(unhandled)}` }
    }
  }
}
