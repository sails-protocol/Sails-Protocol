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

// Markers for "a projection is owed for this escrow transition" and "all of its projections
// completed". Keyed on the escrow transition (EscrowEvent) id - see emitEscrowTransition().
export const TRANSITION_CLAIMED_KEY = 'transition.claimed'
export const TRANSITION_PROJECTED_KEY = 'transition.projected'

// ─── PASS 3 queue (settlement reconciler): claimed transitions whose projections are incomplete ─────
//
// Queue = 'transition.claimed' rows with transitionProjectedAt null. A row leaves it when its
// 'transition.projected' marker is written (recordTransitionProjected(), same transaction). Queue
// position is durable (projectionRecoveryAttemptedAt), so the order survives restarts and is shared by
// every node. Neither column is authority for anything: re-driving a transition stays serialized by
// its publish lock and idempotent through the projection claims above.

export interface ClaimedTransition {
  id: string
  /** The escrow transition (EscrowEvent) id. */
  eventId: string
  /** The escrow id. */
  subjectId: string
}

/** Takes the transition out of the PASS 3 queue. Call in the transaction that writes its 'transition.projected' marker. */
export async function recordTransitionProjected(tx: ProjectionTx, transitionId: string): Promise<void> {
  await tx.eventProjectionClaim.updateMany({
    where: { eventId: transitionId, projectionKey: TRANSITION_CLAIMED_KEY, transitionProjectedAt: null },
    data: { transitionProjectedAt: new Date() },
  })
}

/**
 * Claims the next `limit` queued transitions claimed before `claimedBefore` (the grace period that
 * keeps a live, in-flight handler from being raced) and stamps them in the same statement.
 *
 * Order: by a row's last visit, or by its claim time if it was never visited, oldest first. Every
 * claimed row moves behind every row whose key is older, and keys only grow, so each queued
 * transition is reached within ceil(older rows / limit) runs: a transition that can never be
 * projected cannot hold a slot, a backlog cannot starve new work, and new work cannot starve a
 * backlog. SKIP LOCKED gives overlapping claims disjoint batches. A crash after the claim only moves
 * the row back one lap; nothing is owned, so nothing needs releasing. The literal key matches the
 * partial index predicate (migration 20260930120000), so the claim never walks projected history.
 */
export async function claimTransitionRecoveryBatch(limit: number, claimedBefore: Date): Promise<ClaimedTransition[]> {
  const stampedAt = new Date()
  return prisma.$queryRaw<ClaimedTransition[]>`
    WITH picked AS (
      SELECT c.id FROM event_projection_claims c
      WHERE c."projectionKey" = 'transition.claimed' AND c."transitionProjectedAt" IS NULL
        AND c."appliedAt" < ${claimedBefore}
      ORDER BY COALESCE(c."projectionRecoveryAttemptedAt", c."appliedAt"), c.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE event_projection_claims c SET "projectionRecoveryAttemptedAt" = ${stampedAt}
    FROM picked WHERE c.id = picked.id
    RETURNING c.id, c."eventId", c."subjectId"`
}

/**
 * Of the given claimed rows, takes out of the queue those whose 'transition.projected' marker
 * already exists (written before this column existed, or by a node running older code) and
 * returns their transition ids. One statement, so it never removes a transition still owed work.
 */
export async function markProjectedTransitions(claimIds: string[]): Promise<Set<string>> {
  if (claimIds.length === 0) return new Set()
  const rows = await prisma.$queryRaw<Array<{ eventId: string }>>`
    UPDATE event_projection_claims c SET "transitionProjectedAt" = p."projectedAt"
    FROM (
      SELECT "subjectId", MIN("appliedAt") AS "projectedAt" FROM event_projection_claims
      WHERE "projectionKey" = 'transition.projected'
        AND "subjectId" IN (SELECT "eventId" FROM event_projection_claims WHERE id = ANY(${claimIds}))
      GROUP BY "subjectId"
    ) p
    WHERE c.id = ANY(${claimIds}) AND c."eventId" = p."subjectId" AND c."transitionProjectedAt" IS NULL
    RETURNING c."eventId"`
  return new Set(rows.map((r) => r.eventId))
}
