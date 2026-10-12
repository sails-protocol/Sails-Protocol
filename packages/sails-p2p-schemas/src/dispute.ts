/**
 * Dispute schema — sails-p2p-schemas (04-Deepseek Review.md Task 1).
 *
 * The Dispute *primitive* already exists (PROTOCOL_SPECIFICATION.md §1.9:
 * disputeId, settlementId, openedBy, proofs, arbiterId, status, ruling) —
 * this schema is that primitive's shape, using the task's requested field
 * names where they don't conflict (tradeId is additive alongside the
 * primitive's settlementId-anchored relationships), and is what
 * `prisma/schema.prisma`'s new `Dispute` model (dispute.service.ts)
 * actually persists — not a second, divergent shape.
 *
 * `arbitratorDid` is `arbiterId: string` here, not a real W3C DID — DIDs
 * are OpenIdentity's documented future growth stage
 * (PROTOCOL_SPECIFICATION.md §1.1: Keys -> DID -> Credentials -> Trust
 * Graph), not built yet (today's Identity is Level-0 keypair-only). A DID
 * is just a specially-formatted string, so this field needs no shape
 * change when that stage ships — stated here rather than left implicit.
 */

// CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 38, 2026-09-13) — widened from
// 4 to the real 6 values. This file's own header above claims parity
// with `prisma/schema.prisma`'s real `Dispute` model — that claim was
// false for this exact type: the real enum
// (`prisma/schema.prisma`'s `DisputeStatus`) has always had `APPEALED`
// (RFC-021 D6) and `AUTO_PROPOSED` (RFC-021 D8), both real, actively-used
// values (`dispute.service.ts`'s `appeal()`/QVAC auto-resolution flow) —
// `packages/sails-sdk/src/types.ts`'s own `DisputeStatus` already had the
// correct 6 values; only this package's own copy had drifted. Reconciled
// here, not duplicated — see `tests/disputeStatusParity.test.ts` for the
// test proving this against the real Prisma enum going forward.
// #239D - MOOT: terminal; a prior authoritative economic disposition became final without any ruling deciding the dispute.
export type DisputeStatus = 'OPENED' | 'EVIDENCE_SUBMITTED' | 'ARBITRATED' | 'RESOLVED' | 'APPEALED' | 'AUTO_PROPOSED' | 'MOOT'

// RELEASE = buyer wins (asset released to them) = "dispute_resolved_buyer"
// REFUND  = seller wins (asset returned to them) = "dispute_resolved_seller"
// SPLIT   = §1.9's third option, no buyer/seller-exclusive equivalent
export type DisputeRuling = 'RELEASE' | 'REFUND' | 'SPLIT'

export interface EvidenceDescriptor {
  type: string // e.g. 'payment_receipt', 'chat_log', 'screenshot'
  uri?: string // pointer, if the evidence lives with an EvidenceProvider (RFC-007 D2) once that exists
  note?: string
  // Issue #266 — additive. The canonical id of a Sails OpenProof
  // `EvidenceReference` row (RFC-007 D2, `evidence_references` table) —
  // present ONLY for genuinely integrity-bound file/media evidence, and
  // mutually exclusive with `uri` (dispute.service.ts's own
  // resolveEvidenceDescriptor() rejects a descriptor carrying both:
  // OpenProof already owns provider/uri/sha256 for this object, so a
  // raw `uri` would just be an unverified, potentially forged duplicate
  // of a fact the server can and does derive server-side instead). A
  // descriptor WITHOUT this field is the original, unchanged raw/
  // external reference — historical entries never have it and are read
  // exactly as before. `EvidenceReference` (not Claim/Proof) is the
  // correct canonical identifier here: it is the one row that actually
  // owns the stored bytes' provider/uri/sha256; a Claim can have many
  // Proofs and a Proof can have many EvidenceReferences, so anything
  // coarser would be ambiguous about which exact bytes are referenced.
  evidenceReferenceId?: string
  // Issue #266 CTO Gate re-gate — explicit, non-heuristic discriminator
  // for the OTHER branch of the hybrid model: a lightweight external/
  // non-file reference. Only ever `true` when present (never `false`;
  // absence carries the actual meaning) and never set alongside
  // `evidenceReferenceId` — that field's own presence already
  // unambiguously means "file/media, integrity-bound," a second,
  // contradictory declaration would be meaningless (and is rejected
  // server-side, see dispute.service.ts's own resolveEvidenceDescriptor()).
  // dispute.service.ts requires ONE of `evidenceReferenceId` or
  // `externalReference: true` on every NEW descriptor precisely so
  // `type` (an arbitrary caller string like 'screenshot' or
  // 'payment_receipt') is never trusted to imply which class a raw uri
  // belongs to — the exact heuristic the CTO Gate explicitly forbade.
  // Absent on every historical descriptor (predates this discriminator
  // entirely) — read exactly as recorded, no reinterpretation, no
  // fabricated classification. Requires `uri` to be present (a
  // `uri`-less descriptor is a plain note — nothing that could
  // masquerade as file evidence, so this discriminator does not apply
  // to it either way; `externalReference: true` with no `uri` is
  // rejected as meaningless — there would be nothing being referenced).
  //
  // IMPORTANT — this is a REFERENCE-MODE contract, not a factual claim
  // about the remote content: `externalReference: true` records that
  // the protocol is deliberately treating this uri as an unverified,
  // non-integrity-bound external pointer. It does NOT prove, and must
  // never be read as proving, that the bytes the uri actually resolves
  // to are not media/a file — the server has no way to inspect or
  // verify that. The property this discriminator establishes is
  // narrower and fully mechanical: "was this NEW raw-uri descriptor
  // explicitly declared as unverified/external," never "is the
  // referenced content provably non-file."
  externalReference?: true
  submittedBy: string
  submittedAt: string // ISO 8601
}

export interface DisputeSchema {
  id: string
  tradeId: string
  escrowId: string
  openedBy: string
  reason: string
  evidence: EvidenceDescriptor[]
  arbiterId: string | null // "arbitratorDid" in the task's vocabulary — see doc comment above
  status: DisputeStatus
  ruling: DisputeRuling | null
  resolvedAt: string | null
}
