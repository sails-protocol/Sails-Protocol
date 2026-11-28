import type { LucideIcon } from 'lucide-react'
import { Badge } from './badge'
import { ExplanationPopover } from './ExplanationPopover'
import type { Explanation } from './trustTypes'
import { cn } from '../../lib/utils'

/**
 * Layer A: a planned feature shown in place, honestly: label + "Em breve" badge (same badge as the
 * planned Settings rows), an optional one-line description and an optional explanation popover.
 * Never a value, a number or an action. All copy comes from props.
 */
export function PlannedItem({ icon: Icon, label, soonLabel, description, explanation, explanationLabel, className }: {
  icon?: LucideIcon
  label: string
  soonLabel: string
  description?: string
  explanation?: Explanation
  /** Accessible name of the explanation trigger. */
  explanationLabel?: string
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-2 text-sm', className)}>
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-text-muted" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-brand-text-secondary">{label}</span>
          <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text-secondary">{soonLabel}</Badge>
          {explanation && <ExplanationPopover explanation={explanation} label={explanationLabel ?? explanation.title} />}
        </div>
        {description && <p className="mt-0.5 max-w-[68ch] text-xs text-brand-text-muted">{description}</p>}
      </div>
    </div>
  )
}
