/**
 * Sails OpenIdentity — Reference Implementation
 *
 * The module TODO.md §1 flagged as entirely missing. Challenge issuance
 * and signature verification already existed in
 * `common/middleware/auth.ts` (RT-002's fix) — that file owns the
 * Ed25519 challenge-response mechanics. This service owns the one thing
 * that was still missing: turning a public key into a registered
 * `Participant` (a `User` row) in the first place, which
 * `verifySignedChallenge` already assumes exists (`prisma.user.findUnique`).
 */
import { prisma } from '../../common/database'
import { NotFoundError, ValidationError, AuthError } from '../../common/errors'
import { verifyRegistrationProof } from '../../common/middleware/auth'

export interface RegisterParticipantInput {
  publicKey: string
  // Issue #302 — proof of possession, required. See
  // common/middleware/auth.ts's verifyRegistrationProof() for the exact
  // signed-message construction and atomic-consumption semantics this
  // is checked against.
  signature: string
  displayName?: string
}

// Missão 11 Fase 9.3.5 — INV-OP-10 (Public Verification Surfaces
// Disclose the Minimum Necessary Fact, Never the Underlying Row —
// docs/PROTOCOL_INVARIANTS.md). The ONLY shape ever returned to the
// unauthenticated GET route (/v1/identity/participants/:id) — a lookup
// by ANY caller for ANY participant, unlike `/v1/identity/me`'s
// authenticated, self-referential full row (that one stays a raw
// `User`, correctly — the only recipient is the person it's already
// about). What's kept: `id` (this IS the participantId being looked
// up, not a separate internal row id — it's the literal subject of the
// lookup), `publicKey` (the participant's real cryptographic identity —
// other participants verify signatures/commitments against it),
// `peerId` (their P2P transport identity — required for HyperDHT/Pears
// discovery, the whole point of a peer-to-peer connection), `displayName`
// (public-facing, user-chosen for exactly this purpose), `verified`
// (an identity-verification status fact, distinct from reputation).
// What's deliberately excluded: `reputationScore`/`totalTrades`/
// `disputeCount`/`totalVolumeBtc` — real, legitimately public data, but
// its canonical home is the dedicated `GET /v1/reputation/:participantId`
// route (`reputationService.getScore()`), not this one; duplicating it
// here would be scope creep for an identity-lookup endpoint, not a
// disclosure decision. `moduleId`/`protocolVersion`/`createdAt`/
// `updatedAt` — operator-internal bookkeeping, zero identity-
// verification value.
export interface PublicParticipantIdentity {
  id: string
  publicKey: string
  displayName: string | null
  peerId: string | null
  verified: boolean
}

export class IdentityService {
  /**
   * Issue #302 — canonical participant registration now REQUIRES proof
   * of possession of the submitted Ed25519 public key. Before this
   * fix, `POST /v1/identity/participants` was fully unauthenticated and
   * accepted any caller-supplied publicKey + displayName — knowledge
   * of a public key (which is not secret; other participants routinely
   * learn it through normal protocol interaction) was sufficient to
   * squat the canonical User row for it, permanently denying the real
   * key holder their own identity metadata. Frozen invariant this
   * closes: `Identity knowledge != Identity registration authority`.
   *
   * Defense-in-depth, three independent layers, in this exact order:
   * 1. Pre-check (below) — an already-registered key is rejected
   *    immediately, before ever touching a registration challenge, so
   *    this endpoint can never be used to burn/replace an existing
   *    registration's challenge or metadata.
   * 2. verifyRegistrationProof() (auth.ts) — reuses #301's atomic Redis
   *    compare-and-consume primitive; cryptographic verification
   *    happens BEFORE the challenge is consumed, so an invalid
   *    signature can never burn the legitimate holder's outstanding
   *    challenge, and exactly one of any N concurrent valid claimants
   *    wins the atomic consumption.
   * 3. `User.publicKey @unique` (below, P2002 catch) — the database
   *    remains the FINAL backstop independent of Redis: even if two
   *    proofs were somehow both successfully consumed for the same key
   *    (e.g. two separately-issued challenges, consumed moments apart),
   *    the database can still only ever create one canonical row.
   */
  async register(input: RegisterParticipantInput) {
    const existing = await prisma.user.findUnique({ where: { publicKey: input.publicKey } })
    if (existing) {
      throw new ValidationError(`A participant is already registered for this public key`)
    }

    // AuthError (401), matching /v1/identity/authenticate's own exact
    // precedent for the same class of failure — "you have not proven
    // possession of this key," not "you are known but not permitted."
    const proof = await verifyRegistrationProof(input.publicKey, input.signature, input.displayName)
    if (!proof.verified) {
      throw new AuthError(proof.reason ?? 'Proof of possession of this public key could not be verified')
    }

    try {
      return await prisma.user.create({
        data: {
          publicKey: input.publicKey,
          displayName: input.displayName,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ValidationError(`A participant is already registered for this public key`)
      }
      throw err
    }
  }

  async getParticipant(participantId: string) {
    const user = await prisma.user.findUnique({ where: { id: participantId } })
    if (!user) throw new NotFoundError('Participant', participantId)
    return user
  }

  /**
   * Missão 11 Fase 9.3.5 — the ONLY method the unauthenticated
   * GET /v1/identity/participants/:id route may call. See
   * PublicParticipantIdentity's own comment for exactly which fields
   * are/aren't here.
   */
  async getPublicView(participantId: string): Promise<PublicParticipantIdentity> {
    const user = await this.getParticipant(participantId)
    return {
      id: user.id,
      publicKey: user.publicKey,
      displayName: user.displayName,
      peerId: user.peerId,
      verified: user.verified,
    }
  }
}

export const identityService = new IdentityService()
