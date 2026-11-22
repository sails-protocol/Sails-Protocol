/**
 * Dashboard periods and bucketing (PO 2026-11-23): presets, bucket size by span, custom-range validation, stored
 * period parsing, and per-asset figures that never add one asset to another.
 */
import {
  bucketByKey, bucketSizeFor, bucketStart, bucketStarts, formatRange, parseDateInput, parseStoredPeriod, previousRange,
  resolvePeriod, spanDays, toDateInput, validateRange,
} from '../src/lib/periods'
import { orderUnits, periodFigures, usdSeries, type TradeRecord } from '../src/lib/tradeStats'

const NOW = new Date(2026, 10, 23, 15, 30) // 23 Nov 2026, afternoon
const day = (s: string) => parseDateInput(s) as Date

describe('periods', () => {
  it('presets cover whole days ending today, never before the start', () => {
    const start = day('2024-09-01')
    const r7 = resolvePeriod({ kind: 'preset', preset: '7d' }, NOW, start)
    expect(toDateInput(r7.from)).toBe('2026-11-17')
    expect(toDateInput(r7.to)).toBe('2026-11-23')
    expect(spanDays(r7)).toBe(7)
    expect(spanDays(resolvePeriod({ kind: 'preset', preset: '90d' }, NOW, start))).toBe(90)
    expect(toDateInput(resolvePeriod({ kind: 'preset', preset: 'all' }, NOW, start).from)).toBe('2024-09-01')
    // An account two days old: 30 days starts at the account.
    expect(toDateInput(resolvePeriod({ kind: 'preset', preset: '30d' }, NOW, day('2026-11-21')).from)).toBe('2026-11-21')
  })

  it('a custom range is used as is when valid, and falls back to 30 days when not', () => {
    const start = day('2025-01-01')
    const ok = resolvePeriod({ kind: 'custom', from: '2025-09-01', to: '2026-11-23' }, NOW, start)
    expect([toDateInput(ok.from), toDateInput(ok.to)]).toEqual(['2025-09-01', '2026-11-23'])
    expect(spanDays(resolvePeriod({ kind: 'custom', from: '2026-12-01', to: '2026-12-02' }, NOW, start))).toBe(30)
  })

  it('bucket size: day up to 6 months, week up to 2 years, month beyond', () => {
    const r = (from: string, to: string) => ({ from: day(from), to: day(to) })
    expect(bucketSizeFor(r('2026-08-23', '2026-11-23'))).toBe('day')
    expect(bucketSizeFor(r('2026-01-01', '2026-11-23'))).toBe('week')
    expect(bucketSizeFor(r('2024-12-01', '2026-11-23'))).toBe('week')
    expect(bucketSizeFor(r('2024-09-01', '2026-11-23'))).toBe('month')
  })

  it('weeks start on Monday, months on the 1st, and every bucket in the range is listed', () => {
    expect(toDateInput(bucketStart(day('2026-11-22'), 'week'))).toBe('2026-11-16') // Sunday -> Monday before
    expect(toDateInput(bucketStart(day('2026-11-23'), 'week'))).toBe('2026-11-23') // Monday
    expect(toDateInput(bucketStart(day('2026-11-23'), 'month'))).toBe('2026-11-01')
    const months = bucketStarts({ from: day('2024-09-15'), to: day('2026-11-23') }, 'month')
    expect(months).toHaveLength(27)
    expect(toDateInput(months[0])).toBe('2024-09-01')
  })

  it('validates a custom range: real days, start before end, not in the future, not before the start', () => {
    const limits = { today: NOW, min: day('2025-01-01') }
    expect(validateRange('2025-02-01', '2025-03-01', limits)).toBeNull()
    expect(validateRange('2025-02-30', '2025-03-01', limits)).toBe('invalid')
    expect(validateRange('', '2025-03-01', limits)).toBe('invalid')
    expect(validateRange('2025-03-02', '2025-03-01', limits)).toBe('order')
    expect(validateRange('2026-11-01', '2026-11-24', limits)).toBe('future')
    expect(validateRange('2024-12-31', '2025-03-01', limits)).toBe('beforeStart')
    expect(validateRange('2026-11-23', '2026-11-23', limits)).toBeNull()
  })

  it('previous range is the equal span right before', () => {
    const p = previousRange({ from: day('2026-10-25'), to: day('2026-11-23') })
    expect([toDateInput(p.from), toDateInput(p.to)]).toEqual(['2026-09-25', '2026-10-24'])
  })

  it('stored periods are parsed defensively', () => {
    expect(parseStoredPeriod('{"kind":"preset","preset":"90d"}')).toEqual({ kind: 'preset', preset: '90d' })
    expect(parseStoredPeriod('{"kind":"custom","from":"2025-01-01","to":"2025-02-01"}')).toEqual({ kind: 'custom', from: '2025-01-01', to: '2025-02-01' })
    expect(parseStoredPeriod('{"kind":"preset","preset":"365d"}')).toBeNull()
    expect(parseStoredPeriod('{"kind":"custom","from":"x","to":"2025-02-01"}')).toBeNull()
    expect(parseStoredPeriod('not json')).toBeNull()
    expect(parseStoredPeriod(null)).toBeNull()
  })

  it('formats the range in the interface language', () => {
    const text = formatRange({ from: day('2025-09-01'), to: day('2026-11-23') }, 'pt-BR')
    expect(text).toMatch(/1 de set\. de 2025/)
    expect(text).toMatch(/23 de nov\. de 2026/)
  })

  it('buckets per key and never mixes keys', () => {
    const range = { from: day('2026-11-01'), to: day('2026-11-30') }
    const { starts, series } = bucketByKey([
      { at: new Date(2026, 10, 2, 10), key: 'BTC', value: 1 },
      { at: new Date(2026, 10, 2, 23), key: 'BTC', value: 2 },
      { at: new Date(2026, 10, 2, 12), key: 'USDT', value: 500 },
      { at: new Date(2026, 9, 31, 12), key: 'BTC', value: 99 }, // outside
    ], range, 'week')
    expect(toDateInput(starts[0])).toBe('2026-10-26')
    expect(series.get('BTC')?.[1]).toBe(3) // 2 Nov 2026 is a Monday: second week
    expect(series.get('USDT')?.[1]).toBe(500)
  })
})

describe('trade figures', () => {
  const tr = (p: Partial<TradeRecord>): TradeRecord => ({ unit: 'BTC', amount: 0.1, totalUsd: 9000, status: 'COMPLETED', createdAt: '2026-11-10T10:00:00', completedAt: '2026-11-10T12:00:00', cancelledAt: null, ...p })
  const range = { from: day('2026-11-01'), to: day('2026-11-23') }

  it('counts completed by completion date, cancelled by cancel date, disputed by creation date', () => {
    const f = periodFigures([
      tr({}),
      tr({ unit: 'USDT', amount: 1000, totalUsd: 1000 }),
      tr({ completedAt: '2026-10-01T12:00:00' }), // completed before the period
      tr({ status: 'CANCELLED', completedAt: null, cancelledAt: '2026-11-05T10:00:00' }),
      tr({ status: 'DISPUTED', completedAt: null, createdAt: '2026-11-06T10:00:00' }),
      tr({ status: 'ACTIVE', completedAt: null }),
    ], range)
    expect([f.completed, f.cancelled, f.disputed]).toEqual([2, 1, 1])
    expect(f.completionRate).toBe(0.5)
    expect(f.amountByUnit.get('BTC')).toBeCloseTo(0.1)
    expect(f.amountByUnit.get('USDT')).toBe(1000)
    // No cross-asset total exists anywhere.
    expect([...f.amountByUnit.keys()].sort()).toEqual(['BTC', 'USDT'])
  })

  it('no completed, cancelled or disputed trade: no rate (never 0 %)', () => {
    expect(periodFigures([tr({ status: 'ACTIVE', completedAt: null })], range).completionRate).toBeNull()
  })

  it('USD series is one series per asset', () => {
    const s = usdSeries([tr({}), tr({ unit: 'USDT', totalUsd: 1000 })], range, 'day')
    expect([...s.series.keys()].sort()).toEqual(['BTC', 'USDT'])
    expect(s.series.get('BTC')?.reduce((a, b) => a + b)).toBe(9000)
  })

  it('units keep a fixed order', () => {
    expect(orderUnits(['USDC', 'XYZ', 'BTC', 'USDT', 'BTC'])).toEqual(['BTC', 'USDT', 'USDC', 'XYZ'])
  })
})
