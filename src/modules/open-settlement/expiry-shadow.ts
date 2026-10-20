/**
 * expiry-shadow.ts — Sails Core Implementation Program, Phase 3
 * (M3 — First Shadow Semantic Slice: FUNDS_LOCKED -> EXPIRED).
 *
 * THIS MODULE IS STRUCTURALLY NON-AUTHORITATIVE. It exists to observe,
 * once per swept escrow, whether the Pure Core reference timelock
 * evaluator (`@sails/core`'s `sails-timelock-evaluator@1.0`) agrees
 * with the ALREADY-MADE legacy decision that an escrow's timelock has
 * elapsed — never to make or influence that decision.
 *
 * The legacy decision is made entirely by
 * `escrow.service.ts`'s sweepExpiredEscrows() refund branch: an escrow
 * claimed by `claimExpiryCandidates()` (status FUNDS_LOCKED) that also
 * passes the branch's strict `expiresAt < now`.
 * Every escrow this module ever sees was ALREADY selected by that
 * predicate before this module runs — nothing here re-decides membership
 * in that set, and nothing here can remove an escrow from it either.
 *
 * Hard boundary, enforced by what this module's exported functions
 * simply do not have the capability to do:
 *   - `isLegacyExpired` and `compareExpiryShadow` are pure: no Prisma
 *     import, no event bus, no Provider, no clock of their own.
 *   - `observeExpiryShadow` is the only impure function, and its only
 *     effect is a best-effort structured log line. It never throws
 *     past its own boundary, never returns a value the caller in
 *     `escrow.service.ts` uses for any control-flow decision, and its
 *     return value being ignored there is itself the mechanical
 *     evidence of non-authority: deleting the one call site that
 *     invokes it leaves every economic code path in
 *     `sweepExpiredEscrows()` byte-for-byte identical (verified in
 *     `tests/expiryShadow.test.ts`).
 */
import { childLogger } from '../../common/logger'
import { createEvaluationTime, referenceTimelockEvaluator, ConditionResult, TimelockInput } from '@sails/core'

const log = childLogger('expiry-shadow')

export type ShadowComparison = 'AGREE' | 'DIVERGE' | 'INCONCLUSIVE'

/**
 * The frozen migration divergence taxonomy
 * (docs/CORE_IMPLEMENTATION_ARCHITECTURE.md §21). Automated observation
 * may only ever produce `INCONCLUSIVE` for a real divergence — root-cause
 * classification (LEGACY_DEFECT / CORE_DEFECT / INPUT_MISMATCH /
 * RULESET_MODEL_GAP / EXPECTED_REPRESENTATION_DIFFERENCE) requires
 * human investigation and is never assigned automatically here. Legacy
 * output is evidence to investigate, never normative authority over
 * Core's own semantics — and the reverse is equally true.
 */
export type ShadowDivergenceClassification =
  | 'LEGACY_DEFECT'
  | 'CORE_DEFECT'
  | 'INPUT_MISMATCH'
  | 'RULESET_MODEL_GAP'
  | 'EXPECTED_REPRESENTATION_DIFFERENCE'
  | 'INCONCLUSIVE'

export interface ExpiryShadowDiagnostic {
  readonly escrowId: string
  readonly deadlineMs: number
  readonly evaluationTimeMs: number
  readonly legacyExpired: boolean
  readonly coreResult: ConditionResult
  readonly comparison: ShadowComparison
  readonly divergenceClassification?: ShadowDivergenceClassification
}

/**
 * Mirrors the refund branch's own predicate in sweepExpiredEscrows()
 * EXACTLY: a strict
 * `expiresAt < now`. Kept here ONLY for shadow/diagnostic comparison —
 * never as an alternative implementation of the real query, and never
 * itself used to decide anything. Prisma query builders cannot be
 * introspected as a pure function, so this mirror is maintained by
 * hand; if that query's own condition ever changes, this must change
 * with it (see `tests/expiryShadow.test.ts` for a direct assertion
 * that the two stay in sync).
 */
export function isLegacyExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() < now.getTime()
}

type EvaluateFn = (input: TimelockInput) => ConditionResult

/**
 * Pure: computes the diagnostic only, never logs, never swallows an
 * evaluator failure (that's `observeExpiryShadow`'s job) — kept
 * separate so tests can inject a deliberately wrong or throwing
 * evaluator without needing to mock `@sails/core` itself.
 */
export function compareExpiryShadow(
  escrowId: string,
  expiresAt: Date,
  now: Date,
  evaluate: EvaluateFn = referenceTimelockEvaluator.evaluate,
): ExpiryShadowDiagnostic {
  const deadlineMs = expiresAt.getTime()
  const evaluationTimeMs = now.getTime()
  const legacyExpired = isLegacyExpired(expiresAt, now)

  const coreResult = evaluate({
    deadline: createEvaluationTime(deadlineMs),
    evaluationTime: createEvaluationTime(evaluationTimeMs),
  })

  if (coreResult !== 'SATISFIED' && coreResult !== 'NOT_YET_SATISFIED') {
    // UNSATISFIABLE/UNKNOWN are architecturally unreachable for this
    // evaluator's own published semantics
    // (conformance/evaluators/sails-timelock-evaluator-1.0.json's own
    // `output.rationale`) — reaching either here is itself a genuine
    // anomaly worth flagging, never silently folded into agreement or
    // disagreement.
    return { escrowId, deadlineMs, evaluationTimeMs, legacyExpired, coreResult, comparison: 'INCONCLUSIVE' }
  }

  const coreExpired = coreResult === 'SATISFIED'
  if (legacyExpired === coreExpired) {
    return { escrowId, deadlineMs, evaluationTimeMs, legacyExpired, coreResult, comparison: 'AGREE' }
  }
  return {
    escrowId,
    deadlineMs,
    evaluationTimeMs,
    legacyExpired,
    coreResult,
    comparison: 'DIVERGE',
    // Never auto-assigned LEGACY_DEFECT or CORE_DEFECT — see this
    // file's own taxonomy documentation above.
    divergenceClassification: 'INCONCLUSIVE',
  }
}

function defaultRecord(diagnostic: ExpiryShadowDiagnostic): void {
  const fields = {
    msg: 'M3 shadow observation: FUNDS_LOCKED expiry timelock',
    module: 'expiry-shadow',
    escrowId: diagnostic.escrowId,
    deadlineMs: diagnostic.deadlineMs,
    evaluationTimeMs: diagnostic.evaluationTimeMs,
    legacyExpired: diagnostic.legacyExpired,
    coreResult: diagnostic.coreResult,
    comparison: diagnostic.comparison,
    divergenceClassification: diagnostic.divergenceClassification,
  }
  if (diagnostic.comparison === 'DIVERGE') {
    log.warn(fields)
  } else {
    log.debug(fields)
  }
}

/**
 * The only entry point Runtime code should call. Never throws past
 * this boundary regardless of what fails inside it (evaluator throwing
 * on malformed input, the diagnostic sink itself failing, or anything
 * else) — a failure anywhere inside shadow evaluation degrades to
 * `undefined`, never to an exception the caller has to handle, and
 * never changes anything about the caller's already-decided legacy
 * outcome. The `deps` parameter exists solely so tests can inject a
 * deliberately wrong/throwing evaluator or a throwing sink without
 * needing to mock `@sails/core` or the logger globally.
 */
export function observeExpiryShadow(
  escrowId: string,
  expiresAt: Date,
  now: Date,
  deps: { readonly evaluate?: EvaluateFn; readonly record?: (d: ExpiryShadowDiagnostic) => void } = {},
): ExpiryShadowDiagnostic | undefined {
  const evaluate = deps.evaluate ?? referenceTimelockEvaluator.evaluate
  const record = deps.record ?? defaultRecord
  try {
    const diagnostic = compareExpiryShadow(escrowId, expiresAt, now, evaluate)
    try {
      record(diagnostic)
    } catch {
      // Diagnostic-sink failure never erases an already-computed
      // diagnostic and never propagates — see this file's own header.
    }
    return diagnostic
  } catch {
    return undefined
  }
}
