/**
 * E26 - `ArbitrationCommitmentV1` and its policy document, client side, pure (no I/O).
 * Independent twin of the server's `src/modules/open-p2p/arbitration-commitment.ts`.
 *
 * Contract: Aux 01, E26 M3 spec v2 §1.1 and §9 (CTO 28 Despacho 002). The object is bound to a
 * `TradeCommitmentV1` (its first field after the tag is that commitment's digest) and is signed by
 * the same two parties in the same action; the pair is COMMITTED together or not at all.
 * The capability is never read from the object: the caller derives it from the rail
 * (`deriveCapability`) and this module compares. `arbitration-policy.ts` is not changed here;
 * `UNAVAILABLE` exists only in this module until the CTO decides on ADR-003/#580.
 * Shared vectors in
 * `conformance/vectors/sails-trade-commitment-v1.vectors.json`.
 */
import {
  TRADE_COMMITMENT_DOMAIN_TAG, evaluateTradeCommitment, hasExactKeys, sha256Hex, verifyDigestSignature,
  type E25Refusal, type PartySignature, type TradeCommitmentEvaluation,
} from './trade-commitment'

export const ARBITRATION_COMMITMENT_DOMAIN_TAG = 'sails-arbitration-commitment-v1'
export const ARBITRATION_POLICY_DOMAIN_TAG = 'sails-arbitration-policy-v1'
const FIELD_SEPARATOR = '\x1f'

export const ARBITRATION_CAPABILITIES = ['FIXED_ARBITER_COMMITMENT', 'DYNAMIC_REASSIGNABLE', 'UNAVAILABLE', 'UNKNOWN'] as const
export type ArbitrationCapability = (typeof ARBITRATION_CAPABILITIES)[number]

export type E26RefusalCode =
  | 'E26_NONCANONICAL_FIELD' | 'E26_COMMITMENT_BINDING_MISMATCH' | 'E26_POLICY_DIGEST_MISMATCH'
  | 'E26_TERMS_REFUSED' | 'E26_DIGEST_MISMATCH' | 'E26_COSIGNATURE_INCOMPLETE' | 'E26_SIGNATURE_INVALID' | 'E26_EXPIRED'
/** `E26_TERMS_REFUSED` carries the ordered rule violations (R1 -> R7) in `terms`. */
export type E26Refusal = { ok: false; code: E26RefusalCode; field?: string; terms?: string[] }

export interface ArbitrationCommitmentV1 {
  commitmentDigest: string
  commitmentDomainTag: string
  anchorRef: string
  makerPublicKey: string
  takerPublicKey: string
  rail: string
  arbitrationCapability: string
  arbitrationPolicyDigest: string
  /** Ed25519 ruling key (FIXED), pool/rule hash (DYNAMIC), literal `NONE` (UNAVAILABLE) or `UNPROVEN` (UNKNOWN). */
  arbiterRef: string
  proposedAt: string
  expiresAt: string
}

export interface ArbitrationPolicyV1 {
  policyVersion: string
  capability: string
  mode: string
  rail: string
  arbiterSelection: string
  appeal: string
  hosting: string
  liveness: string
}

const HEX64 = /^[0-9a-f]{64}$/
const TEXT = /^[^\x00-\x1f\x7f]{1,200}$/ // eslint-disable-line no-control-regex
const APPEAL_FIXED = 'E26_CONTRADICTORY_ARBITRATION_TERMS:appeal(none may be promised on the current script)'
const ARBITER_REF_OK: Record<ArbitrationCapability, (ref: string) => boolean> = {
  FIXED_ARBITER_COMMITMENT: (r) => HEX64.test(r), DYNAMIC_REASSIGNABLE: (r) => HEX64.test(r),
  UNAVAILABLE: (r) => r === 'NONE', UNKNOWN: (r) => r === 'UNPROVEN',
}
const SELECTION: Record<ArbitrationCapability, string> = {
  FIXED_ARBITER_COMMITMENT: 'fixed', DYNAMIC_REASSIGNABLE: 'pool', UNAVAILABLE: 'none', UNKNOWN: 'unproven',
}
const isCapability = (c: string): c is ArbitrationCapability => (ARBITRATION_CAPABILITIES as readonly string[]).includes(c)

export function hashArbitrationPolicy(p: ArbitrationPolicyV1): string {
  return sha256Hex([ARBITRATION_POLICY_DOMAIN_TAG, p.policyVersion, p.capability, p.mode, p.rail, p.arbiterSelection, p.appeal, p.hosting, p.liveness].join(FIELD_SEPARATOR))
}

export function canonicalizeArbitrationCommitment(a: ArbitrationCommitmentV1): string {
  return [
    ARBITRATION_COMMITMENT_DOMAIN_TAG, a.commitmentDigest, a.commitmentDomainTag, a.anchorRef, a.makerPublicKey,
    a.takerPublicKey, a.rail, a.arbitrationCapability, a.arbitrationPolicyDigest, a.arbiterRef, a.proposedAt, a.expiresAt,
  ].join(FIELD_SEPARATOR)
}

export function hashArbitrationCommitment(a: ArbitrationCommitmentV1): string {
  return sha256Hex(canonicalizeArbitrationCommitment(a))
}

/**
 * Rules R1-R7 (spec §9.2), every violation in this fixed order: R1 capability valid and equal to
 * the rail-derived one; R2/R3 the policy names the same capability and rail; R4 arbiterRef fits the
 * capability; R5 arbiterSelection fits; R6 FIXED promises no appeal and no liveness on the current
 * script; R7 UNAVAILABLE/UNKNOWN promise no appeal (R4 already forbids them an arbiter or pool).
 */
export function validateArbitrationTerms(a: ArbitrationCommitmentV1, p: ArbitrationPolicyV1, derivedCapability: string): string[] {
  const e: string[] = []
  const cap = a.arbitrationCapability
  if (!isCapability(cap)) e.push('E26_CAPABILITY_INVALID')
  if (cap !== derivedCapability) e.push('E26_CAPABILITY_RAIL_MISMATCH')
  if (p.capability !== cap) e.push('E26_CONTRADICTORY_ARBITRATION_TERMS:policy.capability')
  if (p.rail !== a.rail) e.push('E26_CONTRADICTORY_ARBITRATION_TERMS:policy.rail')
  if (!isCapability(cap) || !ARBITER_REF_OK[cap](a.arbiterRef)) e.push('E26_ARBITER_REF_INVALID')
  if (!isCapability(cap) || p.arbiterSelection !== SELECTION[cap]) e.push('E26_CONTRADICTORY_ARBITRATION_TERMS:arbiterSelection')
  if (cap === 'FIXED_ARBITER_COMMITMENT' && p.appeal !== 'NONE_SCRIPT_FIXED') e.push(APPEAL_FIXED)
  if ((cap === 'UNAVAILABLE' || cap === 'UNKNOWN') && !p.appeal.startsWith('NONE')) e.push('E26_CONTRADICTORY_ARBITRATION_TERMS:appeal')
  if (cap === 'FIXED_ARBITER_COMMITMENT' && p.liveness !== 'NONE_UNDER_CURRENT_SCRIPT') e.push('E26_CONTRADICTORY_ARBITRATION_TERMS:liveness')
  return e
}

export interface CommitmentPairEvaluation {
  trade: TradeCommitmentEvaluation
  arbitration: { commitment: ArbitrationCommitmentV1; declaredDigest: string; policy: ArbitrationPolicyV1; maker?: PartySignature; taker?: PartySignature }
  /** The rail classification (ADR-003), injected; never taken from the object. */
  deriveCapability: (rail: string) => string
}
export type CommitmentPairVerdict =
  | { ok: true; state: 'PROPOSED' | 'PARTIALLY_SIGNED' | 'COMMITTED'; commitmentDigest: string; arbitrationCommitmentDigest: string }
  | E25Refusal | E26Refusal

/**
 * The trade is accepted only as a pair: the `TradeCommitmentV1` and its `ArbitrationCommitmentV1`
 * both bilaterally signed. Each party signs both digests in one action, so a party with one of the
 * two signatures and not the other is refused, and COMMITTED needs all four.
 */
export function evaluateCommitmentPair(e: CommitmentPairEvaluation): CommitmentPairVerdict {
  const trade = evaluateTradeCommitment(e.trade)
  if (!trade.ok) return trade
  const c = e.trade.commitment
  const { commitment: a, policy: p } = e.arbitration
  const bad = (code: E26RefusalCode, field?: string, terms?: string[]): E26Refusal => ({ ok: false, code, ...(field ? { field } : {}), ...(terms ? { terms } : {}) })

  const shape: Array<[string, boolean]> = [
    ['keys', hasExactKeys(a, ['commitmentDigest', 'commitmentDomainTag', 'anchorRef', 'makerPublicKey', 'takerPublicKey', 'rail', 'arbitrationCapability', 'arbitrationPolicyDigest', 'arbiterRef', 'proposedAt', 'expiresAt'])],
    ['policy.keys', hasExactKeys(p, ['policyVersion', 'capability', 'mode', 'rail', 'arbiterSelection', 'appeal', 'hosting', 'liveness'])],
    ['commitmentDigest', HEX64.test(a.commitmentDigest)], ['arbitrationPolicyDigest', HEX64.test(a.arbitrationPolicyDigest)],
    ['arbiterRef', TEXT.test(a.arbiterRef)], ['arbitrationCapability', TEXT.test(a.arbitrationCapability)],
    ...(['policyVersion', 'capability', 'mode', 'rail', 'arbiterSelection', 'appeal', 'hosting', 'liveness'] as const)
      .map((k): [string, boolean] => [`policy.${k}`, typeof p[k] === 'string' && TEXT.test(p[k])]),
  ]
  const shapeBad = shape.find(([, ok]) => !ok)
  if (shapeBad) return bad('E26_NONCANONICAL_FIELD', shapeBad[0])

  const binding: Array<[string, boolean]> = [
    ['commitmentDigest', a.commitmentDigest === trade.digest], ['commitmentDomainTag', a.commitmentDomainTag === TRADE_COMMITMENT_DOMAIN_TAG],
    ['anchorRef', a.anchorRef === c.anchorRef], ['makerPublicKey', a.makerPublicKey === c.makerPublicKey],
    ['takerPublicKey', a.takerPublicKey === c.takerPublicKey], ['rail', a.rail === c.rail],
    ['proposedAt', a.proposedAt === c.proposedAt], ['expiresAt', a.expiresAt === c.expiresAt],
  ]
  const bindingBad = binding.find(([, ok]) => !ok)
  if (bindingBad) return bad('E26_COMMITMENT_BINDING_MISMATCH', bindingBad[0])

  if (hashArbitrationPolicy(p) !== a.arbitrationPolicyDigest) return bad('E26_POLICY_DIGEST_MISMATCH')
  const terms = validateArbitrationTerms(a, p, e.deriveCapability(a.rail))
  if (terms.length) return bad('E26_TERMS_REFUSED', undefined, terms)

  const digest = hashArbitrationCommitment(a)
  if (e.arbitration.declaredDigest !== digest) return bad('E26_DIGEST_MISMATCH')
  for (const [role, sig, key, tradeSig] of [['maker', e.arbitration.maker, a.makerPublicKey, e.trade.maker], ['taker', e.arbitration.taker, a.takerPublicKey, e.trade.taker]] as const) {
    if (!sig !== !tradeSig) return bad('E26_COSIGNATURE_INCOMPLETE', role)
    if (!sig) continue
    if (!verifyDigestSignature(digest, sig.signature, key)) return bad('E26_SIGNATURE_INVALID', role)
    if (sig.receivedAt !== e.trade[role]?.receivedAt) return bad('E26_COSIGNATURE_INCOMPLETE', `${role}.receivedAt`) // one action, one receipt
    if (Date.parse(sig.receivedAt) >= Date.parse(a.expiresAt)) return bad('E26_EXPIRED', role)
  }
  return { ok: true, state: trade.state, commitmentDigest: trade.digest, arbitrationCommitmentDigest: digest }
}
