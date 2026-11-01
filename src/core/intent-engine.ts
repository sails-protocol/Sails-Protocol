/**
 * Intent Engine — Sails Protocol Core Component
 * PROTOCOL_SPECIFICATION.md section 2 (full spec)
 *
 * First real implementation (03-implementation_plan.md MVP happy path,
 * approved by CISO + CTO). Routes Intents by type via registered
 * IntentHandlers (section 2.7 — the plugin pattern). Never imports a
 * module directly; modules register themselves at boot.
 *
 * Governance note (03-implementation_plan.md's own disclaimer): this file
 * implements against src/core/ under the MVP sandbox exemption — real,
 * working logic, but not itself a claim that any shape here is frozen
 * protocol specification until it goes through Protocol Freeze + RFC.
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3, step 2, closed
 * 2026-08-08 — all `prisma.intent.*`/`prisma.intentEvent.*` access moved
 * to `intent-repository.ts`; this file no longer imports `prisma` at
 * all. `createIntentEngine()` is a factory function, not a class —
 * `intentEngine` was always a plain object literal implementing the
 * `IntentEngine` interface (same shape `capability-registry.ts` had
 * before its own step-1 refactor), so the factory takes the repository
 * as an optional parameter (defaulting to the real singleton) instead of
 * a constructor, giving tests the same seam
 * (`createIntentEngine(fakeRepo)` instead of `jest.mock('../common/database', ...)`)
 * with the real `intentEngine` export's own call sites unchanged.
 */
import { createHash, randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { config } from '../config'
import { ValidationError, NotFoundError, ForbiddenError, IntentBoundError } from '../common/errors'
import { prisma } from '../common/database'
import { eventBus } from '../common/events/event-bus'
import type { SailsEventName, SailsEventMap } from '../common/events/event-bus'
import { assertValidTransition, isExpired, type IntentStatus } from './state-machine'
import { validateFinancialSanity } from './policy-engine'
import { coordinationEngine } from './coordination-engine'
import { capabilityRegistry, CAPABILITY_IMPLEMENTATIONS } from './capability-registry'
import { intentRepository, type IntentRepository } from './intent-repository'
import type {
  Intent, IntentType, IntentHandler, IntentPayload, TradeIntentPayload,
} from '../common/types/intent'

export interface IntentEngine {
  registerHandler<T extends IntentPayload>(handler: IntentHandler<T>): void
  // agentId is optional and was already part of Intent's frozen shape
  // (common/types/intent.ts, Protocol Freeze v8.8) but never threaded
  // through create() until modules/open-agents/wallet-agent.ts's
  // BuyerAgent/SellerAgent needed to record which agent produced an
  // Intent on a participant's behalf — filling in an already-specified
  // field, not introducing new protocol surface.
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R4 — idempotencyClaimId is optional
  // and additive, same posture as agentId above: filling in an
  // idempotency-reconciliation identity for the one caller
  // (liquidity.service.ts's persistOffer()) that needs this Intent to be
  // deterministically re-discoverable after a later write in the SAME
  // persist() attempt fails, without decomposing this function's own
  // internal CREATED->VALIDATED->COORDINATED pipeline. See
  // `prisma/schema.prisma`'s `Intent.idempotencyClaimId` doc comment.
  create<T extends IntentPayload>(type: IntentType, payload: T, participantId: string, agentId?: string, idempotencyClaimId?: string): Promise<Intent<T>>
  // cancelledBy added during a gap audit: this previously took only
  // intentId, with no check that the caller cancelling an Intent was the
  // participant who created it — any caller (via the equally-unauthenticated
  // DELETE /v1/intents/:id, see intentRoutes.ts's own fix) could
  // cancel anyone's Intent. Required, not optional, so no call site can
  // silently skip the check by omitting it.
  cancel(intentId: string, cancelledBy: string): Promise<void>
  // Advances an Intent's status, writing the hash-chained audit trail and
  // emitting the caller-supplied typed event — the generic mechanism
  // create()/cancel() below both use, and what modules reacting to an
  // Intent (e.g. modules/open-settlement/lightspark.service.ts) call to
  // move it forward (e.g. → SETTLING) without duplicating this logic.
  transition<K extends SailsEventName>(
    intentId: string,
    toStatus: IntentStatus,
    triggeredBy: string,
    eventName: K,
    eventPayload: SailsEventMap[K],
    note?: string
  ): Promise<Intent>
  // #235 R7G-B1 - transition()'s durable half inside a caller's transaction,
  // so the Intent changes only if the caller's own write commits: validation
  // (an expired Intent is refused, never marked here), the CAS claim and the
  // audit-trail entry go through `tx`. Returns the event publication, to run
  // only after that transaction has committed.
  transitionInTransaction<K extends SailsEventName>(
    tx: Prisma.TransactionClient,
    intentId: string,
    toStatus: IntentStatus,
    triggeredBy: string,
    eventName: K,
    eventPayload: SailsEventMap[K],
  ): Promise<() => Promise<void>>
  /**
   * #235 R7H-NF-E3C-5 (B2) — creates a system-derived, already-NEGOTIATING Intent inside the CALLER's transaction: the
   * Intent a newly admitted trade owns. It records the full approved walk CREATED → VALIDATED → COORDINATED →
   * DISCOVERING → MATCHED → NEGOTIATING as hash-chained IntentEvents and as durable `intent.*` events, all committed
   * (or rolled back) with the caller's other writes. No capability check (an internal action, never a user request),
   * no `expiresAt` (a trade's time authority is its escrow timelock / F8 expiry, not Intent expiry), and no financial
   * sanity re-check (the trade's value is already bound by its offer's validated limits). `dispatch()` is for AFTER
   * commit and never throws.
   */
  createInTransaction(tx: Prisma.TransactionClient, input: CreateIntentInTransactionInput): Promise<{ id: string; dispatch: () => void }>
}

export interface CreateIntentInTransactionInput {
  /** Pre-generated so the caller can reference the Intent from rows it writes in the same transaction. */
  id?: string
  type: IntentType
  payload: IntentPayload
  participantId: string
  parentIntentId?: string | null
  /** Recorded as `triggeredBy` of every IntentEvent of the walk. */
  triggeredBy: string
  note?: string
  metadata?: Record<string, unknown>
  /** `intent.matched`'s candidate ids and `intent.negotiating`'s negotiation id. */
  matchedCandidateIds: string[]
  negotiationId: string
}

const handlers = new Map<IntentType, IntentHandler>()

// ─── CISO Byzantine Rule: reject and drop malformed intents at the entry
// boundary — never persisted, never handed to a handler. RFC-018 Phase 3:
// this no longer knows what a TradeIntent's fields are — that check now
// lives in the registered module handler (modules/open-p2p/intent-handler.ts),
// consistent with §2.7's "the Core never imports a module" principle. An
// IntentType with no registered handler is malformed by construction —
// there is nothing that could have validated it. ─────────────────────────
function validateStructure(type: IntentType, payload: IntentPayload): { valid: boolean; errors?: string[] } {
  const handler = handlers.get(type)
  if (!handler) {
    // PaymentIntent/SwapIntent/LoanIntent/EarnIntent/AgentIntent are 📋
    // future per PROTOCOL_SPECIFICATION.md §2.3 — no handler can exist for
    // them yet, so any attempt to create one is malformed by definition,
    // not a gap in this validator.
    return { valid: false, errors: [`Unsupported intent type: ${type} (no handler registered yet)`] }
  }
  return handler.validate(payload)
}

export function createIntentEngine(repo: IntentRepository = intentRepository): IntentEngine {
  // Hash-chains IntentEvent the same way this pattern will eventually
  // apply to EscrowEvent/ReputationEvent too (RFC-008 D2, still 🔲 in
  // BACKLOG.md) — implemented here first since Intent persistence was
  // being built from scratch when this was written, not retrofitted onto
  // rows that already existed.
  async function writeIntentEvent(
    intentId: string,
    fromStatus: string | null,
    toStatus: string,
    triggeredBy: string,
    note?: string
  ): Promise<void> {
    const last = await repo.findLastEvent(intentId)
    const prevHash = last?.entryHash ?? 'genesis'
    const entryHash = createHash('sha256')
      .update(`${fromStatus ?? ''}|${toStatus}|${triggeredBy}|${prevHash}`)
      .digest('hex')

    await repo.createEvent({ intentId, fromStatus, toStatus, triggeredBy, note, prevHash, entryHash })
  }

  async function transition<K extends SailsEventName>(
    intentId: string,
    toStatus: IntentStatus,
    triggeredBy: string,
    eventName: K,
    eventPayload: SailsEventMap[K],
    note?: string
  ): Promise<Intent> {
    const record = await repo.findById(intentId)
    if (!record) throw new NotFoundError('Intent', intentId)

    const currentStatus = record.status as IntentStatus

    // CISO Byzantine Rule, applied to lifecycle too: an Intent whose window
    // has closed is EXPIRED regardless of what transition was requested —
    // this is the hard-timeout enforcement (state-machine.ts's isExpired()).
    if (isExpired({ status: currentStatus, expiresAt: record.expiresAt }) && toStatus !== 'EXPIRED') {
      await transition(intentId, 'EXPIRED', 'system:expiry-check', 'intent.expired', {
        intentId,
        reason: 'expiresAt window closed before this transition was requested',
      })
      throw new ValidationError(`Intent ${intentId} expired before transitioning to ${toStatus}`)
    }

    assertValidTransition(currentStatus, toStatus)

    // ─── Robustness-audit fix (2026-07-20): the same TOCTOU race
    // escrow.service.ts's transitions had, applied to the RFC-018 state
    // machine itself. The old code checked `assertValidTransition` against
    // `currentStatus` (read moments earlier) and then unconditionally
    // wrote `toStatus` — two concurrent transition() calls for the same
    // Intent (e.g. an event handler reacting to two near-simultaneous real
    // events) could both pass the in-memory check before either write
    // landed. Worse than a lost update: writeIntentEvent() below computes
    // `prevHash` from "the last IntentEvent row for this intentId" — two
    // racing writers could both read the same prior event as "last" and
    // both chain off it, corrupting RFC-008's hash chain (which promises
    // exactly one true predecessor per event) rather than just overwriting
    // a field. The atomic `claimTransition()` makes this impossible: only
    // the request whose expected `currentStatus` still matches the row's
    // real current status affects a row, so only one concurrent caller
    // ever proceeds to writeIntentEvent()/emit(). ────────────────────────
    const claimedCount = await repo.claimTransition(intentId, currentStatus, toStatus)
    if (claimedCount === 0) {
      throw new ValidationError(`Intent ${intentId} was already transitioned by a concurrent request (expected status ${currentStatus})`)
    }
    const updated = await repo.findById(intentId)
    await writeIntentEvent(intentId, currentStatus, toStatus, triggeredBy, note)
    await eventBus.emit(eventName, eventPayload, intentId) // correlationId = intentId (RFC-010)

    return updated as unknown as Intent
  }

  async function transitionInTransaction<K extends SailsEventName>(
    tx: Prisma.TransactionClient,
    intentId: string,
    toStatus: IntentStatus,
    triggeredBy: string,
    eventName: K,
    eventPayload: SailsEventMap[K],
  ): Promise<() => Promise<void>> {
    const record = await tx.intent.findUnique({ where: { id: intentId } })
    if (!record) throw new NotFoundError('Intent', intentId)
    const currentStatus = record.status as IntentStatus
    if (isExpired({ status: currentStatus, expiresAt: record.expiresAt }) && toStatus !== 'EXPIRED') {
      throw new ValidationError(`Intent ${intentId} expired before transitioning to ${toStatus}`)
    }
    assertValidTransition(currentStatus, toStatus)
    const claimed = await tx.intent.updateMany({ where: { id: intentId, status: currentStatus }, data: { status: toStatus } })
    if (claimed.count === 0) {
      throw new ValidationError(`Intent ${intentId} was already transitioned by a concurrent request (expected status ${currentStatus})`)
    }
    const last = await tx.intentEvent.findFirst({ where: { intentId }, orderBy: { createdAt: 'desc' } })
    const prevHash = last?.entryHash ?? 'genesis'
    const entryHash = createHash('sha256').update(`${currentStatus}|${toStatus}|${triggeredBy}|${prevHash}`).digest('hex')
    await tx.intentEvent.create({ data: { intentId, fromStatus: currentStatus, toStatus, triggeredBy, prevHash, entryHash } })
    return async () => { await eventBus.emit(eventName, eventPayload, intentId) }
  }

  return {
    transitionInTransaction,
    registerHandler(handler) {
      for (const type of handler.intentTypes) {
        handlers.set(type, handler as IntentHandler)
      }
    },

    async create<T extends IntentPayload>(type: IntentType, payload: T, participantId: string, agentId?: string, idempotencyClaimId?: string) {
      const structural = validateStructure(type, payload)
      if (!structural.valid) {
        throw new ValidationError('Malformed Intent rejected at entry boundary', structural.errors)
      }

      const sanity = validateFinancialSanity(payload as unknown as TradeIntentPayload)
      if (!sanity.valid) {
        throw new ValidationError('Intent failed financial sanity check', sanity.errors)
      }

      const moduleId = 'openp2p' // TradeIntent's owning module — generalize once other IntentTypes are real

      // RFC-014: capability-registry.ts (real since RFC-013) had no real
      // caller anywhere in this codebase until this check. Off by default
      // (config.features.enforceCapabilities) — see that flag's own doc
      // comment in config/index.ts for why. CAPABILITY_IMPLEMENTATIONS maps
      // moduleId -> the RFC-005 Capability name this module implements
      // ('openp2p' -> 'trade-coordination'); the required scope is the real
      // event name this action produces (event-bus.ts's 'intent.created'),
      // matching RFC-013's own example grant shape rather than inventing a
      // parallel scope vocabulary.
      if (config.features.enforceCapabilities) {
        const capabilityName = CAPABILITY_IMPLEMENTATIONS[moduleId]
        const allowed = await capabilityRegistry.check(participantId, capabilityName, 'intent.created')
        if (!allowed) {
          throw new ForbiddenError(
            `${participantId} has no active '${capabilityName}' capability grant covering 'intent.created'`
          )
        }
      }

      const record = await repo.create({
        type,
        participantId,
        agentId,
        moduleId,
        payload: payload as object,
        status: 'CREATED' satisfies IntentStatus,
        metadata: {},
        idempotencyClaimId,
      })

      await writeIntentEvent(record.id, null, 'CREATED', participantId)
      await eventBus.emit('intent.created', {
        intentId: record.id,
        type,
        participantId,
        moduleId: record.moduleId,
        agentId,
      }, record.id) // correlationId = intentId (RFC-010)

      // RFC-012 (rfcs/RFC-012-intent-validation-and-coordination.md):
      // CREATED -> VALIDATED -> COORDINATED, formal transitions recorded
      // through the same hash-chained transition() mechanism cancel() uses
      // below — not a bare status overwrite. Deterministic today: the CISO
      // Byzantine/Economic checks above already gated persistence, so a
      // persisted CREATED row has, by construction, already passed them —
      // VALIDATED formalizes that as an observable, audited state instead
      // of an implicit pre-persistence gate. This is also the receive path
      // for an agent-generated Intent (modules/open-agents/buyer-agent.ts's
      // QVAC-produced TradeIntentPayload) — agentId, threaded through
      // above, needs no special-cased handling here: it's just data that
      // flows through the same validate/coordinate pipeline every Intent does.
      const validated = await transition(
        record.id, 'VALIDATED', participantId, 'intent.validated',
        { intentId: record.id, participantId }
      )

      const decision = await coordinationEngine.decide(record.id)
      const handler = handlers.get(type)
      if (handler) await handler.onCreated(validated as unknown as Intent)

      const coordinated = await transition(
        record.id, 'COORDINATED', participantId, 'intent.coordinated',
        { intentId: record.id, targetModule: decision.targetModule }
      )

      return coordinated as unknown as Intent<T>
    },

    async createInTransaction(tx, input) {
      const structural = validateStructure(input.type, input.payload)
      if (!structural.valid) {
        throw new ValidationError('Malformed Intent rejected at entry boundary', structural.errors)
      }
      const id = input.id ?? randomUUID()
      const moduleId = 'openp2p' // the only IntentType with a handler today; generalize with the IntentType registry
      const walk: IntentStatus[] = ['CREATED', 'VALIDATED', 'COORDINATED', 'DISCOVERING', 'MATCHED', 'NEGOTIATING']
      for (let i = 1; i < walk.length; i++) assertValidTransition(walk[i - 1], walk[i])

      await tx.intent.create({
        data: {
          id,
          type: input.type,
          participantId: input.participantId,
          moduleId,
          parentIntentId: input.parentIntentId ?? null,
          payload: input.payload as object,
          status: 'NEGOTIATING' satisfies IntentStatus,
          expiresAt: null,
          metadata: (input.metadata ?? {}) as object,
        },
      })

      // Hash-chained exactly like writeIntentEvent()/transitionInTransaction(): sha256(from|to|triggeredBy|prevHash),
      // 'genesis' first. createdAt is set explicitly and strictly increasing: rows of one transaction would otherwise
      // share a timestamp, and later transitions pick "the last event" by createdAt to extend the chain.
      const base = Date.now()
      let prevHash = 'genesis'
      let from: IntentStatus | null = null
      for (let i = 0; i < walk.length; i++) {
        const to = walk[i]
        const entryHash = createHash('sha256').update(`${from ?? ''}|${to}|${input.triggeredBy}|${prevHash}`).digest('hex')
        await tx.intentEvent.create({
          data: {
            intentId: id, fromStatus: from, toStatus: to, triggeredBy: input.triggeredBy,
            note: i === 0 ? input.note : undefined, prevHash, entryHash, createdAt: new Date(base + i),
          },
        })
        prevHash = entryHash
        from = to
      }

      const dispatch = await eventBus.publishInTransaction(tx, [
        { eventName: 'intent.created', correlationId: id, payload: { intentId: id, type: input.type, participantId: input.participantId, moduleId, ...(input.parentIntentId ? { parentIntentId: input.parentIntentId } : {}) } },
        { eventName: 'intent.validated', correlationId: id, payload: { intentId: id, participantId: input.participantId } },
        { eventName: 'intent.coordinated', correlationId: id, payload: { intentId: id, targetModule: moduleId } },
        { eventName: 'intent.discovering', correlationId: id, payload: { intentId: id } },
        { eventName: 'intent.matched', correlationId: id, payload: { intentId: id, candidateIds: input.matchedCandidateIds } },
        { eventName: 'intent.negotiating', correlationId: id, payload: { intentId: id, negotiationId: input.negotiationId } },
      ])
      return { id, dispatch }
    },

    async cancel(intentId, cancelledBy) {
      const record = await repo.findById(intentId)
      if (!record) throw new NotFoundError('Intent', intentId)

      // Gap-audit fix: only the participant who created this Intent may
      // cancel it — checked before anything else (including the expiry
      // branch below), so a non-owner gets a clean 403 regardless of the
      // Intent's current state, rather than silently triggering a
      // system-driven expiry transition on someone else's Intent.
      if (record.participantId !== cancelledBy) {
        throw new ForbiddenError(`${cancelledBy} does not own Intent ${intentId}`)
      }

      // #235 R7H-NF-E3C-5 (F-1) — an Intent that an Offer or a Trade references (Offer.intentId, Trade.intentId,
      // Trade.tradeIntentId) is part of that economic object's lifecycle and is never cancelled here: doing so
      // bypassed the trade-cancellation guards (a maker could cancel the Intent shared by live trades, after which
      // their buyers could not cancel). The reference check and the transition are ONE transaction holding the
      // Intent row's FOR UPDATE lock, which conflicts with the FOR KEY SHARE any referencing INSERT takes through
      // its foreign key — a reference cannot appear between the check and the cancellation. Checked after the
      // ownership test above, so only the owner ever learns an Intent is bound (no existence signal to others).
      const expired = isExpired({ status: record.status as IntentStatus, expiresAt: record.expiresAt })
      const publish = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM intents WHERE id = ${intentId} FOR UPDATE`
        const [ref] = await tx.$queryRaw<Array<{ bound: boolean }>>`
          SELECT (
            EXISTS (SELECT 1 FROM offers WHERE "intentId" = ${intentId})
            OR EXISTS (SELECT 1 FROM trades WHERE "intentId" = ${intentId})
            OR EXISTS (SELECT 1 FROM trades WHERE "tradeIntentId" = ${intentId})
          ) AS bound`
        if (ref?.bound) throw new IntentBoundError(intentId)
        return expired
          ? transitionInTransaction(tx, intentId, 'EXPIRED', 'system:expiry-check', 'intent.expired', {
              intentId,
              reason: 'expiresAt window closed before cancellation was processed',
            })
          : transitionInTransaction(tx, intentId, 'CANCELLED', cancelledBy, 'intent.cancelled', { intentId, cancelledBy })
      })
      await publish()
    },

    transition,
  }
}

export const intentEngine: IntentEngine = createIntentEngine()
