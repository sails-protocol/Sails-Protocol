/**
 * Layer A: a small step diagram (FAQ D1, D2). Steps in a row from sm, a column below. The whole sequence is one
 * `role="img"` with `label` as its text, so a screen reader hears it once; the drawn steps are aria-hidden.
 * Orange marks only the step where the person acts (a dot, like the "Sua vez" pill); no green "final" step.
 * A `dashed` link is a branch that may not happen (amber, dashed). All copy comes from props; tokens only.
 */
import { ArrowDown, ArrowRight } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface FlowStep {
  label: string
  /** The person acts on this step. */
  yours?: boolean
  /** How this step links to the previous one: solid (always) or dashed (only in some trades). */
  link?: 'solid' | 'dashed'
}

export function StepFlow({ steps, label, className }: { steps: readonly FlowStep[]; label: string; className?: string }) {
  return (
    <div role="img" aria-label={label} className={cn('flex flex-col items-start gap-1.5 sm:flex-row sm:flex-wrap sm:items-center', className)}>
      {steps.map((s, i) => (
        <div key={s.label} aria-hidden="true" className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center">
          {i > 0 && (s.link === 'dashed' ? (
            <span className="ml-4 h-4 border-l-2 border-dashed border-brand-warning sm:ml-0 sm:h-0 sm:w-6 sm:border-l-0 sm:border-t-2" />
          ) : (
            <>
              <ArrowDown className="ml-2 size-icon-sm text-brand-text-muted sm:hidden" />
              <ArrowRight className="hidden size-icon-sm text-brand-text-muted sm:block" />
            </>
          ))}
          <span className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-md bg-brand-elevated px-3 py-1 text-caption', s.yours ? 'font-medium text-brand-text' : 'text-brand-text-secondary')}>
            {s.yours && <span className="size-2 shrink-0 rounded-full bg-brand-orange-accent" />}
            {s.label}
          </span>
        </div>
      ))}
    </div>
  )
}
