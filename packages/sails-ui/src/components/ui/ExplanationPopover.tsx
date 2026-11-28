import type { ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { cn } from '../../lib/utils'
import type { Explanation } from './trustTypes'

/**
 * Layer A: an explanation that opens on click or tap (Radix Popover: Esc closes, focus returns to the trigger),
 * so it works on touch too, unlike a hover tooltip. `variant="icon"` is the small "i" badge with a 44px hit area;
 * `variant="text"` shows `label` as a quiet text button. All copy comes from props.
 */
export function ExplanationPopover({
  explanation, label, variant = 'icon', className, more,
}: {
  explanation: Explanation
  /** Accessible name (icon) or visible text (text). */
  label: string
  variant?: 'icon' | 'text'
  className?: string
  /** Optional link under the explanation (the caller owns any routing), e.g. the matching FAQ answer. */
  more?: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === 'icon' ? (
          <button type="button" aria-label={label} className={cn('group p-[14px] -m-[14px] inline-flex items-center justify-center rounded-full', className)}>
            <span aria-hidden="true" className="w-4 h-4 rounded-full border border-brand-border text-brand-text-muted text-xs leading-none font-normal normal-case flex items-center justify-center transition-colors group-hover:border-brand-orange-accent group-hover:text-brand-orange-accent group-data-[state=open]:border-brand-orange-accent group-data-[state=open]:text-brand-orange-accent">
              i
            </span>
          </button>
        ) : (
          <button type="button" className={cn('group inline-flex min-h-8 touch:min-h-11 items-center gap-1.5 rounded-md text-xs font-medium text-brand-text-secondary hover:text-brand-text', className)}>
            <span aria-hidden="true" className="w-4 h-4 rounded-full border border-brand-border text-xs leading-none flex items-center justify-center group-hover:border-brand-orange-accent">i</span>
            {label}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-72 max-w-[calc(100vw-2rem)] text-xs font-normal normal-case text-brand-text-secondary">
        <p className="text-sm font-medium text-brand-text">{explanation.title}</p>
        <ul className="mt-2 space-y-1 tabular-nums">
          {explanation.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {explanation.footer && <p className="mt-2.5 pt-2.5 border-t border-brand-border-subtle">{explanation.footer}</p>}
        {more && <div className="mt-2">{more}</div>}
      </PopoverContent>
    </Popover>
  )
}
