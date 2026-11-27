/**
 * Dashboard figures from trade records the screen already has (PO 2026-11-23, Principal data facts): display only,
 * no economic logic. Every amount stays per asset: crypto quantities are never added across assets, and the chart's
 * USD series is one series per asset (the trade's own `totalUsd`), never one total.
 */
import { bucketByKey, inRange, type BucketSize, type DateRange } from './periods'

/** The fields of an SDK Trade these figures read (GET /v1/openp2p/trades). */
export interface TradeRecord {
  /** Asset unit shown to people ("BTC", "USDT"): the series key. */
  unit: string
  amount: number
  totalUsd: number
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED'
  createdAt: string
  completedAt: string | null
  cancelledAt: string | null
  /** Trade.escrowId: the escrow whose events time the release (null before any escrow). */
  escrowId?: string | null
}

export interface PeriodFigures {
  completed: number
  cancelled: number
  disputed: number
  /** Completed ÷ (completed + cancelled + disputed) in the period; null when the denominator is 0. */
  completionRate: number | null
  /** Crypto quantity per unit (completed trades). */
  amountByUnit: Map<string, number>
  /** USD value per unit (completed trades, the trade's own totalUsd). */
  usdByUnit: Map<string, number>
}

const at = (iso: string | null) => (iso ? new Date(iso) : null)
const valid = (d: Date | null): d is Date => !!d && !Number.isNaN(d.getTime())

/**
 * Completed trades count by `completedAt`, cancelled by `cancelledAt`; a disputed trade has no dispute date on the
 * list, so it counts by `createdAt` (the help line says so).
 */
export function periodFigures(trades: readonly TradeRecord[], range: DateRange): PeriodFigures {
  let completed = 0, cancelled = 0, disputed = 0
  const amountByUnit = new Map<string, number>()
  const usdByUnit = new Map<string, number>()
  for (const tr of trades) {
    if (tr.status === 'COMPLETED') {
      const d = at(tr.completedAt)
      if (!valid(d) || !inRange(d, range)) continue
      completed++
      amountByUnit.set(tr.unit, (amountByUnit.get(tr.unit) ?? 0) + (Number.isFinite(tr.amount) ? tr.amount : 0))
      usdByUnit.set(tr.unit, (usdByUnit.get(tr.unit) ?? 0) + (Number.isFinite(tr.totalUsd) ? tr.totalUsd : 0))
    } else if (tr.status === 'CANCELLED') {
      const d = at(tr.cancelledAt)
      if (valid(d) && inRange(d, range)) cancelled++
    } else if (tr.status === 'DISPUTED') {
      const d = at(tr.createdAt)
      if (valid(d) && inRange(d, range)) disputed++
    }
  }
  const denom = completed + cancelled + disputed
  return { completed, cancelled, disputed, completionRate: denom === 0 ? null : completed / denom, amountByUnit, usdByUnit }
}

/** USD volume of completed trades per unit and bucket (one series per asset). */
export function usdSeries(trades: readonly TradeRecord[], range: DateRange, size: BucketSize) {
  const points = trades.flatMap((tr) => {
    const d = at(tr.completedAt)
    return tr.status === 'COMPLETED' && valid(d) ? [{ at: d, key: tr.unit, value: tr.totalUsd }] : []
  })
  return bucketByKey(points, range, size)
}

/** Fixed series order, so a colour follows its asset and never its rank (dataviz: colour follows the entity). */
export const UNIT_ORDER: readonly string[] = ['BTC', 'USDT', 'USDC']

/** Units sorted by the fixed order, unknown units after, alphabetically. */
export function orderUnits(units: Iterable<string>): string[] {
  const rank = (u: string) => { const i = UNIT_ORDER.indexOf(u); return i < 0 ? UNIT_ORDER.length : i }
  return [...new Set(units)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** One record of Escrow.events (GET /v1/settlement/escrow/:id, createdAt ascending). */
export interface EscrowEventRecord { fromStatus: string; toStatus: string; createdAt: string }

/**
 * Payment declared (FUNDS_LOCKED -> PAYMENT_PENDING) to release (PAYMENT_PENDING -> COMPLETED), in ms, from the
 * escrow's own events. null when either transition is missing, when any event touches DISPUTED (a ruling time is not
 * a cooperative release) or when the times do not make sense. Never falls back to releasedAt: a disputed escrow ends
 * DISPUTED -> COMPLETED with a releasedAt too.
 */
export function releaseDurationMs(events: unknown): number | null {
  if (!Array.isArray(events)) return null
  const list = events.filter((e): e is EscrowEventRecord => !!e && typeof e === 'object' && typeof e.fromStatus === 'string' && typeof e.toStatus === 'string' && typeof e.createdAt === 'string')
  if (list.some((e) => e.fromStatus === 'DISPUTED' || e.toStatus === 'DISPUTED')) return null
  const paid = list.find((e) => e.fromStatus === 'FUNDS_LOCKED' && e.toStatus === 'PAYMENT_PENDING')
  const released = list.find((e) => e.fromStatus === 'PAYMENT_PENDING' && e.toStatus === 'COMPLETED')
  if (!paid || !released) return null
  const ms = Date.parse(released.createdAt) - Date.parse(paid.createdAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** Average of the durations that exist; null when none does. */
export function averageDuration(durations: readonly (number | null)[]): { ms: number; count: number } | null {
  const ok = durations.filter((d): d is number => d !== null)
  return ok.length ? { ms: ok.reduce((a, d) => a + d, 0) / ok.length, count: ok.length } : null
}

/** Escrow reads allowed per period (Principal: one call per trade, display only). */
export const RELEASE_SAMPLE_CAP = 50

/** The escrows to read: completed trades in the period with an escrowId, most recent first, at most `cap`. */
export function releaseSample(trades: readonly TradeRecord[], range: DateRange, cap = RELEASE_SAMPLE_CAP): { escrowIds: string[]; capped: boolean } {
  const eligible = trades
    .filter((tr) => tr.status === 'COMPLETED' && !!tr.escrowId && valid(at(tr.completedAt)) && inRange(at(tr.completedAt) as Date, range))
    .sort((a, b) => (b.completedAt as string).localeCompare(a.completedAt as string))
  return { escrowIds: eligible.slice(0, cap).map((tr) => tr.escrowId as string), capped: eligible.length > cap }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the input order in the result. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Whole minutes and the hours split, for "18 min" / "2 h 05 min" (the words come from the catalog). */
export function durationParts(ms: number): { hours: number; minutes: number; totalMinutes: number } {
  const totalMinutes = Math.round(ms / 60000)
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60, totalMinutes }
}

// shortcut: provisional UI value; the real small-numbers rule belongs to the backend aggregates contract (Principal/CTO), move it there when that contract exists.
export const MIN_AGGREGATE_COUNT = 5

/**
 * Small-numbers privacy for the space dashboard (CTO 29 Portable Analytics): with few concluded trades in the period or
 * few members, a breakdown can point at one person, so the per-asset figures, the chart and the top assets hide.
 * Members unknown counts as few: never shown on a guess.
 */
export function aggregatesHidden(i: { completed: number; members: number | null | undefined }): boolean {
  return i.completed < MIN_AGGREGATE_COUNT || i.members === null || i.members === undefined || i.members < MIN_AGGREGATE_COUNT
}

/**
 * One call per key while it is in flight: callers that ask for the same key before it settles share its promise
 * (Perfil's "Minhas estatísticas" and "Seu caminho" read the same trade list). Settled calls are forgotten, so the
 * next visit or a retry reads fresh data.
 */
export function inFlightOnce<R>(run: (key: string) => Promise<R>): (key: string) => Promise<R> {
  const pending = new Map<string, Promise<R>>()
  return (key) => {
    const known = pending.get(key)
    if (known) return known
    const p = run(key).finally(() => { if (pending.get(key) === p) pending.delete(key) })
    pending.set(key, p)
    return p
  }
}
