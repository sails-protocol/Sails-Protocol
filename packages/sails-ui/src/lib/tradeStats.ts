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
