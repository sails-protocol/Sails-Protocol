import { ArrowLeftRight, Award, Scale, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { TrustKind, TrustLineItem } from './trustTypes'

// Neutral icons only: never a shield or check, which would read as a guarantee.
const ICONS: Record<TrustKind, LucideIcon> = { reputation: Award, trades: ArrowLeftRight, disputes: Scale, disputeRate: Scale }

/**
 * Layer A: a compact trust line, each item an icon plus its text. Items are spaced, not joined by a
 * "·": a visible separator ends up stranded at a line end when the line wraps on narrow screens.
 * The icons already separate the items; screen readers get a comma between them.
 */
export function TrustLine({ items, className }: { items: TrustLineItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums', className)}>
      {items.map((item, i) => {
        const Icon = ICONS[item.kind]
        return (
          <span key={item.kind} className="whitespace-nowrap">
            {i > 0 && <span className="sr-only">, </span>}
            <Icon aria-hidden="true" className="inline-block h-4 w-4 mr-1 align-[-4px]" />
            {item.srText ? <><span aria-hidden="true">{item.text}</span><span className="sr-only">{item.srText}</span></> : item.text}
          </span>
        )
      })}
    </span>
  )
}
