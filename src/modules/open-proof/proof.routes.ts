/**
 * Sails OpenProof routes — PROTOCOL_SPECIFICATION.md §1.8. Every mutating
 * route derives its identity field from the authenticated session
 * (`req.participantId`, `requireAuth`), never a bare id in the body — the
 * same RT-002-class boundary every other mutating route in this codebase
 * already relies on.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { proofService } from './proof.service'
import { requireAuth } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { docsOnlySchema } from '../../common/openapi'
import { config } from '../../config'
import { consumeSharedRateLimitKeys } from '../../common/middleware/redis-rate-limit'

const assertClaimSchema = z.object({
  claimType: z.string().min(1),
  assertion: z.unknown(),
  tradeId: z.string().optional(), // RFC-007 D6 — scopes this Claim into a trade's EvidenceBundle
})

// RFC-007 D2 — media as base64 (this codebase's established JSON-body
// convention, same as every other route here — no multipart upload
// machinery introduced for this one route). signature is hex-encoded,
// verified server-side against the caller's own registered public key
// (proof.service.ts's attachEvidence()) — never trusted as-is.
const attachEvidenceSchema = z.object({
  mediaBase64: z.string().min(1).max(config.proof.evidenceMaxBase64Chars),
  mimeType: z.enum(['image', 'video', 'document', 'ocr', 'external_reference']),
  signatureHex: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
})

const submitProofSchema = z.object({
  claimId: z.string().min(1),
  evidence: z.unknown(),
  claimedHash: z.string().optional(),
})

const verifyProofSchema = z.object({
  verdict: z.enum(['ACCEPTED', 'REJECTED']),
  nonce: z.string().min(1),
  reason: z.string().optional(),
})

const idParamsSchema = z.object({ id: z.string().min(1) })

const tradeIdParamsSchema = z.object({ tradeId: z.string().min(1) })

export async function proofRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/proof/claims', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], body: assertClaimSchema }),
  }, async (request, reply) => {
    const body = assertClaimSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const claim = await proofService.assertClaim({
      claimedBy: participantId,
      claimType: body.claimType,
      assertion: body.assertion,
      tradeId: body.tradeId,
    })
    return reply.code(201).send({ success: true, data: claim })
  })

  app.post('/v1/proof/proofs', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], body: submitProofSchema }),
  }, async (request, reply) => {
    const body = submitProofSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const proof = await proofService.submitProof({
      claimId: body.claimId,
      evidence: body.evidence,
      submittedBy: participantId,
      claimedHash: body.claimedHash,
    })
    return reply.code(201).send({ success: true, data: proof })
  })

  app.post('/v1/proof/proofs/:id/verify-nonce', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: idParamsSchema }),
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    const result = await proofService.issueVerificationNonce(id, participantId)
    return reply.code(200).send({ success: true, data: result })
  })

  app.post('/v1/proof/proofs/:id/verify', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: idParamsSchema, body: verifyProofSchema }),
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const body = verifyProofSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const verification = await proofService.verifyProof(id, participantId, body.verdict, body.nonce, body.reason)
    return reply.code(201).send({ success: true, data: verification })
  })

  app.get('/v1/proof/claims/:id/bundle', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: idParamsSchema }),
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    const bundle = await proofService.getEvidenceBundle(id, participantId)
    return reply.code(200).send({ success: true, data: bundle })
  })

  // RFC-007 D2, closed 2026-08-04. participantId comes from the session
  // (RT-002 boundary, same as every other mutating route above) — the
  // caller cannot attach evidence "as" someone else even if they
  // supplied a signature that happens to verify (attachEvidence()'s own
  // check ties the signature to the AUTHENTICATED caller's public key,
  // not to a client-supplied participantId).
  app.post('/v1/proof/proofs/:id/evidence', {
    // #267 CTO Policy V1: reject oversized JSON before Fastify parses it.
    // mediaBase64 itself is capped at 14 MiB; the extra 64 KiB is only
    // structural JSON/signature/idempotency overhead, not extra media budget.
    bodyLimit: config.proof.evidenceMaxBase64Chars + 64 * 1024,
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: idParamsSchema, body: attachEvidenceSchema }),
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const body = attachEvidenceSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    await consumeSharedRateLimitKeys(request, [
      {
        key: `ratelimit:openproof-evidence:uploader-proof:${participantId}:${id}`,
        max: config.proof.evidenceRateUploaderProofMax,
        windowMs: config.proof.evidenceRateWindowMs,
      },
      {
        key: `ratelimit:openproof-evidence:uploader:${participantId}`,
        max: config.proof.evidenceRateUploaderMax,
        windowMs: config.proof.evidenceRateWindowMs,
      },
    ])
    const media = Buffer.from(body.mediaBase64, 'base64')
    const reference = await proofService.attachEvidence(id, media, body.mimeType, participantId, body.signatureHex, body.idempotencyKey)
    return reply.code(201).send({ success: true, data: reference })
  })

  // RFC-008 D1, closed 2026-08-04. Real submission to a live
  // OpenTimestamps calendar server — a genuine network call and cost, so
  // this stays an explicit, separate call rather than automatic on every
  // attachEvidence() (Policy Engine's own job to decide when it's
  // warranted, per that RFC's own D1).
  app.post('/v1/proof/evidence/:id/anchor', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: idParamsSchema }),
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    const reference = await proofService.anchorEvidence(id, participantId)
    return reply.code(200).send({ success: true, data: reference })
  })

  // Missão 06.6 — corrected from "public read, no session required" (RFC-007
  // D6, closed 2026-08-04; amended 2026-08-16, see that RFC's own amendment
  // note). Found in Missão 06.5's route audit: this bundle's own `timeline`
  // field (proof.service.ts's getEvidenceBundleForTrade()) is a full
  // projection of every correlated event for the trade — including real
  // chat message content (`openp2p.message.sent`'s `content` field), not
  // just coarse status fields like GET /v1/settlement/escrow/:id (the
  // precedent D6 originally borrowed). chat.routes.ts's own
  // GET /v1/openp2p/chat/:tradeId/messages already requires requireAuth +
  // tradeService.assertParticipant() for this exact same content, found
  // and fixed there in an earlier security review — this route was the
  // one place that fix never reached. Reuses that exact same mechanism,
  // no new primitive: EvidenceBundle's own shape, Timeline, the hash
  // chain, Policy Engine, and Capability are all untouched.
  //
  // Corrected/Implemented 2026-09-19 (Issue #264) — this route used to
  // call tradeService.assertParticipant() itself, directly, before
  // calling getEvidenceBundleForTrade(). That protected the HTTP path
  // but not the service boundary: a direct call to
  // proofService.getEvidenceBundleForTrade(tradeId) (a test, a future
  // internal caller) had no authorization at all — the exact class of
  // gap #261 already closed for every other OpenProof method.
  // getEvidenceBundleForTrade() now enforces tradeService.assertParticipant()
  // itself; the route's own separate call was removed rather than kept
  // as a redundant duplicate, matching the shape every other OpenProof
  // route already has post-#261 (extract participantId, pass it to the
  // service, let the service be the one and only authority check).
  app.get('/v1/proof/trades/:tradeId/bundle', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-proof'], params: tradeIdParamsSchema }),
  }, async (request, reply) => {
    const { tradeId } = tradeIdParamsSchema.parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    const bundle = await proofService.getEvidenceBundleForTrade(tradeId, participantId)
    return reply.code(200).send({ success: true, data: bundle })
  })
}
