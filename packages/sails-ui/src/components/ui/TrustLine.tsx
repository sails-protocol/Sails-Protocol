import { ArrowLeftRight, Award, Scale, type LucideIcon } from 'lucide-react'
import { Fragment } from 'react'
import { cn } from '../../lib/utils'
import type { TrustKind, TrustLineItem } from './trustTypes'

// Neutral icons only: never a shield or check, which would read as a guarantee.
const ICONS: Record<TrustKind, LucideIcon> = { reputation: Award, trades: ArrowLeftRight, disputes: Scale, disputeRate: Scale }

/** Layer A: a compact trust line, each item an icon plus its text, joined by a separator. Wraps between items, never inside one. */
export function TrustLine({ items, separator = ' · ', className }: { items: TrustLineItem[]; separator?: string; className?: string }) {
  if (items.length === 0) return null
  return (
    <span className={cn('tabular-nums', className)}>
      {items.map((item, i) => {
        const Icon = ICONS[item.kind]
        return (
          <Fragment key={item.kind}>
            {i > 0 && separator}
            <span className="whitespace-nowrap">
              <Icon aria-hidden="true" className="inline-block h-4 w-4 mr-1 align-[-4px]" />
              {item.srText ? <><span aria-hidden="true">{item.text}</span><span className="sr-only">{item.srText}</span></> : item.text}
            </span>
          </Fragment>
        )
      })}
    </span>
  )
}
