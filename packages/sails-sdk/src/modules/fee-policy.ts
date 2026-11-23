/**
 * @satsails/p2p-trading-sdk — verifies a signed V2 fee policy before the party signs a commitment that references it
 * (G3 + G4, CTO 38). Same digest and rules as the node (`src/modules/open-settlement/global-fee-policy.ts`), proven by
 * a parity test; the client trusts only the authority keys it is configured with, never the node's word.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { canonicalJson, verifyDigestSignature, type FeePolicyV1 } from './trade-commitment'

export const FEE_POLICY_V2_DOMAIN_TAG = 'sails-fee-policy-v2'

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
  signatures: Record<string, string>
}

export function feePolicyDigestV2(p: FeePolicyV2): string {
  return bytesToHex(sha256(utf8ToBytes(FEE_POLICY_V2_DOMAIN_TAG + '\n' + canonicalJson(p))))
}

export type FeePolicyVerdict = { ok: true; digest: string } | { ok: false; reason: string }

/** At least `threshold` distinct keys of `authority.keys` must have signed; other keys are never counted. */
export function verifySignedFeePolicy(doc: SignedFeePolicy, authority: { keys: string[]; threshold: number }, now: Date): FeePolicyVerdict {
  const p = doc?.policy
  if (!p || p.version !== 2) return { ok: false, reason: 'not a V2 fee policy' }
  if (p.destination?.kind !== 'address' || typeof p.destination.value !== 'string' || p.destination.value.length === 0) return { ok: false, reason: 'missing fee destination' }
  if (typeof p.rail !== 'string' || typeof p.network !== 'string' || !p.rail || !p.network) return { ok: false, reason: 'missing rail or network' }
  // Canonical timestamps only (one spelling per instant, so the digest is unambiguous).
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  if (!TS.test(p.validFrom) || (p.validUntil !== null && !TS.test(p.validUntil)) || Number.isNaN(Date.parse(p.validFrom)) || (p.validUntil !== null && Date.parse(p.validUntil) <= Date.parse(p.validFrom))) return { ok: false, reason: 'invalid validity window' }
  if (now < new Date(p.validFrom) || (p.validUntil !== null && now >= new Date(p.validUntil))) return { ok: false, reason: 'outside its validity window' }
  // The trust anchor: at least 2 distinct, well-formed keys (never a single operator-held key), threshold >= 2.
  if (new Set(authority.keys).size !== authority.keys.length || !authority.keys.every((k) => /^[0-9a-f]{64}$/.test(k))) return { ok: false, reason: 'invalid authority keys' }
  if (!Number.isSafeInteger(authority.threshold) || authority.threshold < 2 || authority.threshold > authority.keys.length) return { ok: false, reason: 'invalid authority threshold' }
  const digest = feePolicyDigestV2(p)
  const valid = new Set<string>()
  for (const [pk, sig] of Object.entries(doc.signatures ?? {})) {
    if (authority.keys.includes(pk) && verifyDigestSignature(digest, sig, pk)) valid.add(pk)
  }
  if (valid.size < authority.threshold) return { ok: false, reason: `needs ${authority.threshold} authority signatures, has ${valid.size}` }
  return { ok: true, digest }
}
