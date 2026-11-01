/**
 * semantic-transition-record.ts — Sails Core Implementation Program,
 * Bridge Phase M3.5 (Durable Semantic Transition Record).
 *
 * Exists solely to satisfy docs/CORE_IMPLEMENTATION_ARCHITECTURE.md
 * §12: "No semantic decision becomes Core-authoritative before a
 * durable Transition Record exists for that decision class." See
 * docs/CORE_TRANSITION_RECORD.md for the full design rationale.
 *
 * NOT WIRED INTO ANY LIVE PATH when this module (M3.5) was built — no
 * production call site invoked `commitAuthoritativeEscrowTimelockExpiry`
 * at that time; the M3 shadow observer (`expiry-shadow.ts`) was the only
 * live Core-adjacent code running in `sweepExpiredEscrows()`. This
 * module was built to be proven correct in isolation
 * (tests/semanticTransitionRecord.test.ts) ahead of a future M4 retry,
 * per mission §37 ("Testability before authority"). **Corrigido
 * 2026-09-04 (Current Truth Reconciliation P0):** that M4 retry has
 * since landed — `escrow.service.ts`'s `sweepExpiredEscrows()` now calls
 * `commitAuthoritativeEscrowTimelockExpiry()` unconditionally
 * (`escrow.service.ts:990`) for every escrow whose type is
 * signature-collection-capable (`isSignatureCollectionType()` —
 * MULTISIG, LIGHTNING_HODL, SAFE_GUARD_EVM) undergoing the
 * FUNDS_LOCKED→EXPIRED transition. Core is authoritative for that one
 * transition, on those rails — a separate live path from the
 * MULTISIG-only dispute-ruling chain described in this module's sibling
 * files (`discretionary-authority.ts`, `dispatch-gate-adapter.ts`,
 * `destination-correspondence.ts`, `economic-outcome.ts`).
 *
 * Maps `@sails/core`'s `TransitionRecord` (packages/sails-core/src/transition.ts)
 * — a pure, database-agnostic type — onto this Reference Implementation's
 * Postgres/Prisma storage. Core itself never imports Prisma, never opens
 * a transaction, and never generates a database id; this file is the
 * Runtime persistence adapter, one layer below the (not-yet-built) M4
 * orchestration.
 */
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'
import { TransitionRecord } from '@sails/core'
import { escrowRepository } from './escrow-repository'
import { claimEscrowTransitionRecord } from './escrow-transition-claim'
import { EscrowError } from '../../common/errors'

type SemanticTransitionRecordRow = NonNullable<Awaited<ReturnType<typeof prisma.semanticTransitionRecord.findUnique>>>

/**
 * This slice's own CandidateTransition payload shape — Core's
 * `CandidateTransition.payload` is deliberately opaque/Runtime-defined
 * (transition.ts's own header), the correct place for this specific
 * transition's committed semantic inputs to travel, rather than a
 * bolted-on parameter elsewhere. `deadlineMs`/`evaluationTimeMs` are
 * plain numbers here (not the branded `EvaluationTime`) because this is
 * a Runtime-level shape, never imported back into Core.
 */
export interface EscrowTimelockExpiryPayload {
  readonly fromState: string
  readonly toState: string
  readonly deadlineMs: number
  readonly evaluationTimeMs: number
}

/**
 * Pure: maps a Core `TransitionRecord` to this Reference
 * Implementation's persisted row shape. Never invents a value Core
 * didn't actually supply — every column traces to a real field on the
 * frozen `TransitionRecord`/`SemanticHistoryPosition`/`RulesetRef` types.
 */
export function toSemanticTransitionRecordRow(
  record: TransitionRecord<EscrowTimelockExpiryPayload>,
): Prisma.SemanticTransitionRecordCreateInput {
  const priorPosition = record.priorPosition
  const isLegacyUnverified = priorPosition === 'LEGACY_UNVERIFIED'

  if (record.attribution) {
    throw new Error('semantic-transition-record.ts: this slice never carries discretionary attribution (K2 does not apply) — refusing to silently drop it')
  }
  if (record.outcome) {
    throw new Error('semantic-transition-record.ts: this slice never carries an economic Outcome (K3 does not apply) — refusing to silently drop it')
  }

  return {
    interactionId: record.interaction,
    transitionType: record.transition.type,
    fromState: record.transition.payload.fromState,
    toState: record.transition.payload.toState,
    priorPositionKind: isLegacyUnverified ? 'LEGACY_UNVERIFIED' : 'RESOLVED',
    priorPositionReference: isLegacyUnverified ? null : JSON.stringify(priorPosition.reference),
    rulesetName: record.rulesetRef.name,
    rulesetIdentity: record.rulesetRef.identity,
    rulesetVersion: record.rulesetRef.version,
    rulesetCommitment: String(record.rulesetRef.commitment),
    rulesetExpectedEvaluatorName: record.rulesetRef.expectedEvaluatorIdentity.name,
    rulesetExpectedEvaluatorVersion: record.rulesetRef.expectedEvaluatorIdentity.version,
    rulesetExpectedProfileName: record.rulesetRef.expectedProfileIdentity.name,
    rulesetExpectedProfileVersion: record.rulesetRef.expectedProfileIdentity.version,
    evaluatorIdentityName: record.evaluatorIdentity.name,
    evaluatorIdentityVersion: record.evaluatorIdentity.version,
    profileIdentityName: record.profileIdentity.name,
    profileIdentityVersion: record.profileIdentity.version,
    deadlineMs: BigInt(record.transition.payload.deadlineMs),
    evaluationTimeMs: BigInt(record.transition.payload.evaluationTimeMs),
    conditionResult: record.conditionResult,
  }
}

export interface SemanticTransitionRecordRepository {
  create(data: Prisma.SemanticTransitionRecordCreateInput, tx?: Prisma.TransactionClient): Promise<SemanticTransitionRecordRow>
  findByInteractionAndTransitionType(interactionId: string, transitionType: string): Promise<SemanticTransitionRecordRow | null>
}

class PrismaSemanticTransitionRecordRepository implements SemanticTransitionRecordRepository {
  async create(data: Prisma.SemanticTransitionRecordCreateInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.semanticTransitionRecord.create({ data })
  }

  async findByInteractionAndTransitionType(interactionId: string, transitionType: string) {
    // Sails Core Implementation Program M8-R — appealRound: -1 is this
    // slice's own sentinel ("not applicable to this transition type",
    // schema.prisma's own comment on the column) — every M4 record was
    // written with this default; this repository's callers (M4's expiry
    // slice only) never carry a real appeal round, so the compound key
    // is completed with the same sentinel, not a new parameter.
    return prisma.semanticTransitionRecord.findUnique({
      where: { interactionId_transitionType_appealRound: { interactionId, transitionType, appealRound: -1 } },
    })
  }
}

export const semanticTransitionRecordRepository: SemanticTransitionRecordRepository = new PrismaSemanticTransitionRecordRepository()

export type AuthoritativeCommitResult =
  | { readonly committed: true; readonly record: SemanticTransitionRecordRow; readonly transitionId: string }
  | { readonly committed: false; readonly reason: 'STATE_TRANSITION_LOST_RACE' }

/**
 * The atomic unit a future M4 retry must call: State transition claim
 * and durable Transition Record insert commit together, in one Postgres
 * transaction, or neither commits (mission §14/§15, proofs P1/P2).
 *
 * If `claimTransition` claims 0 rows (a concurrent caller already
 * transitioned this escrow, or it was never in `fromStatus` to begin
 * with), the Record is never created and the transaction is a safe,
 * effect-free no-op — a Record must never claim a transition that did
 * not actually happen. If the Record insert then fails for any reason
 * (e.g. the replay-resistance unique constraint on
 * (interactionId, transitionType)), Postgres rolls back the whole
 * transaction, undoing the State claim too — a transition must never
 * exist without its required Record.
 *
 * The escrow transition itself (its hash-chained EscrowEvent and the
 * 'transition.claimed' marker, claimEscrowTransitionRecord()) is claimed in
 * this same transaction: a durable EXPIRED always has the durable claim
 * from which settlement reconciliation PASS 3 re-publishes its canonical
 * event if the publish that follows this commit never happens (a crash, a
 * failed publish). Publishing stays a separate step after this atomic unit
 * succeeds (publishEscrowTransition(), escrow-lifecycle.ts), with the
 * returned transitionId as the event's identity.
 */
export async function commitAuthoritativeEscrowTimelockExpiry(
  escrowId: string,
  fromStatus: string,
  toStatus: string,
  record: TransitionRecord<EscrowTimelockExpiryPayload>,
  transition: { triggeredBy: string; eventName: string; note?: string },
): Promise<AuthoritativeCommitResult> {
  const row = toSemanticTransitionRecordRow(record)

  return prisma.$transaction(async (tx) => {
    // The escrow's advisory lock (withEscrowFundingLock()'s), taken before the state claim: it serializes
    // the EscrowEvent hash chain with every other transition claim of this escrow.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
    const claimedCount = await escrowRepository.claimTransition(escrowId, fromStatus, toStatus, tx)
    if (claimedCount === 0) {
      return { committed: false, reason: 'STATE_TRANSITION_LOST_RACE' } as const
    }
    const created = await semanticTransitionRecordRepository.create(row, tx)
    const transitionId = await claimEscrowTransitionRecord(tx, { escrowId, from: fromStatus, to: toStatus, ...transition })
    if (!transitionId) {
      // The escrow was still in fromStatus, so a transition to toStatus cannot already exist unless rows
      // were written by hand. Fail closed: roll the state claim and the Record back with it.
      throw new EscrowError(`Escrow ${escrowId} already has a ${toStatus} transition recorded while still ${fromStatus} - not committing a second one`)
    }
    return { committed: true, record: created, transitionId } as const
  })
}
