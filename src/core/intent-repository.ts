/**
 * IntentRepository — Sails Protocol Core Component
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3 ("Introduzir
 * repositórios: IntentRepository, CapabilityGrantRepository,
 * TradeRepository, EscrowRepository — dependência via injeção no
 * construtor"), step 2 of the incremental rollout (step 1 was
 * `CapabilityGrantRepository`), closed 2026-08-08. Wraps every
 * `prisma.intent.*`/`prisma.intentEvent.*` call previously inline in
 * `intent-engine.ts`/`coordination-engine.ts` — moved verbatim, no
 * behavior change, same discipline used for the escrow.service.ts
 * decomposition and step 1.
 *
 * Unlike `CapabilityGrantRepository` (which introduced a real
 * Prisma-row -> domain-shape mapping function, `toCapabilityGrant`),
 * `intent-engine.ts` never had one — it already treats the raw Prisma
 * `Intent` row as the domain `Intent` type via `as unknown as Intent`
 * casts throughout. This repository preserves that exact shape (no new
 * mapping invented) — its return types are derived directly from
 * Prisma's own inferred row type (`IntentRow` below), not the frozen
 * `common/types/intent.ts` `Intent` interface.
 *
 * `claimTransition()` is the one method worth reading carefully before
 * changing anything: it's the exact atomic-conditional-update race
 * protection intent-engine.ts's own `transition()` comment documents
 * (the 2026-07-20 robustness-audit fix, the same `updateMany` + `WHERE
 * status` idiom escrow.service.ts's `claimEscrowTransition()` uses) —
 * returning the raw affected-row count (0 = a concurrent caller won the
 * race) rather than a boolean keeps the caller's own error message
 * ("was already transitioned by a concurrent request") unchanged.
 */
import { prisma } from '../common/database'
import type { IntentType } from '../common/types/intent'

type IntentRow = NonNullable<Awaited<ReturnType<typeof prisma.intent.findUnique>>>
type IntentEventRow = NonNullable<Awaited<ReturnType<typeof prisma.intentEvent.findFirst>>>

export interface CreateIntentInput {
  type: IntentType
  participantId: string
  agentId?: string
  moduleId: string
  payload: object
  status: string
  metadata: object
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R4 — see `prisma/schema.prisma`'s
  // `Intent.idempotencyClaimId` doc comment. `undefined` for every
  // caller outside the idempotency-protected `createOffer()` path.
  idempotencyClaimId?: string
}

export interface CreateIntentEventInput {
  intentId: string
  fromStatus: string | null
  toStatus: string
  triggeredBy: string
  note?: string
  prevHash: string
  entryHash: string
}

export interface ApplyTransitionInput {
  intentId: string
  fromStatus: string
  toStatus: string
  triggeredBy: string
  note?: string
  /** The domain event this transition owes (published after the commit; recovered from this record if that never happens). */
  eventName: string
  eventPayload: object
}

export type OwedPublicationOutcome = 'PUBLISHED' | 'ALREADY_PUBLISHED' | 'SKIPPED'

export interface IntentRepository {
  create(input: CreateIntentInput): Promise<IntentRow>
  findById(intentId: string): Promise<IntentRow | null>
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R4 — see `prisma/schema.prisma`'s
  // `Intent.idempotencyClaimId` doc comment for the durability guarantee
  // this depends on (set atomically as part of the SAME `create()` call
  // above, never a separate write).
  findByIdempotencyClaimId(claimId: string): Promise<IntentRow | null>
  findLastEvent(intentId: string): Promise<IntentEventRow | null>
  createEvent(input: CreateIntentEventInput): Promise<void>
  /**
   * Issue #253 - the status CAS and its hash-chained IntentEvent (with the owed publication) in ONE database
   * transaction. Returns null when the CAS lost (a concurrent caller already transitioned this Intent): nothing
   * was written. `entryHashFor` receives the previous entryHash read INSIDE the transaction.
   */
  applyTransition(input: ApplyTransitionInput, entryHashFor: (prevHash: string) => string): Promise<{ intent: IntentRow; intentEventId: string } | null>
  /** Marks the publication owed by an IntentEvent as done (idempotent). */
  markEventPublished(intentEventId: string): Promise<void>
  /** IntentEvents whose owed publication is older than `olderThan` and still not marked published (oldest first). */
  findUnpublishedEvents(olderThan: Date, limit: number): Promise<IntentEventRow[]>
  /**
   * Publishes ONE owed event under a per-event advisory lock: re-reads it, skips it if already published, marks it
   * published without re-emitting when a durable event for this transition already exists (a publisher that died
   * between publish and mark), otherwise calls `publish`. Two workers can never mint two durable events for it.
   */
  publishOwedEvent(intentEventId: string, publish: (row: IntentEventRow) => Promise<void>): Promise<OwedPublicationOutcome>
}

class PrismaIntentRepository implements IntentRepository {
  async create(input: CreateIntentInput): Promise<IntentRow> {
    return prisma.intent.create({
      data: {
        type: input.type,
        participantId: input.participantId,
        agentId: input.agentId,
        moduleId: input.moduleId,
        payload: input.payload,
        status: input.status as any,
        metadata: input.metadata,
        idempotencyClaimId: input.idempotencyClaimId,
      },
    })
  }

  async findById(intentId: string): Promise<IntentRow | null> {
    return prisma.intent.findUnique({ where: { id: intentId } })
  }

  async findByIdempotencyClaimId(claimId: string): Promise<IntentRow | null> {
    return prisma.intent.findUnique({ where: { idempotencyClaimId: claimId } })
  }

  async findLastEvent(intentId: string): Promise<IntentEventRow | null> {
    return prisma.intentEvent.findFirst({
      where: { intentId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async applyTransition(input: ApplyTransitionInput, entryHashFor: (prevHash: string) => string) {
    return prisma.$transaction(async (tx) => {
      // The CAS takes the row lock until commit, so a concurrent transition of the same Intent blocks here and then
      // sees the new status (count 0); the hash-chain read below therefore always has exactly one predecessor.
      const claim = await tx.intent.updateMany({
        where: { id: input.intentId, status: input.fromStatus as any },
        data: { status: input.toStatus as any },
      })
      if (claim.count === 0) return null
      const intent = await tx.intent.findUniqueOrThrow({ where: { id: input.intentId } })
      const last = await tx.intentEvent.findFirst({ where: { intentId: input.intentId }, orderBy: { createdAt: 'desc' } })
      const prevHash = last?.entryHash ?? 'genesis'
      const event = await tx.intentEvent.create({
        data: {
          intentId: input.intentId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          triggeredBy: input.triggeredBy,
          note: input.note,
          prevHash,
          entryHash: entryHashFor(prevHash),
          eventName: input.eventName,
          eventPayload: input.eventPayload,
        },
      })
      return { intent, intentEventId: event.id }
    })
  }

  async markEventPublished(intentEventId: string): Promise<void> {
    await prisma.intentEvent.updateMany({ where: { id: intentEventId, publishedAt: null }, data: { publishedAt: new Date() } })
  }

  async findUnpublishedEvents(olderThan: Date, limit: number): Promise<IntentEventRow[]> {
    return prisma.intentEvent.findMany({
      where: { eventName: { not: null }, publishedAt: null, createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
  }

  async publishOwedEvent(intentEventId: string, publish: (row: IntentEventRow) => Promise<void>): Promise<OwedPublicationOutcome> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'intent-publish:' + intentEventId})::bigint)`
      const row = await tx.intentEvent.findUnique({ where: { id: intentEventId } })
      if (!row || row.eventName === null || row.publishedAt !== null) return 'SKIPPED' as const
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM durable_events
        WHERE "correlationId" = ${row.intentId} AND "eventName" = ${row.eventName} AND payload->>'transitionId' = ${row.id}
        LIMIT 1`
      if (existing.length === 0) await publish(row)
      await tx.intentEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } })
      return existing.length === 0 ? ('PUBLISHED' as const) : ('ALREADY_PUBLISHED' as const)
    }, { timeout: 30_000 })
  }

  async createEvent(input: CreateIntentEventInput): Promise<void> {
    await prisma.intentEvent.create({
      data: {
        intentId: input.intentId,
        fromStatus: input.fromStatus ?? undefined,
        toStatus: input.toStatus,
        triggeredBy: input.triggeredBy,
        note: input.note,
        prevHash: input.prevHash,
        entryHash: input.entryHash,
      },
    })
  }
}

export const intentRepository: IntentRepository = new PrismaIntentRepository()
