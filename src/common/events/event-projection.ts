/**
 * Issue #298 - durable delivery/replay identity for event-derived projections.
 *
 * `applyEventProjectionOnce(eventId, projectionKey, subjectId, apply)` applies
 * ONE projection effect for ONE subject because of ONE durable event, at most
 * once, no matter how many times or from how many processes that event is
 * delivered:
 *
 *   - the claim row (event_projection_claims, UNIQUE(eventId, projectionKey,
 *     subjectId)) and the mutation `apply` performs commit in the SAME
 *     PostgreSQL transaction. A crash before commit leaves neither, so a
 *     redelivery simply applies it; after commit a redelivery collides on the
 *     unique identity and becomes a no-op;
 *   - `INSERT ... ON CONFLICT DO NOTHING`: a concurrent second delivery blocks
 *     on the first one's uncommitted row and then observes it (returns false),
 *     so N concurrent deliveries produce exactly one effect;
 *   - nothing here is process-local and nothing depends on Redis.
 *
 * The identity is normally NOT the durable eventId: see effectIdentity().
 *
 * This is DELIVERY idempotency (same event delivered N times). It is not the
 * economic operation's replay identity (pendingOperationId / digest) and it is
 * not provider evidence (txReleaseId) - three different identities.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../database'

export type ProjectionTx = Prisma.TransactionClient

/** Returns true if THIS call applied the projection, false if it had already been applied. */
export async function applyEventProjectionOnce(
  eventId: string,
  projectionKey: string,
  subjectId: string,
  apply: (tx: ProjectionTx) => Promise<void>,
  client: Pick<PrismaClient, '$transaction'> = prisma
): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const claimed = await tx.eventProjectionClaim.createMany({
      data: [{ eventId, projectionKey, subjectId }],
      skipDuplicates: true,
    })
    if (claimed.count === 0) return false
    await apply(tx)
    return true
  })
}

/**
 * Issue #253 (CTO decision 2026-10-31) - the identity an economic effect is claimed under: the SOURCE TRANSITION
 * (EscrowEvent id), not the durable eventId. PASS 3 can republish while a live publish is still in flight, so one
 * transition can have two durable events with two eventIds; keyed on eventId each would apply every effect again.
 * Both durable events stay in the stream for traceability. Falls back to eventId for an event with no transition.
 */
export function effectIdentity(event: { eventId: string; payload: { transitionId?: string } }): string {
  return event.payload.transitionId ?? event.eventId
}

// Markers for "a projection is owed for this escrow transition" and "all of its projections
// completed". Keyed on the escrow transition (EscrowEvent) id - see emitEscrowTransition().
export const TRANSITION_CLAIMED_KEY = 'transition.claimed'
export const TRANSITION_PROJECTED_KEY = 'transition.projected'
