/**
 * Sails OpenProof — Reference Implementation (PROTOCOL_SPECIFICATION.md
 * §1.8, RFC-006). Fase 1 Task 3(c): built as the real feature this
 * security review's "QVAC forgery" task actually needed underneath it —
 * there was no OpenProof service layer at all to test against before
 * this file existed (interfaces only, `docs/whitepapers/TECHNICAL_WHITEPAPER.md`'s
 * own 🟡 label). Scope, stated precisely: `Claim → Proof → Verification`
 * plus the three security properties this pass exists to close (hash
 * recompute, nonce anti-replay, time-lock).
 *
 * **Closed 2026-08-04:** RFC-007's `ProofRegistry` (`proof-registry.ts`,
 * duplicate-evidence detection — exact-content only, see that file's own
 * disclosed limitation on perceptual hashing), `EvidenceProvider`
 * (`evidence-provider.ts`, real external media storage — `evidence` on
 * `Proof` itself still stores small/structured claims inline, the same
 * pragmatic choice `Message.content` already makes; `attachEvidence()`
 * below is the new path for actual media bytes), and RFC-008's
 * `AnchorProof`/`TimestampAnchor` (`timestamp-anchor.ts`, real submission
 * to a live OpenTimestamps calendar server — verification/upgrade is a
 * disclosed, separate gap, see that file's own header comment).
 */
import { createHash, randomBytes } from 'crypto'
import nacl from 'tweetnacl'
import { prisma } from '../../common/database'
import { redis } from '../../common/redis'
import { atomicConsume } from '../../common/redis/atomic-consume'
import { NotFoundError, ValidationError, ForbiddenError, EvidenceStorageError } from '../../common/errors'
import { config } from '../../config'
import { eventBus } from '../../common/events/event-bus'
import { proofRegistry } from './proof-registry'
import { evidenceProvider, resolveEvidenceProviderByLabel } from './evidence-provider'
import { timestampAnchor } from './timestamp-anchor'
import { getTimeline } from '../../core/timeline'
import { tradeService } from '../open-p2p/trade.service'
import type { Prisma } from '@prisma/client'

// Issue #261 — the canonical, single authorization boundary for every
// OpenProof operation that references a Claim's economic scope (claim
// creation, proof submission, evidence attachment, verification nonce
// issuance, proof verification, claim-scoped bundle read, evidence
// anchoring). Lives HERE, at the service layer every one of those
// methods already funnels through unconditionally — not at
// proof.routes.ts — so a direct service call (a test, a future
// automation caller, a different route) cannot bypass it the way a
// route-only `if (buyer || seller)` check could.
//
// Authentication ≠ Evidence Authorization: requireAuth (proof.routes.ts)
// only proves `actorId` is a real, currently-logged-in Participant. It
// proves nothing about whether that Participant has any relationship to
// THIS Claim's trade. This function is what closes that gap.
//
// Authority sources, in the order checked (mirrors #220's own findings
// and the mission's explicit list of legitimate sources):
//   1. Trade-bound Claim (claim.tradeId set) → the trade's buyer or
//      seller (tradeService.assertParticipant() — the SAME function
//      already used, and already accepted as correct, for the
//      trade-scoped bundle route's own precedent), OR the trade's
//      CURRENT assigned arbiter. "Current," not "ever assigned": a
//      Dispute row's `arbiterId` is the SAME field RFC-021 D6's appeal
//      flow overwrites in place (the superseded arbiter's id moves to
//      `previousArbiterId` on that same row — no second row is ever
//      created), so this query can never match a replaced arbiter.
//      Past Authority ≠ Current Authority is preserved by construction,
//      not by an extra check.
//   2. Non-trade Claim (claim.tradeId null) — RFC-007 D6's own comment
//      confirms this is a legitimate, supported shape, so it is
//      deliberately NOT prohibited here. But no trade-participant or
//      arbiter relationship exists to check for one, and inventing a
//      broader rule (e.g. "any authenticated Participant") would be
//      exactly the "global authenticated access" the mission forbids.
//      The one relationship that DOES already exist for a non-trade
//      Claim is authorship — Claim.claimedBy. This is the narrowest,
//      most defensible non-invented boundary: only the Claim's own
//      creator has authority over a Claim with no trade to anchor a
//      wider one to. See this mission's own return report for why this
//      is flagged as a real, reported ambiguity for verifyProof()
//      specifically (self-verification is a strange fit for a
//      Verification's own purpose) rather than silently resolved wider.
async function assertClaimEconomicScopeAccess(
  claim: { tradeId: string | null; claimedBy: string },
  actorId: string
): Promise<void> {
  if (!claim.tradeId) {
    if (actorId === claim.claimedBy) return
    throw new ForbiddenError(
      `${actorId} has no economic-scope authority over this Claim — it has no tradeId, so only its ` +
      `creator (${claim.claimedBy}) does; no trade relationship exists here to establish a wider authority.`
    )
  }

  try {
    await tradeService.assertParticipant(claim.tradeId, actorId)
    return
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err // NotFoundError (trade missing) or anything else propagates as-is
  }

  const currentDispute = await prisma.dispute.findFirst({ where: { tradeId: claim.tradeId, arbiterId: actorId } })
  if (currentDispute) return

  throw new ForbiddenError(
    `${actorId} is neither a party to trade ${claim.tradeId} nor its current assigned arbiter — ` +
    'no economic-scope authority over this Claim\'s evidence.'
  )
}

// CTO Delta — Durable Evidence Provenance (Issue #265). The ONE
// sanctioned path for mutating an existing `EvidenceReference` row.
// `provider`/`uri` are storage-location provenance, set once at
// creation (`attachEvidence()`) — see that model's own header comment
// in `prisma/schema.prisma`. This function is the executable form of
// that comment: any caller (today, only `anchorEvidence()` below; any
// future one too) that routes through it CANNOT rewrite `provider`/`uri`
// in place, at runtime, regardless of what TypeScript's own `Omit<>`
// type on `data` would separately have caught or missed at compile
// time — the `hasOwnProperty` check below is real, unconditional,
// defense against an `as any`/spread bypass, not merely a type hint.
//
// Enforcement boundary, stated precisely (never overclaimed): this is a
// DOMAIN/SERVICE-level mutation invariant, not a database constraint. A
// future direct `prisma.evidenceReference.update()` call written
// elsewhere in the repository (bypassing this function entirely), or
// raw SQL against the `evidence_references` table, is NOT prevented by
// this guard — database-level immutability does not exist today. What
// IS true: this is currently the ONLY `EvidenceReference` mutation call
// site in the codebase (confirmed via `grep -rn
// "evidenceReference.update"` src/`), so routing every mutation through
// it (as `anchorEvidence()` already does) closes the gap for as long as
// that remains true. A PostgreSQL trigger/constraint was deliberately
// not added — no evidence in this codebase suggests application-level
// enforcement is insufficient for #265's current scope, and one is not
// required to make this property real and regression-tested today.
export type EvidenceReferenceMutableFields = Omit<Prisma.EvidenceReferenceUpdateInput, 'provider' | 'uri' | 'id' | 'proofId' | 'proof'>

// Exported (deliberately, as an exception to this file's own
// "module-private helper" convention — assertClaimEconomicScopeAccess()
// above is never exported and only exercised indirectly): the whole
// point of this boundary is to be testable and reusable independent of
// any ONE caller's own call shape, per this delta's own requirement
// that a regression test "prove the property, not merely assert the
// current shape of one call."
export function updateEvidenceReferenceProvenanceGuarded(id: string, data: EvidenceReferenceMutableFields) {
  if (Object.prototype.hasOwnProperty.call(data, 'provider') || Object.prototype.hasOwnProperty.call(data, 'uri')) {
    throw new Error(
      `Refusing to update EvidenceReference ${id}: 'provider'/'uri' are immutable storage-location provenance ` +
      'once a reference is created (see prisma/schema.prisma\'s EvidenceReference model comment). A provider ' +
      'migration must insert a new EvidenceReference row — Proof.evidenceReferences is already one-to-many — ' +
      'never mutate an existing row\'s provider/uri.'
    )
  }
  return prisma.evidenceReference.update({ where: { id }, data })
}

const NONCE_PREFIX = 'proof:verify-nonce:'

// Canonical JSON — key order matters for a stable hash across identical
// evidence submitted twice; JSON.stringify's own key order already
// matches insertion order in V8, but callers can supply keys in any
// order, so this sorts them explicitly rather than depending on that
// being the same order twice by accident.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function hashEvidence(evidence: unknown): string {
  return createHash('sha256').update(canonicalize(evidence)).digest('hex')
}

// Issue #300 — CTO-frozen OpenProof Resource Bound Policy V1.
// Inline evidence is intentionally small structured JSON. Validate it without
// recursive traversal before canonicalization/hash so adversarial depth cannot
// consume the very resource this boundary exists to protect.
export const INLINE_EVIDENCE_MAX_UTF8_BYTES = 256 * 1024
export const INLINE_EVIDENCE_MAX_DEPTH = 32
export const INLINE_EVIDENCE_MAX_NODES = 10_000

export function assertInlineEvidenceResourceBounds(value: unknown): void {
  // Structural admission MUST happen before JSON.stringify(): stringify itself
  // recursively descends attacker-controlled objects and therefore cannot be
  // the mechanism that decides whether depth is safe.
  let nodes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > INLINE_EVIDENCE_MAX_NODES) {
      throw new ValidationError('Inline proof evidence exceeds the 10,000-node complexity limit')
    }
    if (current.depth > INLINE_EVIDENCE_MAX_DEPTH) {
      throw new ValidationError('Inline proof evidence exceeds the depth-32 limit')
    }
    if (current.value === null || typeof current.value !== 'object') continue
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 })
  }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new ValidationError('Inline proof evidence must be valid JSON')
  }
  if (serialized === undefined) {
    throw new ValidationError('Inline proof evidence must be valid JSON')
  }
  if (Buffer.byteLength(serialized, 'utf8') > INLINE_EVIDENCE_MAX_UTF8_BYTES) {
    throw new ValidationError('Inline proof evidence exceeds the 256 KiB UTF-8 limit; use EvidenceProvider for larger evidence')
  }
}

export interface AssertClaimInput {
  claimedBy: string
  claimType: string
  assertion: unknown
  // RFC-007 D6 — scopes this Claim into a trade's EvidenceBundle
  // (getEvidenceBundleForTrade() below). Optional: not every Claim is
  // trade-related (see Claim.tradeId's own schema comment for why this
  // is tradeId, not RFC-007's literal intentId).
  tradeId?: string
}

export interface SubmitProofInput {
  claimId: string
  evidence: unknown
  submittedBy: string
  // Deliberately accepted and deliberately ignored for the actual stored
  // hash — see submitProof()'s own comment. Present in the input type so
  // a caller who sends one (trusting their own computation, or a
  // malicious caller trying to make a forged hash stick) is handled
  // explicitly, not silently dropped by a schema that never mentioned it.
  claimedHash?: string
}

export class ProofService {
  // Issue #261 — Claim creation authorization. Required property: a
  // trade-bound Claim's creator must have an authorized relationship to
  // that trade — an unrelated authenticated user must not be able to
  // assert a Claim scoped to a trade they're not party to (they'd be
  // asserting something about someone else's trade with no standing to
  // do so). Reuses tradeService.assertParticipant() directly — the exact
  // function GET /v1/proof/trades/:tradeId/bundle already uses, per the
  // mission's own "useful precedent" instruction — rather than
  // duplicating its buyer/seller comparison here. Deliberately does NOT
  // check the arbiter relationship the way assertClaimEconomicScopeAccess()
  // does for an EXISTING Claim: an arbiter has no standing to assert a
  // NEW Claim on a trade's behalf, only to review/verify existing ones.
  // A Claim with no tradeId is unaffected — RFC-007 D6's own comment
  // confirms non-trade Claims are a legitimate, supported shape; nothing
  // here narrows that.
  async assertClaim(input: AssertClaimInput) {
    if (input.tradeId) {
      await tradeService.assertParticipant(input.tradeId, input.claimedBy)
    }

    const claim = await prisma.claim.create({
      data: {
        claimedBy: input.claimedBy,
        claimType: input.claimType,
        assertion: input.assertion as unknown as Prisma.InputJsonValue,
        tradeId: input.tradeId,
      },
    })

    await eventBus.emit('claim.asserted', {
      claimId: claim.id,
      claimedBy: claim.claimedBy,
      claimType: claim.claimType,
    }, claim.id)

    return claim
  }

  // The security property this method exists to enforce: `evidenceHash`
  // is ALWAYS this server's own sha256(canonicalize(evidence)) — never
  // whatever `input.claimedHash` says, even if a caller supplies one that
  // "looks right." A caller who submits real evidence but a wrong/stale/
  // forged claimedHash gets the correct hash stored anyway (their claimed
  // hash was simply never a source of truth to begin with); this is not
  // a "reject the request" case; it is architecturally impossible for a
  // client-supplied hash to ever reach storage.
  async submitProof(input: SubmitProofInput) {
    // Resource admission precedes every DB read, authorization traversal,
    // canonicalization/hash, persistence, registry lookup and event emission.
    assertInlineEvidenceResourceBounds(input.evidence)

    const claim = await prisma.claim.findUnique({ where: { id: input.claimId } })
    if (!claim) throw new NotFoundError('Claim', input.claimId)

    // Issue #261 — Proof submission authorization. An unrelated user who
    // merely knows the Claim id must not be able to submit arbitrary
    // Proof against it. Deliberately the SAME scope as read/verify
    // (trade participant or current arbiter, or the Claim's own creator
    // for a non-trade Claim) rather than narrowed to "claim owner only":
    // the real-world shape a Proof supports is often submitted by the
    // COUNTERPARTY, not the claimant (buyer claims "I paid," seller
    // submits Proof disputing it) — narrowing to claimedBy-only would
    // break that legitimate case, not just close a gap.
    await assertClaimEconomicScopeAccess(claim, input.submittedBy)

    // Time-lock: evidence submitted long after the Claim it supports is
    // weaker proof of what was true *at the claimed time* — the same
    // reasoning escrow.timelockHours already applies to fund locks.
    const windowMs = config.proof.submissionWindowHours * 3600 * 1000
    const ageMs = Date.now() - claim.createdAt.getTime()
    if (ageMs > windowMs) {
      throw new ValidationError(
        `Proof submitted ${Math.round(ageMs / 3600000)}h after its Claim — outside the ` +
        `${config.proof.submissionWindowHours}h submission window`
      )
    }

    const evidenceHash = hashEvidence(input.evidence)

    const proof = await prisma.proof.create({
      data: {
        claimId: input.claimId,
        evidence: input.evidence as unknown as Prisma.InputJsonValue,
        evidenceHash,
        submittedBy: input.submittedBy,
      },
    })

    // Defense-in-depth signal, not a rejection: a mismatch here means
    // either a buggy client or a real forgery attempt (submitting real
    // evidence bytes while claiming a different, more favorable hash
    // computed some other way) — worth a real event for a human/QVAC to
    // notice, even though it changes nothing about what got stored.
    if (input.claimedHash && input.claimedHash !== evidenceHash) {
      await eventBus.emit('proof.hash_mismatch_detected', {
        proofId: proof.id,
        claimId: input.claimId,
        claimedHash: input.claimedHash,
        actualHash: evidenceHash,
      }, input.claimId)
    }

    // RFC-007 D1 — flags reuse, never blocks it (adjudication is
    // Dispute's/Policy Engine's job, not this method's). excludeTradeId
    // is this Claim's own tradeId, so a participant resubmitting/retrying
    // their own evidence for their own ongoing trade never counts as
    // reuse of itself.
    const duplicates = await proofRegistry.findDuplicates(evidenceHash, claim.tradeId ?? undefined)
    const realDuplicates = duplicates.filter((d) => d.proofId !== proof.id)
    if (realDuplicates.length > 0) {
      await eventBus.emit('proof.duplicate_detected', {
        proofId: proof.id,
        claimId: input.claimId,
        evidenceHash,
        matches: realDuplicates,
      }, input.claimId)
    }

    await eventBus.emit('proof.submitted', {
      proofId: proof.id,
      claimId: proof.claimId,
    }, proof.claimId)

    return proof
  }

  // Anti-replay: a fresh, single-use nonce is required before verifyProof()
  // will accept a verdict — the same challenge-response shape auth.ts's
  // issueChallenge()/verifySignedChallenge() already establishes for
  // login, applied here to stop a captured/old verification call (or an
  // automated verifier accidentally re-invoked) from being replayed
  // against a Proof whose evidence has since been disputed and needs a
  // fresh look, not a stale rubber stamp.
  // Issue #261 — verifier authority. `requestedBy` is new: this method
  // previously took no caller identity at all (proof.routes.ts called it
  // with only `id`), meaning it was structurally impossible to authorize
  // — anyone authenticated could mint a nonce for any Proof.
  //
  // AMBIGUITY, reported rather than silently resolved (per this
  // mission's own required process): Verification.verifiedBy's own
  // schema comment says a verifier "may be a Participant, an assigned
  // Arbiter, or a QVAC agent label" — "a Participant" is RFC-001's broad
  // term for any authenticated actor with an id, not necessarily a
  // participant of THIS trade specifically, and no RFC or code comment
  // anywhere states plainly "only the trade's own buyer/seller/arbiter
  // may verify a Proof about that trade." Treating "a Participant" as
  // "any authenticated Participant" would be exactly the global
  // authenticated-access posture this mission exists to close, so it is
  // NOT what's implemented here. The narrower, fail-closed reading
  // (assertClaimEconomicScopeAccess() — trade participant or current
  // arbiter, or the Claim's own creator for a non-trade Claim) is
  // enforced instead, as the smallest safe boundary current repository
  // truth actually supports. Whether verification authority should be
  // wider (e.g. a distinct, explicitly-granted verifier role/capability,
  // separate from ordinary trade participancy) is a real, open
  // Architecture Decision this mission does not resolve — flagged in
  // this mission's own return report, not invented here.
  async issueVerificationNonce(proofId: string, requestedBy: string): Promise<{ nonce: string; expiresIn: number }> {
    const proof = await prisma.proof.findUnique({ where: { id: proofId }, include: { claim: true } })
    if (!proof) throw new NotFoundError('Proof', proofId)
    await assertClaimEconomicScopeAccess(proof.claim, requestedBy)

    const nonce = randomBytes(32).toString('hex')
    await redis.set(
      `${NONCE_PREFIX}${proofId}:${nonce}`,
      '1',
      'EX',
      config.proof.verificationNonceTtlSeconds
    )
    return { nonce, expiresIn: config.proof.verificationNonceTtlSeconds }
  }

  // Issue #261 — same verifier-authority boundary and same reported
  // ambiguity as issueVerificationNonce() above (this method's own
  // `verifiedBy` parameter already existed, but was never actually
  // checked against any relationship before this mission — a valid
  // nonce alone was sufficient, and a nonce proves only "a verify-nonce
  // call happened for this Proof," never who is entitled to make the
  // call in the first place).
  async verifyProof(
    proofId: string,
    verifiedBy: string,
    verdict: 'ACCEPTED' | 'REJECTED',
    nonce: string,
    reason?: string
  ) {
    const proof = await prisma.proof.findUnique({ where: { id: proofId }, include: { claim: true } })
    if (!proof) throw new NotFoundError('Proof', proofId)
    await assertClaimEconomicScopeAccess(proof.claim, verifiedBy)

    // Issue #301 — atomic consume, not a separate GET+DEL. A plain
    // `redis.get()` followed later by `redis.del()` does not actually
    // guarantee single-use under concurrency: two simultaneous
    // `verifyProof()` calls for the same nonce (including one ACCEPTED
    // and one REJECTED) could both observe it valid before either
    // deleted it, both reaching `prisma.verification.create()` below.
    // `atomicConsume()` is a single Redis-server-side operation with
    // exactly one winner — the loser gets `null` here and is rejected
    // before ever creating a Verification row.
    const nonceKey = `${NONCE_PREFIX}${proofId}:${nonce}`
    const nonceValid = await atomicConsume(nonceKey)
    if (!nonceValid) {
      throw new ValidationError(
        'Missing, expired, or already-used verification nonce — call ' +
        'POST /v1/proof/proofs/:id/verify-nonce first, and note each nonce is single-use'
      )
    }

    const verification = await prisma.verification.create({
      data: { proofId, verifiedBy, verdict, reason },
    })

    await eventBus.emit(
      verdict === 'ACCEPTED' ? 'verification.accepted' : 'verification.rejected',
      { verificationId: verification.id, proofId, verifiedBy, verdict: verdict as 'ACCEPTED' | 'REJECTED' },
      proof.claimId
    )

    return verification
  }

  // Issue #261 — claim-scoped evidence bundle read authorization.
  // `requestedBy` is new (this method previously took only `claimId` —
  // proof.routes.ts called it with no caller identity at all, so an
  // authenticated but entirely unrelated user could read any Claim's
  // full bundle — every Proof, every Verification — merely by knowing
  // or guessing its id). Mirrors GET /v1/proof/trades/:tradeId/bundle's
  // own already-accepted tradeService.assertParticipant() precedent,
  // extended with the current-arbiter and non-trade-Claim-creator cases
  // assertClaimEconomicScopeAccess() covers generally — see that
  // function's own header for the full reasoning. Evidence is never
  // public-by-default: no branch here returns the bundle without a
  // passing relationship check first.
  async getEvidenceBundle(claimId: string, requestedBy: string) {
    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: { proofs: { include: { verifications: true } } },
    })
    if (!claim) throw new NotFoundError('Claim', claimId)
    await assertClaimEconomicScopeAccess(claim, requestedBy)
    return claim
  }

  /**
   * RFC-007 D2, closed 2026-08-04 — stores real media bytes for an
   * existing Proof via `evidenceProvider` (local filesystem by default)
   * and persists the resulting `EvidenceReference`. `signature` is
   * verified for real against `submittedBy`'s own registered
   * `User.publicKey` (Ed25519, same `tweetnacl` call
   * `common/middleware/auth.ts`'s `verifySignedChallenge()` uses) — over
   * the media's own sha256 hex digest, not the raw bytes, so a caller
   * never needs to re-sign large media, only its hash. Never trusted
   * unverified: a caller claiming a signature that doesn't actually
   * verify is rejected outright, not stored with a "trust me" flag.
   */
  // Issue #261 — this is the sharpest instance of the mission's own
  // central distinction: `sigValid` below proves "submittedBy really
  // signed this media's own hash" — real cryptographic identity/
  // integrity — but proves NOTHING about whether submittedBy has any
  // authority to attach that (genuinely, validly signed) media to THIS
  // proof's Claim/Trade. Before this fix, a perfectly valid signature
  // from User A was sufficient to attach evidence to User B's unrelated
  // Proof. The scope check runs FIRST, before the (comparatively
  // expensive, and previously the only) signature verification — an
  // unauthorized caller is refused before any crypto work or storage
  // write, not after.
  async attachEvidence(
    proofId: string,
    media: Uint8Array,
    mimeType: 'image' | 'video' | 'document' | 'ocr' | 'external_reference',
    submittedBy: string,
    signatureHex: string
  ) {
    const proof = await prisma.proof.findUnique({ where: { id: proofId }, include: { claim: true } })
    if (!proof) throw new NotFoundError('Proof', proofId)
    await assertClaimEconomicScopeAccess(proof.claim, submittedBy)

    const submitter = await prisma.user.findUnique({ where: { id: submittedBy } })
    if (!submitter) throw new NotFoundError('User', submittedBy)

    const digestHex = createHash('sha256').update(media).digest('hex')
    let sigValid = false
    try {
      sigValid = nacl.sign.detached.verify(
        new Uint8Array(Buffer.from(digestHex, 'hex')),
        new Uint8Array(Buffer.from(signatureHex, 'hex')),
        new Uint8Array(Buffer.from(submitter.publicKey, 'hex'))
      )
    } catch {
      sigValid = false
    }
    if (!sigValid) {
      throw new ForbiddenError(`Signature does not verify against ${submittedBy}'s registered public key for this media's own hash`)
    }

    const stored = await evidenceProvider.store(media, mimeType)
    // Issue #265 CTO Gate R2, BLOCKER 2 — corrects the previous comment
    // here, which claimed this divergence "would mean a bug in the
    // provider itself, not an adversarial input" and left it unchecked.
    // That reasoning assumed a well-behaved provider; it never actually
    // enforced the frozen property "storage provider != source of
    // evidence truth." `digestHex` is the hash `submittedBy`'s signature
    // was verified against, above — the one thing this method already
    // knows for certain is genuine. `stored.sha256` is whatever the
    // provider itself claims to have written; a faulty or malicious
    // provider (corrupting bytes in flight, or simply misreporting its
    // own hash) must never get to silently become the canonical,
    // caller-trusted `EvidenceReference.sha256`. Checked here, before
    // persistence — the provider's own hash is used only to detect this
    // mismatch, never stored.
    if (stored.sha256 !== digestHex) {
      throw new EvidenceStorageError(
        `Evidence provider '${stored.provider}' returned sha256 ${stored.sha256} for stored media, ` +
        `but ${submittedBy}'s signature covers ${digestHex} — refusing to persist a mismatched EvidenceReference`,
        'CORRUPTED'
      )
    }
    const reference = await prisma.evidenceReference.create({
      data: {
        proofId,
        provider: stored.provider,
        uri: stored.uri,
        sha256: digestHex, // canonical, service-computed, signer-bound digest — never the provider's own self-report
        mimeType,
        signature: signatureHex,
      },
    })

    await eventBus.emit('proof.submitted', { proofId, claimId: proof.claimId }, proof.claimId)

    return reference
  }

  /**
   * Issue #265 Step 4 — hash verification lives HERE, not inside any
   * `EvidenceProvider` implementation: "storage provider retrieves
   * bytes; OpenProof/service layer verifies them against the canonical
   * `EvidenceReference` metadata. Do not let a storage backend become
   * the source of evidence truth." A storage backend can be UNAVAILABLE
   * (a provider-level `EvidenceStorageError` with `storageReason:
   * 'UNAVAILABLE'`, propagated as-is) or return the wrong bytes for a
   * genuine `NOT_FOUND` reference (never conflated — `retrieve()` itself
   * already keeps those apart); this method adds the one thing neither
   * provider can decide on its own: whether the bytes it got back are
   * the SAME bytes `attachEvidence()` actually stored, per the
   * database's own recorded `sha256`. A mismatch throws
   * `EvidenceStorageError` with `storageReason: 'CORRUPTED'` — corrupted/
   * tampered bytes are rejected here, never returned to a caller as if
   * they were the real evidence.
   *
   * Deliberately not wired to any HTTP route: #234's own audit found
   * zero byte-retrieval route exists anywhere in production code today
   * (evidence upload is write-only through the current API), and #265's
   * mission explicitly lists "implement retrieval product UX/API unless
   * strictly required for provider testability" as a non-goal. This
   * exists so the hash-verification contract is real, internally
   * callable, and testable without inventing that API surface.
   *
   * Issue #265 CTO Gate R2, BLOCKER 3 — dispatches on
   * `reference.provider`, not the currently-configured global
   * `evidenceProvider` singleton. A reference created under one backend
   * (e.g. `local-fs` before this deployment switched to `s3`) must be
   * read back through THAT backend, never whichever provider this
   * deployment happens to be configured to WRITE new evidence to today
   * — see `resolveEvidenceProviderByLabel()`'s own header comment.
   */
  async retrieveVerifiedEvidence(evidenceReferenceId: string, requestedBy: string): Promise<Uint8Array> {
    const reference = await prisma.evidenceReference.findUnique({
      where: { id: evidenceReferenceId },
      include: { proof: { include: { claim: true } } },
    })
    if (!reference) throw new NotFoundError('EvidenceReference', evidenceReferenceId)
    await assertClaimEconomicScopeAccess(reference.proof.claim, requestedBy)

    const provider = resolveEvidenceProviderByLabel(reference.provider)
    const bytes = await provider.retrieve(reference.uri)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (actualSha256 !== reference.sha256) {
      throw new EvidenceStorageError(
        `Retrieved evidence for ${evidenceReferenceId} does not match its recorded sha256 (expected ${reference.sha256}, got ${actualSha256})`,
        'CORRUPTED'
      )
    }
    return bytes
  }

  /**
   * Issue #266 — resolves and scope-checks an `EvidenceReference` for a
   * cross-module caller (`dispute.service.ts`'s own evidence
   * cross-reference path, the only consumer today). Deliberately a
   * DIFFERENT question from `assertClaimEconomicScopeAccess()` above:
   * that function asks "does this ACTOR have authority over this
   * claim" (trade party or current arbiter); this one asks "does this
   * EvidenceReference genuinely belong to THIS TRADE" — a scope-
   * membership check, not an actor-authorization check. The caller-
   * authorization question stays the calling module's own
   * responsibility (`dispute.service.ts` already reuses its own
   * existing trade-party check before ever calling this).
   *
   * `EvidenceReference` (not `Claim`/`Proof`) is the correct, most
   * specific canonical identifier to cross-reference — a `Claim` can
   * have many `Proof`s and a `Proof` can have many
   * `EvidenceReference`s (Prisma's own one-to-many relations, RFC-007),
   * so anything coarser would be ambiguous about which exact
   * integrity-bound bytes are being referenced.
   */
  async assertEvidenceReferenceBelongsToTrade(evidenceReferenceId: string, tradeId: string) {
    const reference = await prisma.evidenceReference.findUnique({
      where: { id: evidenceReferenceId },
      include: { proof: { include: { claim: true } } },
    })
    if (!reference) throw new NotFoundError('EvidenceReference', evidenceReferenceId)
    if (reference.proof.claim.tradeId !== tradeId) {
      throw new ForbiddenError(
        `EvidenceReference ${evidenceReferenceId} does not belong to trade ${tradeId} — a dispute cross-reference must ` +
        "point at evidence from the SAME trade's own Claim/Proof chain, never a different trade's or a non-trade-scoped Claim's."
      )
    }
    return reference
  }

  /**
   * RFC-008 D1, closed 2026-08-04 — real submission to a live
   * OpenTimestamps calendar server (`timestamp-anchor.ts`). Policy-gated
   * per that RFC's own D1 ("Policy Engine decides when an anchor is
   * required") — this method is the mechanism, not something called
   * unconditionally from `attachEvidence()`; a caller (a route, or a
   * future real Policy Engine hook) decides when the real network cost
   * is worth it.
   */
  // Issue #261 — anchoring authorization. `requestedBy` is new (this
  // method previously took only `evidenceReferenceId` — no caller
  // identity at all, so any authenticated user could trigger a real,
  // costed network call to a live OpenTimestamps calendar server against
  // ANY EvidenceReference).
  //
  // AMBIGUITY, reported rather than guessed: this method's own header
  // comment above already discloses that RFC-008 D1's real intent is
  // "Policy Engine decides when an anchor is required" — i.e. anchoring
  // was conceived as a SYSTEM/automation decision, not necessarily a
  // manual action tied to one specific human role. No real Policy Engine
  // gate exists in this codebase today (searched — there is no "trusted
  // system caller" identity concept modeled anywhere for this), so that
  // intended automation path cannot be enforced here without inventing
  // one, which this mission does not do. The fail-closed default applied
  // instead is the SAME economic-scope boundary as every other action in
  // this evidence chain — a trade participant or current arbiter (or a
  // non-trade Claim's creator) may anchor evidence that is already part
  // of their own Claim's Proof, since anchoring only strengthens
  // integrity assurance for evidence they already have legitimate access
  // to; an unrelated caller may not trigger the real external cost.
  // Whether a distinct "system/policy-engine automation" caller identity
  // should exist for this action is a real, open Architecture Decision,
  // flagged in this mission's own return report.
  async anchorEvidence(evidenceReferenceId: string, requestedBy: string) {
    const reference = await prisma.evidenceReference.findUnique({
      where: { id: evidenceReferenceId },
      include: { proof: { include: { claim: true } } },
    })
    if (!reference) throw new NotFoundError('EvidenceReference', evidenceReferenceId)
    await assertClaimEconomicScopeAccess(reference.proof.claim, requestedBy)

    const anchorProof = await timestampAnchor.anchor(reference.sha256)

    // CTO Delta — Durable Evidence Provenance. Routed through the one
    // sanctioned mutation function (see its own header comment above) —
    // never a direct `prisma.evidenceReference.update()` call.
    const updated = await updateEvidenceReferenceProvenanceGuarded(evidenceReferenceId, {
      anchorProof: anchorProof as unknown as Prisma.InputJsonValue,
    })
    return updated
  }

  /**
   * RFC-007 D6, closed 2026-08-04 — the real per-trade aggregate that
   * RFC's own interface describes (claims/proofs/verifications/timeline/
   * externalReferences), distinct from `getEvidenceBundle(claimId)`
   * above (an already-shipped, differently-scoped per-Claim read with
   * its own real SDK/React-hook surface — kept unchanged, not renamed,
   * to avoid a breaking change to that surface). `tradeId`, not RFC-007's
   * literal `intentId` — same real-world correction `core/timeline.ts`'s
   * own header comment already explains and this file's `Claim.tradeId`
   * schema comment repeats.
   *
   * Issue #264 — this method previously took no caller identity at all;
   * GET /v1/proof/trades/:tradeId/bundle's own route enforced
   * tradeService.assertParticipant() before calling here, but that made
   * "HTTP route protected" != "service boundary protected" — a direct
   * service caller (a test, a future internal caller, a different route)
   * could read any trade's full evidence bundle with no authorization at
   * all. `requestedBy` is new, and the SAME canonical
   * tradeService.assertParticipant() the route already used is now
   * enforced HERE too — not a second, independently-maintained buyer/
   * seller check. Deliberately does NOT add current-arbiter read
   * authority: the pre-existing route only ever granted buyer/seller
   * (assertParticipant() has no arbiter branch), and nothing in RFC-007
   * D6 or this method's own history establishes arbiter access to this
   * specific trade-scoped aggregate — broadening it here would be
   * inventing new authority, not closing this bug. (Contrast with
   * proof.service.ts's own assertClaimEconomicScopeAccess(), used by
   * every OTHER OpenProof method since #261, which DOES include current-
   * arbiter access for the claim-scoped bundle and other Claim/Proof
   * operations — that's a real, separately-flagged inconsistency between
   * this trade-scoped aggregate and the rest of OpenProof, reported in
   * this mission's own return, not silently resolved either way here.)
   */
  async getEvidenceBundleForTrade(tradeId: string, requestedBy: string) {
    await tradeService.assertParticipant(tradeId, requestedBy)

    const claims = await prisma.claim.findMany({
      where: { tradeId },
      include: { proofs: { include: { verifications: true, evidenceReferences: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const proofs = claims.flatMap((c) => c.proofs)
    const verifications = proofs.flatMap((p) => p.verifications)
    const externalReferences = proofs.flatMap((p) => p.evidenceReferences)

    const timeline = await getTimeline(tradeId).getEvents()
    // Missão 05 (2026-08-15), current-truth corrected 2026-09-07
    // (docs/TECHNICAL_DEBT_AUDIT.md #55) — evidence-integrity finding,
    // disclosed in the bundle itself rather than left for a reader to
    // discover. `claims`/`proofs`/`verifications`/`externalReferences`
    // above are Postgres-backed and survive a restart. `timeline` is read
    // through whichever `EventStore` `eventBus` (event-bus.ts's own
    // singleton) is actually configured with, not a hardcoded assumption.
    // As of Missão 05.7 (2026-08-15, a later same-day pass than the
    // original finding above), the real default is `PostgresEventStore`
    // (`durable = true`) — under the current default, timeline history
    // is not lost merely because the application process restarts,
    // unlike the former `InMemoryEventStore` default. This does not by
    // itself prove that an empty `timeline` means nothing ever happened
    // for this trade: durability describes whether recorded history
    // survives the relevant persistence/restart boundary, not whether
    // every event was ever recorded in the first place.
    // `SailsEventBus` accepts an `EventStore` via its constructor, and
    // `InMemoryEventStore` remains an available non-durable
    // implementation — but the current production singleton (`eventBus`,
    // above) exposes no config/env switch to select it; today's real
    // default is unconditionally `PostgresEventStore`. If a future
    // change did wire a non-durable store in, this array could again go
    // silently EMPTY after a restart/redeploy, and an arbiter reading
    // this bundle would have no way to tell "nothing happened" apart
    // from "the history was lost." `timelineDurable`/`timelineStore`
    // below report the actual configured store at read time (never
    // hardcoded), specifically so that ambiguity can never be silently
    // reintroduced without also becoming visible here. Separately:
    // RFC-008 D2's hash chain gives the Timeline tamper-EVIDENCE —
    // `verifyChain()` detects covered mutation/reordering/deletion of
    // the events it does record (`tests/timeline.test.ts` proves this).
    // Durability is a distinct property describing whether that
    // recorded history survives a restart. Neither property alone
    // proves completeness, historical non-occurrence, portability, or
    // independent verifiability.
    const timelineDurable = eventBus.durable
    return {
      tradeId, claims, proofs, verifications, externalReferences, timeline,
      timelineDurable,
      timelineStore: eventBus.storeName,
    }
  }
}

export const proofService = new ProofService()
