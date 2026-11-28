import { ArrowLeftRight, Award, Scale, Star, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { TrustKind, TrustLineItem } from './trustTypes'

// Neutral icons only: never a shield or check, which would read as a guarantee.
const ICONS: Record<TrustKind, LucideIcon> = { reputation: Award, trades: ArrowLeftRight, disputes: Scale, disputeRate: Scale, rating: Star }
// Read-only rating stars are neutral secondary text: blue stays for the chosen star of the StarRating input, and a
// blue star in a list row would read as a link (Architect 2026-11-21, item 7). Never yellow (that is attention).
// A filled star reads heavier than the outline icons at the same size, so it is drawn smaller: 12px, the one
// documented exception to the 14/16/20/24 scale (DESIGN_SYSTEM.md 4). Its classes replace the base ones instead of
// being merged with them: `cn` cannot tell that a size token overrides h-4/w-4, and both ended up applied.
const ICON_CLASS: Partial<Record<TrustKind, string>> = { rating: 'inline-block size-3 fill-current text-brand-text-secondary ml-0.5 mr-1.5 align-[-1px]' }
const BASE_ICON = 'inline-block h-4 w-4 mr-1 align-[-4px]'

/**
 * Layer A: a compact trust line, each item an icon plus its text. Items are spaced, not joined by a
 * "·": a visible separator ends up stranded at a line end when the line wraps on narrow screens.
 * The icons already separate the items; screen readers get a comma between them.
 */
export function TrustLine({ items, className }: { items: TrustLineItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <span className={cn('tabular-nums', className)}>
      {items.map((item, i) => {
        const Icon = ICONS[item.kind]
        return (
          // Spacing lives on the items (not flex gap) so a caller's display class ("block") cannot remove it.
          <span key={item.kind} className="inline-block sm:whitespace-nowrap mr-3 last:mr-0">
            {i > 0 && <span className="sr-only">, </span>}
            <Icon aria-hidden="true" className={ICON_CLASS[item.kind] ?? BASE_ICON} />
            {item.srText ? <><span aria-hidden="true">{item.text}</span><span className="sr-only">{item.srText}</span></> : item.text}
          </span>
        )
      })}
    </span>
  )
}
