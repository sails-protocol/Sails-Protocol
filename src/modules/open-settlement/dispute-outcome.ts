/**
 * dispute-outcome.ts — Sails Core Implementation Program M8-R (Live
 * Dispatch Retry). The Runtime orchestration that makes Mission13's
 * MULTISIG disputed-settlement path Core-authoritative: composes M5
 * Attribution + M7 Outcome + M8.5 Destination Snapshot into one durable,
 * atomically-committed `SemanticTransitionRecord` — BEFORE `dispute.service.ts`'s
 * `applyRuling()` is allowed to call any settlement action.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `semantic-transition-record.ts`
 * (M3.5/M4): that file's `commitAuthoritativeEscrowTimelockExpiry()` and
 * `EscrowTimelockExpiryPayload` are hard-coded to a deterministic,
 * non-repeatable, non-outcome-bearing transition (`fromState`/`toState`/
 * `deadlineMs`/`evaluationTimeMs`, throwing if `attribution`/`outcome`
 * are ever present). Mission13 dispute ruling is a genuinely different
 * decision class — K2 (discretionary) AND K3 (outcome-bearing), and
 * legitimately REPEATABLE per escrow across appeal rounds — so it gets
 * its own persistence-mapping function alongside the existing one
 * (`toDisputeRulingTransitionRecordRow`, not a parametrized reuse of
 * `toSemanticTransitionRecordRow`), per this program's own established
 * "add a new one, when the scope is genuinely different" discipline.
 * Both write to the SAME `semantic_transition_records` table — the K2/K3
 * columns that table's own schema comment already reserved for exactly
 * this future slice.
 *
 * ATOMICITY BOUNDARY (mission §13): this module's own transaction is the
 * ENTIRE semantic commit — Dispute.status: * -> RESOLVED (plus the
 * signed-decision bookkeeping fields dispute.service.ts previously wrote
 * separately) AND the SemanticTransitionRecord insert commit together,
 * or neither does. `dispute.service.ts`'s EXISTING revert-on-failure
 * block (if the LATER, non-transactional settlement-action call fails)
 * is extended to also delete the just-committed record — see that
 * file's own comment for why a reverted ruling must never leave a
 * dangling Core authorization behind.
 *
 * DESTINATION SNAPSHOT (mission §8-9, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md
 * §6): resolved via the SAME transactional client (`tx.payoutAddress.findUnique`)
 * used for the Dispute claim and the Record insert — never a plain
 * SELECT before the transaction begins. See this file's own
 * `resolveBeneficiaryDestination()` for the exact deterministic-race
 * reasoning (no advisory lock needed here — unlike
 * `withEscrowFundingLock()`'s genuine read-then-write TOCTOU gap across
 * multiple tables, this is a pure read of a row this transaction never
 * writes to, so Postgres's own READ COMMITTED MVCC snapshot already
 * gives a real, deterministic happens-before relationship against any
 * concurrent PayoutAddress mutation — proven in
 * tests/integration/disputeOutcomeDestinationSnapshot.test.ts).
 *
 * NO FABRICATED PROVENANCE (Decision 4, M8.5 §14): a beneficiary with no
 * registered PayoutAddress fails this transaction closed — the caller
 * gets the SAME clear error `escrow-lifecycle.ts`'s `resolvePayoutAddress()`
 * already produces for "no address, none registered," never a
 * caller-supplied or profile-mutation fallback.
 */
import { prisma } from '../../common/database'
import type { DisputeStatus, Prisma } from '@prisma/client'
import { EscrowError, ValidationError } from '../../common/errors'
import type { AssetType } from '../../common/types'
import {
  RulesetRef,
  createRulesetRef,
  SAILS_SEMANTIC_PROFILE_IDENTITY,
  TransitionRecord,
  createInteractionId,
  createTransitionTypeId,
  createCandidateTransition,
  LEGACY_UNVERIFIED,
  createTransitionRecord,
  SAILS_ATTRIBUTION_EVALUATOR_IDENTITY,
} from '@sails/core'
import {
  evaluateAuthorityDecisionAttribution,
  buildDisputeRulingContext,
  ESCROW_DISPUTE_RULING_TRANSITION_TYPE,
} from './discretionary-authority'
import { AuthorityDecisionPayload } from './arbitration-authority'
import {
  ArbitrationOutcomeContent,
  BeneficiaryDestination,
  buildArbitrationOutcome,
  buildOutcomeDestinationBinding,
  buildAttributedArbitrationTransitionRecord,
} from './economic-outcome'
import { economicDispositionLockKey } from './economic-disposition-authority'

type SemanticTransitionRecordRow = NonNullable<Awaited<ReturnType<typeof prisma.semanticTransitionRecord.findUnique>>>

/**
 * The Ruleset governing Mission13 disputed-settlement decisions. The
 * expected (and, since only one real implementation of this evaluator
 * exists, also actual — matching M4's own ESCROW_TIMELOCK_EXPIRY_RULESET
 * precedent) evaluator identity is M5's generalized attribution
 * evaluator — the K2 check this decision class actually depends on.
 */
export const DISPUTE_RULING_RULESET: RulesetRef = createRulesetRef({
  name: 'Sails Mission13 Dispute Ruling Ruleset',
  identity: 'sails-mission13-dispute-ruling-ruleset',
  version: '1.0',
  commitment: 'sails-mission13-dispute-ruling-ruleset@1.0:attributed-decision+economic-outcome' as unknown as RulesetRef['commitment'],
  expectedEvaluatorIdentity: SAILS_ATTRIBUTION_EVALUATOR_IDENTITY,
  expectedProfileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
})

/**
 * Pure: derives the allocation/remainder shape from the ruling + bps.
 * Buyer's basis points and the remainder-beneficiary choice for SPLIT
 * MUST match `multisig.provider.ts`'s own, real, unchanged
 * `buildUnsignedSplit()` arithmetic exactly (`buyerValue =
 * floor(pool * buyerBps / 10000)`, seller absorbs the remainder) — this
 * is not an independent design choice, it is the EXISTING, live
 * provider convention, reproduced here so the authoritative Outcome and
 * the real on-chain split can never structurally disagree about WHO
 * absorbs a rounding remainder (M8.5/M7 W1's own finding: this must
 * never be incidental).
 */
export function buildRulingOutcomeContent(
  ruling: 'RELEASE' | 'REFUND' | 'SPLIT',
  totalUnits: string,
  asset: string,
  buyerId: string,
  sellerId: string,
  buyerBps: number | null,
): ArbitrationOutcomeContent {
  if (ruling === 'RELEASE') {
    return { ruling, totalUnits, asset, allocations: [{ beneficiary: buyerId, basisPoints: 10000 }], remainderBeneficiary: buyerId }
  }
  if (ruling === 'REFUND') {
    return { ruling, totalUnits, asset, allocations: [{ beneficiary: sellerId, basisPoints: 10000 }], remainderBeneficiary: sellerId }
  }
  if (buyerBps === null || !Number.isInteger(buyerBps) || buyerBps < 1 || buyerBps > 9999) {
    throw new ValidationError('buildRulingOutcomeContent: SPLIT requires an integer buyerBps between 1 and 9999')
  }
  return {
    ruling,
    totalUnits,
    asset,
    allocations: [
      { beneficiary: buyerId, basisPoints: buyerBps },
      { beneficiary: sellerId, basisPoints: 10000 - buyerBps },
    ],
    // multisig.provider.ts buildUnsignedSplit(): buyerValue is the exact
    // bps computation, sellerBase = pool - buyerValue — seller is always
    // the remainder side. Reproduced here verbatim, not re-derived.
    remainderBeneficiary: sellerId,
  }
}

/**
 * Resolves ONE beneficiary's destination inside the given transactional
 * client. Never a plain top-level `prisma` read — see this file's own
 * header for why the transactional client is what makes the destination
 * snapshot race-safe.
 */
async function resolveBeneficiaryDestination(tx: Prisma.TransactionClient, participantId: string, asset: AssetType): Promise<string> {
  const registered = await tx.payoutAddress.findUnique({ where: { participantId_asset: { participantId, asset } } })
  if (!registered) {
    throw new EscrowError(
      `No payout address registered for participant ${participantId} (asset ${asset}) — a Core-authoritative dispute ` +
      'settlement resolves the beneficiary\'s own registered PayoutAddress, never a caller-supplied override. ' +
      'Register one via POST /v1/settlement/payout-addresses first (docs/DESTINATION_AUTHORITY_ARCHITECTURE.md).'
    )
  }
  return registered.address
}

/** Which beneficiaries actually need a resolved destination for a given ruling — REFUND never touches the buyer's payout address, RELEASE never touches the seller's. */
function beneficiariesFor(ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerId: string, sellerId: string): readonly string[] {
  if (ruling === 'RELEASE') return [buyerId]
  if (ruling === 'REFUND') return [sellerId]
  return [buyerId, sellerId]
}

/**
 * Pure: maps a Core `TransitionRecord` for this decision class onto this
 * Reference Implementation's persisted row shape. Never invents a value
 * Core didn't actually supply — mirrors `semantic-transition-record.ts`'s
 * own `toSemanticTransitionRecordRow()` discipline exactly, for a
 * genuinely different (K2+K3-bearing, repeatable) decision class.
 */
function toDisputeRulingTransitionRecordRow(
  record: TransitionRecord<{ readonly escrowId: string }, ArbitrationOutcomeContent, readonly BeneficiaryDestination[]>,
  appealRound: number,
  fromDisputeStatus: string,
): Prisma.SemanticTransitionRecordCreateInput {
  if (!record.attribution) {
    throw new Error('dispute-outcome.ts: a dispute-ruling TransitionRecord must always carry attribution (K2 applies) — refusing to persist without it')
  }
  if (!record.outcome) {
    throw new Error('dispute-outcome.ts: a dispute-ruling TransitionRecord must always carry an Outcome (K3 applies) — refusing to persist without it')
  }
  const priorPosition = record.priorPosition
  const isLegacyUnverified = priorPosition === 'LEGACY_UNVERIFIED'

  return {
    interactionId: record.interaction,
    transitionType: record.transition.type,
    // The state claim THIS transaction actually commits is the Dispute's
    // own status transition — the Escrow's own status change (COMPLETED/
    // REFUNDED/SPLIT) is a separate, later semantic event governed by the
    // EXISTING, unchanged claimEscrowTransition()/VALID_TRANSITIONS
    // machinery inside initiateRelease/Refund/Split — never claimed here.
    fromState: fromDisputeStatus,
    toState: 'RESOLVED',
    priorPositionKind: isLegacyUnverified ? 'LEGACY_UNVERIFIED' : 'RESOLVED',
    priorPositionReference: isLegacyUnverified ? null : JSON.stringify((priorPosition as { reference: unknown }).reference),
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
    // This decision class has no timelock/deadline concept — both are
    // 0, a documented "not applicable" value (never null; the columns
    // are NOT NULL BIGINT, shared with M4's own slice).
    deadlineMs: BigInt(0),
    evaluationTimeMs: BigInt(0),
    conditionResult: record.conditionResult,
    attributionActor: String(record.attribution.actor),
    attributionRawProof: String(record.attribution.rawProof),
    attributionResolvedIdentity: String(record.attribution.resolvedIdentityReference),
    outcomeContent: record.outcome.content as unknown as Prisma.InputJsonValue,
    outcomeDestinationBinding: (record.outcome.destinationBinding?.reference ?? []) as unknown as Prisma.InputJsonValue,
    appealRound,
  }
}

export type DisputeRulingCommitResult =
  // displacedStatus: the Dispute status this commit actually replaced with RESOLVED, read under the row
  // lock — the only correct target if the caller later has to revert this ruling.
  | { readonly committed: true; readonly destinations: readonly BeneficiaryDestination[]; readonly displacedStatus: DisputeStatus }
  | { readonly committed: false; readonly reason: 'NOT_ATTRIBUTED' }
  | { readonly committed: false; readonly reason: 'DISPUTE_STATE_LOST_RACE' }

/**
 * The atomic unit `dispute.service.ts`'s `applyRuling()` calls: signature
 * verification (M5, real, never a pre-computed boolean), Outcome
 * construction (M7), destination snapshot (M8.5), Dispute state claim,
 * and durable Record insert commit together, in ONE Postgres
 * transaction, or none of them do.
 *
 * `payload`/`authoritySignatureHex`/`resolvedArbiterPublicKeyHex` are
 * exactly what `dispute.service.ts`'s existing top-level fail-fast check
 * already verifies — this function independently RE-verifies via M5's
 * own evaluator rather than trusting that earlier check ran (no dual
 * authority: the top-level check can only ever reject early, never
 * substitute for or override this function's own verdict).
 */
export async function commitAuthoritativeDisputeRuling(
  dispute: { readonly id: string; readonly escrowId: string; readonly status: string; readonly appealRound: number },
  payload: AuthorityDecisionPayload,
  authoritySignatureHex: string,
  resolvedArbiterPublicKeyHex: string,
  totalUnits: string,
  asset: AssetType,
  buyerId: string,
  sellerId: string,
): Promise<DisputeRulingCommitResult> {
  const context = buildDisputeRulingContext(dispute.escrowId, payload)
  const verdict = evaluateAuthorityDecisionAttribution(payload, authoritySignatureHex, resolvedArbiterPublicKeyHex, context)
  if (verdict.kind !== 'ATTRIBUTED') {
    return { committed: false, reason: 'NOT_ATTRIBUTED' }
  }

  const outcomeContent = buildRulingOutcomeContent(payload.outcome, totalUnits, asset, buyerId, sellerId, payload.buyerBps)

  return prisma.$transaction(async (tx) => {
    // ADR-005 §3/§10 — same `economic-disposition:<disputeId>` lock scope
    // appeal() and the Economic Disposition Commit Gate use. The
    // conditional `updateMany` guard below already gave MULTISIG
    // reasonable protection against the old-arbiter in-flight race (an
    // appeal reassigning `arbiterId` makes `payload.authorityId` stop
    // matching); this lock makes that ordering deterministic rather than
    // relying only on row-level contention, and puts MULTISIG on the
    // identical serialization domain as every other rail's disputed-ruling
    // resolve-write and the Commit Gate's own re-validation.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(dispute.id)})::bigint)`

    // The state this ruling displaces is read HERE, under a row lock, never taken from the caller's earlier
    // read (`dispute.status` is not used for provenance). The advisory lock above only serializes the
    // economic-disposition writers (rulings, appeal()); contest, the expiry sweep, evidence submission and
    // proposals change the status with plain conditional updates, so without FOR UPDATE the row could still
    // move between this read and the claim. With it, those writers wait for this transaction and then see
    // RESOLVED (their own conditions then fail), and anything they committed before is what is read here.
    const [locked] = await tx.$queryRaw<Array<{ status: DisputeStatus; appealRound: number; arbiterId: string | null }>>`
      SELECT status::text AS status, "appealRound", "arbiterId" FROM disputes WHERE id = ${dispute.id} FOR UPDATE`
    if (!locked || locked.status === 'RESOLVED' || locked.status === 'MOOT' || locked.arbiterId !== payload.authorityId || locked.appealRound !== payload.appealRound) {
      return { committed: false, reason: 'DISPUTE_STATE_LOST_RACE' } as const
    }

    const claim = await tx.dispute.updateMany({
      // The signed appeal round is part of the claim: a decision signed for round N never commits over a
      // dispute that appeal() has since moved to another round.
      where: { id: dispute.id, status: locked.status, appealRound: payload.appealRound, arbiterId: payload.authorityId },
      data: {
        status: 'RESOLVED',
        ruling: payload.outcome,
        resolvedAt: new Date(),
        authoritySignature: authoritySignatureHex,
        authorityIssuedAt: new Date(payload.issuedAt),
        authorityBuyerBps: payload.buyerBps,
      },
    })
    if (claim.count === 0) {
      return { committed: false, reason: 'DISPUTE_STATE_LOST_RACE' } as const
    }

    const beneficiaries = beneficiariesFor(payload.outcome, buyerId, sellerId)
    const destinations: BeneficiaryDestination[] = []
    for (const beneficiary of beneficiaries) {
      destinations.push({ beneficiary, destination: await resolveBeneficiaryDestination(tx, beneficiary, asset) })
    }
    const destinationBinding = buildOutcomeDestinationBinding(destinations)
    const outcome = buildArbitrationOutcome(outcomeContent, destinationBinding)

    const interaction = createInteractionId(dispute.escrowId)
    const record = buildAttributedArbitrationTransitionRecord(dispute.escrowId, verdict.claim, verdict.attribution, outcome, DISPUTE_RULING_RULESET)
    const row = toDisputeRulingTransitionRecordRow(record, dispute.appealRound, locked.status)

    try {
      await tx.semanticTransitionRecord.create({ data: row })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Replay-resistance key collision: an authoritative Record for
        // this exact (escrow, transition type, appeal round) already
        // exists — never silently overwrite it, roll the whole
        // transaction back (Postgres does this automatically on a
        // re-thrown error inside prisma.$transaction).
        throw new EscrowError(`A durable authoritative decision record already exists for dispute ${dispute.id}'s appeal round ${dispute.appealRound} — refusing to create a second one`)
      }
      throw err
    }

    return { committed: true, destinations, displacedStatus: locked.status } as const
  })
}

/**
 * Loads the JUST-COMMITTED (or any historically-committed) authoritative
 * record back from durable storage — never reuses the in-memory objects
 * built during commit. This is what lets the M8 dispatch gate prove it
 * is reading persistence, not transient request memory (mission §16).
 *
 * `client` lets a caller that already holds a transaction (ST-1's stale-round cleanup, which re-reads the Outcome
 * under the dispute and escrow locks) read through it; the default is the shared client, as before.
 */
export async function loadDisputeRulingRecord(
  escrowId: string,
  appealRound: number,
  client: Pick<Prisma.TransactionClient, 'semanticTransitionRecord'> = prisma,
): Promise<SemanticTransitionRecordRow | null> {
  return client.semanticTransitionRecord.findUnique({
    where: {
      interactionId_transitionType_appealRound: {
        interactionId: escrowId,
        transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE,
        appealRound,
      },
    },
  })
}

/**
 * Reconstructs a Core `TransitionRecord` from a persisted row — the
 * exact inverse of `toDisputeRulingTransitionRecordRow()`. Every record
 * this program's own commit path writes for this decision class carries
 * `priorPositionKind: LEGACY_UNVERIFIED` (no prior Core record exists
 * for a Dispute, per `buildAttributedArbitrationTransitionRecord()`'s
 * own hard-coded `priorPosition: 'LEGACY_UNVERIFIED'`) — the RESOLVED
 * arm is schema-representable for future generality but genuinely
 * unreachable today, so it throws rather than fabricating a
 * `SemanticHistoryPosition` shape this file has no real data to fill in.
 */
export function fromDisputeRulingRow(row: SemanticTransitionRecordRow): TransitionRecord<{ readonly escrowId: string }, ArbitrationOutcomeContent, readonly BeneficiaryDestination[]> {
  if (row.priorPositionKind !== 'LEGACY_UNVERIFIED') {
    throw new Error(`fromDisputeRulingRow: priorPositionKind "${row.priorPositionKind}" is not yet supported for this decision class — every record this program writes today is LEGACY_UNVERIFIED`)
  }
  const interaction = createInteractionId(row.interactionId)
  return createTransitionRecord({
    interaction,
    priorPosition: LEGACY_UNVERIFIED,
    transition: createCandidateTransition({ interaction, type: createTransitionTypeId(row.transitionType), payload: { escrowId: row.interactionId } }),
    rulesetRef: DISPUTE_RULING_RULESET,
    evaluatorIdentity: { name: row.evaluatorIdentityName, version: row.evaluatorIdentityVersion } as never,
    profileIdentity: { name: row.profileIdentityName, version: row.profileIdentityVersion } as never,
    conditionResult: row.conditionResult,
    attribution: row.attributionActor
      ? { actor: row.attributionActor as never, rawProof: row.attributionRawProof, resolvedIdentityReference: row.attributionResolvedIdentity }
      : undefined,
    outcome: row.outcomeContent
      ? { content: row.outcomeContent as unknown as ArbitrationOutcomeContent, destinationBinding: { reference: (row.outcomeDestinationBinding ?? []) as unknown as readonly BeneficiaryDestination[] } }
      : undefined,
  })
}

/** Deletes a committed record — used ONLY by `dispute.service.ts`'s existing revert-on-failure path, mirroring exactly how it already reverts the Dispute's own authority fields on a downstream settlement-action failure. Never called for any other reason. */
export async function revertDisputeRulingRecord(escrowId: string, appealRound: number): Promise<void> {
  await prisma.semanticTransitionRecord.deleteMany({
    where: { interactionId: escrowId, transitionType: ESCROW_DISPUTE_RULING_TRANSITION_TYPE, appealRound },
  })
}
