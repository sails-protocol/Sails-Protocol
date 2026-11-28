/**
 * G3 + G4 (CTO 38): the protocol fee policy as a document signed by the economic authority, carrying the fee
 * destination inside its digest. Its global identity is the digest, not a node's row id. A node imports a policy only if
 * the signature verifies against the authority keys pinned in the release; no operator can publish a fee of its own.
 *
 * `feePolicyDigestV2` (trade-commitment.ts) is what a commitment's `feePolicyDigest` holds for a V2 policy, so the
 * parties commit to the destination without a new commitment version.
 */
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import { Prisma } from '@prisma/client'
import { canonicalJson, verifyDigestSignature, feePolicyDigestV2, type FeePolicyV1 } from '../open-p2p/trade-commitment'

export { feePolicyDigestV2, FEE_POLICY_V2_DOMAIN_TAG } from '../open-p2p/trade-commitment'

export interface FeePolicyV2 extends FeePolicyV1 {
  version: 2
  rail: string
  network: string
  destination: { kind: 'address'; value: string }
  validFrom: string
  validUntil: string | null
}

export interface SignedFeePolicy {
  policy: FeePolicyV2
  /** One Ed25519 signature (hex, 64 B) per authority key that signed, keyed by that key (hex, 32 B). */
  signatures: Record<string, string>
}

export interface VerificationContext {
  authority: { keys: string[]; threshold: number }
  /** This node's (or client's) network: the policy must name it, and its destination must be an address of it. */
  network: { name: string; bitcoin: bitcoin.Network }
  /** The effective protocol fee ceiling (fee-policy.service.ts maxProtocolFeeRate()); a signature never waives it. */
  maxRate: string
  now: Date
  /**
   * 'new-use': a new commitment or escrow, so the validity window applies. 'existing': an escrow already open settles
   * from its frozen snapshot, and an expired window never blocks it.
   */
  purpose: 'new-use' | 'existing'
}

const HEX32 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{128}$/
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function signFeePolicy(p: FeePolicyV2, secretKeys: Uint8Array[]): SignedFeePolicy {
  const digest = Buffer.from(feePolicyDigestV2(p), 'hex')
  const signatures: Record<string, string> = {}
  for (const sk of secretKeys) {
    const pk = Buffer.from(nacl.sign.keyPair.fromSecretKey(sk).publicKey).toString('hex')
    signatures[pk] = Buffer.from(nacl.sign.detached(digest, sk)).toString('hex')
  }
  return { policy: p, signatures }
}

export type FeePolicyVerdict = { ok: true; digest: string } | { ok: false; reason: string }

/**
 * Verifies a signed policy: shape, network and destination, the fee ceiling, the validity window (new use only), and
 * at least `threshold` distinct authority signatures. Signatures from unknown keys are ignored, never counted.
 */
export function verifySignedFeePolicy(doc: SignedFeePolicy, ctx: VerificationContext): FeePolicyVerdict {
  const p = doc?.policy
  if (!p || p.version !== 2) return { ok: false, reason: 'not a V2 fee policy' }
  if (p.destination?.kind !== 'address' || typeof p.destination.value !== 'string' || p.destination.value.length === 0) return { ok: false, reason: 'missing fee destination' }
  if (typeof p.rail !== 'string' || !p.rail) return { ok: false, reason: 'missing rail' }
  // A testnet policy is never reusable on mainnet, and vice versa.
  if (p.network !== ctx.network.name) return { ok: false, reason: `policy is for network ${p.network}, not ${ctx.network.name}` }
  try { bitcoin.address.toOutputScript(p.destination.value, ctx.network.bitcoin) } catch { return { ok: false, reason: 'fee destination is not an address of this network' } }
  let rate: Prisma.Decimal
  try { rate = new Prisma.Decimal(p.protocolFeeRate) } catch { return { ok: false, reason: 'invalid fee rate' } }
  if (!rate.isFinite() || rate.isNegative() || rate.greaterThan(ctx.maxRate)) return { ok: false, reason: `fee rate above the ceiling ${ctx.maxRate}` }
  if (!TS.test(p.validFrom) || (p.validUntil !== null && !TS.test(p.validUntil)) || Number.isNaN(Date.parse(p.validFrom)) || (p.validUntil !== null && Date.parse(p.validUntil) <= Date.parse(p.validFrom))) return { ok: false, reason: 'invalid validity window' }
  if (ctx.purpose === 'new-use' && (ctx.now < new Date(p.validFrom) || (p.validUntil !== null && ctx.now >= new Date(p.validUntil)))) return { ok: false, reason: 'outside its validity window' }
  // The trust anchor: at least 2 distinct, well-formed keys (never a single operator-held key), threshold >= 2.
  const { keys, threshold } = ctx.authority
  if (new Set(keys).size !== keys.length || !keys.every((k) => HEX32.test(k))) return { ok: false, reason: 'invalid authority keys' }
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > keys.length) return { ok: false, reason: 'invalid authority threshold' }

  const digest = feePolicyDigestV2(p)
  const valid = new Set<string>()
  for (const [pk, sig] of Object.entries(doc.signatures ?? {})) {
    if (!keys.includes(pk) || !HEX64.test(sig)) continue
    if (verifyDigestSignature(digest, sig, pk)) valid.add(pk) // canonical-encoding checked (no malleable signatures)
  }
  if (valid.size < threshold) return { ok: false, reason: `needs ${threshold} authority signatures, has ${valid.size}` }
  return { ok: true, digest }
}

/** Where the node keeps the signed document of a policy row. A port, so the storage choice changes nothing here. */
export interface SignedFeePolicyStore {
  load(feePolicyVersionId: string): Promise<SignedFeePolicy | null>
}

/** The economic fields of a fee policy row, as stored by the node. */
export interface FeePolicyRowFields {
  railScope: string
  protocolFeeRate: Prisma.Decimal | string
  payerModel: string
  economicBasis: string
  requiredConfirmations: number | null
  smallTradeRule: unknown
}

/** The canonical rate spelling, the same as commitment-pair.service.ts loadFeePolicy(): 8 places, no trailing zeros. */
const canonicalRate = (r: Prisma.Decimal | string): string => new Prisma.Decimal(r).toFixed(8).replace(/\.?0+$/, '')

/**
 * A validly signed document is not enough: it must be the document OF THIS ROW. Otherwise a valid document of another
 * policy could be pasted next to different economic fields. Compares every economic field and the rail; the destination
 * exists only in the document, which is why the document (not the row) is what the escrow freezes it from.
 */
export function signedDocumentMatchesRow(doc: SignedFeePolicy, row: FeePolicyRowFields): { ok: true } | { ok: false; field: string } {
  const p = doc.policy
  if (p.rail !== row.railScope) return { ok: false, field: 'rail' }
  let docRate: string
  try { docRate = canonicalRate(p.protocolFeeRate) } catch { return { ok: false, field: 'protocolFeeRate' } }
  if (docRate !== p.protocolFeeRate || docRate !== canonicalRate(row.protocolFeeRate)) return { ok: false, field: 'protocolFeeRate' }
  if (p.payerModel !== row.payerModel) return { ok: false, field: 'payerModel' }
  if (p.economicBasis !== row.economicBasis) return { ok: false, field: 'economicBasis' }
  if (p.requiredConfirmations !== row.requiredConfirmations) return { ok: false, field: 'requiredConfirmations' }
  if (canonicalJson(p.smallTradeRule) !== canonicalJson(row.smallTradeRule)) return { ok: false, field: 'smallTradeRule' }
  return { ok: true }
}
