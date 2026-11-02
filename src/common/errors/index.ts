/**
 * Error classes — referenced by escrow.service.ts, liquidity.service.ts,
 * and every route that gets restored. API_REFERENCE.md §9 defines the
 * response shape these map to.
 */

// Same link on every error response — there's no per-code anchor in
// API_REFERENCE.md's §9 (a table's rows aren't independently addressable
// on GitHub), so this points at the whole error-taxonomy section rather
// than fabricating anchors that don't exist. Real, checked repo URL, not
// a guessed one — this is the same GitHub path every other doc link in
// this codebase already uses.
export const ERROR_DOCS_URL = 'https://github.com/alan-schramm/Sails-Protocol/blob/main/docs/API_REFERENCE.md#9-error-response-shape'

// CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39, 2026-09-13) — closes
// `docs/BACKLOG.md` item 39, registered by
// `docs/CROSS_LAYER_SEMANTIC_CONTRACT_AUDIT.md`'s CSC-G01: six
// structurally different underlying reasons an operation can be
// unavailable (a real rail limitation, an unconfigured deployment, a
// missing permission, a maturity/eligibility gate, a config toggle, an
// unimplemented stub) all used to surface as similarly-worded plain
// `EscrowError`/`Error` text with no way for a caller to mechanically
// tell them apart short of parsing the message string. This is a
// classificatory field added to the EXISTING error envelope — not a
// second error framework, not a new error class per reason. A caller
// (or the Reference UI) that doesn't recognize a `reason` value must
// still work correctly: `reason` is always additive, `code`/`message`
// remain exactly what they always were.
//
// Deliberately named after this mission's own required vocabulary, not
// invented independently — reuse this exact set, never add a 7th
// without updating this comment and every consuming layer:
// - UNSUPPORTED    — a real, structural rail/technical limitation (this
//                    will never work on this rail, not a config issue).
// - UNAVAILABLE    — this deployment hasn't wired a provider/rail that
//                    could exist (a structural absence, not a policy).
// - FORBIDDEN      — a permission/`CapabilityGrant`/policy denial (the
//                    actor lacks authorization, the operation itself is
//                    real and configured). Distinct from the existing
//                    `ForbiddenError` class (401/403 AUTHENTICATION
//                    boundary) — this reason classifies a CAPABILITY
//                    denial specifically, which may or may not also be
//                    surfaced via `ForbiddenError`.
// - INELIGIBLE     — a maturity/capability-profile/eligibility mismatch
//                    (the actor or object doesn't yet qualify).
// - DISABLED       — a deployment config toggle is off (would work if
//                    enabled; this deployment chose not to).
// - NOT_IMPLEMENTED — a genuine SDK/server stub with no real backing
//                    implementation yet.
export type CapabilityDenialReason =
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'FORBIDDEN'
  | 'INELIGIBLE'
  | 'DISABLED'
  | 'NOT_IMPLEMENTED'

export class AppError extends Error {
  statusCode: number
  code: string
  details?: unknown
  reason?: CapabilityDenialReason

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown, reason?: CapabilityDenialReason) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.reason = reason
    Error.captureStackTrace?.(this, this.constructor)
  }

  toResponse() {
    return {
      success: false,
      error: this.code,
      message: this.message,
      details: this.details ?? [],
      docsUrl: ERROR_DOCS_URL,
      ...(this.reason ? { reason: this.reason } : {}),
    }
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, 'NOT_FOUND')
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details)
  }
}

export class EscrowError extends AppError {
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — optional `reason`
  // (see `CapabilityDenialReason` above); most of CSC-G01's identified
  // capability-denial throw sites already use this class, so it gets
  // the field directly rather than every call site switching to raw
  // `AppError`.
  constructor(message: string, reason?: CapabilityDenialReason) {
    super(message, 409, 'ESCROW_ERROR', undefined, reason)
  }
}

// Issue #291 - a settlement result (provider evidence: txReleaseId) is
// write-once. A DIFFERENT value for an escrow that already holds one is an
// integrity anomaly: never overwritten, never silently ignored.
export class SettlementResultConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'SETTLEMENT_RESULT_CONFLICT')
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required or invalid') {
    super(message, 401, 'AUTH_ERROR')
  }
}

export class ForbiddenError extends AppError {
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — optional `reason`.
  // Most `ForbiddenError` throws are a real auth-boundary denial (not a
  // capability-denial reason at all — `reason` stays undefined for
  // those, unchanged from before this mission). Only the capability-
  // policy call sites this mission's own audit named (e.g.
  // `checkFundMovementCapability()`) pass `'FORBIDDEN'` explicitly.
  constructor(message = 'Not authorized for this action', reason?: CapabilityDenialReason) {
    super(message, 403, 'FORBIDDEN', undefined, reason)
  }
}

// Missão 11 Fase 7.1A/7.2 — thrown when a fail-closed policy lookup
// (FeePolicyService.findLivePolicyForRail() / DistributionPolicyService.
// findLivePolicy()) finds more than one simultaneously-PUBLISHED row for
// the same economic authority. Should be structurally impossible under
// the DB-native exclusivity indexes (fee_policy_versions_single_published_
// per_rail_key / distribution_policy_versions_single_published_key) —
// this is defense-in-depth for a legacy/corrupt/raw-SQL-bypass state, not
// an expected runtime path. 500, not 409/403: this is never the caller's
// fault, it signals a real reconciliation-worthy anomaly in the data.
export class EconomicAuthorityAmbiguityError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 500, 'ECONOMIC_AUTHORITY_AMBIGUITY', details)
  }
}

// escrow-circuit-breaker.ts, 2026-08-15 — 503 (not 409 like EscrowError):
// this isn't "your specific request conflicted," it's "this escrow is
// temporarily paused because of a recent burst of conflicts on it" —
// the caller should back off and retry later, the same semantic
// @fastify/rate-limit's own 429 already carries for volume limiting.
export class CircuitBreakerOpenError extends AppError {
  constructor(message: string) {
    super(message, 503, 'CIRCUIT_BREAKER_OPEN')
  }
}

// redis-rate-limit.ts (Missão 08B Fase 9) — same code/shape
// @fastify/rate-limit's own plugin-thrown 429 already produces via
// app.ts's error handler (statusCode===429 -> 'RATE_LIMIT_EXCEEDED'), so
// a caller can't tell whether a given route is on the local plugin or
// the shared Redis limiter from the response alone.
export class RateLimitExceededError extends AppError {
  constructor(retryAfterSeconds: number) {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', { retryAfterSeconds })
  }
}

// Fase 8's route matrix: auth + critical tiers both already hard-depend
// on Redis independent of rate limiting (challenge/session lookups),
// so failing closed here adds no new single point of failure — same
// 503/"temporarily unavailable, retry" semantic as CircuitBreakerOpenError
// above, not a 500 (this isn't a bug, it's a deliberate fail-closed
// policy decision).
export class RateLimitUnavailableError extends AppError {
  constructor() {
    super('Rate limiting store temporarily unavailable', 503, 'RATE_LIMIT_UNAVAILABLE')
  }
}

// CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37, 2026-09-13) —
// src/common/idempotency.ts's withIdempotency() throws this when a
// concurrent, not-yet-resolved call already claimed the same
// (scope, participantId, key). 409, not 500/503: this is a real,
// well-formed conflict on the caller's own request, not a server fault
// or a transient infra issue — the correct caller behavior is "wait and
// re-check," not "retry immediately" or "treat as a different failure
// class." Deliberately distinct from EscrowError's own 409 (settlement-
// specific "invalid state for this action") — this is about the
// idempotency claim itself, not any resource's business state.
export class IdempotencyKeyConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'IDEMPOTENCY_KEY_IN_PROGRESS')
  }
}

// Issue #265 — EvidenceProvider (evidence-provider.ts) storage-outcome
// taxonomy. A DIFFERENT axis from CapabilityDenialReason above (which
// classifies WHY an operation is policy-denied, not an I/O outcome), so
// this is its own narrow union rather than widening that one — same
// "one purpose-specific AppError subclass, not a second competing error
// framework" pattern CircuitBreakerOpenError/RateLimitExceededError/
// IdempotencyKeyConflictError above already establish. Three outcomes a
// storage backend can report, deliberately never collapsed into each
// other (per #265's own mission brief — "UNAVAILABLE != INVALID",
// "missing bytes != evidence never existed"):
// - NOT_FOUND  — positive confirmation the object does not exist at this
//                reference (a real 404, not "we couldn't tell").
// - UNAVAILABLE — the provider could not answer at all (timeout, network,
//                 outage) — an OPERATIONAL outcome, not evidence that the
//                 bytes never existed or were ever missing.
// - CORRUPTED  — the provider returned bytes, but they don't match the
//                canonical EvidenceReference.sha256 — an integrity
//                anomaly, never the caller's fault (mirrors
//                EconomicAuthorityAmbiguityError's own reasoning for
//                using 500 rather than 409/403).
export type EvidenceStorageErrorReason = 'NOT_FOUND' | 'UNAVAILABLE' | 'CORRUPTED'

const EVIDENCE_STORAGE_STATUS_CODE: Record<EvidenceStorageErrorReason, number> = {
  NOT_FOUND: 404, // matches NotFoundError's own convention
  UNAVAILABLE: 503, // matches CircuitBreakerOpenError/RateLimitUnavailableError's "temporarily unavailable, retry" convention
  CORRUPTED: 500, // never the caller's fault — a real reconciliation-worthy anomaly, same reasoning as EconomicAuthorityAmbiguityError
}

export class EvidenceStorageError extends AppError {
  storageReason: EvidenceStorageErrorReason

  constructor(message: string, storageReason: EvidenceStorageErrorReason, details?: unknown) {
    super(message, EVIDENCE_STORAGE_STATUS_CODE[storageReason], `EVIDENCE_STORAGE_${storageReason}`, details)
    this.storageReason = storageReason
  }
}
