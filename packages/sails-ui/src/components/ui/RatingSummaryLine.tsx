import { Star } from 'lucide-react'
import { ExplanationPopover } from './ExplanationPopover'
import type { Explanation } from './trustTypes'
import { cn } from '../../lib/utils'

/**
 * Layer A: the full star-rating summary for a detail or profile block ("★ 4,8 · 126 avaliações · desde
 * jan. de 2025"), same footprint as PlannedItem so it can replace it in place. The star is the checked
 * blue of StarRating, never yellow. All copy comes from props; the compact list form is a TrustLine item.
 */
export function RatingSummaryLine({ text, srText, meta, description, explanation, explanationLabel, className }: {
  /** Visible summary after the star, e.g. "4,8 · 126 avaliações". */
  text: string
  /** Accessible name of the summary, e.g. "Avaliação média 4,8 de 5, 126 avaliações". */
  srText: string
  /** Optional trailing fact, e.g. "desde jan. de 2025". */
  meta?: string
  description?: string
  explanation?: Explanation
  explanationLabel?: string
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-2 text-sm', className)}>
      <Star className="mt-1 size-icon-xs shrink-0 fill-current text-brand-checked" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
          <span className="font-medium text-brand-text whitespace-nowrap">
            <span aria-hidden="true">{text}</span><span className="sr-only">{srText}</span>
          </span>
          {/* Phone: the fact gets its own line and no "·" (a separator must never start a wrapped line); from sm it follows inline. */}
          {meta && <span className="basis-full sm:basis-auto text-brand-text-secondary whitespace-nowrap"><span aria-hidden="true" className="hidden sm:inline">· </span><span className="sr-only sm:hidden">, </span>{meta}</span>}
          {explanation && <ExplanationPopover explanation={explanation} label={explanationLabel ?? explanation.title} />}
        </div>
        {description && <p className="mt-0.5 text-xs text-brand-text-muted">{description}</p>}
      </div>
    </div>
  )
}
