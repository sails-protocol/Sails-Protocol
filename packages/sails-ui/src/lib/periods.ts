/**
 * Period selection for the dashboards (PO 2026-11-23): presets (7 / 30 / 90 days, "Desde o início") and a custom
 * range, the bucket size the span implies (day, week, month), range validation and per-asset bucketing. Pure, local
 * time, no economic logic: it only groups records the screen already has. Dates travel as `YYYY-MM-DD` strings
 * (what `<input type="date">` gives) so they persist and compare without time-zone drift.
 */

export type PeriodPreset = '7d' | '30d' | '90d' | 'all'
export type Period = { kind: 'preset'; preset: PeriodPreset } | { kind: 'custom'; from: string; to: string }
export type BucketSize = 'day' | 'week' | 'month'
export type RangeError = 'invalid' | 'order' | 'future' | 'beforeStart'

export interface DateRange {
  /** Start of the first day (local). */
  from: Date
  /** Start of the last day (local); the range includes that whole day. */
  to: Date
}

export const PERIOD_PRESETS: readonly PeriodPreset[] = ['7d', '30d', '90d', 'all']
export const DEFAULT_PERIOD: Period = { kind: 'preset', preset: '30d' }
const PRESET_DAYS: Record<Exclude<PeriodPreset, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }
const DAY = 86_400_000

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** Whole days from `from` to `to`, both included (DST-safe: rounds). */
export function spanDays(range: DateRange): number {
  return Math.round((startOfDay(range.to).getTime() - startOfDay(range.from).getTime()) / DAY) + 1
}

/** `YYYY-MM-DD` as a local date, or null when it is not a real calendar day. */
export function parseDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
}

export function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The days a period covers. `start` is the first day there can be data (account or market start): "Desde o início"
 * begins there, and a preset never reaches before it.
 */
export function resolvePeriod(period: Period, now: Date, start: Date): DateRange {
  const today = startOfDay(now)
  const first = startOfDay(start) > today ? today : startOfDay(start)
  if (period.kind === 'custom') {
    const from = parseDateInput(period.from)
    const to = parseDateInput(period.to)
    if (from && to && !validateRange(period.from, period.to, { today, min: first })) return { from, to }
    return { from: addDays(today, -(PRESET_DAYS['30d'] - 1)), to: today }
  }
  if (period.preset === 'all') return { from: first, to: today }
  const from = addDays(today, -(PRESET_DAYS[period.preset] - 1))
  return { from: from < first ? first : from, to: today }
}

/** The equal span right before `range` (for "vs período anterior"). */
export function previousRange(range: DateRange): DateRange {
  const n = spanDays(range)
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) }
}

/** Day buckets up to 6 months, weeks up to 2 years, months beyond (PO 2026-11-23). */
export function bucketSizeFor(range: DateRange): BucketSize {
  const days = spanDays(range)
  if (days > 731) return 'month'
  if (days > 183) return 'week'
  return 'day'
}

/** Start of the bucket holding `d`: the day, the Monday of its week, or the 1st of its month. */
export function bucketStart(d: Date, size: BucketSize): Date {
  const day = startOfDay(d)
  if (size === 'day') return day
  if (size === 'month') return new Date(day.getFullYear(), day.getMonth(), 1)
  return addDays(day, -((day.getDay() + 6) % 7))
}

function nextBucket(d: Date, size: BucketSize): Date {
  if (size === 'day') return addDays(d, 1)
  if (size === 'week') return addDays(d, 7)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}

/** Every bucket start from the one holding `range.from` to the one holding `range.to`. */
export function bucketStarts(range: DateRange, size: BucketSize): Date[] {
  const out: Date[] = []
  const last = bucketStart(range.to, size).getTime()
  for (let d = bucketStart(range.from, size); d.getTime() <= last; d = nextBucket(d, size)) out.push(d)
  return out
}

export function inRange(at: Date, range: DateRange): boolean {
  const t = at.getTime()
  return t >= startOfDay(range.from).getTime() && t < addDays(range.to, 1).getTime()
}

/** null when the custom range is valid; otherwise the first rule it breaks. */
export function validateRange(from: string, to: string, limits: { today: Date; min?: Date }): RangeError | null {
  const a = parseDateInput(from)
  const b = parseDateInput(to)
  if (!a || !b) return 'invalid'
  if (a > b) return 'order'
  if (b > startOfDay(limits.today)) return 'future'
  if (limits.min && a < startOfDay(limits.min)) return 'beforeStart'
  return null
}

export interface DatedAmount {
  at: Date
  /** Series key (one asset). Values are never added across keys. */
  key: string
  value: number
}

/** Sums `value` per key and per bucket, inside `range` only. Keys keep their own arrays: nothing is summed across. */
export function bucketByKey(points: readonly DatedAmount[], range: DateRange, size: BucketSize): { starts: Date[]; series: Map<string, number[]> } {
  const starts = bucketStarts(range, size)
  const index = new Map(starts.map((d, i) => [d.getTime(), i]))
  const series = new Map<string, number[]>()
  for (const p of points) {
    if (!inRange(p.at, range) || !Number.isFinite(p.value)) continue
    const i = index.get(bucketStart(p.at, size).getTime())
    if (i === undefined) continue
    const row = series.get(p.key) ?? starts.map(() => 0)
    row[i] += p.value
    series.set(p.key, row)
  }
  return { starts, series }
}

/** "1 de set. de 2025 – 23 de nov. de 2026" in the interface language. */
export function formatRange(range: DateRange, locale: string): string {
  const f = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  return spanDays(range) === 1 ? f.format(range.from) : `${f.format(range.from)} – ${f.format(range.to)}`
}

/** Axis / table label of one bucket. */
export function formatBucket(d: Date, size: BucketSize, locale: string): string {
  const opts: Intl.DateTimeFormatOptions = size === 'month' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }
  return new Intl.DateTimeFormat(locale, opts).format(d)
}

/** A stored period, or null when it is missing or malformed (never trusted as is). */
export function parseStoredPeriod(raw: string | null): Period | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<{ kind: string; preset: string; from: string; to: string }>
    if (v.kind === 'preset' && PERIOD_PRESETS.includes(v.preset as PeriodPreset)) return { kind: 'preset', preset: v.preset as PeriodPreset }
    if (v.kind === 'custom' && typeof v.from === 'string' && typeof v.to === 'string' && parseDateInput(v.from) && parseDateInput(v.to)) return { kind: 'custom', from: v.from, to: v.to }
  } catch { /* malformed: ignored */ }
  return null
}

/** Per-dashboard memory in this browser; storage can be missing or blocked, and then nothing is remembered. */
export function loadPeriod(key: string): Period {
  try { return parseStoredPeriod(localStorage.getItem(key)) ?? DEFAULT_PERIOD } catch { return DEFAULT_PERIOD }
}

export function savePeriod(key: string, period: Period): void {
  try { localStorage.setItem(key, JSON.stringify(period)) } catch { /* not remembered */ }
}
