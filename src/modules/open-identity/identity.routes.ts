/**
 * Sails OpenIdentity routes — API_REFERENCE.md section 2.
 *
 * Thin HTTP wiring only — registration delegates to identity.service.ts,
 * challenge/authenticate delegate to common/middleware/auth.ts (RT-002's
 * fix). No route here reads a bare `userId`/`participantId` from the
 * request body as an identity claim — that was exactly the vulnerability
 * this module exists to close.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { identityService } from './identity.service'
import { issueChallenge, verifySignedChallenge, requireAuth, issueWsTicket, issueRegistrationChallenge, revokeSession } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { createSharedRateLimit } from '../../common/middleware/redis-rate-limit'
import { config } from '../../config'
import { docsOnlySchema } from '../../common/openapi'

// Missão 08B Fase 9 — Redis-shared (cross-instance) counter, replacing
// the per-route `config: { rateLimit: {...} } }` local-store override
// these two routes used before (see redis-rate-limit.ts's header for
// why). The global `@fastify/rate-limit` registration in app.ts still
// applies underneath, untouched, as the broader per-instance ceiling.
const authRateLimit = createSharedRateLimit({
  max: config.rateLimit.authMax,
  windowMs: config.rateLimit.authWindowMs,
  keyPrefix: 'auth',
})

// Issue #302 — signature now required: proof of possession of the
// submitted public key before canonical registration. See
// identity.service.ts's register()/common/middleware/auth.ts's
// verifyRegistrationProof() for the full property this closes.
const registerSchema = z.object({
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex-encoded Ed25519 public key'),
  signature: z.string().min(1),
  displayName: z.string().optional(),
})

const participantIdParamsSchema = z.object({ id: z.string().min(1) })

const challengeSchema = z.object({
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex-encoded Ed25519 public key'),
})

// Issue #302 — same shape as challengeSchema; kept as its own named
// const (not reused directly) so the two request bodies stay free to
// diverge independently — they already belong to different security
// domains (see auth.ts's REGISTRATION_PROOF_DOMAIN).
const registerChallengeSchema = z.object({
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex-encoded Ed25519 public key'),
})

const authenticateSchema = z.object({
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex-encoded Ed25519 public key'),
  signature: z.string().min(1),
})

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  // Issue #302 — registration-challenge issuance. Deliberately
  // unauthenticated (the participant does not exist yet), and rate-
  // limited the same as /v1/identity/challenge below — this route is
  // now exactly the same class of endpoint (a free Ed25519 challenge
  // mint keyed by a caller-supplied public key), so it gets the same
  // existing credential-stuffing/brute-force protection, not a new one.
  app.post('/v1/identity/register-challenge', {
    preHandler: authRateLimit,
    ...docsOnlySchema({ tags: ['open-identity'], body: registerChallengeSchema }),
  }, async (request, reply) => {
    const body = registerChallengeSchema.parse(request.body)
    const result = await issueRegistrationChallenge(body.publicKey)
    return reply.code(200).send({ success: true, data: result })
  })

  // Issue #302 — now requires signature: proof of possession of
  // `publicKey`'s corresponding private key against a current
  // registration challenge (POST /v1/identity/register-challenge
  // above). Rate-limited the same as /v1/identity/authenticate below —
  // this route now performs a real Ed25519 verification + Redis
  // round-trip, the same cost/abuse profile.
  app.post('/v1/identity/participants', {
    preHandler: authRateLimit,
    ...docsOnlySchema({ tags: ['open-identity'], body: registerSchema }),
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const participant = await identityService.register(body)
    return reply.code(201).send({ success: true, data: participant })
  })

  // Missão 11 Fase 9.3.5 — INV-OP-10: response narrowed from the raw
  // User row to getPublicView()'s projection (id/publicKey/displayName/
  // peerId/verified only — no reputation stats, which have their own
  // canonical home at GET /v1/reputation/:participantId, and no
  // moduleId/protocolVersion/createdAt/updatedAt). This route stays
  // deliberately unauthenticated (a real protocol lookup — a
  // counterparty needs another participant's publicKey/peerId to
  // verify signatures/connect over P2P); /v1/identity/me below stays
  // full-row (authenticated, self-referential).
  app.get('/v1/identity/participants/:id', {
    ...docsOnlySchema({ tags: ['open-identity'], params: participantIdParamsSchema }),
  }, async (request, reply) => {
    const { id } = participantIdParamsSchema.parse(request.params)
    const view = await identityService.getPublicView(id)
    return reply.code(200).send({ success: true, data: view })
  })

  // Tighter, dedicated limit than the global default (app.ts) — these two
  // routes are exactly what a credential-stuffing/brute-force attempt
  // would hit (RED_TEAM_REVIEW.md RT-002), so they get their own ceiling
  // rather than sharing the general API's more permissive ones.
  app.post('/v1/identity/challenge', {
    preHandler: authRateLimit,
    ...docsOnlySchema({ tags: ['open-identity'], body: challengeSchema }),
  }, async (request, reply) => {
    const body = challengeSchema.parse(request.body)
    const result = await issueChallenge(body.publicKey)
    return reply.code(200).send({ success: true, data: result })
  })

  app.post('/v1/identity/authenticate', {
    preHandler: authRateLimit,
    ...docsOnlySchema({ tags: ['open-identity'], body: authenticateSchema }),
  }, async (request, reply) => {
    const body = authenticateSchema.parse(request.body)
    const result = await verifySignedChallenge(body.publicKey, body.signature)
    if (!result.verified) {
      return reply.code(401).send({ success: false, error: 'AUTH_ERROR', message: result.reason ?? 'Verification failed', details: [] })
    }
    return reply.code(200).send({
      success: true,
      data: { participantId: result.participantId, sessionToken: result.sessionToken },
    })
  })

  // Dev-only introspection of the caller's own session — nothing in
  // API_REFERENCE.md requires this, but every other route in this pass
  // needs at least one example of requireAuth actually gating a route
  // (TODO.md §3's "still open" half of this item) rather than the
  // middleware existing unused.
  app.get('/v1/identity/me', {
    preHandler: requireAuth,
    schema: { tags: ['open-identity'] },
  }, async (request, reply) => {
    const participant = await identityService.getParticipant((request as AuthenticatedRequest).participantId)
    return reply.code(200).send({ success: true, data: participant })
  })

  // Security review finding, 2026-08-15 (P1) — see auth.ts's issueWsTicket()
  // and ws-auth.ts's resolveParticipantFromTicket() for the full rationale.
  // Requires an already-valid session (the caller proved who they are via
  // the Bearer header requireAuth checks here); mints a short-lived,
  // single-use ticket the caller then passes as chat.routes.ts/
  // relay.routes.ts's `?ticket=` — never the raw session token itself.
  app.post('/v1/identity/ws-ticket', {
    preHandler: requireAuth,
    schema: { tags: ['open-identity'] },
  }, async (request, reply) => {
    const authenticated = request as AuthenticatedRequest
    const result = await issueWsTicket(authenticated.participantId, authenticated.sessionToken)
    return reply.code(200).send({ success: true, data: result })
  })

  app.post('/v1/identity/logout', {
    preHandler: requireAuth,
    schema: { tags: ['open-identity'] },
  }, async (request, reply) => {
    await revokeSession((request as AuthenticatedRequest).sessionToken)
    return reply.code(204).send()
  })
}
