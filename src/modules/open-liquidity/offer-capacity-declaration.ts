// M-1b (CTO 28 Despacho 029 (1)): the owner-signed capacity declaration, `sails-offer-capacity-v1`.
//
// The capacity of a LOGICAL Offer (offer_capacity, one row per (ownerPublicKey, logicalOfferId)) is raised or lowered ONLY by a
// declaration signed with the owner's ECONOMIC key. A session alone never changes it. The database stores the declaration and its
// signature for offline re-verification but cannot check Ed25519 itself (declared residual); this module is the single place
// the bytes are built and verified, shared by the service and by the failing-loud audit (scripts/audit-offer-capacity.js).
//
// Same primitive as the Offer envelope (Ed25519 over the sha256 of a canonical, separator-joined, validated byte string) but a
// DIFFERENT domain tag, so a signature for one message class can never be replayed as the other. The network/environment id is a
// signed field: a declaration made for "testnet" is refused on "mainnet" (anti-replay across contexts).
import nacl from 'tweetnacl'
import { createHash } from 'crypto'
import { isCanonicalEd25519Encoding } from './offer-envelope'

export const OFFER_CAPACITY_DOMAIN_TAG = 'sails-offer-capacity-v1'

const FIELD_SEPARATOR = '\x1f'
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/
const CANONICAL_DECIMAL = /^(0|[1-9]\d{0,15})\.\d{8}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const NETWORK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const CONTROL = /[\x00-\x1f\x7f]/
const MAX_REVISION = 2147483647

export interface OfferCapacityDeclarationContent {
  /** The ECONOMIC key of the Offer owner, never an operational node key. */
  ownerPublicKey: string
  logicalOfferId: string
  /** The Offer's own asset (must equal the envelope's asset: the capacity is in that unit, one balance per Offer). */
  asset: string
  /** Decimal string with exactly 8 fractional digits, > 0. */
  capacityTotal: string
  /** Strictly increasing per (owner, logicalOfferId): anti-replay of an older declaration. */
  capacityRevision: number
  /** Network/environment the declaration is valid in (e.g. "mainnet", "testnet"). */
  networkId: string
  /** ISO-8601 UTC with milliseconds. */
  issuedAt: string
}

export interface SignedOfferCapacityDeclaration extends OfferCapacityDeclarationContent {
  signature: string
}

export type CapacityVerdict = { valid: true } | { valid: false; reason: string }

export function validateOfferCapacityFields(d: Partial<SignedOfferCapacityDeclaration>): CapacityVerdict {
  const str = (v: unknown, name: string): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 && !CONTROL.test(v) ? null : `${name} must be a non-empty string without control characters (max 256)`)
  const bad = str(d.logicalOfferId, 'logicalOfferId') ?? str(d.asset, 'asset')
  if (bad) return { valid: false, reason: bad }
  if (typeof d.ownerPublicKey !== 'string' || !HEX_64.test(d.ownerPublicKey)) return { valid: false, reason: 'ownerPublicKey must be 64 lowercase hex characters' }
  if (typeof d.capacityTotal !== 'string' || !CANONICAL_DECIMAL.test(d.capacityTotal)) return { valid: false, reason: 'capacityTotal must be a canonical decimal string with exactly 8 fractional digits' }
  if (Number(d.capacityTotal) <= 0) return { valid: false, reason: 'capacityTotal must be greater than zero' }
  if (!Number.isInteger(d.capacityRevision) || (d.capacityRevision as number) < 1 || (d.capacityRevision as number) > MAX_REVISION) return { valid: false, reason: 'capacityRevision must be an integer in [1, 2^31-1]' }
  if (typeof d.networkId !== 'string' || !NETWORK_ID.test(d.networkId)) return { valid: false, reason: 'networkId must match [a-z0-9][a-z0-9-]{0,31}' }
  if (typeof d.issuedAt !== 'string' || !CANONICAL_TIMESTAMP.test(d.issuedAt) || Number.isNaN(Date.parse(d.issuedAt))) return { valid: false, reason: 'issuedAt must be a canonical ISO-8601 UTC timestamp with milliseconds' }
  if (d.signature !== undefined && (typeof d.signature !== 'string' || !HEX_128.test(d.signature))) return { valid: false, reason: 'signature must be 128 lowercase hex characters' }
  return { valid: true }
}

export function canonicalizeOfferCapacity(c: OfferCapacityDeclarationContent): Buffer {
  return Buffer.from([OFFER_CAPACITY_DOMAIN_TAG, c.ownerPublicKey, c.logicalOfferId, c.asset, c.capacityTotal, String(c.capacityRevision), c.networkId, c.issuedAt].join(FIELD_SEPARATOR), 'utf8')
}

export function hashOfferCapacity(c: OfferCapacityDeclarationContent): Buffer {
  return createHash('sha256').update(canonicalizeOfferCapacity(c)).digest()
}

/** Reference signer (the owner's own client). The server never holds a secret key; it only verifies. */
export function signOfferCapacity(c: OfferCapacityDeclarationContent, secretKeyHex: string): string {
  return Buffer.from(nacl.sign.detached(new Uint8Array(hashOfferCapacity(c)), new Uint8Array(Buffer.from(secretKeyHex, 'hex')))).toString('hex')
}

/**
 * Re-verifies a declaration from its raw fields. `expectedNetworkId` is mandatory: a declaration signed for another network or
 * environment is refused even with a perfectly valid signature.
 */
export function verifyOfferCapacity(d: SignedOfferCapacityDeclaration, expectedNetworkId: string): CapacityVerdict {
  const shape = validateOfferCapacityFields(d)
  if (!shape.valid) return shape
  if (d.signature === undefined) return { valid: false, reason: 'signature is required' }
  if (d.networkId !== expectedNetworkId) return { valid: false, reason: `declaration is for network "${d.networkId}", expected "${expectedNetworkId}"` }
  const sig = new Uint8Array(Buffer.from(d.signature, 'hex'))
  const key = new Uint8Array(Buffer.from(d.ownerPublicKey, 'hex'))
  if (!isCanonicalEd25519Encoding(sig, key)) return { valid: false, reason: 'signature or public key is not canonically encoded' }
  let ok = false
  try { ok = nacl.sign.detached.verify(new Uint8Array(hashOfferCapacity(d)), sig, key) } catch { return { valid: false, reason: 'malformed signature or public key encoding' } }
  return ok ? { valid: true } : { valid: false, reason: "signature does not verify against the declaration's own ownerPublicKey" }
}

// --- Reorg-unblock decision (decision A, CTO 048): the reviewer's Ed25519 signature over the request digest the DATABASE computed. ---
export const OFFER_CAPACITY_UNBLOCK_DOMAIN_TAG = 'sails-offer-capacity-unblock-decision-v1'

/** The bytes the reviewer signs: sha256(domain \x1f requestDigest). Bound to the exact request (identity, block instant, evidence, requester). */
export function hashUnblockDecision(requestDigestHex: string): Buffer {
  return createHash('sha256').update([OFFER_CAPACITY_UNBLOCK_DOMAIN_TAG, requestDigestHex].join(FIELD_SEPARATOR), 'utf8').digest()
}
export function signUnblockDecision(requestDigestHex: string, reviewerSecretKeyHex: string): string {
  return Buffer.from(nacl.sign.detached(new Uint8Array(hashUnblockDecision(requestDigestHex)), new Uint8Array(Buffer.from(reviewerSecretKeyHex, 'hex')))).toString('hex')
}
export function verifyUnblockDecision(requestDigestHex: string, reviewerPublicKeyHex: string, signatureHex: string): CapacityVerdict {
  if (!HEX_64.test(requestDigestHex) || !HEX_64.test(reviewerPublicKeyHex) || !HEX_128.test(signatureHex)) return { valid: false, reason: 'digest/key (64 hex) and signature (128 hex) required' }
  const sig = new Uint8Array(Buffer.from(signatureHex, 'hex')), key = new Uint8Array(Buffer.from(reviewerPublicKeyHex, 'hex'))
  if (!isCanonicalEd25519Encoding(sig, key)) return { valid: false, reason: 'signature or public key is not canonically encoded' }
  let ok = false
  try { ok = nacl.sign.detached.verify(new Uint8Array(hashUnblockDecision(requestDigestHex)), sig, key) } catch { return { valid: false, reason: 'malformed signature or public key encoding' } }
  return ok ? { valid: true } : { valid: false, reason: 'the reviewer signature does not verify over the request digest' }
}
