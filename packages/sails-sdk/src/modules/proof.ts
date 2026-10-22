/**
 * @satsails/p2p-trading-sdk — Sails OpenProof module (RFC-006, RFC-007,
 * verified against src/modules/open-proof/proof.routes.ts directly).
 *
 * The intent-facade's submitProof() is the primary write path
 * for most applications. This module covers the remaining
 * proof operations — reading evidence bundles, issuing
 * verification nonces, and verifying proofs — that the
 * facade intentionally does not expose.
 */
import type { SailsTransport } from '../transport'
import type { Proof, Verification } from '../types'
import type { WalletAdapter } from '../wallet-adapter'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, bytesToBase64 } from '../encoding'

export interface EvidenceBundle {
  claim: {
    id: string
    claimType: string
    assertion: unknown
    claimedBy: string
    createdAt: string
  }
  proofs: Array<{
    id: string
    claimId: string
    evidence: unknown
    evidenceHash: string
    submittedBy: string
    createdAt: string
    verifications: Array<{
      id: string
      proofId: string
      verdict: 'ACCEPTED' | 'REJECTED'
      nonce: string
      reason?: string
      verifiedBy: string
      createdAt: string
    }>
  }>
}

export interface AssertClaimInput {
  claimType: string
  assertion: unknown
  // RFC-007 D6, closed 2026-08-04 — scopes this Claim into a trade's
  // EvidenceBundle (getEvidenceBundleForTrade() below).
  tradeId?: string
}

// RFC-007 D2, closed 2026-08-04.
export interface EvidenceReference {
  id: string
  proofId: string
  provider: string
  uri: string
  sha256: string
  mimeType: 'image' | 'video' | 'document' | 'ocr' | 'external_reference'
  signature: string
  anchorProof: AnchorProof | null
  createdAt: string
}

// RFC-008 D1, closed 2026-08-04.
export interface AnchorProof {
  anchorType: 'opentimestamps'
  anchorId: string
  submittedAt: string
  upgraded: false
}

// RFC-007 D6, closed 2026-08-04 — the real per-trade aggregate, distinct
// from EvidenceBundle above (that one is per-Claim, already shipped with
// its own real SDK/React-hook surface — kept unchanged to avoid a
// breaking rename of that surface).
export interface TradeEvidenceBundle {
  tradeId: string
  claims: Array<{ id: string; claimedBy: string; claimType: string; assertion: unknown; tradeId: string | null; createdAt: string }>
  proofs: Proof[]
  verifications: Verification[]
  externalReferences: EvidenceReference[]
  timeline: Array<{ eventType: string; occurredAt: string; payload: unknown; eventId: string; entryHash: string; prevHash: string }>
}

export interface SubmitProofInput {
  claimId: string
  evidence: unknown
  claimedHash?: string
}

export interface VerifyProofInput {
  verdict: 'ACCEPTED' | 'REJECTED'
  nonce: string
  reason?: string
}

export class SailsProofModule {
  constructor(private readonly transport: SailsTransport) {}

  /** Requires an active session. */
  async assertClaim(input: AssertClaimInput): Promise<Proof> {
    return this.transport.post<Proof>('/v1/proof/claims', input, true)
  }

  /** Requires an active session. */
  async submitProof(input: SubmitProofInput): Promise<Proof> {
    return this.transport.post<Proof>('/v1/proof/proofs', input, true)
  }

  /** Requires an active session. Returns a nonce for the given proof id. */
  async issueVerificationNonce(proofId: string): Promise<{ nonce: string }> {
    return this.transport.post<{ nonce: string }>(`/v1/proof/proofs/${proofId}/verify-nonce`, undefined, true)
  }

  /** Requires an active session. Submits a verdict for the given proof. */
  async verifyProof(proofId: string, input: VerifyProofInput): Promise<Verification> {
    return this.transport.post<Verification>(`/v1/proof/proofs/${proofId}/verify`, input, true)
  }

  /** Requires an active session. Returns the full evidence bundle for a claim, including all proofs and verifications. */
  async getEvidenceBundle(claimId: string): Promise<EvidenceBundle> {
    return this.transport.get<EvidenceBundle>(`/v1/proof/claims/${claimId}/bundle`, undefined, true)
  }

  /**
   * RFC-007 D2, closed 2026-08-04. Requires an active session. Signs the
   * media's own sha256 digest with `wallet.signMessage()` — the private
   * key never leaves the caller's own wallet, the same "sign a hash, not
   * the identity key itself" shape `identity.ts`'s
   * `authenticateWithWallet()` already established. The server
   * (`proof.service.ts`'s `attachEvidence()`) independently recomputes
   * this same digest and verifies the signature against the caller's own
   * registered public key — never trusts the signature as-is.
   *
   * `encoding.ts`'s own disclosed limitation on `bytesToBase64()` applies
   * here too: fine for typical screenshot/document-sized evidence, not
   * validated against large (multi-MB video) payloads — no chunked/
   * streaming upload exists yet.
   */
  async attachEvidence(
    proofId: string,
    media: Uint8Array,
    mimeType: 'image' | 'video' | 'document' | 'ocr' | 'external_reference',
    wallet: WalletAdapter,
    idempotencyKey: string
  ): Promise<EvidenceReference> {
    const digest = sha256(media)
    const signature = await wallet.signMessage(digest)
    return this.transport.post<EvidenceReference>(
      `/v1/proof/proofs/${proofId}/evidence`,
      { mediaBase64: bytesToBase64(media), mimeType, signatureHex: bytesToHex(signature), idempotencyKey },
      true
    )
  }

  /**
   * RFC-008 D1, closed 2026-08-04. Requires an active session. Submits a
   * real request to a live OpenTimestamps calendar server server-side —
   * a genuine network call and cost, not automatic on every
   * `attachEvidence()` call.
   */
  async anchorEvidence(evidenceReferenceId: string): Promise<EvidenceReference> {
    return this.transport.post<EvidenceReference>(`/v1/proof/evidence/${evidenceReferenceId}/anchor`, undefined, true)
  }

  /**
   * RFC-007 D6 (2026-08-04): aggregated across every
   * Claim/Proof/Verification/EvidenceReference for an entire trade, plus
   * its real hash-chained Timeline (RFC-008 D2). Requires an active
   * session — Missão 06.6 (2026-08-16) closed a real privacy gap here
   * (the route used to be a public read, but the aggregated bundle
   * includes private chat content) and scoped it to the trade's own
   * buyer/seller; this comment and call previously still claimed "public
   * read, no session required" and 401'd unconditionally until fixed
   * (Missão 07.1). Only a party to the trade may fetch it.
   */
  async getTradeEvidenceBundle(tradeId: string): Promise<TradeEvidenceBundle> {
    return this.transport.get<TradeEvidenceBundle>(`/v1/proof/trades/${tradeId}/bundle`, undefined, true)
  }
}