import { cn } from '../../lib/utils'
import { seriesColor, type SeriesSlot } from './LineAreaChart'

export interface BarListItem {
  key: string
  label: string
  /** Drives the bar length; never shown raw. */
  value: number
  /** Always shown (caller formats it in the interface language). */
  valueText: string
  /** Secondary line under the label, e.g. "12 negociações". */
  meta?: string
  /** Series colour of the entity (the asset keeps its chart colour). */
  slot?: SeriesSlot
}

/**
 * Layer A: ranked horizontal bars (top assets, top offers). Every value is printed, so the list reads without the
 * bars and needs no tooltip; bars are thin (8 px, rounded ends) and decorative (aria-hidden). An ordered list.
 */
export function BarList({ items, label, className }: { items: readonly BarListItem[]; label: string; className?: string }) {
  const max = Math.max(0, ...items.map((i) => i.value))
  return (
    <ol aria-label={label} className={cn('space-y-3', className)}>
      {items.map((item) => (
        <li key={item.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-body-sm text-brand-text break-words">{item.label}</span>
            <span className="shrink-0 text-body-sm font-medium tabular-nums text-brand-text">{item.valueText}</span>
          </div>
          {item.meta && <p className="text-caption text-brand-text-muted">{item.meta}</p>}
          <div aria-hidden="true" className="mt-1 h-2">
            <div className="h-2 rounded-full" style={{ width: `${max > 0 ? Math.max(2, (item.value / max) * 100) : 0}%`, background: seriesColor(item.slot ?? 1) }} />
          </div>
        </li>
      ))}
    </ol>
  )
}
