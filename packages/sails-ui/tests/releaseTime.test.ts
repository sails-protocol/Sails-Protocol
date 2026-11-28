import { averageDuration, durationParts, inFlightOnce, mapLimited, releaseDurationMs, releaseSample, RELEASE_SAMPLE_CAP, type TradeRecord } from '../src/lib/tradeStats'

const ev = (fromStatus: string, toStatus: string, createdAt: string) => ({ fromStatus, toStatus, createdAt })
const COOPERATIVE = [
  ev('CREATED', 'FUNDS_LOCKED', '2026-11-01T10:00:00Z'),
  ev('FUNDS_LOCKED', 'PAYMENT_PENDING', '2026-11-01T10:10:00Z'),
  ev('PAYMENT_PENDING', 'COMPLETED', '2026-11-01T10:28:00Z'),
]

describe('release time from escrow events (Principal: cooperative releases only)', () => {
  it('measures payment declared -> released', () => expect(releaseDurationMs(COOPERATIVE)).toBe(18 * 60000))
  it('skips an escrow missing either transition', () => {
    expect(releaseDurationMs(COOPERATIVE.slice(0, 2))).toBeNull()
    expect(releaseDurationMs([COOPERATIVE[0], COOPERATIVE[2]])).toBeNull()
    expect(releaseDurationMs(undefined)).toBeNull()
    expect(releaseDurationMs([])).toBeNull()
  })
  it('excludes a disputed escrow, even one that ends DISPUTED -> COMPLETED', () => {
    expect(releaseDurationMs([...COOPERATIVE.slice(0, 2), ev('PAYMENT_PENDING', 'DISPUTED', '2026-11-01T11:00:00Z'), ev('DISPUTED', 'COMPLETED', '2026-11-02T09:00:00Z')])).toBeNull()
    expect(releaseDurationMs([...COOPERATIVE, ev('FUNDS_LOCKED', 'DISPUTED', '2026-11-01T10:05:00Z')])).toBeNull()
  })
  it('never falls back to releasedAt: an escrow with only releasedAt and no events is excluded', () => {
    expect(releaseDurationMs((({ releasedAt: '2026-11-01T10:28:00Z', events: [] }) as { events: unknown[] }).events)).toBeNull()
  })
  it('rejects a release recorded before the payment', () => {
    expect(releaseDurationMs([ev('FUNDS_LOCKED', 'PAYMENT_PENDING', '2026-11-01T11:00:00Z'), ev('PAYMENT_PENDING', 'COMPLETED', '2026-11-01T10:00:00Z')])).toBeNull()
  })
  it('averages only the durations that exist', () => {
    expect(averageDuration([60000, null, 180000])).toEqual({ ms: 120000, count: 2 })
    expect(averageDuration([null])).toBeNull()
  })
  it('splits durations for "18 min" and "2 h 05 min"', () => {
    expect(durationParts(18 * 60000)).toEqual({ hours: 0, minutes: 18, totalMinutes: 18 })
    expect(durationParts(125 * 60000)).toEqual({ hours: 2, minutes: 5, totalMinutes: 125 })
  })
})

describe('release sample (one escrow read per trade, capped)', () => {
  const range = { from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) }
  const tr = (i: number, patch: Partial<TradeRecord> = {}): TradeRecord => ({
    unit: 'BTC', amount: 1, totalUsd: 1, status: 'COMPLETED', createdAt: '2026-11-01T00:00:00Z',
    completedAt: new Date(2026, 10, 1, 12, i).toISOString(), cancelledAt: null, escrowId: `e${i}`, ...patch,
  })
  it('keeps completed trades in the period with an escrow, most recent first', () => {
    const s = releaseSample([tr(1), tr(2), tr(3, { escrowId: null }), tr(4, { status: 'CANCELLED' }), tr(5, { completedAt: '2026-12-15T12:00:00Z' })], range)
    expect(s).toEqual({ escrowIds: ['e2', 'e1'], capped: false })
  })
  it('caps at the most recent RELEASE_SAMPLE_CAP and says so', () => {
    const s = releaseSample(Array.from({ length: RELEASE_SAMPLE_CAP + 5 }, (_, i) => tr(i)), range)
    expect(s.escrowIds).toHaveLength(RELEASE_SAMPLE_CAP)
    expect(s.escrowIds[0]).toBe(`e${RELEASE_SAMPLE_CAP + 4}`)
    expect(s.capped).toBe(true)
  })
  it('runs at most `limit` reads at a time and keeps the order', async () => {
    let live = 0, peak = 0
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(peak).toBe(4)
  })
})

describe('inFlightOnce', () => {
  it('shares one call per key while it runs, then calls again', async () => {
    let calls = 0
    const once = inFlightOnce(async (k: string) => { calls += 1; return `${k}:${calls}` })
    const [a, b, c] = await Promise.all([once('me'), once('me'), once('other')])
    expect([a, b, c]).toEqual(['me:1', 'me:1', 'other:2'])
    expect(await once('me')).toBe('me:3')
  })
  it('forgets a failed call so a retry runs again', async () => {
    let calls = 0
    const once = inFlightOnce(async () => { calls += 1; if (calls === 1) throw new Error('down'); return 'ok' })
    await expect(once('me')).rejects.toThrow('down')
    await expect(once('me')).resolves.toBe('ok')
  })
})
