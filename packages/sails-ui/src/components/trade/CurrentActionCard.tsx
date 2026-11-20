/**
 * Layer A: one card saying who must act now and the next permitted
 * action. Presentational only — the view-model comes from
 * deriveCurrentAction() and the handlers from the host page.
 */
import { useId } from 'react'
import type { CurrentAction, CurrentActionKind } from '../../lib/currentAction'
import { Button } from '../ui/button'
import { Lock, Banknote, CheckCircle2, AlertTriangle, Hourglass, Info } from 'lucide-react'
import { cn } from '../../lib/utils'

interface Props {
  view: CurrentAction
  acting: boolean
  onAction: (action: CurrentActionKind) => void
  onOpenDispute: () => void
}

const ICONS = { lock: Lock, markPaymentSent: Banknote, release: CheckCircle2 }

export function CurrentActionCard({ view, acting, onAction, onOpenDispute }: Props) {
  const ActorIcon = view.tone === 'waiting' ? Hourglass : view.tone === 'action' ? AlertTriangle : Info
  const titleId = useId()
  const PrimaryIcon = view.primary ? ICONS[view.primary.action] : null

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'mt-4 rounded-lg border border-brand-border bg-brand-elevated p-4 border-t-4',
        view.tone === 'action' ? 'border-t-brand-orange' : view.tone === 'attention' ? 'border-t-brand-warning' : 'border-t-brand-border',
      )}
    >
      <p className={cn(
        'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide',
        view.tone === 'action' ? 'text-brand-orange-accent' : view.tone === 'attention' ? 'text-brand-warning' : 'text-brand-text-muted',
      )}>
        <ActorIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {view.actorLabel}
      </p>
      <h2 id={titleId} className="mt-1.5 text-base font-semibold text-brand-text">{view.title}</h2>
      <p role={view.tone === 'waiting' ? 'status' : undefined} className="mt-1 text-sm text-brand-text-secondary">
        {view.description}
      </p>

      {(view.primary || view.canDispute) && (
        <div className="mt-4 flex flex-col gap-2">
          {view.primary && PrimaryIcon && (
            <Button onClick={() => onAction(view.primary!.action)} disabled={acting} className="w-full min-h-11 py-2.5 text-sm">
              <PrimaryIcon className="h-4 w-4" aria-hidden="true" />
              {view.primary.label}
            </Button>
          )}
          {view.canDispute && (
            <Button
              variant="outline"
              onClick={onOpenDispute}
              disabled={acting}
              className="w-full min-h-11 py-2 text-sm border-red-700/70 text-red-700 hover:bg-red-700/10 hover:text-red-700 dark:border-red-400/70 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-400"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Abrir Disputa
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
