/**
 * G3 + G4 (CTO 38): the protocol fee policy as a document signed by the economic authority, carrying the fee
 * destination inside its digest. Its global identity is the digest, not a node's row id. A node imports a policy only if
 * the signature verifies against the authority keys pinned in the release; no operator can publish a fee of its own.
 *
 * `feePolicyDigestV2` is what a commitment's `feePolicyDigest` holds for a V2 policy, so the parties commit to the
 * destination without a new commitment version.
 */
import nacl from 'tweetnacl'
import { createHash } from 'crypto'
import { canonicalJson, verifyDigestSignature, type FeePolicyV1 } from '../open-p2p/trade-commitment'

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
  /** One Ed25519 signature (hex, 64 B) per authority key that signed, keyed by that key (hex, 32 B). */
  signatures: Record<string, string>
}

const HEX32 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{128}$/

function bytes(p: FeePolicyV2): Buffer {
  return Buffer.from(FEE_POLICY_V2_DOMAIN_TAG + '\n' + canonicalJson(p), 'utf8')
}

/** The policy's global identity: sha256 over the domain tag and its canonical bytes (hex). */
export function feePolicyDigestV2(p: FeePolicyV2): string {
  return createHash('sha256').update(bytes(p)).digest('hex')
}

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
 * Verifies a signed policy against the authority set pinned in the release: at least `threshold` distinct authority
 * keys must have signed the digest. Signatures from unknown keys are ignored, never counted. Also checks the shape and
 * the validity window at `now`.
 */
export function verifySignedFeePolicy(doc: SignedFeePolicy, authority: { keys: string[]; threshold: number }, now: Date): FeePolicyVerdict {
  const p = doc?.policy
  if (!p || p.version !== 2) return { ok: false, reason: 'not a V2 fee policy' }
  if (p.destination?.kind !== 'address' || typeof p.destination.value !== 'string' || p.destination.value.length === 0) return { ok: false, reason: 'missing fee destination' }
  if (typeof p.rail !== 'string' || typeof p.network !== 'string' || !p.rail || !p.network) return { ok: false, reason: 'missing rail or network' }
  if (Number.isNaN(Date.parse(p.validFrom)) || (p.validUntil !== null && Number.isNaN(Date.parse(p.validUntil)))) return { ok: false, reason: 'invalid validity window' }
  if (now < new Date(p.validFrom) || (p.validUntil !== null && now >= new Date(p.validUntil))) return { ok: false, reason: 'outside its validity window' }
  if (!Number.isSafeInteger(authority.threshold) || authority.threshold < 1 || authority.threshold > authority.keys.length) return { ok: false, reason: 'invalid authority threshold' }

  const digest = feePolicyDigestV2(p)
  const valid = new Set<string>()
  for (const [pk, sig] of Object.entries(doc.signatures ?? {})) {
    if (!authority.keys.includes(pk) || !HEX32.test(pk) || !HEX64.test(sig)) continue
    if (verifyDigestSignature(digest, sig, pk)) valid.add(pk) // canonical-encoding checked (no malleable signatures)
  }
  if (valid.size < authority.threshold) return { ok: false, reason: `needs ${authority.threshold} authority signatures, has ${valid.size}` }
  return { ok: true, digest }
}
