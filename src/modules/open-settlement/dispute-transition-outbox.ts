// src/modules/open-settlement/dispute-transition-outbox.ts
//
// #308 / D-308 — recoverable publication of the AUTO_PROPOSED -> EVIDENCE_SUBMITTED transition event.
//
// The compare-and-set that wins the transition and the `dispute_transition_outbox` row are written in ONE
// transaction (dispute.service.ts), so a crash after that commit cannot lose the event. This module publishes
// pending rows through the EXISTING eventBus -> PostgresEventStore (no second bus, hash chain untouched) and
// makes the delivery idempotent:
//
//   - one row is handled per transaction, locked FOR UPDATE SKIP LOCKED, so two processes never publish the
//     same row at once (the loser simply sees no row);
//   - before publishing, the durable log is checked for the row's causal key (payload.transitionKey): a crash
//     AFTER publish and BEFORE the row was marked published leaves the event in the log and the row pending,
//     and the next run only marks it published instead of publishing a second time.
//
// This is "published at least once, de-duplicated by causal key", not a claim about downstream projections
// (#253): publication != every consumer having applied its effect.

import { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { eventBus } from '../../common/events/event-bus'
import { childLogger } from '../../common/logger'

const log = childLogger('dispute-transition-outbox')

export type DisputeTransitionKind = 'CONTESTED' | 'EXPIRED'

export const transitionKeyFor = (disputeId: string, generation: number, kind: DisputeTransitionKind) => `${disputeId}:${generation}:${kind}`

type OutboxRow = { id: string; tradeId: string; payload: Prisma.JsonValue; transitionKey: string }

export interface PublishPendingResult { published: number; alreadyInLog: number; failed: number }

/**
 * Publishes pending transition events, oldest first. `onlyId` restricts it to one outbox row (the winner of a
 * claim publishing its own event right after the commit); without it every pending row is drained up to `limit`.
 * Never throws: a publication failure leaves the row pending for the next run.
 */
export async function publishPendingDisputeTransitions(opts: { onlyId?: string; limit?: number } = {}): Promise<PublishPendingResult> {
  const result: PublishPendingResult = { published: 0, alreadyInLog: 0, failed: 0 }
  const limit = opts.limit ?? 50
  for (let i = 0; i < limit; i++) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const filter = opts.onlyId ? Prisma.sql`AND "id" = ${opts.onlyId}` : Prisma.empty
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT "id", "tradeId", "payload", ("disputeId" || ':' || "generation" || ':' || "kind") AS "transitionKey"
          FROM "dispute_transition_outbox"
          WHERE "publishedAt" IS NULL ${filter}
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`
        const row = rows[0]
        if (!row) return 'NONE' as const

        const present = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS "n" FROM "durable_events"
          WHERE "correlationId" = ${row.tradeId}
            AND "eventName" = 'dispute.auto_resolution_contested'
            AND ("payload"::jsonb ->> 'transitionKey') = ${row.transitionKey}`
        const inLog = Number(present[0]?.n ?? 0) > 0
        if (!inLog) {
          // eventBus.emit() commits the durable record in its own transaction; if this process dies right after
          // it, the row stays pending and the check above finds the record on the next run.
          await eventBus.emit('dispute.auto_resolution_contested', row.payload as never, row.tradeId)
        }
        await tx.disputeTransitionOutbox.update({ where: { id: row.id }, data: { publishedAt: new Date() } })
        return inLog ? ('ALREADY_IN_LOG' as const) : ('PUBLISHED' as const)
      }, { timeout: 30_000 })

      if (outcome === 'NONE') break
      if (outcome === 'ALREADY_IN_LOG') result.alreadyInLog += 1
      else result.published += 1
      if (opts.onlyId) break
    } catch (err) {
      result.failed += 1
      log.error({ msg: 'DISPUTE_TRANSITION_PUBLISH_FAILED — the outbox row stays pending and will be retried', err: err instanceof Error ? err.message : String(err) })
      break
    }
  }
  return result
}
