import { TRANSITION_CLAIMED_KEY } from '../../common/events/event-projection'
import { childLogger } from '../../common/logger'
import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { prisma } from '../../common/database'
import { NotFoundError, EscrowError, ForbiddenError, SettlementResultConflictError } from '../../common/errors'
import { AssetType } from '../../common/types'
import { config } from '../../config'
import { eventBus } from '../../common/events/event-bus'
import { payoutAddressService } from './payout-address.service'
import { escrowRepository } from './escrow-repository'
import { tradeRepository } from '../open-p2p/trade-repository'
import { assertCircuitClosed, recordEscrowConflict } from './escrow-circuit-breaker'
import { capabilityRegistry, CAPABILITY_IMPLEMENTATIONS } from '../../core/capability-registry'
import { escrowFundingEvidenceService } from './escrow-funding-evidence.service'

/**
 * Sails OpenSettlement — Escrow lifecycle shared helpers
 * (ARCHITECTURE_AUDIT_REPORT.md §2's escrow.service.ts finding,
 * recommendation #1, closed 2026-08-08 — see escrow-providers.ts's
 * identical header comment for the full context).
 *
 * Everything in this file was previously module-scope free functions or
 * private EscrowService methods in escrow.service.ts, moved verbatim (no
 * behavior change). None of it holds instance state — EscrowService
 * itself is a stateless orchestrator, so converting "class method using
 * `this.otherMethod()`" into "free function importing `otherFunction()`"
 * changes nothing observable.
 */

export const VALID_TRANSITIONS: Record<string, string[]> = {
  CREATED: ['FUNDS_LOCKED', 'REFUNDED'],
  // Missão 11 Fase 7.3.3 §B — EXPIRED is reached ONLY from FUNDS_LOCKED,
  // by the existing timelock sweeper, for a signature-collection type
  // whose cooperative refund cannot succeed (see escrow.service.ts's
  // sweepExpiredEscrows()). PAYMENT_PENDING is deliberately NOT given
  // this same expiry path — a buyer who has already claimed payment is a
  // genuine payment dispute, not a timelock-expiry scenario, and already
  // has its own real resolution path (raiseDispute() from PAYMENT_PENDING,
  // unchanged) — conflating the two would apply seller-only expiry-recovery
  // authority to a state where the buyer may have the stronger claim.
  FUNDS_LOCKED: ['PAYMENT_PENDING', 'DISPUTED', 'REFUNDED', 'EXPIRED'],
  PAYMENT_PENDING: ['COMPLETED', 'DISPUTED'],
  COMPLETED: [],
  // RFC-021 D9 — SPLIT only ever reaches an escrow via a dispute ruling
  // (§1.9's third option has no non-disputed equivalent, unlike
  // RELEASE/REFUND which both also have a normal happy-path route here).
  DISPUTED: ['COMPLETED', 'REFUNDED', 'SPLIT'],
  REFUNDED: [],
  SPLIT: [],
  // Missão 11 Fase 7.3.3 §B/§C — from EXPIRED, either a real dispute is
  // raised (the seller's own authorized recovery path,
  // dispute.service.ts's initiateExpiryRecovery(), or the general
  // raiseDispute() itself, unchanged) or — if the counterparty actually
  // returns — a genuinely cooperative refund remains possible (§C's own
  // "cooperative signatures still possible" answer: yes, nothing about
  // entering EXPIRED forecloses this). Never COMPLETED/SPLIT directly —
  // those still require a real dispute ruling first, same as today.
  EXPIRED: ['DISPUTED', 'REFUNDED'],
}

// Found during a general gap audit (not tied to any single RFC): none of
// this class's mutating methods verified `triggeredBy` was actually a
// party to the trade before this fix — any authenticated participant on
// the platform could lock/confirm/release/refund/dispute *any* other
// trade's escrow, not just their own (an IDOR, the same class of bug
// RT-002 already fixed once for raw-userId-in-body — this was the same
// gap one layer deeper, at the service boundary rather than the auth
// boundary). `triggeredBy` may be a participant's own id, or an agent
// acting on their behalf (`agent:{label}:{participantId}`,
// `wallet-agent.ts`) — that string shape only ever originates from
// trusted internal callers (settlement-orchestrator.ts), never from an
// HTTP request body, so accepting it here doesn't reopen the hole this
// fix closes.
// Missão 11 Fase 9.6 — hardening, not a new authorization mechanism
// (Kimi K3 R2's AUTH-01/AUTH-03/AUTH-04/CONST-GAP-02, downgraded from
// P1 to DESIGN DEBT during Fase 9.5's independent triage: grepping
// every real call site of isPartyOrAgent() in this codebase showed the
// first argument is always either an authenticated caller's own
// requireAuth-verified participantId — a server-generated UUID that
// structurally can never take the `agent:...` shape — or a hardcoded
// system constant; nothing request-controlled reaches this function
// unchanged today). The gap the triage flagged wasn't that this is
// exploitable now — it's that nothing STOPS a future call site from
// threading raw request/body text into this parameter without
// noticing the precedent this comment (and the one above, predating
// this phase) already documents. TrustedActorId is a pure compile-time
// brand — identical to `string` at runtime, zero behavior change —
// so a future `isPartyOrAgent(request.body.someField, ...)` fails to
// COMPILE instead of silently reopening the syntactic-pattern gap.
declare const trustedActorBrand: unique symbol
export type TrustedActorId = string & { readonly [trustedActorBrand]: true }

// The ONLY sanctioned way to produce a TrustedActorId. Call it with
// either an authenticated caller's own participantId (requireAuth's
// verified session — settlement.routes.ts's participantId(request)
// helper) or one of this codebase's own hardcoded system constants
// (SYSTEM_SWEEPER_ID, an already-validated arbiterId, etc.) — never
// with a raw, unvalidated request field.
export function asTrustedActor(id: string): TrustedActorId {
  return id as TrustedActorId
}

export function isPartyOrAgent(triggeredBy: TrustedActorId, participantId: string): boolean {
  return triggeredBy === participantId || new RegExp(`^agent:[^:]+:${participantId}$`).test(triggeredBy)
}

// Shared by releaseFunds()/refundFunds() (escrow.service.ts) — both are
// legitimately triggered by either the seller (the normal path) or the
// arbiter assigned to an open dispute on this trade (dispute.service.ts's
// resolveDispute(), which validates the arbiter match itself *before*
// calling into this class — this is a second, defense-in-depth check,
// not the only one). Only queries Dispute when the cheaper seller check
// already failed. Exported as a free function (was EscrowService's
// public isSellerOrAssignedArbiter() method) — no instance state was
// ever involved, so callers use the same call surface either way.
export async function isSellerOrAssignedArbiter(tradeId: string, sellerId: string, triggeredBy: string): Promise<boolean> {
  if (isPartyOrAgent(asTrustedActor(triggeredBy), sellerId)) return true
  const dispute = await escrowRepository.findDisputeByTradeAndArbiter(tradeId, triggeredBy)
  return dispute !== null
}

/**
 * Once an escrow is DISPUTED, ordinary seller disposition authority is
 * suspended: RELEASE / REFUND / SPLIT are no longer cooperative seller
 * actions; they are the economic effect of the dispute's current ruling.
 *
 * Keep this separate from isSellerOrAssignedArbiter(): that helper is
 * intentionally broader because seller authority remains legitimate on
 * non-disputed cooperative/recovery paths. This assertion is the state-
 * conditional narrowing shared by both direct settlement calls and the
 * signature-collection initiate-* flow.
 *
 * ADR-005 / #218 — returns the live Dispute row (rather than void) when
 * the escrow is DISPUTED, so a caller building a pending economic
 * operation (escrow-pending-tx.ts's initiateSignatureCollectionCore()) can
 * snapshot the exact ruling generation that authorized it, without a
 * second, independently-racy re-fetch. Returns null for the non-disputed
 * case — existing callers that only awaited this for its side effect
 * (loadEscrowWithAuthorization()) are unaffected by this additive change.
 */
export async function assertDisputedDispositionAuthority(
  tradeId: string,
  escrowStatus: string,
  triggeredBy: string,
): Promise<Awaited<ReturnType<typeof escrowRepository.findDisputeByTradeAndArbiter>>> {
  if (escrowStatus !== 'DISPUTED') return null

  const dispute = await escrowRepository.findDisputeByTradeAndArbiter(tradeId, triggeredBy)
  if (!dispute) {
    throw new ForbiddenError(
      `${triggeredBy} is not the current assigned arbiter for disputed trade ${tradeId} — ` +
      'ordinary seller disposition authority is suspended while the escrow is DISPUTED'
    )
  }
  return dispute
}

// Missão 06.9 (RFC-014 wiring completion) — RFC-014's own convention
// ("the required scope string is the real event name this action
// produces") already covers refund/split semantically; it was only ever
// wired for release (`escrow.service.ts`'s `releaseFunds()` and
// `escrow-pending-tx.ts`'s `initiateRelease()`). `refundFunds()`,
// `splitFunds()`, `initiateRefund()`, and `initiateSplit()` never called
// it — a real, found-by-audit inconsistency (Missão 06.7), not a
// deliberate design choice; `splitFunds()`'s own comment already claimed
// parity with `releaseFunds()` that didn't actually exist.
//
// A single, tiny helper (not a new service/layer) shared by every direct
// and pending-tx fund-movement call site, specifically so this class of
// drift — one call site gets the check, its siblings quietly don't —
// can't happen again the same way. Checked against `triggeredBy`
// exactly as `releaseFunds()` already did: whoever is actually driving
// the transition (the seller for a normal release/refund, or the
// assigned arbiter for a disputed ruling — `dispute.service.ts`'s
// `applyRuling()` already passes `arbiterId` as `triggeredBy` for every
// ruling type, RELEASE included, so this mirrors release's own existing
// behavior rather than inventing a new distinction between seller and
// arbiter capability). A sweeper-triggered refund (`sweepExpiredEscrows()`)
// is unaffected by this being a "new" check in practice: it already
// passes the trade's real `sellerId` as `triggeredBy` (its own comment:
// "never a fabricated 'system' actor... mirrors settlement-orchestrator.ts's
// own sellerTriggeredBy precedent"), so it is subject to the identical
// capability requirement a manual seller-initiated refund already would
// be — not a new rule, the natural consequence of an existing one.
export async function checkFundMovementCapability(
  triggeredBy: string,
  scope: 'settlement.escrow.released' | 'settlement.escrow.refunded' | 'settlement.escrow.split'
): Promise<void> {
  if (!config.features.enforceCapabilities) return
  const capabilityName = CAPABILITY_IMPLEMENTATIONS.opensettlement
  const allowed = await capabilityRegistry.check(triggeredBy, capabilityName, scope)
  if (!allowed) {
    throw new ForbiddenError(
      `${triggeredBy} has no active '${capabilityName}' capability grant covering '${scope}'`,
      'FORBIDDEN' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — a real policy/CapabilityGrant denial, not a technical or maturity gap
    )
  }
}

// Missão 11 Fase 9.1 §2 — closes the Phase 9.0 audit's own "DP-05/DP-07"
// finding (those labels are non-canonical/unrecoverable — see Missão 11
// Fase 9.3.3, docs/PROTOCOL_INVARIANTS.md's Level 2 DP-1, derived from
// INV-04/INV-07): nothing previously stopped a trade from advancing past
// funding evidence a reorg sweep had already determined was false.
//
// Deliberately narrow: called ONLY from markPaymentSent(), initiateRelease(),
// and initiateSplit() (see each call site's own comment for why) — never
// from refund initiation, dispute raising, the EXPIRED transition, or
// expiry-recovery. Those four are recovery/observation paths, and
// blocking a legitimate recovery path is exactly the "permanent fund
// denial" this phase was explicitly told not to create — refund returns
// collateral to the party who originally funded it (not a new
// false-positive risk the way crediting the buyer or collecting a fee
// would be), and a dispute/recovery action is precisely how a party
// should be able to respond to a funding problem, not something that
// problem should block.
//
// Only meaningful for MULTISIG (the only rail with a real funding-reorg
// concept today) — a no-op for every other escrow type, matching the
// same "MULTISIG today" scoping multisig-funding-reorg-sweep.ts itself
// already uses.
export async function assertFundingNotUncertain(escrowId: string, escrowType: string): Promise<void> {
  if (escrowType !== 'MULTISIG') return
  const uncertain = await escrowFundingEvidenceService.isFundingUncertain(escrowId)
  if (uncertain) {
    throw new EscrowError(
      `Escrow ${escrowId}'s funding evidence is currently uncertain — a background reorg check found the previously-accepted funding transaction ` +
      'no longer confirmed on the best chain, and it has not yet been reconfirmed or replaced by a re-verified transaction. Refusing to proceed ' +
      'rather than manufacture certainty the chain does not currently support. Refunding, raising a dispute, or waiting for reconfirmation remain available.'
    )
  }
}

// Missão 11 Fase 9.3 — closes the reorg/lifecycle TOCTOU race an
// independently-reproduced red-team finding surfaced (Kimi K3 R1
// MULTI-03/REORG-01/REORG-02/FAIL-04, corrected P0→P2 after reproduction:
// the sweep's own recovery path already prevents permanent fund denial —
// but the race itself, a lifecycle transition succeeding on
// assertFundingNotUncertain()'s now-stale result because a concurrent
// sweep tick invalidated the same evidence a moment later, was real).
//
// assertFundingNotUncertain() above is a cheap, unlocked, EARLY fail-fast
// only — it saves wasted work (trade lookups, authorization checks,
// PSBT construction) when the escrow is already known-bad, but a
// separate read followed later by a separate write is exactly a TOCTOU
// window: the sweep (multisig-funding-reorg-sweep.ts) can invalidate the
// evidence in between. This helper closes that window by making the
// AUTHORITATIVE re-check and the state-changing write atomic with
// respect to any concurrent evidence write, using the exact same
// pg_advisory_xact_lock pattern already shipped and tested for
// correlationId-scoped event-append serialization
// (src/common/events/event-store.ts's PostgresEventStore.publish()) —
// applied here with escrowId as the lock key instead.
//
// Why this closes the race: whichever writer (a lifecycle transition via
// this helper, or the sweep via its own use of this same helper) acquires
// the advisory lock first for a given escrowId completes its ENTIRE
// read-then-write sequence — inside one Postgres transaction — before the
// other side can even acquire the lock. There is no window in which one
// side's write can land between the other side's read and write, because
// both sides' read-then-write is now one atomic unit under the same key.
//
// Why pg_advisory_xact_lock specifically (mirrors event-store.ts's own
// documented reasoning exactly): (a) it lives in Postgres itself, so it
// serializes every writer across every app instance/process, not just
// within one process's memory — a plain in-process Map<id, Promise> mutex
// would NOT serialize two separate server instances, which this system
// must support; (b) the `_xact_` variant auto-releases at transaction end
// (commit OR rollback), so a crashed request or thrown error can never
// leak a held lock — no explicit unlock call needed, restart-safe by
// construction; (c) hashtext() converts escrowId (a string) into the
// bigint Postgres advisory locks require, with the same disclosed,
// accepted, harmless caveat event-store.ts's own comment already
// documents: two different escrowIds could theoretically hash-collide
// and briefly contend for the lock (extra serialization, never a
// wrong-key collision — the WHERE/read predicates inside fn() are always
// scoped by the real escrowId, never by the hash).
//
// Different escrowIds never contend with each other (proven by the
// adversarial "two workers, different escrows" test) — this is
// deliberately NOT a global lock, matching the CTO's explicit
// requirement that the mechanism stay scoped to the affected escrow.
export async function withEscrowFundingLock<T>(
  escrowId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
    return fn(tx)
  })
}

/** Loads an escrow + its trade + verifies the seller-or-arbiter authorization
 *  every state transition from PAYMENT_PENDING/DISPUTED requires. */
export async function loadEscrowWithAuthorization(
  escrowId: string,
  triggeredBy: string
): Promise<{ escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>; trade: NonNullable<Awaited<ReturnType<typeof tradeRepository.findById>>> }> {
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)
  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
  if (escrow.status === 'DISPUTED') {
    await assertDisputedDispositionAuthority(trade.id, escrow.status, triggeredBy)
  } else if (!(await isSellerOrAssignedArbiter(trade.id, trade.sellerId, triggeredBy))) {
    throw new ForbiddenError(`${triggeredBy} is neither the seller of trade ${trade.id} nor its assigned dispute arbiter`)
  }
  return { escrow, trade }
}

/** Buyer/seller/arbiter pubkeys from EscrowParticipantKey — only the
 *  non-custodial providers consume these. arbiterPubkey is undefined for a
 *  legacy escrow (Missão 11 Fase 5.2 — no role='arbiter' row exists for
 *  one) or for a rail that has never populated one (LIGHTNING_HODL/
 *  SAFE_GUARD_EVM today); MultisigProvider.partiesFor() falls back to live
 *  derivation in that case, unchanged from before this phase. */
export async function loadParticipantPubkeys(escrowId: string): Promise<{ buyerPubkey?: string; sellerPubkey?: string; arbiterPubkey?: string }> {
  const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId } })
  return {
    buyerPubkey: keys.find((k: { role: string }) => k.role === 'buyer')?.pubkey,
    sellerPubkey: keys.find((k: { role: string }) => k.role === 'seller')?.pubkey,
    arbiterPubkey: keys.find((k: { role: string }) => k.role === 'arbiter')?.pubkey,
  }
}

/** Atomic escrow.status transition — the same conditional updateMany +
 *  count === 0 → throw + revert idiom every mutating method below uses
 *  (the robustness-audit fix from 2026-07-20). */
export async function claimEscrowTransition(escrowId: string, fromStatus: string, toStatus: string): Promise<void> {
  // 2026-08-15 — checked first and cheaply, before any real work: once
  // this escrow's circuit is open, every further attempt should fail
  // fast, not pay for an authorization check + DB round trip first. See
  // escrow-circuit-breaker.ts for why this is scoped per-escrowId.
  assertCircuitClosed(escrowId)

  // Defense in depth — the caller already validated the transition, but
  // re-checking here means a typo or future refactor that bypassed
  // assertEscrowTransition() surfaces as a loud EscrowError, not a silent no-op.
  const allowed = VALID_TRANSITIONS[fromStatus] ?? []
  if (!allowed.includes(toStatus)) {
    throw new EscrowError(`Invalid escrow transition: ${fromStatus} → ${toStatus}. Allowed: ${allowed.join(', ') || 'none'}`)
  }
  const claimedCount = await escrowRepository.claimTransition(escrowId, fromStatus, toStatus)
  if (claimedCount === 0) {
    // A real, concrete anomaly on this specific escrow — not a heuristic
    // guess — so it feeds the circuit breaker directly.
    recordEscrowConflict(escrowId)
    throw new EscrowError(`Escrow ${escrowId} was already transitioned by a concurrent request`)
  }
}

const lifecycleLog = childLogger('escrow-lifecycle')

/**
 * Issue #291 - error boundary AFTER external economic execution succeeded.
 *
 * Once the provider call has returned successfully the economic operation may
 * already have happened externally. A later LOCAL step failing (persisting the
 * result, fee accounting, publishing the event) must NOT revert the escrow
 * status as though nothing happened: the escrow stays in its claimed terminal
 * state and reconciliation (PASS 0/1/2/3) owns convergence from durable facts.
 * A settlement-result integrity conflict is surfaced unchanged.
 */
export function settlementSucceededButLocalStepFailed(escrowId: string, operation: string, resultRef: string | undefined, err: unknown): Error {
  if (err instanceof SettlementResultConflictError) return err
  const reason = err instanceof Error ? err.message : String(err)
  lifecycleLog.error({
    msg: 'Provider execution succeeded but a local completion step failed - escrow NOT reverted, reconciliation owns convergence',
    escrowId, operation, resultRef, err: reason,
  })
  return new EscrowError(
    `${operation} for escrow ${escrowId} executed externally (result ${resultRef ?? 'unknown'}) but a local completion step failed (${reason}). ` +
    'The escrow status was NOT reverted; reconciliation will converge it from durable facts.'
  )
}

/** Revert-on-failure boilerplate — every provider call in this class wraps
 *  the same try/catch so a partial transition can never leave an escrow
 *  "claiming COMPLETED with no funds behind it." The .catch(() => {}) on
 *  the revert swallows the unlikely double-fault so the original provider
 *  error reaches the caller — they already saw the problem, a "revert
 *  also failed" chain would just bury the real failure. */
export async function revertEscrowStatus(escrowId: string, claimedStatus: string, fromStatus: string): Promise<void> {
  // #241 — rollback is ownership-sensitive. A delayed worker may restore
  // the prior state only while it still owns the exact claimed state.
  await escrowRepository.revertStatus(escrowId, claimedStatus, fromStatus).catch(() => {})
}

export function assertEscrowTransition(current: string, next: string) {
  const allowed = VALID_TRANSITIONS[current] ?? []
  if (!allowed.includes(next)) {
    throw new EscrowError(
      `Invalid escrow transition: ${current} → ${next}. Allowed: ${allowed.join(', ') || 'none'}`
    )
  }
}

// RFC-008 D2 amendment (Missão 05.5, 2026-08-15) — EscrowEvent's own hash
// chain, same composition and same reasoning as intent-engine.ts's
// writeIntentEvent(): sha256(fromStatus + toStatus + triggeredBy +
// prevHash). Deliberately excludes `note` and `createdAt` from the hash —
// mirroring IntentEvent's own precedent exactly, not inventing a new
// composition. Exported so verifyEscrowEventChain() below (and its own
// tests) can recompute and compare against the stored entryHash — the
// only way to catch an entry mutated in place, not just prevHash links
// reordered.
export function computeEscrowEventHash(fromStatus: string, toStatus: string, triggeredBy: string, prevHash: string): string {
  return createHash('sha256').update(`${fromStatus}|${toStatus}|${triggeredBy}|${prevHash}`).digest('hex')
}

// Missão 11 Fase 9.7 — CONC-03's "C5" closure (found auditing this exact
// function while investigating whether Fase 9.6's own crash-recovery
// reconciliation could itself double-fire a settlement completion — it
// could: a concurrent reconciliation run picking up the same escrow as
// a live, not-yet-finished normal completion would both reach this
// point). Every existing normal-path caller (releaseFunds()/
// refundFunds()/splitFunds()/submitTransactionSignature()/markPaymentSent()/
// openDispute()) is already protected against a CONCURRENT duplicate
// call by claimEscrowTransition()'s own status-based atomic claim
// earlier in its own flow — but escrow-settlement-reconciliation.service.ts's
// crash-recovery catch-up calls this function directly, for an escrow
// that may (rarely) still be genuinely mid-flight in a live completion
// that hasn't crashed at all. This closes that race for every caller at
// once: the FIRST invocation for a given (escrowId, toStatus) — a pair
// this state machine's own VALID_TRANSITIONS graph never revisits, so
// this is a safe, non-ambiguous key — creates the EscrowEvent row and
// fires eventBus.emit(); every other concurrent or later attempt for
// the IDENTICAL transition is a safe, silent no-op, never a second
// firing of the non-idempotent downstream cascade (trade completion,
// reputation, volume — audited Fase 9.7, several of which are raw
// increments with no idempotency key of their own). Uses the SAME
// escrowId-scoped advisory lock withEscrowFundingLock() already
// provides — no new locking primitive, no schema change.
//
// Returns whether THIS call actually emitted (false = another caller
// already had). No existing caller inspects the return value — this is
// purely additive; every existing `await emitEscrowTransition(...)`
// site is unaffected.
// Issue #298 - escrow transitions whose downstream (Trade/Intent/counters/reputation) projections
// must converge, keyed to the event name each publishes. Other transitions are untouched.
export const RECOVERABLE_TRANSITION_EVENTS: ReadonlySet<string> = new Set([
  'settlement.escrow.locked',
  'settlement.escrow.disputed',
  'settlement.escrow.released',
  'settlement.escrow.refunded',
  'settlement.escrow.split',
])
// EscrowEvent.toStatus -> the event name emitEscrowTransition() publishes for it.
export const EVENT_NAME_BY_TARGET_STATUS: Record<string, string> = {
  FUNDS_LOCKED: 'settlement.escrow.locked',
  DISPUTED: 'settlement.escrow.disputed',
  COMPLETED: 'settlement.escrow.released',
  REFUNDED: 'settlement.escrow.refunded',
  SPLIT: 'settlement.escrow.split',
}

export async function emitEscrowTransition(
  escrowId: string,
  tradeId: string,
  from: string,
  to: string,
  triggeredBy: string,
  eventName: Parameters<typeof eventBus.emit>[0],
  eventExtra: Record<string, unknown> = {},
  note?: string
): Promise<boolean> {
  // entryHash/prevHash are never accepted from a caller — this function's
  // own signature has no such parameters, so they can only ever be what
  // the server itself derives here.
  const claimed = await withEscrowFundingLock<string | false>(escrowId, async (tx) => {
    const alreadyEmitted = await tx.escrowEvent.findFirst({ where: { escrowId, toStatus: to as any } })
    if (alreadyEmitted) return false

    const last = await tx.escrowEvent.findFirst({ where: { escrowId }, orderBy: { createdAt: 'desc' } })
    const prevHash = last?.entryHash ?? 'genesis'
    const entryHash = computeEscrowEventHash(from, to, triggeredBy, prevHash)

    const transition = await tx.escrowEvent.create({
      data: { escrowId, fromStatus: from as any, toStatus: to as any, triggeredBy, note, entryHash, prevHash },
    })
    // Issue #298 - claim != publish != projection. For the transitions whose downstream projections
    // must converge, record atomically WITH the claim that a projection is now owed. Its completion
    // ('transition.projected', written by the handler) is a separate fact, so recovery can tell
    // "claimed but never published" and "published but not fully projected" apart from "done".
    // eventId here holds the transition (EscrowEvent) id - no durable event exists yet.
    if (RECOVERABLE_TRANSITION_EVENTS.has(eventName as string)) {
      await tx.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: TRANSITION_CLAIMED_KEY, subjectId: escrowId } })
    }
    return transition.id as string
  })

  if (!claimed) return false
  const transitionId = claimed

  // correlationId = tradeId (RFC-010) — stand-in for intentId until Intent
  // persistence exists; Trade already IS the concrete TradeIntent (§2.3).
  // Deliberately outside the lock/transaction above — this cascades into
  // several other modules' own writes (OpenP2P, OpenReputation), and
  // holding a Postgres advisory lock open across that whole chain would
  // be a real architectural liability for no added safety once the
  // EscrowEvent claim above has already made this the sole winner.
  await eventBus.emit(eventName as any, {
    escrowId,
    tradeId,
    from,
    to,
    triggeredBy,
    ...eventExtra,
    transitionId,
  }, tradeId)
  return true
}

// RFC-008 D2 amendment — Fase 5's own verification primitive. Same shape
// as core/timeline.ts's Timeline.verifyChain() (explanatory result, not a
// bare boolean): reports the first index where the chain is provably
// wrong and why, so a Dispute UI or ArbitrationProvider can point at
// exactly where tampering occurred.
//
// Historical-row strategy (Fase 6, matches RFC-008 D2's own already-
// specified policy for the identical situation on Timeline/DurableEvent —
// not a new decision invented here): a row with entryHash === null
// predates this migration and is skipped, never treated as a broken
// link. The FIRST row that does have a real entryHash is required to
// have prevHash === 'genesis' regardless of whether older, unchained rows
// exist before it — this is exactly what the write path above already
// produces (`last?.entryHash ?? 'genesis'` evaluates to 'genesis' for a
// row whose most recent predecessor has a null entryHash, the identical
// nullish-coalescing behavior as "no predecessor at all"), so the
// verifier's expectation and the writer's real behavior are provably the
// same rule, not two independently-asserted ones that could drift apart.
export interface EscrowChainVerification {
  valid: boolean
  brokenAtIndex?: number
  reason?: string
}

export async function verifyEscrowEventChain(escrowId: string): Promise<EscrowChainVerification> {
  const events = await prisma.escrowEvent.findMany({ where: { escrowId }, orderBy: { createdAt: 'asc' } })

  let expectedPrevHash = 'genesis'
  let chainStarted = false
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.entryHash === null) continue // pre-migration row — unverifiable by construction, not a break

    const storedPrevHash = event.prevHash ?? 'genesis'
    const recomputed = computeEscrowEventHash(event.fromStatus, event.toStatus, event.triggeredBy, storedPrevHash)
    if (event.entryHash !== recomputed) {
      return { valid: false, brokenAtIndex: i, reason: 'entryHash does not match the recomputed hash — this entry was mutated in place after being written' }
    }

    const expected = chainStarted ? expectedPrevHash : 'genesis'
    if (storedPrevHash !== expected) {
      return {
        valid: false, brokenAtIndex: i,
        reason: chainStarted
          ? `prevHash does not match the running chain (expected ${expected}, got ${storedPrevHash}) — an entry was reordered, inserted, or deleted`
          : `the first chained entry's prevHash must be 'genesis', got ${storedPrevHash}`,
      }
    }

    expectedPrevHash = event.entryHash
    chainStarted = true
  }

  return { valid: true }
}

// RFC-021 Phase 0's chargeProtocolFee() (the original 35/30/25/10-shaped
// real-fee computation, persisted as a FeeDistribution row) lived here
// from PROTOCOL_ECONOMY.md §6.2's first draft until Missão 11 Fase 6.5.2,
// which removed it as part of the CTO-authorized single-economic-authority
// cutover: FeeCollectionEvidence(CONFIRMED) -> FeeObligation -> a frozen
// DistributionPolicyVersion -> EntitlementLedgerEntry is now the only
// normative source of a future economic entitlement (see
// entitlement-allocation.service.ts). It had exactly one caller
// (escrow.service.ts's releaseFunds()) and was already permanently inert
// in every environment this repository evidences — PROTOCOL_FEE_RATE has
// never been set above 0. Removed rather than left as unreachable dead
// code (CODE_STYLE.md's "no commented-out/dead code" discipline) once
// Fase 6.5.1's audit confirmed zero other production call sites existed
// anywhere in the repository. Historical `fee_distributions` rows are
// untouched and remain readable; the table itself is now write-frozen at
// the database level (prisma/migrations/20260823020000_legacy_fee_distribution_write_freeze) —
// see docs/DATABASE.md's own entry for that table for the full historical
// account.

// BACKLOG.md's own "Participant payout address" gap, closed 2026-08-04
// — see payout-address.service.ts's own header comment for the full
// rationale. Never fabricates a value (CODE_STYLE.md §2): an explicit
// address always wins; absent that, falls back to the participant's
// own registered PayoutAddress for this escrow's asset; absent BOTH,
// throws a clear, specific error naming exactly what's missing rather
// than guessing.
//
// AUTHORITY BOUNDARY (Sails Core Implementation Program M8-R2,
// 2026-09-11, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md) — this
// function's own "explicit wins" rule is a TRUSTED-INTERNAL-CALLER
// contract, not a caller-facing one: `explicitAddress` must only ever be
// a value the calling code has ALREADY independently verified/authorized
// as belonging to `participantId`'s own Destination Authority (e.g. a
// durable Outcome-commit snapshot, dispute.service.ts's own
// `commitAuthoritativeDisputeRuling()` path for MULTISIG). No HTTP route
// serving an untrusted, request-supplied destination for the cooperative
// release/refund path may forward a raw request body value here —
// settlement.routes.ts's `/release` and `/initiate-release` handlers
// deliberately always pass `undefined`, so this function's fallback (the
// participant's own registered PayoutAddress) is the only path a
// cooperative release can ever resolve through. This function's own
// signature is intentionally unchanged — see that mission's own report
// for why relaxing this contract (e.g. requiring every explicit value to
// re-verify its own provenance here) was rejected as unnecessary
// complexity for what is, and remains, a small, explicit trust boundary
// enforced entirely at each call site.
export async function resolvePayoutAddress(explicitAddress: string | undefined, participantId: string, asset: AssetType): Promise<string> {
  if (explicitAddress) return explicitAddress
  const registered = await payoutAddressService.getPayoutAddress(participantId, asset)
  if (!registered) {
    throw new EscrowError(
      `No payout address provided for participant ${participantId} (asset ${asset}), and none is registered — ` +
      'register one via POST /v1/settlement/payout-addresses first, or pass an explicit address to this call.'
    )
  }
  return registered.address
}
