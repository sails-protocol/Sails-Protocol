import { prisma } from '../../common/database'
import { lockWdkEscrow, assertWdkFundingProven, wdkLockMayHoldFunds } from './wdk-lock-authority'
import { assertWdkOutboundPolicy, planWdkOutbound, settleWdkOutbound, wdkOutboundFailure } from './wdk-outbound-authority'
import { NotFoundError, EscrowError, ForbiddenError, ValidationError } from '../../common/errors'
import { EscrowType } from '../../common/types/trade'
import type { AssetType } from '../../common/types'
import type { CreateEscrowInput } from '@satsails/p2p-schemas'
import { config } from '../../config'
import { eventBus } from '../../common/events/event-bus'
import { translateLegacyAssetType } from '../../common/settlement-scope-legacy'
import { resolveSingleStructurallyCompatibleImplementation } from '../../common/execution-candidates'
import {
  EscrowRecord,
  SettlementProvider,
  NON_CUSTODIAL_PROVIDERS,
  SIGNATURE_COLLECTION_PROVIDERS,
  PUBKEY_HEX_PATTERN,
  recommendedEscrowType,
  getSettlementProvider,
  getCustodyModelForType,
} from './escrow-providers'
import {
  isPartyOrAgent,
  asTrustedActor,
  isSellerOrAssignedArbiter,
  loadEscrowWithAuthorization,
  loadParticipantPubkeys,
  claimEscrowTransition,
  revertEscrowStatus,
  settlementSucceededButLocalStepFailed,
  assertEscrowTransition,
  emitEscrowTransition,
  publishEscrowTransition,
  resolvePayoutAddress,
  checkFundMovementCapability,
  assertFundingNotUncertain,
  withEscrowFundingLock,
  VALID_TRANSITIONS,
} from './escrow-lifecycle'
import { assertCircuitClosed, recordEscrowConflict } from './escrow-circuit-breaker'
import { escrowFundingEvidenceService } from './escrow-funding-evidence.service'
import * as dualApproval from './escrow-dual-approval'
import * as pendingTx from './escrow-pending-tx'
// Sails Core Implementation Program M3 — structurally non-authoritative
// shadow observation only; see expiry-shadow.ts's own header. Retained
// ONLY on the disjoint, still-unmigrated refund branch below as pure
// diagnostic evidence — removed from the target slice now that Core is
// authoritative there (mission's own "M3 Shadow Migration, Option A":
// retaining a shadow comparison alongside a now-authoritative decision
// would read as a hidden second opinion, never actually gating anything
// but confusing to a future reader).
import { observeExpiryShadow } from './expiry-shadow'
// Sails Core Implementation Program M4 — the SOLE semantic authority for
// FUNDS_LOCKED -> EXPIRED eligibility; see expiry-authority.ts's own header.
import { evaluateExpiryAuthority } from './expiry-authority'
// M3.5's validated atomic commit path (State claim + durable
// SemanticTransitionRecord, one Postgres transaction) — see
// semantic-transition-record.ts's own header.
import { commitAuthoritativeEscrowTimelockExpiry } from './semantic-transition-record'
import { claimEscrowTransitionRecord } from './escrow-transition-claim'
import { Prisma } from '@prisma/client'
import { escrowRepository, type EscrowRepository } from './escrow-repository'
import { tradeRepository } from '../open-p2p/trade-repository'
import { assertFirstEscrowAllowed, lockTradeLifecycle } from '../open-p2p/trade-lifecycle-lock'
import { feeObligationService } from './fee-obligation.service'
import { escrowFeeSnapshotService } from './escrow-fee-snapshot.service'
import { isValidTimelockHours } from './escrow-timelock-policy'
import { escrowFundingEvidenceRepository } from './escrow-funding-evidence-repository'
import { assertKnownCapabilityProfile, findCapabilityCommitBlocker } from './capability-profile'

/**
 * Sails OpenSettlement — Reference Implementation
 *
 * Owns: escrow state machine, SettlementProvider abstraction.
 * Does NOT own: Trade, User. This service must never write to those
 * tables directly — it only emits settlement.escrow.* events. The
 * modules that own Trade (OpenP2P) and User/reputation (OpenReputation)
 * subscribe to those events and update their own domain.
 *
 * This boundary was violated in the previous version of this file
 * (direct prisma.trade.update / prisma.user.update calls). Fixed here —
 * see /common/events/handlers.ts for the listeners that now do that work.
 *
 * ARCHITECTURE_AUDIT_REPORT.md §2's "escrow.service.ts — 1,257 linhas
 * (CRITICAL)" finding, closed 2026-08-08: this file used to also contain
 * the SettlementProvider registry, RFC-015 dual-approval, and the
 * client-signature-collection pending-transaction flow inline — 6 mixed
 * responsibilities in one 1,264-line file per that audit's own count.
 * Extracted into 4 focused modules (the audit's own recommendation #1,
 * "extrair em pelo menos 4 módulos focados: ciclo de vida, registry de
 * providers, dual-approval, transações pendentes"):
 *   - escrow-providers.ts    — SettlementProvider registry/dispatch
 *   - escrow-lifecycle.ts    — shared atomic-claim + authorization helpers
 *   - escrow-dual-approval.ts — RFC-015 two-person control
 *   - escrow-pending-tx.ts   — client-signature-collection flow
 * This file keeps the escrow lifecycle state machine itself (create/
 * lock/mark-paid/release/dispute/refund/split) plus the `EscrowService`
 * class and `escrowService` singleton every other module imports —
 * pure internal reorganization, zero behavior change, zero public-API
 * change. Every method on `EscrowService` below has the exact same
 * name/signature/behavior it always did; only the internal `this.x()`
 * calls that used to reach a private class method now call an imported
 * function instead (none of those methods ever touched instance state —
 * this class was always a stateless orchestrator, so the two are
 * behaviorally identical).
 */

export type { EscrowRecord, SettlementProvider }
export { recommendedEscrowType }
// Issue #229 R3 — exported alongside recommendedEscrowType above, same
// reason: a pure decision function (asset/explicitType in, EscrowType
// out or throws) with no side effects, worth letting tests exercise and
// structurally inspect directly rather than only through the much larger
// createEscrow() surface.
export { resolveEscrowType }

// Missão 10, Fase 6.10/6.11 — the wire shape getEscrow()/getEscrowByTrade()
// expose for `EscrowParticipantKey` rows: trimmed to exactly what a
// recovering wallet needs to compare its own re-derived key against the
// server's registration (SDK's verifyRecoveredKeyRegistration(), "Level
// 2"). Deliberately narrower than the raw Prisma row — drops `id`,
// `escrowId` (redundant, caller already has it), `createdAt` (not needed
// for this purpose) — and renames `pubkey` -> `publicKeyHex` to match the
// naming convention the SDK's derivation types already use throughout.
// Gated by the SAME authorization the whole GET route already enforces
// (isParty || isAssignedArbiter, settlement.routes.ts) — no new
// authorization logic, no new route, no reverse pubkey->escrow lookup
// (that capability remains explicitly out of scope, deferred to a future
// "Seed-only Recovery Discovery" mission).
// Missão 11 Fase 9.1 §10 — attaches this escrow type's own disclosed
// custodyModel (getCustodyModelForType()'s own header comment has the
// full reasoning). Same gating as mapParticipantKeysShape() above: no new
// authorization, no new route, just one more curated field on the
// existing authenticated GET response.
function mapCustodyModelShape(escrow: any): any {
  return { ...escrow, custodyModel: getCustodyModelForType(escrow.type) }
}

function mapParticipantKeysShape(escrow: any): any {
  if (!escrow.participantKeys) return escrow
  return {
    ...escrow,
    participantKeys: escrow.participantKeys.map((k: { participantId: string; role: string; pubkey: string }) => ({
      participantId: k.participantId,
      role: k.role,
      publicKeyHex: k.pubkey,
    })),
  }
}

// Missão 11 Fase 7.2 §L — narrow, curated projection of this escrow's
// frozen distribution-policy history. Replaces the raw `feeObligation`
// relation (which carries internal accounting fields this route must not
// expose — distributedInBatchId, recipientAddress, createdBy, a
// recipient's identityKey) with exactly the historical-verification
// surface required: one entry per CONFIRMED collection generation this
// escrow's FeeObligation has ever had (normally one; more than one only
// after a reorg + reconfirmation), each carrying the policy that was
// independently frozen for THAT generation — never "the current live
// policy," which cannot prove what governed a specific past generation
// after a policy rotation (the exact gap this phase's CTO correction
// identified). No general EntitlementLedgerEntry data (Decision D).
function mapDistributionPolicyFreezesShape(escrow: any): any {
  const { feeObligation, ...rest } = escrow
  if (!feeObligation) return rest
  const distributionPolicyFreezes = (feeObligation.evidence ?? []).map((ev: any) => ({
    confirmationEvidenceId: ev.id,
    confirmedAt: ev.recordedAt,
    distributionPolicyVersionId: ev.distributionPolicyVersionId,
    distributionPolicy: ev.distributionPolicyVersion
      ? {
          id: ev.distributionPolicyVersion.id,
          label: ev.distributionPolicyVersion.label,
          publishedAt: ev.distributionPolicyVersion.publishedAt,
          recipients: ev.distributionPolicyVersion.recipients.map((r: any) => ({
            recipientId: r.recipientId,
            class: r.recipient.class,
            label: r.recipient.label,
            weightPct: r.weightPct,
          })),
        }
      : null, // a real, permanent outcome (Fase 7.2 §C) — no DistributionPolicyVersion was PUBLISHED when this generation was confirmed
  }))
  return { ...rest, distributionPolicyFreezes }
}

// F5 (docs/TECHNICAL_DEBT_AUDIT.md #52) — the canonical escrow-creation
// structural contract, shared with the SDK
// (packages/sails-sdk/src/modules/settlement.ts) and the route's own
// zod validator (settlement.routes.ts's createEscrowSchema), both of
// which now import the SAME type/enum-value source instead of each
// redeclaring their own copy. See packages/sails-p2p-schemas/src/escrow.ts
// for the full rationale and scope.
export type { CreateEscrowInput }

// VERTICAL-SLICE-1 (2026-09-12), generalized by Mission 4 (2026-09-14,
// docs/ADAPTIVE_EXECUTION_CAPABILITY_ROUTING.md) — the point where
// ADR-002's canonical SettlementScope/Provider registries become
// authoritative in a real, running journey, not merely
// available-but-unused.
//
// Runs for every legacy asset `translateLegacyAssetType()` can map to a
// canonical scope (ADR-002 §11's 5 high-confidence mappings: BTC,
// USDT_ERC20, USDT_TRC20, USDT_LIQUID, LIQUID_BTC) — widened from
// VERTICAL-SLICE-1's original BTC-only gate now that
// `execution-candidates.ts` makes the same resolution scope-agnostic.
// Outcome-preserving for both previously-covered cases: BTC still
// resolves to MULTISIG, USDT_ERC20 still resolves to WDK_USDT_EVM —
// same result, single mechanism instead of two independent hardcoded
// maps (this file's own `RECOMMENDED_ESCROW_TYPE` and the SDK's
// separately-maintained copy in `packages/sails-sdk/src/modules/settlement.ts`
// stay as-is for now; only the SERVER's authoritative resolution is
// unified here — see the design doc's Backlog Delta for the SDK-side
// follow-up this does not itself close).
// `LN_BTC` and every other legacy asset (deliberately ambiguous or
// unmapped per ADR-002 §11) still fall through to the untouched
// `recommendedEscrowType()` below, exactly as before this change.
//
// Why this must run even when `type` is already supplied, not only when
// omitted: `packages/sails-sdk/src/modules/settlement.ts`'s own
// `SailsSettlementModule.create()` resolves `type` CLIENT-SIDE, via its
// own separately-hardcoded `RECOMMENDED_ESCROW_TYPE` map, before ever
// calling this server — the real Reference UI (`Trade.tsx` -> SDK
// `create()`) therefore always sends an explicit `type` for a mapped
// asset, and a resolution gated on `input.type` being *absent* would
// never actually execute for that traffic (a real architectural bypass,
// found during VERTICAL-SLICE-1's own discovery pass). Making the
// canonical registry authoritative here — validating whatever `type`
// arrives (client-supplied or defaulted) against the scope's own
// registered implementation — is what makes it genuinely part of the
// real journey instead of a parallel, never-exercised code path.
//
// The pre-existing, intentional `type: 'MOCK'` override escape hatch
// (tests/escrowProviderWiring.test.ts's "an explicitly passed type is
// never overridden" — used for fake/test escrows regardless of asset)
// is preserved unconditionally, checked first, before any canonical
// lookup — EXCEPT in production. Issue #229: RT-001 (config/index.ts)
// already refuses to boot in production unless MOCK_ESCROW=false, which
// only ever governed the *implicit default* used when a caller omits
// `type` entirely (the branch just below this one). It never touched
// this branch — an authenticated participant could always reach
// MockSettlementProvider in production simply by passing `type: 'MOCK'`
// explicitly, regardless of NODE_ENV or any feature flag, because this
// check runs unconditionally before config is even consulted. Gated
// here too, at the one place an escrow's type is decided before the row
// is ever persisted, via the SAME canonical policy function
// (assertDeploymentEligible(), escrow-providers.ts) getSettlementProvider()
// itself now also calls — not a second, independently-maintained check.
//
// Corrected/Implemented 2026-09-19 (Issue #229 R2, CTO corrective
// mission) — this comment previously claimed provider dispatch was
// deliberately left ungated to avoid undoing Fase 7.3.1's fix for
// legacy/pre-existing MOCK rows. That reasoning was incomplete: Fase
// 7.3.1's actual property ("provider resolution trusts an already-
// persisted type unconditionally") only needs to hold for REAL types
// (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM/WDK_USDT_EVM), which still do,
// completely unaffected. It was never required to hold for MOCK, whose
// provider fabricates settlement success rather than doing real
// economic work — a persisted MOCK row surviving into a production
// database out-of-band (a promoted staging DB, or one created before
// this gate existed) must not be able to reactivate fake economic
// execution merely by existing. getSettlementProvider() now enforces
// this at dispatch time too — see its own header comment.
//
// Corrected/Implemented 2026-09-19 (Issue #229 R3, CTO corrective
// mission) — R2 called assertDeploymentEligible() only from inside the
// `explicitType === 'MOCK'` branch, which meant this function's own
// generic-policy claim was only true for that one path: the implicit
// mockEscrow-default branch, the canonical-registry branch, and the
// legacy-fallback branch each returned their resolved type without ever
// passing through the eligibility check. Refactored so resolution and
// eligibility are two separate steps — resolveEscrowTypeCandidate()
// below returns WHATEVER type any branch resolves to, and this function
// asserts eligibility on that single result once, unconditionally,
// before returning it to createEscrow() for persistence. No branch
// needs its own check; a future #220 addition to
// PRODUCTION_INELIGIBLE_TYPES is covered automatically, from whichever
// branch produces that type.
//
// Corrected/Implemented 2026-09-19 (Issue #243, Beta correctness
// remediation) — the #220 audit found this function verified deployment
// ELIGIBILITY but never verified a SettlementProvider is actually
// REGISTERED for the resolved type. A schema-valid, deployment-eligible
// type with zero runtime implementation (LIQUID_COVENANT — representable
// in ESCROW_TYPE_VALUES, never blocked by assertDeploymentEligible since
// it isn't in PRODUCTION_INELIGIBLE_TYPES either) could reach
// createEscrow()'s persistence step, permanently binding a trade to an
// escrow no provider could ever execute — the failure only surfaced
// later, at first lockFunds()/releaseFunds() call. Three genuinely
// different questions were being conflated: protocol-representable
// (ESCROW_TYPE_VALUES) ≠ runtime-registered (PROVIDERS) ≠ deployment-
// eligible (PRODUCTION_INELIGIBLE_TYPES). The standalone
// assertDeploymentEligible() call is replaced by getSettlementProvider(),
// which already runs that exact check FIRST, unconditionally, before its
// own registration check — same ordering the mission's own required
// property describes (eligibility, then registration), now one call
// instead of two. Discarding the return value is deliberate: this call
// exists purely for its two structural checks, never for the instance
// itself (every PROVIDERS entry is an already-constructed singleton —
// no network access, no provider initialization, no economic method
// invoked). Reusing this exact function rather than a second `type in
// PROVIDERS` check means creation can never drift from the real
// dispatch-time truth — they are now literally the same lookup.
/**
 * #235 R7F-B — TRADE_ESCROW_ECONOMIC_BINDING_V1. A trade-backed escrow
 * commits exactly the trade's economic intent: its asset and its principal
 * T (Escrow.lockedAmount = Trade.amount; the protocol fee reserve, R = T +
 * Fmax, is separate and never folded in — fee-reserve-math.ts). The caller's
 * `asset`/`lockedAmount` are assertions checked against the Trade, never
 * authority: a mismatch is refused, never silently replaced. Amounts are
 * compared as exact Decimals ("0.001" equals "0.0010"; one unit apart never
 * collapses). A trade whose AssetType has no authorized settlement
 * translation (ADR-002 §11: LN_BTC, USDT_LIGHTNING, SPARK, STACKS, RSK_BTC)
 * cannot be escrowed at all — no caller-chosen rail, MOCK included, may
 * decide what such a trade actually locks. Runs before anything is written.
 * Returns the Trade's own values to persist.
 */
function bindEscrowToTrade(
  trade: { id: string; asset: AssetType; amount: Prisma.Decimal | string },
  input: Pick<CreateEscrowInput, 'asset' | 'lockedAmount'>,
): { asset: AssetType; lockedAmount: string } {
  if (input.asset !== trade.asset) {
    throw new ValidationError(`Escrow asset ${input.asset} does not match trade ${trade.id}'s asset ${trade.asset}`)
  }
  const principal = new Prisma.Decimal(trade.amount.toString())
  let requested: Prisma.Decimal
  try {
    requested = new Prisma.Decimal(input.lockedAmount)
  } catch {
    throw new ValidationError(`lockedAmount "${input.lockedAmount}" is not a decimal amount`)
  }
  if (!requested.equals(principal)) {
    throw new ValidationError(
      `lockedAmount ${input.lockedAmount} does not equal trade ${trade.id}'s amount ${principal.toString()}: an escrow locks exactly the trade's principal (the protocol fee reserve is separate)`
    )
  }
  if (!translateLegacyAssetType(trade.asset)) {
    throw new EscrowError(
      `Trade ${trade.id} is in ${trade.asset}, which has no authorized settlement translation (ADR-002 §11) — no trade-backed escrow can be created for it`,
      'UNAVAILABLE'
    )
  }
  return { asset: trade.asset, lockedAmount: principal.toString() }
}

function resolveEscrowType(asset: AssetType, explicitType: EscrowType | undefined): EscrowType {
  const resolved = resolveEscrowTypeCandidate(asset, explicitType)
  getSettlementProvider(resolved)
  return resolved
}

function resolveEscrowTypeCandidate(asset: AssetType, explicitType: EscrowType | undefined): EscrowType {
  if (explicitType === 'MOCK') return 'MOCK'
  if (!explicitType && config.features.mockEscrow) return 'MOCK'

  const scope = translateLegacyAssetType(asset)
  if (scope) {
    const resolution = resolveSingleStructurallyCompatibleImplementation(scope.asset, scope.rail)
    if ('error' in resolution) {
      throw new EscrowError(`Cannot create a ${asset} escrow: ${resolution.error}`)
    }
    if (explicitType && explicitType !== resolution.implementation) {
      throw new EscrowError(
        `type '${explicitType}' does not match '${resolution.implementation}', the canonical settlement implementation registered for {${scope.asset}, ${scope.rail}} — refusing to create a semantically inconsistent ${asset} escrow.`
      )
    }
    return resolution.implementation
  }

  return explicitType ?? recommendedEscrowType(asset)
}

/**
 * #235 R7G F8B - SIGNATURE_COLLECTION_DISPOSITION_AUTHORITY_V1. On a signature-collection rail (MULTISIG,
 * LIGHTNING_HODL, SAFE_GUARD_EVM) the disposition authority is the persisted signing round
 * (EscrowPendingTransaction), never cooperativeDisposition / arbitratedDisposition. Their providers refuse a
 * direct release/refund/split anyway, but only after claimEscrowTransition() had frozen the caller's intent -
 * a false, durable disposition the reverted status left behind. Refused here, before any claim or write.
 */
function assertDirectlyExecutable(escrow: { id: string; type: string }, operation: 'release' | 'refund' | 'split'): void {
  if (!(escrow.type in SIGNATURE_COLLECTION_PROVIDERS)) return
  throw new EscrowError(
    `Escrow ${escrow.id} (${escrow.type}) settles only through signature collection: use POST /v1/settlement/escrow/${escrow.id}/initiate-${operation}, then submit-transaction-signature. Nothing was recorded.`
  )
}

/**
 * Expired FUNDS_LOCKED escrows one timelock sweep pass claims (claimExpiryCandidates()). The pass takes
 * one claim and is never re-run inside the same tick, so this bounds every pass:
 * - a Core candidate (MULTISIG, LIGHTNING_HODL, SAFE_GUARD_EVM) costs one trade read, one transaction
 *   (state + record + claimed transition) and one publish, no external call: measured ~15 ms each against
 *   local PostgreSQL (2,000 in 29.5 s), so a full batch is ~1.5 s of a 300 s default interval;
 * - a refund-branch candidate (MOCK, WDK_USDT_EVM, LIQUID_COVENANT) runs refundFunds(), a provider call
 *   whose own transport bounds its time; this caps how many of those one pass can start.
 * 100 per pass is 1,200 per hour per instance at the default interval, and instances claim disjoint batches.
 */
export const EXPIRY_SWEEP_BATCH = 100

export class EscrowService {
  constructor(private readonly repo: EscrowRepository = escrowRepository) {}

  // RFC-021 D9 — exposed so dispute.service.ts's applyRuling() can route a
  // ruling to the right fund-movement mechanism. Bug found while building
  // SPLIT (2026-08-02): applyRuling() previously called releaseFunds()/
  // refundFunds() unconditionally for every escrow type, but those throw
  // "not directly callable" for MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM
  // (client-held keys — see each provider's own releaseFunds() stub) —
  // meaning a disputed RELEASE/REFUND on those three escrow types could
  // never actually resolve through resolveDispute() at all; the dispute
  // row's RESOLVED status got written then immediately reverted by
  // applyRuling()'s own catch block. Never caught before because no test
  // exercised resolveDispute() against a non-MOCK/WDK escrow. Fixed here,
  // for all three rulings uniformly, not just SPLIT: a signature-collection
  // type now routes through initiateRelease()/initiateRefund()/
  // initiateSplit() instead, which is consistent with how the *cooperative*
  // (non-disputed) path already works for these types — funds finish
  // moving once the winning party submits their own signature, not
  // synchronously inside resolveDispute() itself.
  isSignatureCollectionType(type: string): boolean {
    return type in SIGNATURE_COLLECTION_PROVIDERS
  }

  // Shared by releaseFunds()/refundFunds() below — both are legitimately
  // triggered by either the seller (the normal path) or the arbiter
  // assigned to an open dispute on this trade (dispute.service.ts's
  // resolveDispute(), which validates the arbiter match itself *before*
  // calling into this class — this is a second, defense-in-depth check,
  // not the only one). Thin delegate to escrow-lifecycle.ts's free
  // function — kept as a public method here since it's the documented
  // call surface other modules already reach for.
  async isSellerOrAssignedArbiter(tradeId: string, sellerId: string, triggeredBy: string): Promise<boolean> {
    return isSellerOrAssignedArbiter(tradeId, sellerId, triggeredBy)
  }

  // SECURITY_AUDIT_REPORT.md §9 ("Escrow Bypass"), closed 2026-08-08 — this
  // method had NO membership check at all: any authenticated participant
  // could create an escrow against ANY trade, not just their own. Beyond
  // exposing the trade to attacker-chosen `type`/`lockedAmount`/`asset`
  // values, it was a real griefing vector — `trade.escrowId` being set
  // permanently blocks the real parties' own createEscrow() call below
  // (`EscrowError('Trade already has an escrow')`), so a stranger could
  // brick any trade they could merely guess the id of. `participantId`
  // required now — same "buyer or seller of the trade" bar every other
  // trade-mutating method in this file already enforces (see e.g.
  // submitParticipantKey()'s identical check a few lines below).
  // #235 R7H-E3 — narrowed to the SELLER: the seller commits the escrowed funds and the payment account the fiat
  // leg is paid into, so only the seller (participantId is always the authenticated caller, or a DB-derived
  // trade.sellerId for internal callers) can create the escrow. The account / method / policy binding itself is
  // decided in the repository transaction and by the database.
  async createEscrow(input: CreateEscrowInput, participantId: string) {
    // Reads Trade only to validate existence — this is a read, not a write,
    // so it does not violate the module boundary (OpenSettlement may read
    // cross-module state; it must never WRITE to another module's tables).
    const trade = await tradeRepository.findById(input.tradeId)
    if (!trade) throw new NotFoundError('Trade', input.tradeId)
    if (participantId !== trade.sellerId) {
      throw new ForbiddenError(participantId === trade.buyerId
        ? `Only the seller of trade ${trade.id} can create its escrow: the seller commits the escrowed funds and the payment account`
        : `${participantId} is not the seller of trade ${trade.id}`)
    }
    if (trade.escrowId) throw new EscrowError('Trade already has an escrow')
    // #235 R7G-A — fail fast; this.repo.create() re-checks under the trade-lifecycle lock.
    assertFirstEscrowAllowed(trade.id, trade.status)

    const { asset, lockedAmount } = bindEscrowToTrade(trade, input)
    const type = resolveEscrowType(asset, input.type)
    // #235 R7F-B (D4) — SAFE_GUARD_EVM locks native ETH, which no AssetType
    // represents, so it can never carry a trade's economic commitment.
    // Unreachable through bindEscrowToTrade() + resolveEscrowType() today
    // (every translated asset resolves to its own registered rail); kept as
    // an explicit refusal so a future resolution change cannot reopen it.
    if (type === 'SAFE_GUARD_EVM') {
      throw new EscrowError(`Trade ${trade.id} cannot use SAFE_GUARD_EVM: it locks native ETH, which is not the trade's asset (${asset})`, 'UNAVAILABLE')
    }

    // Master Backlog R5 — the timelock is protocol policy, frozen on the
    // escrow here; input.timelockHours (still accepted by the route for
    // compatibility) is never read. Re-checked although boot already
    // validated it, so no path can insert an escrow under an invalid value.
    const timelockHours = config.trade.defaultTimelockHours
    if (!isValidTimelockHours(timelockHours)) {
      throw new Error(`DEFAULT_TIMELOCK_HOURS policy value ${timelockHours} is not a valid escrow timelock — refusing to create an escrow`)
    }

    // Missão 11 Fase 4.1 §4 — computed BEFORE the escrow row exists and
    // folded into the SAME insert below, not a separate best-effort update
    // afterward (Fase 4's earlier, now-superseded design). This is what
    // makes the whole operation fail-closed by construction: if a
    // PUBLISHED policy exists for this rail, Fmax/R already depend on it,
    // so a failure computing or persisting the snapshot must fail escrow
    // creation itself — there is no separate persistence step left to
    // fail independently, and therefore no way for a fee-aware escrow to
    // silently end up downgraded to a legacy (feePolicyVersionId=NULL)
    // one because of a DB hiccup. Deliberately UNGUARDED (no try/catch):
    // a no-op (null) only when no PUBLISHED FeePolicyVersion exists for
    // this rail — which is every rail today (Fase 4's own scope boundary)
    // — so this has zero effect on any real deployment right now; any
    // OTHER failure here (a real active policy, but the lookup itself
    // errors) must propagate and fail this call, per CTO decision.
    const feeSnapshot = await escrowFeeSnapshotService.computeSnapshotFields(type, lockedAmount)

    // MULTISIG/LIGHTNING_HODL's buyer/seller keys are now client-held
    // (each provider's own header comment) — the deposit address
    // genuinely cannot be derived yet at creation time, only once both
    // parties have submitted their pubkey via submitParticipantKey()
    // below. Escrow.multisigAddr stays null until then.
    const escrow = await this.repo.create({
      tradeId: input.tradeId,
      type,
      lockedAmount,
      asset,
      network: input.network,
      timelockHours,
      requireGovernedRail: config.isProduction,
      ...(feeSnapshot ? { feeSnapshot } : {}),
    })

    await eventBus.emit('settlement.escrow.created', {
      escrowId: escrow.id,
      tradeId: escrow.tradeId,
      type: escrow.type,
      lockedAmount: escrow.lockedAmount.toString(),   // RFC-009 — Decimal -> decimal string at the event boundary
      asset: escrow.asset,
    }, escrow.tradeId)   // correlationId = tradeId (RFC-010)

    return escrow
  }

  // The client-held-keys write path (2026-07-27) — buyer/seller each call
  // this once, from their own client, submitting only their public key
  // (their private key never leaves the browser; see multisig.provider.ts's
  // and lightning-hodl.provider.ts's own header comments for the full
  // custody-model disclosure). Idempotent per role: a party resubmitting
  // overwrites their own row (upsert), same shape as approveRelease()
  // above. Once both buyer and seller rows exist, derives and persists
  // the real deposit address — this is the only place that now happens,
  // replacing createEscrow()'s old immediate-population branch.
  async submitParticipantKey(escrowId: string, participantId: string, pubkey: string, capabilityProfile?: string) {
    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)

    const provider = NON_CUSTODIAL_PROVIDERS[escrow.type]
    if (!provider) {
      throw new EscrowError(`Escrow type '${escrow.type}' does not use client-submitted keys — nothing to submit`)
    }

    const trade = await tradeRepository.findById(escrow.tradeId)
    if (!trade) throw new NotFoundError('Trade', escrow.tradeId)

    let role: 'buyer' | 'seller'
    if (participantId === trade.buyerId) role = 'buyer'
    else if (participantId === trade.sellerId) role = 'seller'
    else throw new ForbiddenError(`${participantId} is not a counterparty (buyer or seller) of trade ${trade.id}`)

    if (!PUBKEY_HEX_PATTERN.test(pubkey)) {
      throw new EscrowError('pubkey must be a 33-byte compressed secp256k1 public key, hex-encoded (66 hex characters, starting with 02 or 03)')
    }

    // Missão 11 Fase 9.1 §4/§5 — a garbage/unrecognized declaration is
    // rejected immediately, independent of escrow type (see
    // capability-profile.ts's own header comment for the full design and
    // the backward-compatibility decision an omitted declaration gets).
    assertKnownCapabilityProfile(capabilityProfile)

    // #235 R7G-B1 — a key, and the deposit address the second key derives, are
    // written under the trade-lifecycle lock a cancellation also takes, after
    // re-reading the trade: a cancelled trade gets no new funding surface, and a
    // cancellation that comes later sees the address (unilateral-revocation.ts).
    return prisma.$transaction(async (tx) => {
      await lockTradeLifecycle(tx, trade.id)
      const current = await tx.trade.findUnique({ where: { id: trade.id }, select: { status: true } })
      if (current?.status === 'CANCELLED') {
        throw new EscrowError(`Trade ${trade.id} is CANCELLED: no participant key can be submitted for its escrow`)
      }
      const fresh = await tx.escrow.findUnique({ where: { id: escrowId } })
      if (!fresh) throw new NotFoundError('Escrow', escrowId)

      // #235 R7G-B2A — SCRIPT_AUTHORITY_IMMUTABILITY_V1: once the funding
      // address exists, the keys that derived it are its authority. The same
      // key again is a no-op; any other key is refused (the database refuses it
      // too: escrow_participant_keys_script_authority_guard).
      if (fresh.multisigAddr) {
        const committed = await tx.escrowParticipantKey.findUnique({ where: { escrowId_role: { escrowId, role } } })
        const sameKey = committed && Buffer.from(committed.pubkey, 'hex').equals(Buffer.from(pubkey, 'hex'))
          && (committed.capabilityProfile ?? null) === (capabilityProfile ?? null)
        if (!sameKey) {
          throw new EscrowError(`Escrow ${escrowId}'s funding address is already derived from its participant keys — the ${role} key can no longer change`)
        }
        const keys = await tx.escrowParticipantKey.findMany({ where: { escrowId } })
        return { escrow: fresh, buyerKeySubmitted: keys.some((k) => k.role === 'buyer'), sellerKeySubmitted: keys.some((k) => k.role === 'seller') }
      }

      await tx.escrowParticipantKey.upsert({
        where: { escrowId_role: { escrowId, role } },
        update: { participantId, pubkey, capabilityProfile: capabilityProfile ?? null },
        create: { escrowId, role, participantId, pubkey, capabilityProfile: capabilityProfile ?? null },
      })

      const keys = await tx.escrowParticipantKey.findMany({ where: { escrowId } })
      const buyerKey = keys.find((k: { role: string }) => k.role === 'buyer')
      const sellerKey = keys.find((k: { role: string }) => k.role === 'seller')

      let updatedEscrow = fresh
      if (buyerKey && sellerKey && !fresh.multisigAddr && !config.features.mockEscrow) {
        // Missão 11 Fase 9.1 §4, fail-closed per Fase 9.1.1 CTO decision —
        // "a trade must not commit to [this escrow type] unless every
        // required participant has a compatible profile," checked right
        // here, immediately before the deposit address (the actual commit
        // point) is derived and persisted. An OMITTED declaration now
        // blocks exactly like an incompatible one — "unknown capability =
        // unsupported" applies to silence too, no exception for either
        // role or for who `participantId` happens to be.
        const blocker = findCapabilityCommitBlocker(
          escrow.type as EscrowType, buyerKey.capabilityProfile, sellerKey.capabilityProfile
        )
        if (blocker) {
          const detail = blocker.reason === 'missing'
            ? 'declared no capability profile at all'
            : `declared an incompatible capability profile ('${blocker.declared}')`
          throw new EscrowError(
            `Cannot commit escrow ${escrowId} to type '${escrow.type}': the ${blocker.role} ${detail} — ` +
            `every participant must declare a compatible capability profile before this escrow type can commit.`,
            'INELIGIBLE' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — a real maturity/capability-profile mismatch, not a technical, policy, or config gap
          )
        }

        const { address, arbiterPubkeyHex, arbiterId } = await provider.getDepositAddress(trade.id, buyerKey.pubkey, sellerKey.pubkey)
        updatedEscrow = await tx.escrow.update({ where: { id: escrowId }, data: { multisigAddr: address } })

        // Missão 11 Fase 5.2 §2/§3 — persist the escrow-specific, immutable
        // arbiter public-key commitment, using the EXACT bytes
        // getDepositAddress() just used to build the script (never a second,
        // independent derivation). Only MULTISIG populates arbiterPubkeyHex/
        // arbiterId today (LIGHTNING_HODL/SAFE_GUARD_EVM leave them
        // undefined — a disclosed, out-of-scope analogous gap, not fixed
        // this phase). create() (not upsert) — this row is meant to be
        // write-once; the DB trigger (escrow_participant_keys_arbiter_
        // immutability_guard) is the defense-in-depth backstop if this
        // branch is ever reached twice for the same escrow, which the
        // `!escrow.multisigAddr` guard above should already make impossible
        // in the normal flow.
        if (arbiterPubkeyHex && arbiterId) {
          await tx.escrowParticipantKey.create({
            data: { escrowId, role: 'arbiter', participantId: arbiterId, pubkey: arbiterPubkeyHex },
          })
        }
      }

      return { escrow: updatedEscrow, buyerKeySubmitted: !!buyerKey, sellerKeySubmitted: !!sellerKey }
    })
  }

  async lockFunds(escrowId: string, triggeredBy: string) {
    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    assertEscrowTransition(escrow.status, 'FUNDS_LOCKED')

    // Locking collateral is the seller's own action — see isPartyOrAgent()'s
    // doc comment (escrow-lifecycle.ts) for why an IDOR check was missing here.
    const trade = await tradeRepository.findById(escrow.tradeId)
    if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
    if (!isPartyOrAgent(asTrustedActor(triggeredBy), trade.sellerId)) {
      throw new ForbiddenError(`${triggeredBy} is not the seller of trade ${trade.id} — only the seller may lock escrow funds`)
    }

    // #235 R7G-F6B — a WDK LOCK is a signed, persisted transaction; the escrow becomes FUNDS_LOCKED only
    // when that transaction is final (WDK_TRANSFER_ATTEMPT_TRUTH_V1), never by an up-front claim.
    if (escrow.type === 'WDK_USDT_EVM') return lockWdkEscrow(escrowId, triggeredBy)

    // ─── Robustness-audit fix (2026-07-20): claim the transition
    // atomically BEFORE calling the external provider, not after. The
    // old code read `escrow.status`, checked it in memory
    // (assertEscrowTransition above), then called the real, side-effecting
    // provider — two concurrent lockFunds() calls for the same escrow
    // (double-click, a retried request after a timeout) would both pass
    // that in-memory check before either write landed, so both would go
    // on to call provider.lockFunds(). For WDK_USDT_EVM that means two
    // real on-chain calls for one escrow. The shared claimEscrowTransition
    // helper makes Postgres itself the arbiter: only the request whose
    // WHERE still matches the row's *current* status affects a row —
    // the loser gets `count: 0` and is rejected before ever touching the
    // provider, not after. ────────────────────────────────────────────
    //
    // #235 R7G-B1 — the FUNDS_LOCKED claim is made under the trade-lifecycle lock
    // a cancellation also takes, after re-reading the trade: a cancelled trade's
    // escrow is never locked (no provider call), and a cancellation that comes
    // later sees FUNDS_LOCKED and is refused. The provider call stays outside the
    // lock.
    await prisma.$transaction(async (tx) => {
      await lockTradeLifecycle(tx, escrow.tradeId)
      const current = await tx.trade.findUnique({ where: { id: escrow.tradeId }, select: { status: true } })
      if (current?.status === 'CANCELLED') {
        throw new EscrowError(`Trade ${escrow.tradeId} is CANCELLED: its escrow cannot be locked`)
      }
      await claimEscrowTransition(escrowId, escrow.status, 'FUNDS_LOCKED')
    })

    try {
      const provider = getSettlementProvider(escrow.type)
      // MULTISIG/LIGHTNING_HODL need the client-submitted pubkeys
      // (EscrowParticipantKey) to re-derive the same script lockFunds()
      // verifies against — every other provider ignores these extra
      // fields, same "optional, only two providers care" shape as
      // buyerId/sellerId below.
      const { buyerPubkey, sellerPubkey, arbiterPubkey } = NON_CUSTODIAL_PROVIDERS[escrow.type]
        ? await loadParticipantPubkeys(escrowId)
        : { buyerPubkey: undefined, sellerPubkey: undefined, arbiterPubkey: undefined }
      const result = await provider.lockFunds(providerEscrow(escrow, { buyerId: trade.buyerId, sellerId: trade.sellerId, buyerPubkey, sellerPubkey, arbiterPubkey }))

      const now = new Date()
      const expiresAt = new Date(now.getTime() + escrow.timelockHours * 3600 * 1000)

      // Missão 10 — result.vout is only populated by providers with a
      // real Bitcoin-style outpoint (MULTISIG today); every other
      // provider's lockFunds() return has no `vout`, so this stays null
      // for them — exactly the "no outpoint concept" case
      // txLockVout's own schema comment documents.
      //
      // Missão 11 Fase 4 §C — result.fundedAmount is only populated by a
      // provider that observed a real external funding value for a
      // policy-aware escrow (MULTISIG). Purely observational, per
      // Escrow.fundedAmount's own schema comment — never persisted for a
      // legacy escrow or a provider that doesn't report it.
      // #235 R7G-B2A — a persisted funding address is never re-pointed: a lock
      // that reports a different address fails closed (and the database
      // refuses the write: escrows_multisig_addr_write_once_guard).
      if (escrow.multisigAddr && result.address !== escrow.multisigAddr) {
        throw new EscrowError(`Escrow ${escrowId} was locked at ${result.address}, not at its persisted funding address ${escrow.multisigAddr} — refusing to change it`)
      }
      const updated = await this.repo.updateLockResult(escrowId, {
        txLockId: result.txId, txLockVout: result.vout ?? null, multisigAddr: escrow.multisigAddr ?? result.address, lockedAt: now, expiresAt,
        ...(result.fundedAmount !== undefined ? { fundedAmount: result.fundedAmount } : {}),
      })

      // Missão 11 Fase 9.1 §1 — the durable historical record of "funding
      // was accepted under evidence X at time T," so a later reorg
      // sweep (multisig-funding-reorg-sweep.ts) has something concrete to
      // invalidate/reconfirm against, and so this fact is never lost even
      // though Escrow.status/txLockId themselves are never retroactively
      // rewritten. Only meaningful for a provider with a real Bitcoin-style
      // outpoint (result.vout !== undefined — MULTISIG today); every other
      // provider has no funding-reorg concept to record.
      if (result.vout !== undefined) {
        await escrowFundingEvidenceRepository.record({
          escrowId, kind: 'OBSERVED_CONFIRMED', txid: result.txId, vout: result.vout,
          ...(result.fundedAmount !== undefined ? { amountSats: BigInt(Math.round(result.fundedAmount)) } : {}),
          ...(result.confirmedAtHeight !== undefined ? { observedAtHeight: result.confirmedAtHeight } : {}),
          ...(result.tipHeightAtObservation !== undefined ? { tipHeightAtObservation: result.tipHeightAtObservation } : {}),
        })
      }

      // NOTE: previously this method also called prisma.trade.update(...) to set
      // Trade.status = 'ACTIVE'. That write belonged to OpenP2P, not here. The
      // OpenP2P trade handler now does this in reaction to the event below.
      await emitEscrowTransition(escrowId, escrow.tradeId, 'CREATED', 'FUNDS_LOCKED', triggeredBy, 'settlement.escrow.locked', {
        txId: result.txId,
      })

      return updated
    } catch (err) {
      // Revert the claim — an escrow left claiming FUNDS_LOCKED with no
      // real lock behind it (the provider call failed) would otherwise
      // block every future lockFunds() attempt via assertEscrowTransition,
      // with no way to retry. Same revert-on-failure idiom
      // dispute.service.ts's resolveDispute() already established.
      await revertEscrowStatus(escrowId, 'FUNDS_LOCKED', escrow.status)
      throw err
    }
  }

  async markPaymentSent(escrowId: string, triggeredBy: string) {
    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    assertEscrowTransition(escrow.status, 'PAYMENT_PENDING')

    // Missão 11 Fase 9.1 §2 — the single most direct case this closure
    // exists for: a buyer claiming they've sent real-world fiat based on
    // funding evidence a background reorg sweep has already invalidated.
    await assertFundingNotUncertain(escrowId, escrow.type)
    // #235 R7G-F6B — PAYMENT_CLAIM_REQUIRES_PROVEN_FUNDING_V1 (early, cheap; re-checked under the lock below).
    if (escrow.type === 'WDK_USDT_EVM') await assertWdkFundingProven(prisma, escrowId)

    // Claiming fiat was sent is the buyer's own claim — see isPartyOrAgent()'s doc comment.
    const trade = await tradeRepository.findById(escrow.tradeId)
    if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
    if (!isPartyOrAgent(asTrustedActor(triggeredBy), trade.buyerId)) {
      throw new ForbiddenError(`${triggeredBy} is not the buyer of trade ${trade.id} — only the buyer may confirm payment sent`)
    }

    // No external provider call here, but still atomic (robustness audit,
    // 2026-07-20) — a double-click could otherwise write the same
    // transition twice, emitting settlement.escrow.payment_pending
    // twice for one real event. NOTE: this is a pre-existing,
    // undeduplicated duplicate of escrow-lifecycle.ts's
    // claimEscrowTransition() — it deliberately does NOT go through that
    // helper because that one also gates on VALID_TRANSITIONS, a check
    // this call site has never had; preserved as-is, not merged, to avoid
    // a silent behavior change in fund-adjacent code.
    //
    // Missão 11 Fase 9.3 — the AUTHORITATIVE funding-uncertainty re-check
    // (the early assertFundingNotUncertain() above is only a cheap
    // fail-fast) and the transition claim now run inside the same
    // withEscrowFundingLock() transaction, closing the window where a
    // concurrent reorg-sweep tick could invalidate the evidence between
    // the earlier check and this write. See escrow-lifecycle.ts's own
    // header comment on withEscrowFundingLock() for why this specific
    // mechanism closes the race.
    const claimedCount = await withEscrowFundingLock(escrowId, async (tx) => {
      if (escrow.type === 'WDK_USDT_EVM') await assertWdkFundingProven(tx, escrowId)
      const uncertain = await escrowFundingEvidenceService.isFundingUncertain(escrowId, tx)
      if (uncertain) {
        throw new EscrowError(
          `Escrow ${escrowId}'s funding evidence became uncertain (reorg or replacement detected) while this request was in flight — refusing to record payment confirmation. Refunding, raising a dispute, or waiting for reconfirmation remain available.`
        )
      }
      return this.repo.claimTransition(escrowId, escrow.status, 'PAYMENT_PENDING', tx)
    })
    if (claimedCount === 0) {
      throw new EscrowError(`Escrow ${escrowId} was already transitioned by a concurrent request`)
    }
    const updated = await this.repo.findById(escrowId)

    await emitEscrowTransition(
      escrowId,
      escrow.tradeId,
      'FUNDS_LOCKED',
      'PAYMENT_PENDING',
      triggeredBy,
      'settlement.escrow.payment_pending'
    )

    return updated
  }

  // `toAddress` is a TRUSTED-INTERNAL-CALLER value, never a raw HTTP
  // request field — see escrow-lifecycle.ts's resolvePayoutAddress() own
  // "AUTHORITY BOUNDARY" comment (M8-R2, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md).
  // settlement.routes.ts's `/release` always passes undefined here, so a
  // cooperative release resolves the buyer's own registered PayoutAddress.
  // dispute.service.ts's legacy applyRuling() (LIGHTNING_HODL/
  // SAFE_GUARD_EVM/WDK_USDT_EVM/MOCK disputes, unmigrated) still passes
  // the arbiter's own releaseToAddress here — a disclosed residual gap,
  // not fixed by M8-R2 (out of that mission's bounded scope).
  // Issue #254 - disputeId (additive, optional) is set ONLY by dispute.service.ts's applyRuling() for a
  // real RELEASE ruling - captured into the settlement.escrow.released event's own payload (below) so
  // common/events/handlers.ts's reputation-outcome derivation never needs to re-query CURRENT (mutable,
  // appeal()-reinterpretable) Dispute state. Absent for every cooperative, non-disputed release.
  async releaseFunds(escrowId: string, toAddress: string | undefined, triggeredBy: string, disputeId?: string) {
    const { escrow, trade } = await loadEscrowWithAuthorization(escrowId, triggeredBy)
    assertDirectlyExecutable(escrow, 'release')
    assertEscrowTransition(escrow.status, 'COMPLETED')
    assertWdkOutboundCaller(escrow, 'release', [toAddress])
    const resolvedToAddress = await resolvePayoutAddress(toAddress, trade.buyerId, escrow.asset)

    // RFC-014: the real capability check. Lives here, not in
    // settlement-orchestrator.ts (where it originally shipped) — found
    // while implementing RFC-015 that this is the actual single choke
    // point every real release goes through (settlement-orchestrator.ts's
    // executeSettlement(), settlement.routes.ts's direct
    // POST /v1/settlement/escrow/:id/release, and dispute.service.ts's
    // arbitrated resolveDispute()); a check placed only in the
    // orchestrator silently missed the other two. Off by default
    // (config.features.enforceCapabilities) — see that flag's own doc
    // comment in config/index.ts. Missão 06.9 — moved into the shared
    // checkFundMovementCapability() helper (escrow-lifecycle.ts) so
    // refundFunds()/splitFunds() below get the identical check instead
    // of silently missing it, same class of gap this comment already
    // describes for the pre-RFC-015 orchestrator-only version.
    await checkFundMovementCapability(triggeredBy, 'settlement.escrow.released')

    // RFC-015: two-person control. Only on the normal (non-disputed)
    // path — escrow.status is still the pre-transition value here
    // (PAYMENT_PENDING for a normal release, DISPUTED for an arbitrated
    // one, both allowed by assertEscrowTransition above). An arbitrated release
    // already went through dispute.service.ts's own authorization
    // (only the assigned, TRUSTED_ARBITRATORS-configured arbiter may
    // call resolveDispute()) — requiring the original two counterparties
    // to *also* agree would defeat the point of arbitration existing at
    // all (if they could still agree, there'd be no dispute). Off by
    // default (config.features.requireDualApprovalForRelease) — see that
    // flag's own doc comment in config/index.ts.
    if (config.features.requireDualApprovalForRelease && escrow.status === 'PAYMENT_PENDING') {
      const dual = await dualApproval.hasDualApproval(escrowId)
      if (!dual) {
        throw new EscrowError(
          `Release blocked: both counterparties must call POST /v1/settlement/escrow/${escrowId}/approve-release ` +
          'before funds can be released (RFC-015 two-person control).'
        )
      }
    }

    // ─── Robustness-audit fix (2026-07-20), the highest-severity finding
    // of this pass: this is the one call in the entire codebase that can
    // move real money (WDK_USDT_EVM signs and broadcasts a real on-chain
    // USDT transfer). The old code called `provider.releaseFunds()`
    // straight after the in-memory `assertEscrowTransition` check above, with
    // no DB-level guard before it — two concurrent releaseFunds() calls
    // for the same escrow (a double-click, a client retrying after a
    // timeout that actually succeeded server-side, or a race between
    // executeSettlement()'s auto-settle path and a manual API call)
    // would both pass assertEscrowTransition before either write landed, and
    // both would go on to sign and broadcast a real transfer — an actual
    // double-payment, not a theoretical one. Fixed the same way
    // lockFunds() above now is: atomically claim COMPLETED via a
    // conditional `updateMany` *before* ever calling the provider, so a
    // concurrent loser is rejected before touching real funds, not after.
    // #235 R7G-F6C - a WDK release is planned from durable authority (proven funding, the buyer's registered
    // payout address, the full locked amount) before the claim, and executed by the signed outbound authority.
    const wdkLegs = escrow.type === 'WDK_USDT_EVM' ? await planWdkOutbound(escrow, 'RELEASE', { buyer: resolvedToAddress }) : null
    await claimEscrowTransition(escrowId, escrow.status, 'COMPLETED', { triggeredBy })

    // Issue #291 - two distinct error boundaries. Only a failing PROVIDER call
    // reverts the claim; once it has returned, external execution may already
    // have happened and a later local failure must never pretend it did not.
    // #235 R7G-F6C (DF1) - a WDK outbound failure reverts the claim only when nothing was signed.
    let result: { txId: string }
    try {
      if (wdkLegs) {
        result = { txId: (await settleWdkOutbound(escrowId, wdkLegs)).join(',') }
      } else {
        const provider = getSettlementProvider(escrow.type)
        result = await provider.releaseFunds(
          providerEscrow(escrow, { buyerId: trade.buyerId, sellerId: trade.sellerId, triggeredBy }),
          resolvedToAddress
        )
      }
    } catch (err) {
      if (wdkLegs) throw await wdkOutboundFailure(escrowId, 'COMPLETED', escrow.status, err)
      await revertEscrowStatus(escrowId, 'COMPLETED', escrow.status)
      throw err
    }

    try {

      // RFC-021 Phase 0's chargeProtocolFee() lived here until Missão 11
      // Fase 6.5.2's single-economic-authority cutover removed it —
      // FeeCollectionEvidence(CONFIRMED) -> FeeObligation -> a frozen
      // DistributionPolicyVersion -> EntitlementLedgerEntry (below) is now
      // the only normative source of a future economic entitlement.
      // Escrow.feeCharged is retained as a schema column (historical rows
      // remain readable) but is never set again by this path — always
      // null going forward, exactly as it already was in every real
      // environment (PROTOCOL_FEE_RATE has never been set above 0).
      const feeCharged = null

      const updated = await this.repo.updateReleaseResult(escrowId, {
        txReleaseId: result.txId, releasedAt: new Date(), feeCharged,
      })

      // Missão 11 Fase 3 — the policy-versioned FeeObligation accounting,
      // the real upstream of the sole future economic authority (Fase
      // 6.5.2). A no-op today for every real escrow (feePolicyVersionId
      // is null until a future phase wires escrow-fee-snapshot.service.ts
      // into createEscrow()).
      await feeObligationService.recordObligationForEscrowSettlement(escrow, 'RELEASE')

      // NOTE: previously this method also updated Trade.status/completedAt AND
      // incremented User.totalTrades/totalVolumeBtc directly (reaching into
      // OpenP2P's and OpenReputation's domains). Both writes are now owned by
      // their respective modules, triggered by the event emitted below.
      await emitEscrowTransition(escrowId, escrow.tradeId, escrow.status, 'COMPLETED', triggeredBy, 'settlement.escrow.released', {
        txId: result.txId,
        ...(disputeId ? { disputeId } : {}),
      })

      return updated
    } catch (err) {
      // Issue #291 - the provider already succeeded (see above): never revert
      // here. Reconciliation converges the escrow from durable facts.
      throw settlementSucceededButLocalStepFailed(escrowId, 'release', result.txId, err)
    }
  }

  async openDispute(escrowId: string, triggeredBy: string, reason: string) {
    await this.openDisputeEstablishing(escrowId, triggeredBy, reason, async () => undefined)
    return this.repo.findById(escrowId)
  }

  /**
   * Issue #238 - the escrow freeze and the durable facts that make it a valid dispute are one commit.
   * Same authorization and lifecycle checks as before; then, in ONE transaction under the escrow's
   * advisory lock (withEscrowFundingLock(), which also serializes the EscrowEvent hash chain): the
   * conditional DISPUTED claim, its transition record ('transition.claimed', recoverable by settlement
   * reconciliation PASS 3) and `establish(tx)` - raiseDispute()'s Dispute row + assigned arbiter. Any
   * failure rolls all of it back: no committed DISPUTED without its Dispute, and no Dispute without the
   * freeze. Publishing the transition event happens after the commit (publishEscrowTransition()).
   */
  async openDisputeEstablishing<T>(escrowId: string, triggeredBy: string, reason: string, establish: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    assertEscrowTransition(escrow.status, 'DISPUTED')

    // Defense in depth: dispute.service.ts's raiseDispute() already makes
    // this exact check before ever calling here (its only real caller
    // today) — kept here too so this method is safe to call directly if
    // a second caller is ever added, consistent with the "the real check
    // belongs at the actual choke point" lesson from RFC-014/015.
    const trade = await tradeRepository.findById(escrow.tradeId)
    if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
    if (!isPartyOrAgent(asTrustedActor(triggeredBy), trade.buyerId) && !isPartyOrAgent(asTrustedActor(triggeredBy), trade.sellerId)) {
      throw new ForbiddenError(`${triggeredBy} is not a party to trade ${trade.id}`)
    }

    // Atomic conditional update — see lockFunds()'s comment. No external
    // provider call here, but dispute.service.ts's raiseDispute() itself
    // already has its own @@unique([tradeId]) guard at the Dispute-row
    // level (2026-07-19 security round); this closes the same race one
    // layer down, at the Escrow row this method actually mutates.
    // Same pre-claim gates and lost-race handling as claimEscrowTransition(), with the claim inside
    // the transaction below.
    assertCircuitClosed(escrowId)
    const committed = await withEscrowFundingLock(escrowId, async (tx) => {
      if (await this.repo.claimTransition(escrowId, escrow.status, 'DISPUTED', tx) === 0) return null
      const transitionId = await claimEscrowTransitionRecord(tx, {
        escrowId, from: escrow.status, to: 'DISPUTED', triggeredBy, eventName: 'settlement.escrow.disputed', note: reason,
      })
      if (!transitionId) {
        // Still in escrow.status a moment ago, so no DISPUTED transition can exist unless written by
        // hand - fail closed, rolling the claim back (commitAuthoritativeEscrowTimelockExpiry()'s rule).
        throw new EscrowError(`Escrow ${escrowId} already has a DISPUTED transition recorded while still ${escrow.status} - not committing a second one`)
      }
      return { transitionId, established: await establish(tx) }
    })
    if (!committed) {
      recordEscrowConflict(escrowId)
      throw new EscrowError(`Escrow ${escrowId} was already transitioned by a concurrent request`)
    }

    await publishEscrowTransition(escrowId, escrow.tradeId, escrow.status, 'DISPUTED', triggeredBy, 'settlement.escrow.disputed', {}, committed.transitionId)
    return committed.established
  }

  // Issue #254 - disputeId, same additive/optional shape and reason as releaseFunds()'s own comment above.
  async refundFunds(escrowId: string, triggeredBy: string, disputeId?: string) {
    const { escrow, trade } = await loadEscrowWithAuthorization(escrowId, triggeredBy)
    assertDirectlyExecutable(escrow, 'refund')
    assertEscrowTransition(escrow.status, 'REFUNDED')
    // #235 R7G-F6B — DF2: a refund of a never-locked escrow must not become a second economic operation
    // while a LOCK transaction may hold or move its funds. Checked before the outbound gate below so it
    // stands on its own when outbound authority exists (F6C).
    if (escrow.type === 'WDK_USDT_EVM' && escrow.status === 'CREATED' && await wdkLockMayHoldFunds(escrowId)) {
      throw new EscrowError(`Escrow ${escrowId} is CREATED but has a WDK LOCK transaction that may hold or move funds — refusing a refund until that LOCK is resolved`)
    }
    assertWdkOutboundCaller(escrow, 'refund', [])
    if (escrow.type === 'WDK_USDT_EVM' && escrow.status === 'CREATED') {
      throw new EscrowError(`Escrow ${escrowId} is CREATED: its WDK funding was never proven, so there is nothing to refund on-chain — refusing a WDK refund`)
    }

    // Missão 06.9 (RFC-014 wiring completion) — same check releaseFunds()
    // above already had; refund moves the exact same class of real,
    // signed funds and was found (Missão 06.7's audit) to have no
    // capability check at all, a real gap, not a deliberate exemption.
    await checkFundMovementCapability(triggeredBy, 'settlement.escrow.refunded')

    // #235 R7G-F6C - a WDK refund returns the full locked amount to the treasury that funded the LOCK.
    const wdkLegs = escrow.type === 'WDK_USDT_EVM' ? await planWdkOutbound(escrow, 'REFUND', {}) : null
    // Same fix as releaseFunds() above, same reason: claim REFUNDED
    // atomically before ever calling the real, side-effecting provider.
    await claimEscrowTransition(escrowId, escrow.status, 'REFUNDED', { triggeredBy })

    let result: { txId: string }
    try {
      if (wdkLegs) {
        result = { txId: (await settleWdkOutbound(escrowId, wdkLegs)).join(',') }
      } else {
        const provider = getSettlementProvider(escrow.type)
        result = await provider.refundFunds(
          providerEscrow(escrow, { buyerId: trade.buyerId, sellerId: trade.sellerId, triggeredBy })
        )
      }
    } catch (err) {
      if (wdkLegs) throw await wdkOutboundFailure(escrowId, 'REFUNDED', escrow.status, err)
      await revertEscrowStatus(escrowId, 'REFUNDED', escrow.status)
      throw err
    }

    try {

      const updated = await this.repo.updateRefundResult(escrowId, result.txId)

      // Missão 11 Fase 3 — FULL_REFUND is always NOT_APPLICABLE (Fase 1.2
      // §1, unchanged) — recorded explicitly here rather than left as an
      // absent row (Fase 2.1 §3's own auditability finding).
      await feeObligationService.recordObligationForEscrowSettlement(escrow, 'FULL_REFUND')

      await emitEscrowTransition(escrowId, escrow.tradeId, escrow.status, 'REFUNDED', triggeredBy, 'settlement.escrow.refunded', {
        txId: result.txId,
        ...(disputeId ? { disputeId } : {}),
      })

      return updated
    } catch (err) {
      throw settlementSucceededButLocalStepFailed(escrowId, 'refund', result.txId, err)
    }
  }

  // RFC-021 D9 (2026-08-02) — the direct-call half of SPLIT's real
  // settlement action, for providers in PROVIDERS that move funds
  // synchronously in one call (MOCK, WDK_USDT_EVM this pass). Mirrors
  // releaseFunds()/refundFunds() above — same atomic-claim-before-
  // provider-call race protection, and (Missão 06.9, corrected — this
  // comment previously claimed "same authorization check" too, which
  // was false until this pass actually wired it) now the same capability
  // check as well — only reachable from DISPUTED (VALID_TRANSITIONS),
  // since SPLIT has no non-disputed happy path. See initiateSplit()
  // (escrow-pending-tx.ts) for the client-signature-collection
  // equivalent (MULTISIG).
  async splitFunds(escrowId: string, buyerAddress: string | undefined, sellerAddress: string | undefined, buyerBps: number, triggeredBy: string) {
    if (!(buyerBps > 0 && buyerBps < 10000)) {
      throw new ValidationError('buyerBps must be strictly between 0 and 10000 for a real split — use release/refund for an all-or-nothing outcome')
    }
    const { escrow, trade } = await loadEscrowWithAuthorization(escrowId, triggeredBy)
    assertDirectlyExecutable(escrow, 'split')
    assertEscrowTransition(escrow.status, 'SPLIT')
    assertWdkOutboundCaller(escrow, 'split', [buyerAddress, sellerAddress])
    await checkFundMovementCapability(triggeredBy, 'settlement.escrow.split')
    const resolvedBuyerAddress = await resolvePayoutAddress(buyerAddress, trade.buyerId, escrow.asset)
    const resolvedSellerAddress = await resolvePayoutAddress(sellerAddress, trade.sellerId, escrow.asset)

    const provider = getSettlementProvider(escrow.type)
    if (!provider.splitFunds) {
      throw new EscrowError(
        `Escrow type '${escrow.type}' does not support a SPLIT settlement action — see that provider's own splitFunds()/buildUnsignedSplit() comment for the specific reason (contract/protocol limitation, not a missing wire-up).`
      )
    }

    // #247/#248 - the claim freezes the arbitrated intent (SPLIT at buyerBps) before any provider side
    // effect; a failed provider call below reverts only the status, so a retry - by whoever is then the
    // assigned arbiter (checked above) - must present this identical allocation.
    // #235 R7G-F6C - a WDK split is two legs frozen here: floor(amount x buyerBps / 10000) to the buyer, the
    // exact remainder to the seller, each to its registered payout address.
    const wdkLegs = escrow.type === 'WDK_USDT_EVM'
      ? await planWdkOutbound(escrow, 'SPLIT', { buyer: resolvedBuyerAddress, seller: resolvedSellerAddress }, buyerBps)
      : null
    await claimEscrowTransition(escrowId, escrow.status, 'SPLIT', { triggeredBy, splitBuyerBps: buyerBps })

    let result: { txIds: string[] }
    try {
      result = wdkLegs
        ? { txIds: await settleWdkOutbound(escrowId, wdkLegs) }
        : await provider.splitFunds!(
          providerEscrow(escrow, { buyerId: trade.buyerId, sellerId: trade.sellerId, triggeredBy }),
          resolvedBuyerAddress,
          resolvedSellerAddress,
          buyerBps
        )
    } catch (err) {
      if (wdkLegs) throw await wdkOutboundFailure(escrowId, 'SPLIT', escrow.status, err)
      await revertEscrowStatus(escrowId, 'SPLIT', escrow.status)
      throw err
    }

    try {

      const updated = await this.repo.updateSplitResult(escrowId, {
        txReleaseId: result.txIds.join(','), releasedAt: new Date(),
      })

      // Missão 11 Fase 3 — SPLIT is OWED, basis = seller's bps-derived
      // portion only (buyerBps out of 10000; seller gets the remainder —
      // escrow-providers.ts's own SettlementProvider.splitFunds() comment).
      await feeObligationService.recordObligationForEscrowSettlement(escrow, 'SPLIT', buyerBps)

      // Joined into the shared txId?: string field (SettlementEscrowStatusChangedEvent)
      // rather than widening that event's payload for the one settlement
      // action that can produce two transaction hashes instead of one.
      await emitEscrowTransition(escrowId, escrow.tradeId, escrow.status, 'SPLIT', triggeredBy, 'settlement.escrow.split', {
        txId: result.txIds.join(','),
      })

      return updated
    } catch (err) {
      throw settlementSucceededButLocalStepFailed(escrowId, 'split', result.txIds.join(','), err)
    }
  }

  // ─── RFC-015 two-person control — thin delegates to escrow-dual-approval.ts ──
  async approveRelease(escrowId: string, approverId: string) {
    return dualApproval.approveRelease(escrowId, approverId)
  }

  async getReleaseApprovals(escrowId: string) {
    return dualApproval.getReleaseApprovals(escrowId)
  }

  async hasDualApproval(escrowId: string): Promise<boolean> {
    return dualApproval.hasDualApproval(escrowId)
  }

  // ─── Client-signature-collection flow — thin delegates to escrow-pending-tx.ts ──
  async initiateRelease(escrowId: string, toAddress: string | undefined, triggeredBy: string) {
    return pendingTx.initiateRelease(escrowId, toAddress, triggeredBy)
  }

  async initiateRefund(escrowId: string, triggeredBy: string, toAddress?: string) {
    return pendingTx.initiateRefund(escrowId, triggeredBy, toAddress)
  }

  async initiateSplit(escrowId: string, buyerAddress: string | undefined, sellerAddress: string | undefined, buyerBps: number, triggeredBy: string) {
    return pendingTx.initiateSplit(escrowId, buyerAddress, sellerAddress, buyerBps, triggeredBy)
  }

  async submitTransactionSignature(escrowId: string, participantId: string, signedPsbtBase64: string) {
    return pendingTx.submitTransactionSignature(escrowId, participantId, signedPsbtBase64)
  }

  async getPendingTransaction(escrowId: string, viewerId: string) {
    return pendingTx.getPendingTransaction(escrowId, viewerId)
  }

  // `disputes` — real gap found while closing the arbiter's own dispute-
  // discovery gap (settlement.routes.ts's new GET /v1/settlement/disputes):
  // whoever CALLS raiseDispute() gets the created Dispute row directly in
  // that response, but the OTHER trade party — who didn't open it — had no
  // way to ever learn the disputeId at all. No listener reacts to
  // `dispute.opened` to push it over the trade's WebSocket room either.
  // `Escrow.disputes` (schema.prisma) already existed as a relation; this
  // just includes it, so the same public GET a trade party already polls
  // for escrow status now also answers "is there a dispute, and what's its
  // id" — no schema change, no new route needed.
  async getEscrow(escrowId: string) {
    const escrow = await this.repo.findByIdWithDetails(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    return mapCustodyModelShape(mapParticipantKeysShape(mapDistributionPolicyFreezesShape(escrow)))
  }

  async getEscrowByTrade(tradeId: string) {
    const escrow = await this.repo.findByTradeIdWithDetails(tradeId)
    if (!escrow) throw new NotFoundError('Escrow for this trade', tradeId)
    return mapCustodyModelShape(mapParticipantKeysShape(mapDistributionPolicyFreezesShape(escrow)))
  }

  // Real gap found (BACKLOG.md P0, "Escrow timelock proactive sweeper"):
  // lockFunds() computes and stores a real Escrow.expiresAt, but nothing
  // ever read it back — a FUNDS_LOCKED escrow whose counterparty never
  // returns stayed locked forever, with no automatic path back to
  // REFUNDED. This is the "notice time has passed" trigger that row
  // said was the only missing piece; refundFunds() itself already
  // existed and is reused unchanged below.
  //
  // triggeredBy is always the trade's own sellerId, never a fabricated
  // "system" actor — isSellerOrAssignedArbiter() only accepts the real
  // seller or an assigned arbiter (INV-OP-1), and a timelock refund
  // returns the seller their own locked collateral, the same effect the
  // seller could trigger themselves by calling this route directly once
  // expiresAt has passed. This mirrors settlement-orchestrator.ts's own
  // `sellerTriggeredBy` precedent for automated, non-human-initiated
  // calls into this same method.
  //
  // Per-escrow try/catch, same "one failure must not stop the rest"
  // shape as getAggregatedOffers() (liquidity.service.ts) — a single
  // stuck/already-transitioning escrow must not block every other
  // legitimately expired one in the same sweep.
  // Missão 11 Fase 7.3.1 §C — real P0 closed (Fase 7.3 audit): for a
  // signature-collection escrow type (MULTISIG/LIGHTNING_HODL/
  // SAFE_GUARD_EVM — buyer/seller keys are client-held), this.refundFunds()
  // unconditionally throws ("not directly callable — buyer/seller keys
  // are client-held") — the sweep used to attempt it anyway, every cycle,
  // forever, landing in `failed` alongside genuine errors with no way for
  // an operator to distinguish "this will never succeed by design" from
  // "something is actually broken." Worse, it silently gave no signal
  // that this escrow needs any attention at all beyond a generic error.
  //
  // Root-cause protocol semantics (derived from what already exists, not
  // invented here): a non-disputed cooperative refund still needs BOTH
  // buyer and seller signatures (buildUnsignedRefund()'s own comment) —
  // exactly the case the buyer being unresponsive rules out. The ONLY
  // cryptographically possible unilateral path is the arbiter's
  // co-signature, which requires the escrow to actually be DISPUTED
  // first (buildUnsignedRefund()'s disputed branch pre-signs with the
  // arbiter key, needing only the seller's signature). Raising a dispute
  // is ALREADY something the seller can do unilaterally today —
  // dispute.service.ts's raiseDispute() only requires the caller be a
  // real trade party, not both parties' cooperation — so no new
  // authority, no new caller category, and no server custody of any key
  // is introduced here. What was actually missing is real signal: this
  // sweep now recognizes "expired, but this rail can never be
  // auto-refunded" as its own real outcome, with a real emitted event
  // (for an operator/UI to act on: raise a dispute on the seller's
  // behalf, through the seller's own authenticated session) instead of a
  // silent, indistinguishable failure.
  //
  // Missão 11 Fase 7.3.3 §B (CTO-selected: Model C + Model A) — the
  // event-only signal above is now backed by a real, durable, queryable
  // state transition: FUNDS_LOCKED -> EXPIRED (schema.prisma's own
  // EscrowStatus.EXPIRED comment has the full design rationale). This is
  // purely an OBSERVATION of a real fact — the timelock genuinely
  // expired with no cooperative resolution — never a fund-moving action,
  // never a signature, never a party-authorized transition. `triggeredBy`
  // is the honest, structurally-non-participant string 'system:expiry-sweeper'
  // (same "clearly-labeled non-human identity" convention as the
  // existing `agent:{label}:{participantId}` shape — deliberately never
  // matching isPartyOrAgent()'s own regex, since no participant
  // authorization check applies to observing a real timestamp having
  // passed). Idempotent by construction: claimExpiryCandidates() only
  // ever queries status='FUNDS_LOCKED', so an escrow already transitioned
  // to EXPIRED is structurally excluded from every later sweep tick —
  // the same idempotency mechanism (query-scoped, not a separate flag)
  // already used everywhere else in this codebase for this exact class
  // of problem. The actual, authorized recovery action (raising a
  // dispute) is the seller's own — see dispute.service.ts's
  // initiateExpiryRecovery() and this phase's own authority-matrix
  // report for why seller-only is correct here, not assumed.
  async sweepExpiredEscrows(): Promise<{
    refunded: string[]
    requiresManualRecovery: string[]
    failed: Array<{ escrowId: string; error: string }>
  }> {
    // Captured once and reused for BOTH the M4 authoritative evaluation
    // and the M3 shadow observation below, so Core evaluates the exact
    // same (deadline, now) pair the query already used to select each
    // escrow — never a second, independently captured clock read, which
    // would introduce spurious clock-skew "divergence" unrelated to any
    // real semantic difference.
    const now = new Date()

    const refunded: string[] = []
    const requiresManualRecovery: string[] = []
    const failed: Array<{ escrowId: string; error: string }> = []
    const SYSTEM_SWEEPER_ID = 'system:expiry-sweeper'

    // One bounded claim per pass (claimExpiryCandidates(), escrow-repository.ts): at most
    // EXPIRY_SWEEP_BATCH expired FUNDS_LOCKED escrows, in durable round-robin order, disjoint from what a
    // concurrent pass on another instance claims. A larger backlog drains over the following passes.
    // Both branches below take their candidates from it, each with its own predicate.
    const candidates = await this.repo.claimExpiryCandidates(now, EXPIRY_SWEEP_BATCH)

    // ---- Target slice (Sails Core Implementation Program M4): --------
    // FUNDS_LOCKED -> EXPIRED, now exclusively Core-authoritative. This
    // is the ONLY escrow class VALID_TRANSITIONS (escrow-lifecycle.ts)
    // ever lets reach EXPIRED — the disjoint refund branch below can
    // never overlap with it. evaluateExpiryAuthority() (expiry-authority.ts)
    // is the sole decision-maker for whether each candidate is eligible;
    // the claim's `<=` filter only ever WIDENS the candidate set relative
    // to Core's own `>=` rule, so it can never silently decide a case Core
    // doesn't get to rule on.
    for (const escrow of candidates) {
      // Only the signature-collection types: never granting Core authority
      // over the disjoint refund branch's escrow types.
      if (!this.isSignatureCollectionType(escrow.type)) continue
      if (!escrow.expiresAt) {
        failed.push({ escrowId: escrow.id, error: 'FUNDS_LOCKED escrow has no expiresAt — cannot evaluate expiry eligibility' })
        continue
      }
      try {
        // evaluateExpiryAuthority() is documented to never throw past its
        // own boundary — but it lives inside this per-escrow try anyway,
        // on the same "do not crash unrelated system functionality"
        // principle as everything else in this loop: if it ever did
        // throw despite its own contract, that must cost this ONE
        // candidate a `failed` entry, never take down the rest of this
        // loop or the disjoint refund loop after it.
        const verdict = evaluateExpiryAuthority(escrow.id, escrow.expiresAt.getTime(), now.getTime())
        if (verdict.kind !== 'AUTHORIZED') {
          // NOT_ELIGIBLE is the ordinary case candidate discovery's
          // deliberately wide `<=` net is expected to occasionally
          // produce — not an anomaly, no action. BINDING_MISMATCH/
          // EVALUATION_FAILED fail closed — no legacy fallback — and are
          // surfaced loudly so they aren't mistaken for an ordinary
          // non-candidate next sweep.
          if (verdict.kind === 'BINDING_MISMATCH' || verdict.kind === 'EVALUATION_FAILED') {
            failed.push({ escrowId: escrow.id, error: `Core expiry authority did not authorize a transition (${verdict.kind}) — no legacy fallback` })
          }
          continue
        }

        // Same pre-transaction safety checks claimEscrowTransition()
        // (escrow-lifecycle.ts) already applies for every other
        // transition in this codebase — reproduced explicitly here
        // because commitAuthoritativeEscrowTimelockExpiry()'s atomic
        // transaction calls the repository's own claimTransition()
        // directly (it needs the shared `tx` handle to keep the State
        // claim and the SemanticTransitionRecord insert in one Postgres
        // transaction, per M3.5/M3.5-V), not the claimEscrowTransition()
        // wrapper, which has no such `tx` parameter to thread through.
        // Core's AUTHORIZED verdict is necessary, not sufficient, for
        // the transition to actually commit — these guards are unrelated
        // to the semantic decision and must not be weakened by routing
        // through the new atomic path.
        assertCircuitClosed(escrow.id)
        if (!(VALID_TRANSITIONS['FUNDS_LOCKED'] ?? []).includes('EXPIRED')) {
          throw new EscrowError('Invalid escrow transition: FUNDS_LOCKED → EXPIRED is no longer a recognized transition')
        }

        const trade = await tradeRepository.findById(escrow.tradeId)
        if (!trade) throw new NotFoundError('Trade', escrow.tradeId)

        // State, Record and the claimed transition commit together; the publish after it is the live
        // path's job, and PASS 3 re-publishes from the durable claim if it never happens.
        const note = 'Timelock expired with no cooperative resolution — cooperative refund needs both signatures; only a dispute (arbiter co-signature) can unilaterally recover this rail.'
        const commitResult = await commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', verdict.record, {
          triggeredBy: SYSTEM_SWEEPER_ID, eventName: 'settlement.escrow.expired', note,
        })
        if (!commitResult.committed) {
          // A concurrent caller already transitioned this escrow — same
          // circuit-breaker feed claimEscrowTransition() already gives
          // every other lost-race outcome in this codebase, and the
          // same "not an error, just lost the race" treatment (no
          // `failed` entry): a real anomaly on this specific escrow, not
          // a heuristic guess.
          recordEscrowConflict(escrow.id)
          continue
        }
        await publishEscrowTransition(
          escrow.id, escrow.tradeId, 'FUNDS_LOCKED', 'EXPIRED', SYSTEM_SWEEPER_ID,
          'settlement.escrow.expired',
          { type: escrow.type, sellerId: trade.sellerId },
          commitResult.transitionId
        )
        requiresManualRecovery.push(escrow.id)
      } catch (err) {
        failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // ---- Untouched legacy path: FUNDS_LOCKED -> REFUNDED -------------
    // Authority here has NOT migrated — still exactly the pre-M4
    // `expiresAt < now` predicate, unchanged scope, unchanged behavior.
    // Signature-collection types are explicitly skipped: they were
    // already fully handled above, and legacy no longer decides anything
    // for them.
    for (const escrow of candidates) {
      if (this.isSignatureCollectionType(escrow.type)) continue
      // The claim is `<=`; this branch keeps its strict `<` (an escrow due exactly now is refunded on a
      // later pass).
      if (!escrow.expiresAt || !(escrow.expiresAt < now)) continue
      // M3 shadow observation continues here as pure diagnostic evidence
      // for this still-unmigrated transition — never gating it.
      if (escrow.expiresAt) observeExpiryShadow(escrow.id, escrow.expiresAt, now)
      try {
        const trade = await tradeRepository.findById(escrow.tradeId)
        if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
        await this.refundFunds(escrow.id, trade.sellerId)
        refunded.push(escrow.id)
      } catch (err) {
        failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return { refunded, requiresManualRecovery, failed }
  }
}

export const escrowService = new EscrowService()

/**
 * #235 R7G-F6B — NF1: the record a SettlementProvider receives. lockedAmount is the exact decimal string of
 * the Prisma Decimal (toFixed(): never exponent notation, never a JS number); every other field is the
 * escrow's own, plus the caller's extra fields.
 */
function providerEscrow(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, extra: Record<string, unknown>): EscrowRecord {
  return { ...escrow, lockedAmount: exactDecimalString(escrow.lockedAmount), ...extra } as EscrowRecord
}

function exactDecimalString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof (value as { toFixed?: unknown }).toFixed === 'function') {
    return (value as { toFixed(): string }).toFixed()
  }
  // Never through a JS number (RFC-009). Absent stays absent, as the provider received it before.
  if (value === undefined || value === null) return value as unknown as string
  throw new EscrowError(`escrow lockedAmount must be an exact decimal, got ${typeof value}`)
}

/**
 * #235 R7G-F6C — before any claim: WDK outbound needs its network policy (chain, finality, corroborating RPC,
 * gas caps), and its recipients come only from durable authority (registered payout addresses, the treasury).
 * A caller-supplied destination - the auto-settle buyer sub-account (NF-B1) or any explicit override - is
 * refused for this rail rather than frozen into an irreversible obligation.
 */
function assertWdkOutboundCaller(escrow: { id: string; type: string }, operation: 'release' | 'refund' | 'split', explicitDestinations: Array<string | undefined>): void {
  if (escrow.type !== 'WDK_USDT_EVM') return
  assertWdkOutboundPolicy(escrow.id)
  if (explicitDestinations.some((d) => d !== undefined)) {
    throw new EscrowError(
      `WDK_USDT_EVM ${operation} for escrow ${escrow.id} pays only registered payout addresses: a caller-supplied destination is refused (buyer payout custody, NF-B1). Nothing was executed.`,
      'UNAVAILABLE'
    )
  }
}
