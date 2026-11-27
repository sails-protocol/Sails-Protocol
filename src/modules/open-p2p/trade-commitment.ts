/**
 * E25 F1 - `TradeCommitmentV1` and `FeePolicyDigestV1`, pure (no I/O, no persistence).
 *
 * The bilateral economic consent of a trade: both parties sign the sha256 of 18 canonical
 * fields joined by `\x1f` (domain tag first), with the same primitives as the offer envelope
 * (`offer-envelope.ts`). The SDK carries an independent implementation
 * (`packages/sails-sdk/src/modules/trade-commitment.ts`); both are checked against
 * `conformance/vectors/sails-trade-commitment-v1.vectors.json`.
 *
 * COMMITTED here is a verdict over signatures, never a persisted state: uniqueness per anchor
 * (INV-5), the seller-exposure reservation and any economic effect belong to later phases.
 */
import nacl from 'tweetnacl'
import { createHash } from 'crypto'
import { isCanonicalEd25519Encoding } from '../open-liquidity/offer-envelope'

export const TRADE_COMMITMENT_DOMAIN_TAG = 'sails-trade-commitment-v1'
export const FEE_POLICY_DOMAIN_TAG = 'sails-fee-policy-v1'
const FIELD_SEPARATOR = '\x1f'

export type E25RefusalCode =
  | 'E25_NONCANONICAL_FIELD' | 'E25_SAME_PARTY' | 'E25_DIGEST_MISMATCH' | 'E25_OFFER_ENVELOPE_INVALID'
  | 'E25_OFFER_LIMITS_VIOLATED' | 'E25_RAIL_NOT_ENABLED' | 'E25_FEE_POLICY_DIGEST_MISMATCH'
  | 'E25_SIGNATURE_INVALID' | 'E25_EXPIRED'
export type E25Refusal = { ok: false; code: E25RefusalCode; field?: string }

export interface TradeCommitmentV1 {
  anchorRef: string
  offerEnvelopeDigest: string
  offerLogicalId: string
  offerRevision: number
  makerPublicKey: string
  takerPublicKey: string
  side: string
  asset: string
  rail: string
  network: string
  /** The offer envelope's own canonical decimal (exactly 8 fractional digits), so it compares byte for byte with it. */
  amount: string
  priceUsd: string
  paymentMethod: string
  feePolicyVersionId: string
  feePolicyDigest: string
  proposedAt: string
  expiresAt: string
}

/** The economically decisive, immutable content of a PUBLISHED fee policy version. */
export interface FeePolicyV1 {
  protocolFeeRate: string
  payerModel: string
  economicBasis: string
  requiredConfirmations: number
  smallTradeRule: unknown
}

/** The accepted offer envelope, already verified by `verifyOfferEnvelope()` by the caller. */
export interface AcceptedOffer {
  digest: string
  logicalOfferId: string
  revision: number
  ownerPublicKey: string
  side: string
  asset: string
  priceUsd: string
  paymentMethod: string
  minAmount: string
  maxAmount: string
  expiresAt: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const IDENT = /^[A-Z][A-Z0-9_]*$/
const NETWORK = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DECIMAL8 = /^(0|[1-9]\d{0,15})\.\d{8}$/ // offer-envelope.ts CANONICAL_DECIMAL
const RATE = /^(0|[1-9]\d*)(\.\d{0,7}[1-9])?$/ // no trailing zero, at most 8 places (#687)
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const MAX_INT4 = 2147483647

const isTimestamp = (s: unknown): s is string => typeof s === 'string' && TIMESTAMP.test(s) && new Date(s).toISOString() === s
const isPositiveDecimal8 = (s: unknown): s is string => typeof s === 'string' && DECIMAL8.test(s) && !/^0\.0{8}$/.test(s)
const isInt = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX_INT4
const units = (d: string): bigint => BigInt(d.replace('.', ''))
const TRADE_COMMITMENT_KEYS = ['anchorRef', 'offerEnvelopeDigest', 'offerLogicalId', 'offerRevision', 'makerPublicKey', 'takerPublicKey', 'side', 'asset', 'rail', 'network', 'amount', 'priceUsd', 'paymentMethod', 'feePolicyVersionId', 'feePolicyDigest', 'proposedAt', 'expiresAt']
/** True when the object has exactly these keys: an unknown (unsigned) field is refused, never ignored. */
export const hasExactKeys = (o: object, keys: readonly string[]): boolean => { const k = Object.keys(o).sort(); const e = [...keys].sort(); return k.length === e.length && k.every((x, i) => x === e[i]) }
const refuse = (code: E25RefusalCode, field?: string): E25Refusal => (field ? { ok: false, code, field } : { ok: false, code })

/** Exactly one accepted form per field; anything else is refused, never normalized. */
export function validateTradeCommitmentFields(c: TradeCommitmentV1): { ok: true } | E25Refusal {
  if (!hasExactKeys(c, TRADE_COMMITMENT_KEYS)) return refuse('E25_NONCANONICAL_FIELD', 'keys')
  const checks: Array<[keyof TradeCommitmentV1, boolean]> = [
    ['anchorRef', typeof c.anchorRef === 'string' && UUID.test(c.anchorRef)],
    ['offerEnvelopeDigest', typeof c.offerEnvelopeDigest === 'string' && HEX64.test(c.offerEnvelopeDigest)],
    ['offerLogicalId', typeof c.offerLogicalId === 'string' && c.offerLogicalId.length >= 1 && c.offerLogicalId.length <= 200 && !CONTROL.test(c.offerLogicalId)],
    ['offerRevision', isInt(c.offerRevision, 0)],
    ['makerPublicKey', typeof c.makerPublicKey === 'string' && HEX64.test(c.makerPublicKey)],
    ['takerPublicKey', typeof c.takerPublicKey === 'string' && HEX64.test(c.takerPublicKey)],
    ['side', c.side === 'BUY' || c.side === 'SELL'],
    ['asset', typeof c.asset === 'string' && IDENT.test(c.asset)],
    ['rail', typeof c.rail === 'string' && IDENT.test(c.rail)],
    ['network', typeof c.network === 'string' && NETWORK.test(c.network)],
    ['amount', isPositiveDecimal8(c.amount)],
    ['priceUsd', isPositiveDecimal8(c.priceUsd)],
    ['paymentMethod', typeof c.paymentMethod === 'string' && IDENT.test(c.paymentMethod)],
    ['feePolicyVersionId', typeof c.feePolicyVersionId === 'string' && UUID.test(c.feePolicyVersionId)],
    ['feePolicyDigest', typeof c.feePolicyDigest === 'string' && HEX64.test(c.feePolicyDigest)],
    ['proposedAt', isTimestamp(c.proposedAt)],
    ['expiresAt', isTimestamp(c.expiresAt) && isTimestamp(c.proposedAt) && Date.parse(c.proposedAt) < Date.parse(c.expiresAt)],
  ]
  const bad = checks.find(([, ok]) => !ok)
  if (bad) return refuse('E25_NONCANONICAL_FIELD', bad[0])
  if (c.makerPublicKey === c.takerPublicKey) return refuse('E25_SAME_PARTY')
  return { ok: true }
}

/** Canonical bytes of already-validated fields (validate first; this function does not). */
export function canonicalizeTradeCommitment(c: TradeCommitmentV1): Buffer {
  return Buffer.from([
    TRADE_COMMITMENT_DOMAIN_TAG, c.anchorRef, c.offerEnvelopeDigest, c.offerLogicalId, String(c.offerRevision),
    c.makerPublicKey, c.takerPublicKey, c.side, c.asset, c.rail, c.network, c.amount, c.priceUsd, c.paymentMethod,
    c.feePolicyVersionId, c.feePolicyDigest, c.proposedAt, c.expiresAt,
  ].join(FIELD_SEPARATOR), 'utf8')
}

export function hashTradeCommitment(c: TradeCommitmentV1): string {
  return createHash('sha256').update(canonicalizeTradeCommitment(c)).digest('hex')
}

/** JSON with sorted keys and no whitespace; `{}` when there is no rule. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return '{}'
  const enc = (v: unknown): string => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number'); return JSON.stringify(v) }
    if (Array.isArray(v)) return `[${v.map(enc).join(',')}]`
    if (typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${enc((v as Record<string, unknown>)[k])}`).join(',')}}`
    throw new Error(`canonicalJson: unsupported ${typeof v}`)
  }
  return enc(value)
}

export const FEE_POLICY_V2_DOMAIN_TAG = 'sails-fee-policy-v2'

/** `FeePolicyDigestV2`: sha256 over the V2 domain tag, a newline and the canonical JSON of the whole policy. */
export function feePolicyDigestV2(p: object): string {
  return createHash('sha256').update(FEE_POLICY_V2_DOMAIN_TAG + '\n' + canonicalJson(p), 'utf8').digest('hex')
}

/**
 * The digest a commitment holds for a policy, chosen by the policy's explicit version: no `version` field is V1, 2 is
 * V2, anything else is refused (null). A V2 policy is never digested, and so never accepted, as V1.
 */
export function feePolicyDigest(p: FeePolicyV1 & { version?: unknown }): string | null {
  if (!('version' in p) || p.version === undefined) return feePolicyDigestV1(p)
  if (p.version === 2) { try { return feePolicyDigestV2(p) } catch { return null } }
  return null
}

/** `FeePolicyDigestV1`, or null when a field is not in its canonical form. */
export function feePolicyDigestV1(p: FeePolicyV1): string | null {
  if (!RATE.test(p.protocolFeeRate) || !IDENT.test(p.payerModel) || !IDENT.test(p.economicBasis) || !isInt(p.requiredConfirmations, 0)) return null
  let rule: string
  try { rule = canonicalJson(p.smallTradeRule) } catch { return null }
  const bytes = [FEE_POLICY_DOMAIN_TAG, p.protocolFeeRate, p.payerModel, p.economicBasis, String(p.requiredConfirmations), rule].join(FIELD_SEPARATOR)
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/** Reference client signing (a party signs locally; the server only verifies). */
export function signTradeCommitment(c: TradeCommitmentV1, secretKeyHex: string): string {
  return Buffer.from(nacl.sign.detached(Buffer.from(hashTradeCommitment(c), 'hex'), Buffer.from(secretKeyHex, 'hex'))).toString('hex')
}

/** Ed25519 over the hex digest, canonical encoding enforced (S < L, y < P) before tweetnacl, as `verifyOfferEnvelope`. */
export function verifyDigestSignature(digestHex: string, signatureHex: string, publicKeyHex: string): boolean {
  if (!HEX64.test(digestHex) || !HEX128.test(signatureHex) || !HEX64.test(publicKeyHex)) return false
  const sig = new Uint8Array(Buffer.from(signatureHex, 'hex')); const pk = new Uint8Array(Buffer.from(publicKeyHex, 'hex'))
  if (!isCanonicalEd25519Encoding(sig, pk)) return false
  try { return nacl.sign.detached.verify(new Uint8Array(Buffer.from(digestHex, 'hex')), sig, pk) } catch { return false }
}

export interface PartySignature { signature: string; receivedAt: string }
export interface TradeCommitmentEvaluation {
  commitment: TradeCommitmentV1
  declaredDigest: string
  offer: AcceptedOffer
  feePolicy: FeePolicyV1
  /** B5: the rails proven for the new flow. Empty while B5 is on HOLD, so every rail is refused. */
  enabledRails: ReadonlySet<string>
  maker?: PartySignature
  taker?: PartySignature
}
export type TradeCommitmentState = 'PROPOSED' | 'PARTIALLY_SIGNED' | 'COMMITTED'
export type TradeCommitmentVerdict = { ok: true; state: TradeCommitmentState; digest: string } | E25Refusal

/**
 * The normative verification (spec §3). COMMITTED only when BOTH roles signed the same
 * recomputed digest, each with its own key, each received (server clock) before `expiresAt`.
 * A missing signature is never COMMITTED; a present but invalid or late one is a refusal.
 */
export function evaluateTradeCommitment(e: TradeCommitmentEvaluation): TradeCommitmentVerdict {
  const c = e.commitment
  const shape = validateTradeCommitmentFields(c)
  if (!shape.ok) return shape
  const digest = hashTradeCommitment(c)
  if (e.declaredDigest !== digest) return refuse('E25_DIGEST_MISMATCH')
  const o = e.offer
  const offerChecks: Array<[string, boolean]> = [
    ['offerEnvelopeDigest', o.digest === c.offerEnvelopeDigest], ['offerLogicalId', o.logicalOfferId === c.offerLogicalId],
    ['offerRevision', o.revision === c.offerRevision], ['makerPublicKey', o.ownerPublicKey === c.makerPublicKey],
    ['side', o.side === c.side], ['asset', o.asset === c.asset], ['priceUsd', o.priceUsd === c.priceUsd],
    ['paymentMethod', o.paymentMethod === c.paymentMethod], ['expiresAt', isTimestamp(o.expiresAt) && Date.parse(c.expiresAt) <= Date.parse(o.expiresAt)],
  ]
  const offerBad = offerChecks.find(([, ok]) => !ok)
  if (offerBad) return refuse('E25_OFFER_ENVELOPE_INVALID', offerBad[0])
  if (!isPositiveDecimal8(o.minAmount) || !isPositiveDecimal8(o.maxAmount)) return refuse('E25_OFFER_ENVELOPE_INVALID', 'limits')
  if (units(c.amount) < units(o.minAmount) || units(c.amount) > units(o.maxAmount)) return refuse('E25_OFFER_LIMITS_VIOLATED')
  if (!e.enabledRails.has(c.rail)) return refuse('E25_RAIL_NOT_ENABLED')
  if (feePolicyDigest(e.feePolicy) !== c.feePolicyDigest) return refuse('E25_FEE_POLICY_DIGEST_MISMATCH')
  for (const [role, sig, key] of [['maker', e.maker, c.makerPublicKey], ['taker', e.taker, c.takerPublicKey]] as const) {
    if (!sig) continue
    if (!verifyDigestSignature(digest, sig.signature, key)) return refuse('E25_SIGNATURE_INVALID', role)
    if (!isTimestamp(sig.receivedAt)) return refuse('E25_NONCANONICAL_FIELD', role + '.receivedAt')
    if (Date.parse(sig.receivedAt) >= Date.parse(c.expiresAt)) return refuse('E25_EXPIRED', role) // exclusive limit (C5)
  }
  const state: TradeCommitmentState = e.maker && e.taker ? 'COMMITTED' : e.maker || e.taker ? 'PARTIALLY_SIGNED' : 'PROPOSED'
  return { ok: true, state, digest }
}
