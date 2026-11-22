import type { ReactNode } from 'react'
import { InfoTooltip } from './InfoTooltip'
import { cn } from '../../lib/utils'

export interface StatItem {
  label: string
  value: ReactNode
  /** Definition shown in an info tooltip next to the label. */
  info?: string
}

/** Layer A: a row of label/value stats with no boxes, left-aligned; two per row on phones (2×2 for four). */
export function StatStrip({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:flex-wrap', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="flex items-center gap-1 text-xs text-brand-text-muted">
            {item.label}
            {item.info && <InfoTooltip text={item.info} />}
          </dt>
          <dd className="money text-brand-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
