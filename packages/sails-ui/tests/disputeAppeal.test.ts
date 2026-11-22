import {
  deadlineDisplay, deriveAppealBlock, deriveContestBlock, parseAppealView, submitFailure, type DisputeAppealView,
} from '../src/lib/disputeAppeal'
import { MAX_SERVER_OFFSET_MS, offsetFromDateHeader } from '../src/lib/serverClock'

// C12 (PRINCIPAL-C12 §2): the UI shows only what the backend view says; no view means no button and no deadline.
const MIN = 60_000, H = 60 * MIN
const NOW = Date.parse('2026-11-21T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const D = { id: 'd1', status: 'RESOLVED' as const, autoResolutionDeadline: null as string | null }
const view = (patch: Partial<DisputeAppealView> = {}): DisputeAppealView => ({
  disputeId: 'd1', appealSupported: true, appealStatus: 'open', appealDeadlineAt: null, canCurrentUserAppeal: true, decisionFinalAt: null, ...patch,
})

describe('deriveAppealBlock (contest of the decision)', () => {
  it('hidden until a decision exists', () => {
    for (const status of ['OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'AUTO_PROPOSED'] as const) {
      expect(deriveAppealBlock({ ...D, status }, view(), NOW)).toEqual({ kind: 'hidden' })
    }
  })
  it('null view (no endpoint today): unknown, never a button or deadline', () => {
    expect(deriveAppealBlock(D, null, NOW)).toEqual({ kind: 'unknown' })
  })
  it('APPEALED with no view is the recorded fact "submitted"', () => {
    expect(deriveAppealBlock({ ...D, status: 'APPEALED' }, null, NOW)).toEqual({ kind: 'submitted' })
  })
  it('loading and error states pass through', () => {
    expect(deriveAppealBlock(D, 'loading', NOW)).toEqual({ kind: 'loading' })
    expect(deriveAppealBlock(D, 'error', NOW)).toEqual({ kind: 'error' })
  })
  it('a view for another dispute is ignored', () => {
    expect(deriveAppealBlock(D, view({ disputeId: 'other' }), NOW)).toEqual({ kind: 'unknown' })
  })
  it('not supported is not available, whatever the status says', () => {
    expect(deriveAppealBlock(D, view({ appealSupported: false, appealStatus: 'open' }), NOW)).toEqual({ kind: 'not_available' })
    expect(deriveAppealBlock(D, view({ appealStatus: 'not_available' }), NOW)).toEqual({ kind: 'not_available' })
  })
  it('submitted, expired and resolved come from the view', () => {
    expect(deriveAppealBlock({ ...D, status: 'APPEALED' }, view({ appealStatus: 'submitted' }), NOW)).toEqual({ kind: 'submitted' })
    expect(deriveAppealBlock(D, view({ appealStatus: 'expired' }), NOW)).toEqual({ kind: 'expired' })
    expect(deriveAppealBlock(D, view({ appealStatus: 'resolved' }), NOW)).toEqual({ kind: 'resolved' })
  })
  it('open: the button only from canCurrentUserAppeal', () => {
    expect(deriveAppealBlock(D, view(), NOW)).toEqual({ kind: 'open', canAppeal: true, deadline: null })
    expect(deriveAppealBlock(D, view({ canCurrentUserAppeal: false }), NOW)).toEqual({ kind: 'open', canAppeal: false, deadline: null })
  })
  it('a null appealDeadlineAt never produces a countdown', () => {
    const b = deriveAppealBlock(D, view({ appealDeadlineAt: null }), NOW)
    expect(b.kind === 'open' && b.deadline).toBe(null)
  })
  it('a non-null deadline counts down, and at zero switches to expired at once', () => {
    const b = deriveAppealBlock(D, view({ appealDeadlineAt: at(2 * H) }), NOW)
    expect(b.kind === 'open' && b.deadline?.remainingMs).toBe(2 * H)
    expect(deriveAppealBlock(D, view({ appealDeadlineAt: at(0) }), NOW)).toEqual({ kind: 'expired', deadlineAt: at(0) })
  })
})

describe('deriveContestBlock (contest of the automatic suggestion)', () => {
  const P = { id: 'd1', status: 'AUTO_PROPOSED' as const, autoResolutionDeadline: at(5 * H) }
  it('only for AUTO_PROPOSED with a backend deadline', () => {
    expect(deriveContestBlock({ ...P, status: 'EVIDENCE_SUBMITTED' }, true, null, NOW)).toEqual({ kind: 'hidden' })
    expect(deriveContestBlock({ ...P, autoResolutionDeadline: null }, true, null, NOW)).toEqual({ kind: 'hidden' })
    expect(deriveContestBlock({ ...P, autoResolutionDeadline: 'not a date' }, true, null, NOW)).toEqual({ kind: 'hidden' })
  })
  it('open with the real deadline; button for trade parties when there is no view', () => {
    const b = deriveContestBlock(P, true, null, NOW)
    expect(b).toMatchObject({ kind: 'open', canContest: true, deadline: { at: at(5 * H), remainingMs: 5 * H, tone: 'neutral' } })
    expect(deriveContestBlock(P, false, null, NOW)).toMatchObject({ kind: 'open', canContest: false })
  })
  it('the view, when it exists, decides the permission and the deadline', () => {
    const v = view({ autoProposal: { contestable: true, contestDeadlineAt: at(30 * MIN), canCurrentUserContest: false } })
    expect(deriveContestBlock(P, true, v, NOW)).toMatchObject({ kind: 'open', canContest: false, deadline: { remainingMs: 30 * MIN } })
    const closed = view({ autoProposal: { contestable: false, contestDeadlineAt: at(H), canCurrentUserContest: true } })
    expect(deriveContestBlock(P, true, closed, NOW)).toMatchObject({ kind: 'open', canContest: false })
  })
  it('amber under 1 h, like the escrow countdown', () => {
    expect(deriveContestBlock({ ...P, autoResolutionDeadline: at(H) }, true, null, NOW)).toMatchObject({ deadline: { tone: 'neutral' } })
    expect(deriveContestBlock({ ...P, autoResolutionDeadline: at(H - 1) }, true, null, NOW)).toMatchObject({ deadline: { tone: 'attention', milestone: 1 } })
  })
  it('deadline passed and not yet recorded: expired, no button', () => {
    const b = deriveContestBlock({ ...P, autoResolutionDeadline: at(-1) }, true, null, NOW)
    expect(b.kind).toBe('expired')
    expect('canContest' in b).toBe(false)
  })
})

describe('deadlineDisplay', () => {
  it('never invents a deadline', () => {
    expect(deadlineDisplay(null, NOW)).toBeNull()
    expect(deadlineDisplay(undefined, NOW)).toBeNull()
    expect(deadlineDisplay('', NOW)).toBeNull()
  })
  it('uses the 10 % rule only when the total is known', () => {
    expect(deadlineDisplay(at(2 * H), NOW, 24 * H)?.tone).toBe('attention')
    expect(deadlineDisplay(at(2 * H), NOW)?.tone).toBe('neutral')
  })
})

describe('parseAppealView', () => {
  it('accepts the contract shape', () => {
    expect(parseAppealView(view())).toEqual(view())
    const withAuto = view({ autoProposal: { contestable: true, contestDeadlineAt: at(H), canCurrentUserContest: true } })
    expect(parseAppealView(withAuto)).toEqual(withAuto)
  })
  it('rejects anything else', () => {
    expect(parseAppealView(null)).toBeNull()
    expect(parseAppealView({ ...view(), appealStatus: 'pending' })).toBeNull()
    expect(parseAppealView({ ...view(), canCurrentUserAppeal: 'yes' })).toBeNull()
    expect(parseAppealView({ ...view(), appealDeadlineAt: 'tomorrow' })).toBeNull()
    expect(parseAppealView({ ...view(), autoProposal: { contestable: true } })).toBeNull()
  })
})

describe('submitFailure', () => {
  it('maps the backend refusals and never reads a network failure as "not sent"', () => {
    expect(submitFailure({ statusCode: 400 })).toBe('changed')
    expect(submitFailure({ statusCode: 403 })).toBe('forbidden')
    expect(submitFailure({ statusCode: 404 })).toBe('notFound')
    expect(submitFailure({ statusCode: 0 })).toBe('unknown')
    expect(submitFailure(new Error('network'))).toBe('unknown')
    expect(submitFailure(null)).toBe('unknown')
  })
})

describe('offsetFromDateHeader (server clock)', () => {
  const received = Date.parse('2026-11-21T12:00:00.000Z')
  it('server minus device, at the midpoint of the header second', () => {
    expect(offsetFromDateHeader('Sat, 21 Nov 2026 12:00:30 GMT', received)).toBe(30_500)
    expect(offsetFromDateHeader('Sat, 21 Nov 2026 11:59:00 GMT', received)).toBe(-59_500)
  })
  it('ignores missing, broken and absurd headers', () => {
    expect(offsetFromDateHeader(null, received)).toBeNull()
    expect(offsetFromDateHeader('garbage', received)).toBeNull()
    expect(offsetFromDateHeader(new Date(received + MAX_SERVER_OFFSET_MS + 1000).toUTCString(), received)).toBeNull()
  })
})
