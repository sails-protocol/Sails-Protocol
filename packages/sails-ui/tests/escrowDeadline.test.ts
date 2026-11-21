import { deadlineMilestone, deadlineTone, escrowDeadlineView, formatRemaining } from '../src/lib/escrowDeadline'

// Escrow deadline timer (UX-029): only expiresAt/timelockHours, thresholds at 1 h and 10 %.
const MIN = 60_000, H = 60 * MIN
const NOW = Date.parse('2026-11-20T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()

describe('formatRemaining', () => {
  it('hours and padded minutes from exactly 1 h up', () => {
    expect(formatRemaining(H)).toBe('1\u00a0h 00\u00a0min')
    expect(formatRemaining(39 * H + 59 * MIN + 59_000)).toBe('39\u00a0h 59\u00a0min')
    expect(formatRemaining(72 * H)).toBe('72\u00a0h 00\u00a0min')
  })
  it('minutes and seconds under 1 h, never 0 while live', () => {
    expect(formatRemaining(H - 1)).toBe('59\u00a0min 59\u00a0s')
    expect(formatRemaining(12 * MIN + 5_000)).toBe('12\u00a0min 05\u00a0s')
    expect(formatRemaining(42_000)).toBe('42\u00a0s')
    expect(formatRemaining(1)).toBe('1\u00a0s')
  })
})

describe('deadlineTone', () => {
  const T = 72 * H
  it('exactly 1 h is neutral, just under is attention', () => {
    expect(deadlineTone(H, null)).toBe('neutral')
    expect(deadlineTone(H - 1, null)).toBe('attention')
  })
  it('exactly 10 % is neutral, just under is attention', () => {
    expect(deadlineTone(T * 0.1, T)).toBe('neutral')
    expect(deadlineTone(T * 0.1 - 1, T)).toBe('attention')
  })
  it('zero and past are expired', () => {
    expect(deadlineTone(0, T)).toBe('expired')
    expect(deadlineTone(-5 * MIN, T)).toBe('expired')
  })
  it('no total: only the 1 h rule applies', () => {
    expect(deadlineTone(2 * H, null)).toBe('neutral')
    expect(deadlineTone(2 * H, 0)).toBe('neutral')
  })
})

describe('deadlineMilestone', () => {
  it('orders attention < 10 min < 1 min < expired', () => {
    expect(deadlineMilestone(2 * H, 'neutral')).toBe(0)
    expect(deadlineMilestone(50 * MIN, 'attention')).toBe(1)
    expect(deadlineMilestone(10 * MIN, 'attention')).toBe(2)
    expect(deadlineMilestone(MIN, 'attention')).toBe(3)
    expect(deadlineMilestone(0, 'expired')).toBe(4)
  })
})

describe('escrowDeadlineView', () => {
  it('active neutral with bar and absolute deadline', () => {
    const v = escrowDeadlineView({ expiresAt: at(36 * H), timelockHours: 72, status: 'FUNDS_LOCKED' }, NOW)
    expect(v).toMatchObject({ kind: 'active', tone: 'neutral', remainingText: '36\u00a0h 00\u00a0min', progress: 50 })
    if (v?.kind === 'active') expect(v.deadlineText).toMatch(/^até \d\d\/\d\d, \d\d:\d\d$/)
  })
  it('attention near the end, no bar without a total', () => {
    expect(escrowDeadlineView({ expiresAt: at(8 * MIN), timelockHours: 72, status: 'PAYMENT_PENDING' }, NOW)).toMatchObject({ tone: 'attention', remainingText: '8\u00a0min 00\u00a0s' })
    expect(escrowDeadlineView({ expiresAt: at(5 * H), timelockHours: 0, status: 'FUNDS_LOCKED' }, NOW)).toMatchObject({ tone: 'neutral', progress: null })
  })
  it('past deadline: "Encerrado", never negative', () => {
    const v = escrowDeadlineView({ expiresAt: at(-3 * H), timelockHours: 72, status: 'FUNDS_LOCKED' }, NOW)
    expect(v).toMatchObject({ kind: 'active', tone: 'expired', remainingText: 'Encerrado' })
    if (v?.kind === 'active') expect(v.deadlineText.startsWith('em ')).toBe(true)
  })
  it('CREATED before lock: the total only; missing values: unavailable', () => {
    expect(escrowDeadlineView({ expiresAt: null, timelockHours: 72, status: 'CREATED' }, NOW)).toMatchObject({ kind: 'pending', text: '72\u00a0h a partir do bloqueio dos fundos' })
    expect(escrowDeadlineView({ expiresAt: null, timelockHours: 72, status: 'FUNDS_LOCKED' }, NOW)).toMatchObject({ kind: 'unavailable' })
    expect(escrowDeadlineView({ expiresAt: 'not-a-date', timelockHours: 72, status: 'FUNDS_LOCKED' }, NOW)).toMatchObject({ kind: 'unavailable' })
    expect(escrowDeadlineView({ expiresAt: null, timelockHours: undefined, status: 'CREATED' }, NOW)).toMatchObject({ kind: 'unavailable' })
  })
  it('never in terminal states or EXPIRED', () => {
    for (const status of ['COMPLETED', 'REFUNDED', 'SPLIT', 'EXPIRED'] as const) {
      expect(escrowDeadlineView({ expiresAt: at(H), timelockHours: 72, status }, NOW)).toBeNull()
    }
  })
  it('explains the deadline per status, never promising an automatic action by this interface', () => {
    const lines = (status: 'FUNDS_LOCKED' | 'PAYMENT_PENDING' | 'DISPUTED') => escrowDeadlineView({ expiresAt: at(H * 2), timelockHours: 72, status }, NOW)!.explanation.lines.join(' ')
    expect(lines('FUNDS_LOCKED')).toContain('deixa de aceitar as etapas normais do trade')
    expect(lines('PAYMENT_PENDING')).toContain('não encerra o escrow por este prazo')
    expect(lines('DISPUTED')).toContain('não encerra o escrow por este prazo')
  })
})
