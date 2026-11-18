/**
 * Policy / Rules Engine — Sails Protocol Core Component
 * PROTOCOL_SPECIFICATION.md section 1.10, PROTOCOL_ECONOMY.md
 *
 * STUB — get/propose/activate below (the GOVERNED, versioned
 * policy-storage system, PROTOCOL_ECONOMY.md §7's Months 10-12
 * multi-stakeholder governance layer) are still deliberately
 * unimplemented — real scope, correctly out of the current MVP per this
 * file's own original reasoning below.
 *
 * RFC-021 Phase 0 (`docs/rfcs/RFC-021-...md`) once read a hardcoded
 * `config.settlement.protocolFeeRate` in `releaseFunds()`; that mechanism
 * was retired in Missão 11 Fase 6.5.2 and the config value removed. Fee
 * rates now live in the versioned `FeePolicyVersion` foundation
 * (`fee-policy.service.ts`), not here — this file's `get`/`propose`/
 * `activate` still throw, correctly, until the broader governance
 * feature is actually built.
 */
export interface FeePolicy {
  feeRate: number
  bucketSplit: { nodeOperators: number; treasury: number; walletRebate: number; arbitratorReserve: number }
}
export interface TrustPolicy {
  tradeLimitsByScore: { minScore: number; maxTradeValue: number }[]
}
export interface RoutingPolicy {
  rankingWeights: { price: number; reputation: number }
}

export interface PolicyEngine {
  get<T>(appliesTo: string): Promise<T>
  propose<T>(appliesTo: string, rules: T): Promise<void>
  activate(policyId: string): Promise<void>
}

// ─── Policy decision primitive — Missão 03 ─────────────────────────────────
// Deliberately NOT the governed get/propose/activate system above (that
// remains Months 10-12 scope, unchanged — RFC-023's own Alternatives
// Considered #5 already rejected building it out for the /propose route,
// and the CTO's own Missão 03 brief re-confirms the distinction rather
// than asking for that system to be built now).
//
// The distinction this file now makes explicit, not just in a comment:
// Capability answers "does this actor hold potential authority for this
// class of action?" (capability-registry.ts, a pure grant lookup, no
// business context). Policy answers "given this actor, this specific
// resource, and the current contextual conditions, is this exact action
// permitted right now?" A valid capability grant is necessary but never
// sufficient — evaluateIntentPolicy() below explicitly proves this by
// still denying a capability-holding, Intent-owning caller whose
// requested amount falls outside the Intent's own declared bounds.
//
// Evolved from Missão 02's authorizeIntentAction() (same function,
// renamed and extended — 2026-08-15): ownership/expiry/status/capability
// were already unified there; the amount-vs-declared-bounds check that
// core/intent.routes.ts's propose handler still made inline is folded in
// here too, since it is exactly the kind of contextual condition this
// primitive exists to own, not a route-level formatting concern.
//
// Deliberately excluded, per Missão 03 Fase 3's own explicit boundary:
// settlement authorization (escrow.service.ts's isSellerOrAssignedArbiter,
// RFC-014/RFC-015's own checks) stays exactly where it is — this file
// never imports anything from open-settlement, and never will (see
// policyEngineHasNoSettlementAccess in the test file for a direct,
// structural proof of that, not just a comment promise). Counterparty
// reputation filtering (minReputationRating) also stays out — that is a
// discovery/matching concern (liquidityRouter.proposeForIntent()), a
// property of what a search finds, not of whether the actor asking is
// authorized to ask.
import type { IntentStatus } from './state-machine'
import { isExpired } from './state-machine'
import { capabilityRegistry, type CapabilityRegistry } from './capability-registry'

export type PolicyEffect = 'ALLOW' | 'DENY'

// Fase 9 — a decision must be auditable: who, which action, on which
// resource, ALLOW/DENY, and why. No secrets, no capability-grant
// internals beyond the name/scope already public to the caller.
export interface PolicyDecision {
  effect: PolicyEffect
  reason: string
  actor: string
  action: string
  resource: { type: string; id: string }
  // Lets the caller map a denial onto the right HTTP error class without
  // string-matching `reason` — 'forbidden' for identity/authority
  // failures (403), 'validation' for state/context failures (400),
  // matching this route's pre-existing status codes exactly.
  denialCategory?: 'forbidden' | 'validation'
}

function allow(actor: string, action: string, resource: { type: string; id: string }): PolicyDecision {
  return { effect: 'ALLOW', reason: 'all policy conditions satisfied', actor, action, resource }
}

function deny(
  actor: string, action: string, resource: { type: string; id: string },
  reason: string, denialCategory: 'forbidden' | 'validation'
): PolicyDecision {
  return { effect: 'DENY', reason, actor, action, resource, denialCategory }
}

// The only action this evaluator currently knows how to decide — Fase 5's
// "unknown action -> DENY" applied literally: a caller asking about any
// other action string gets a real denial, not a silent no-op ALLOW. Grows
// by adding a name here plus a real branch, never by accepting an
// arbitrary string and assuming it's fine.
const KNOWN_INTENT_ACTIONS = new Set(['intent.propose'])

export async function evaluateIntentPolicy(
  params: {
    action: string
    // Intentionally nullable — Fase 5's "recurso inexistente -> DENY"
    // covered directly rather than trusted to always be pre-checked by
    // the caller (defense in depth: a caller that races a lookup against
    // a deletion still gets a real DENY, not a crash on `.participantId`).
    intent: { id: string; participantId: string; status: IntentStatus; expiresAt: Date | null } | null
    requestedBy: string
    allowedStatuses: IntentStatus[]
    requireCapability: boolean
    capabilityName: string
    capabilityScope: string
    // The condition the CTO's own example names directly ("preço está
    // dentro do limite; quantidade está dentro do limite") — optional
    // because not every intent action involves a requested amount
    // (cancel, for instance), but when present it's evaluated as a real
    // policy condition, not a separate inline check the caller re-derives.
    requestedAmount?: { amount: string; minValue?: string; maxValue?: string }
  },
  registry: Pick<CapabilityRegistry, 'check'> = capabilityRegistry
): Promise<PolicyDecision> {
  const resource = { type: 'Intent', id: params.intent?.id ?? 'unknown' }

  if (!KNOWN_INTENT_ACTIONS.has(params.action)) {
    return deny(params.requestedBy, params.action, resource, `No policy exists for action '${params.action}'`, 'validation')
  }

  if (!params.intent) {
    return deny(params.requestedBy, params.action, resource, 'Resource does not exist', 'validation')
  }

  if (!params.requestedBy) {
    return deny(params.requestedBy, params.action, resource, 'Incomplete policy context: requestedBy is required', 'validation')
  }

  if (params.intent.participantId !== params.requestedBy) {
    return deny(params.requestedBy, params.action, resource, `${params.requestedBy} does not own this Intent`, 'forbidden')
  }

  if (isExpired({ status: params.intent.status, expiresAt: params.intent.expiresAt })) {
    return deny(params.requestedBy, params.action, resource, 'Intent has expired', 'validation')
  }

  if (!params.allowedStatuses.includes(params.intent.status)) {
    return deny(
      params.requestedBy, params.action, resource,
      `Intent is not in a valid state for '${params.action}' (status: ${params.intent.status})`, 'validation'
    )
  }

  if (params.requireCapability) {
    const hasCapability = await registry.check(params.requestedBy, params.capabilityName, params.capabilityScope)
    if (!hasCapability) {
      return deny(
        params.requestedBy, params.action, resource,
        `${params.requestedBy} has no active '${params.capabilityName}' capability grant covering '${params.capabilityScope}'`,
        'forbidden'
      )
    }
  }

  // Reached only once ownership, expiry, status, and capability all
  // cleared — proves by construction that a valid capability alone never
  // reaches ALLOW on its own; this condition still runs after it.
  if (params.requestedAmount) {
    const { amount, minValue, maxValue } = params.requestedAmount
    const amountNum = Number(amount)
    if (minValue !== undefined && amountNum < Number(minValue)) {
      return deny(
        params.requestedBy, params.action, resource,
        `amount ${amount} is below Intent ${resource.id}'s own minValue (${minValue})`, 'validation'
      )
    }
    if (maxValue !== undefined && amountNum > Number(maxValue)) {
      return deny(
        params.requestedBy, params.action, resource,
        `amount ${amount} is above Intent ${resource.id}'s own maxValue (${maxValue})`, 'validation'
      )
    }
  }

  return allow(params.requestedBy, params.action, resource)
}

// TODO(Meses 1-3): implement. Governance transition (Satsails-controlled →
// multi-stakeholder) tracked in PROTOCOL_ECONOMY.md section 7.
export const policyEngine: PolicyEngine = {
  async get() { throw new Error('Not yet implemented — see TODO.md') },
  async propose() { throw new Error('Not yet implemented — see TODO.md') },
  async activate() { throw new Error('Not yet implemented — see TODO.md') },
}

// ─── Financial sanity check — CISO Economic Rule (03-implementation_plan.md) ─
// A real, working policy check, separate from the get/propose/activate
// governed-policy-storage system above (which needs a Prisma-backed
// policies table that doesn't exist yet — bigger scope than the MVP happy
// path warrants). This is what core/intent-engine.ts actually calls today.
// maxValue/minValue are decimal strings (RFC-009) — parsed via Number()
// only for the sanity comparison itself, never stored or propagated as a
// number, consistent with RFC-009's sort-comparator precedent
// (liquidity.service.ts) of Number() being fine for a bounds check that
// only needs "is this roughly sane," not exact arithmetic.
const MAX_SANE_TRADE_VALUE = 100_000_000 // 100M units of any asset — a deliberately generous ceiling; a real value here is a governance decision (section 7), not an engineering one

export interface SanityCheckResult {
  valid: boolean
  errors?: string[]
}

export function validateFinancialSanity(payload: {
  maxValue?: string; minValue?: string
  // RFC-023 — same sanity gate as maxValue/minValue, applied to the new
  // price-limit fields so they're checked for sanity (non-negative, sane
  // ceiling, min <= max), not just type (intent-handler.ts's validate()
  // only confirms these are strings, not that they're sane numbers).
  maxPriceUsd?: string; minPriceUsd?: string
}): SanityCheckResult {
  const errors: string[] = []

  for (const [field, raw] of [
    ['minValue', payload.minValue], ['maxValue', payload.maxValue],
    ['minPriceUsd', payload.minPriceUsd], ['maxPriceUsd', payload.maxPriceUsd],
  ] as const) {
    if (raw === undefined) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      errors.push(`${field} is not a valid decimal string: "${raw}"`)
      continue
    }
    if (n < 0) errors.push(`${field} cannot be negative: ${raw}`)
    if (n > MAX_SANE_TRADE_VALUE) errors.push(`${field} exceeds sane bounds (${MAX_SANE_TRADE_VALUE}): ${raw}`)
  }

  if (
    payload.minValue !== undefined &&
    payload.maxValue !== undefined &&
    Number.isFinite(Number(payload.minValue)) &&
    Number.isFinite(Number(payload.maxValue)) &&
    Number(payload.minValue) > Number(payload.maxValue)
  ) {
    errors.push(`minValue (${payload.minValue}) cannot exceed maxValue (${payload.maxValue})`)
  }

  if (
    payload.minPriceUsd !== undefined &&
    payload.maxPriceUsd !== undefined &&
    Number.isFinite(Number(payload.minPriceUsd)) &&
    Number.isFinite(Number(payload.maxPriceUsd)) &&
    Number(payload.minPriceUsd) > Number(payload.maxPriceUsd)
  ) {
    errors.push(`minPriceUsd (${payload.minPriceUsd}) cannot exceed maxPriceUsd (${payload.maxPriceUsd})`)
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}
