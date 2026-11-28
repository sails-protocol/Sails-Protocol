import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface StatDelta {
  /** Caller copy, e.g. "+12 vs período anterior". */
  text: string
  direction: 'up' | 'down' | 'flat'
}

/**
 * Layer A: one KPI inside a `<dl>` (dataviz stat tile: label, value, optional delta and help). The delta is neutral
 * text with an arrow: up is not "good" and down is not "bad", so it never wears green or red (one meaning per colour).
 * No box: tiles sit on the section surface and separate by space.
 */
export function StatTile({ label, value, help, delta, aside, className }: {
  label: string
  value: ReactNode
  /** How the number is computed, in one line (caller copy). */
  help?: string
  delta?: StatDelta
  /** A marker next to the label (e.g. SimulatedBadge). */
  aside?: ReactNode
  className?: string
}) {
  const Arrow = delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : Minus
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="flex flex-wrap items-center gap-1.5 text-caption text-brand-text-muted">{label}{aside}</dt>
      <dd className="mt-1 text-headline tabular-nums text-brand-text break-words">{value}</dd>
      {delta && (
        <dd className="mt-0.5 flex items-center gap-1 text-caption text-brand-text-secondary">
          <Arrow aria-hidden="true" className="size-icon-xs shrink-0" />{delta.text}
        </dd>
      )}
      {help && <dd className="mt-0.5 text-caption text-brand-text-muted">{help}</dd>}
    </div>
  )
}
