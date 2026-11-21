/**
 * Layer A: one card saying who must act now and the next permitted
 * action. Presentational only — the view-model comes from
 * deriveCurrentAction() and the handlers from the host page.
 */
import { useId, type ReactNode, type Ref } from 'react'
import type { CurrentAction, CurrentActionKind } from '../../lib/currentAction'
import { Button } from '../ui/button'
import { Lock, Banknote, CheckCircle2, AlertTriangle, Hourglass, Info, Unlock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { t } from '../../i18n'

interface Props {
  view: CurrentAction
  acting: boolean
  onAction: (action: CurrentActionKind) => void
  onOpenDispute: () => void
  /** Prerequisite steps rendered above the primary action (e.g. a payout-address form). */
  children?: ReactNode
  /** Lets the host return focus to "Abrir disputa" after the dispute form is cancelled. */
  disputeTriggerRef?: Ref<HTMLButtonElement>
}

const ICONS = { createEscrow: Unlock, lock: Lock, markPaymentSent: Banknote, release: CheckCircle2 }

export function CurrentActionCard({ view, acting, onAction, onOpenDispute, children, disputeTriggerRef }: Props) {
  const ActorIcon = view.tone === 'waiting' ? Hourglass : view.tone === 'action' ? AlertTriangle : Info
  const titleId = useId()
  const PrimaryIcon = view.primary ? ICONS[view.primary.action] : null

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'rounded-lg border border-brand-border-subtle bg-brand-elevated p-4 border-t-4',
        // Same code as the rail (DESIGN_SYSTEM.md 5.5): orange = your action, blue = waiting, amber = attention, neutral = closed.
        view.tone === 'action' ? 'border-t-brand-orange' : view.tone === 'waiting' ? 'border-t-brand-blue' : view.tone === 'attention' ? 'border-t-brand-warning' : 'border-t-brand-border',
      )}
    >
      <p className={cn(
        'flex items-center gap-1.5 text-xs font-medium',
        view.tone === 'action' ? 'text-brand-orange-accent' : view.tone === 'attention' ? 'text-brand-warning' : 'text-brand-text-muted',
      )}>
        <ActorIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {view.actorLabel}
      </p>
      <h2 id={titleId} className="mt-1.5 text-heading text-brand-text">{view.title}</h2>
      <p role={view.tone === 'waiting' ? 'status' : undefined} className="mt-1 text-sm text-brand-text-secondary">
        {view.description}
      </p>

      {children}

      {(view.primary || view.canDispute) && (
        <div className="mt-4 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between">
          {view.primary && PrimaryIcon && (
            <Button onClick={() => onAction(view.primary!.action)} loading={acting} className="w-full sm:w-auto min-h-11 px-5 py-2.5 text-sm">
              <PrimaryIcon className="h-4 w-4" aria-hidden="true" />
              {view.primary.label}
            </Button>
          )}
          {view.canDispute && (
            // Tertiary on purpose: reachable (44px target) but never competing with the primary action.
            <button
              ref={disputeTriggerRef}
              type="button"
              onClick={onOpenDispute}
              disabled={acting}
              className="min-h-11 px-1 text-sm text-brand-text-secondary underline underline-offset-4 hover:text-brand-text disabled:text-brand-disabled-content disabled:no-underline rounded-sm sm:ml-auto"
            >
              {t('trade.action.openDispute')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
