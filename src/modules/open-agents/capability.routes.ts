/**
 * Sails OpenAgents — Capability routes
 * rfcs/RFC-013-capability-registry-and-wallet-adapter.md
 *
 * First real routes for this module. Capability declaration/grant maps
 * onto `agent-delegation` in RFC-005's module<->Capability table
 * (`core/capability-registry.ts`'s `CAPABILITY_IMPLEMENTATIONS`), the
 * closest existing owner — a wallet or agent declaring "I can do X"
 * before being trusted to act is the same shape as an Agent being
 * delegated a capability.
 *
 * Self-issued grants only for this pass (`issuedBy = grantedTo` — the
 * caller grants themselves scope over their own declared capabilities).
 * A real multi-party issuance flow (a module operator granting scope to
 * an agent it doesn't control) is real, separate follow-up work
 * (RFC-013's Reference Implementation Plan §5), not claimed done here.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { capabilityRegistry } from '../../core/capability-registry'
import { requireAuth } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { createSharedRateLimit } from '../../common/middleware/redis-rate-limit'
import { config } from '../../config'
import { docsOnlySchema } from '../../common/openapi'

// Missão 08B Fase 9 — Redis-shared counter (see redis-rate-limit.ts);
// same critical tier as settlement.routes.ts's dispute/resolve/appeal.
const criticalRateLimit = createSharedRateLimit({
  max: config.rateLimit.criticalMax,
  windowMs: config.rateLimit.criticalWindowMs,
  keyPrefix: 'critical',
})

const registerSchema = z.object({
  capabilityName: z.string().min(1).max(100),
  scope: z.array(z.string().min(1).max(100)).min(1).max(3),
  constraints: z.record(z.string(), z.unknown()).optional(), // Zod v4 requires an explicit key schema
})

const participantIdParamsSchema = z.object({ participantId: z.string().min(1) })

const grantIdParamsSchema = z.object({ grantId: z.string().min(1) })

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/capabilities/register', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-agents'], body: registerSchema }),
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId

    const grant = await capabilityRegistry.grant({
      grantedTo: participantId,
      capabilityName: body.capabilityName,
      scope: body.scope,
      constraints: body.constraints,
      issuedBy: participantId,
    })

    return reply.code(201).send({ success: true, data: grant })
  })

  app.get('/v1/capabilities/:participantId', {
    ...docsOnlySchema({ tags: ['open-agents'], params: participantIdParamsSchema }),
  }, async (request, reply) => {
    const { participantId } = participantIdParamsSchema.parse(request.params)
    const grants = await capabilityRegistry.listGrants(participantId)
    return reply.code(200).send({ success: true, data: grants })
  })

  // CTO_DUE_DILIGENCE_REPORT.md A-SEC-05, closed 2026-08-08 — revoking a
  // capability grant is a real authority change, not a read; the global
  // rate limit alone left this route as exposed as any GET.
  app.post('/v1/capabilities/:grantId/revoke', {
    preHandler: [criticalRateLimit, requireAuth],
    ...docsOnlySchema({ tags: ['open-agents'], params: grantIdParamsSchema }),
  }, async (request, reply) => {
    const { grantId } = grantIdParamsSchema.parse(request.params)
    const participantId = (request as AuthenticatedRequest).participantId
    await capabilityRegistry.revoke(grantId, participantId)
    return reply.code(200).send({ success: true })
  })
}
