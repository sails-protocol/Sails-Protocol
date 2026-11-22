/**
 * C12: what the trade page may say about contesting a dispute (PRINCIPAL-C12-contestacao-disputa.md §1-§2,
 * ESPEC_COMPARTILHADA_C12_CONTESTACAO.md). Two separate mechanisms, two blocks:
 *
 * A. Contest of the arbiter's decision (RFC-021 D6, SDK `appealDispute()`). Its rules live on the backend
 *    (arbitration mode, committed arbiter key) and no route exposes them yet (proposed read-only
 *    `GET /v1/settlement/disputes/:id/appeal-view`, LOOSE_WIRES.disputeAppealView). Without that view the UI
 *    never infers eligibility (not from the escrow type, not from being a party): no button, no deadline.
 *    `appealDeadlineAt` is always null today (gap G1), so no countdown is ever drawn from it until it is not.
 *    The appeal fee is recorded but never collected (G3), so it is not part of the model.
 * B. Contest of the automatic proposal (RFC-021 D8, SDK `contestAutoResolution()`): real data on the Dispute
 *    (`status === 'AUTO_PROPOSED'` + `autoResolutionDeadline`). Off by default in production; rendered only when
 *    the backend returns that state. At the deadline the proposal is not applied: the case goes to the arbiter.
 *
 * The backend is the authority at submission time (400/403/404); every countdown here is only a display.
 * Pure (no React, no Vite-only syntax), so Node tests can import it.
 */
import type { Dispute } from '@satsails/p2p-trading-sdk'
import { deadlineMilestone, deadlineTone, type DeadlineTone } from './escrowDeadline'

/** The proposed read-only view (PRINCIPAL-C12 §2), exactly as the contract, plus the optional block B data. */
export interface DisputeAppealView {
  disputeId: string
  /** false unless ARBITRATION_MODE=market AND the escrow has no committed arbiter key (decided on the backend). */
  appealSupported: boolean
  appealStatus: 'not_available' | 'open' | 'submitted' | 'expired' | 'resolved'
  /** Always null today (no appeal deadline exists, gap G1); typed as a date so a future deadline needs no UI change. */
  appealDeadlineAt: string | null
  /** appealSupported && status RESOLVED && caller is buyer or seller, computed on the backend. */
  canCurrentUserAppeal: boolean
  /** ISO 8601 UTC when the escrow reached its terminal status; null before (INCERTO in the contract). */
  decisionFinalAt: string | null
  autoProposal?: { contestable: boolean; contestDeadlineAt: string; canCurrentUserContest: boolean }
}

const APPEAL_STATUSES: ReadonlySet<string> = new Set(['not_available', 'open', 'submitted', 'expired', 'resolved'])
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isDateOrNull = (v: unknown): v is string | null => v === null || isDate(v)

/** Trust-boundary read of a view (endpoint response or demo fixture): null unless every field has its contract shape. */
export function parseAppealView(raw: unknown): DisputeAppealView | null {
  const v = raw as Partial<Record<keyof DisputeAppealView, unknown>> | null
  if (!v || typeof v !== 'object') return null
  if (typeof v.disputeId !== 'string' || typeof v.appealSupported !== 'boolean' || typeof v.canCurrentUserAppeal !== 'boolean') return null
  if (typeof v.appealStatus !== 'string' || !APPEAL_STATUSES.has(v.appealStatus)) return null
  if (!isDateOrNull(v.appealDeadlineAt) || !isDateOrNull(v.decisionFinalAt)) return null
  const view: DisputeAppealView = {
    disputeId: v.disputeId,
    appealSupported: v.appealSupported,
    appealStatus: v.appealStatus as DisputeAppealView['appealStatus'],
    appealDeadlineAt: v.appealDeadlineAt,
    canCurrentUserAppeal: v.canCurrentUserAppeal,
    decisionFinalAt: v.decisionFinalAt,
  }
  const a = v.autoProposal as Partial<NonNullable<DisputeAppealView['autoProposal']>> | undefined
  if (a !== undefined) {
    if (!a || typeof a.contestable !== 'boolean' || typeof a.canCurrentUserContest !== 'boolean' || !isDate(a.contestDeadlineAt)) return null
    view.autoProposal = { contestable: a.contestable, contestDeadlineAt: a.contestDeadlineAt, canCurrentUserContest: a.canCurrentUserContest }
  }
  return view
}

/** A running deadline as a display: remaining time and the escrow countdown's tone rule (amber under 1 h or 10 %). */
export interface DeadlineDisplay {
  at: string
  remainingMs: number
  tone: DeadlineTone
  milestone: 0 | 1 | 2 | 3 | 4
}

/** null when there is no parseable deadline: never a fabricated one. `totalMs` only when the backend states it. */
export function deadlineDisplay(at: string | null | undefined, now: number, totalMs: number | null = null): DeadlineDisplay | null {
  if (!isDate(at)) return null
  const remainingMs = Date.parse(at) - now
  const tone = deadlineTone(remainingMs, totalMs)
  return { at, remainingMs, tone, milestone: deadlineMilestone(remainingMs, tone) }
}

/** Where the view comes from: none (no endpoint), still loading, failed, or read. */
export type AppealViewState = DisputeAppealView | null | 'loading' | 'error'

export type AppealBlock =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  /** No view (no endpoint today): the decision is recorded, the contest is not available here. No button, no deadline. */
  | { kind: 'unknown' }
  | { kind: 'not_available' }
  /** `canAppeal` is the backend's canCurrentUserAppeal, never derived here; `deadline` only from a non-null appealDeadlineAt. */
  | { kind: 'open'; canAppeal: boolean; deadline: DeadlineDisplay | null }
  | { kind: 'submitted' }
  /** `deadlineAt` when a shown deadline just passed on screen (the page re-reads); absent when the view says expired. */
  | { kind: 'expired'; deadlineAt?: string }
  | { kind: 'resolved' }

/** Block A. Hidden until a decision exists (RESOLVED) or a contest of it is recorded (APPEALED). */
export function deriveAppealBlock(dispute: Pick<Dispute, 'id' | 'status'>, view: AppealViewState, now: number): AppealBlock {
  if (dispute.status !== 'RESOLVED' && dispute.status !== 'APPEALED') return { kind: 'hidden' }
  if (view === 'loading' || view === 'error') return { kind: view }
  // APPEALED is itself a recorded fact (status), not an inferred rule.
  if (!view || view.disputeId !== dispute.id) return dispute.status === 'APPEALED' ? { kind: 'submitted' } : { kind: 'unknown' }
  if (!view.appealSupported || view.appealStatus === 'not_available') return { kind: 'not_available' }
  if (view.appealStatus !== 'open') return { kind: view.appealStatus }
  const deadline = deadlineDisplay(view.appealDeadlineAt, now)
  // Zero reached with the screen open: the expired visual at once; the page re-reads and the backend decides.
  if (deadline && deadline.remainingMs <= 0) return { kind: 'expired', deadlineAt: deadline.at }
  return { kind: 'open', canAppeal: view.canCurrentUserAppeal, deadline }
}

export type ContestBlock =
  | { kind: 'hidden' }
  /** `canContest`: the view's permission when it exists; otherwise trade party (the backend still answers 403). */
  | { kind: 'open'; canContest: boolean; deadline: DeadlineDisplay }
  /** Deadline passed on the device clock, not yet recorded: no button; the page re-reads the dispute. */
  | { kind: 'expired'; deadline: DeadlineDisplay }

/** Block B. Rendered only for AUTO_PROPOSED with a deadline from the backend (Principal: no placeholder otherwise). */
export function deriveContestBlock(
  dispute: Pick<Dispute, 'id' | 'status' | 'autoResolutionDeadline'>,
  isParty: boolean,
  view: AppealViewState,
  now: number,
): ContestBlock {
  if (dispute.status !== 'AUTO_PROPOSED' || !dispute.autoResolutionDeadline) return { kind: 'hidden' }
  const auto = view && typeof view === 'object' && view.disputeId === dispute.id ? view.autoProposal : undefined
  const deadline = deadlineDisplay(auto?.contestDeadlineAt ?? dispute.autoResolutionDeadline, now)
  if (!deadline) return { kind: 'hidden' }
  if (deadline.remainingMs <= 0) return { kind: 'expired', deadline }
  return { kind: 'open', canContest: auto ? auto.contestable && auto.canCurrentUserContest : isParty, deadline }
}

/** Why a contest submission failed, from the SDK error's HTTP status. A network failure is never read as "not sent". */
export type SubmitFailure = 'changed' | 'forbidden' | 'notFound' | 'unknown'

export function submitFailure(err: unknown): SubmitFailure {
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  if (status === 400 || status === 409) return 'changed'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notFound'
  return 'unknown'
}
