/**
 * Escrow deadline timer in the current-stage card (UX-029, DESIGN_SYSTEM.md 5.6). Presentational: the
 * view, thresholds and copy come from lib/escrowDeadline.ts, from `escrow.expiresAt` only (CTO 437:
 * no invented deadline). Ticks every second under 1 h, every 30 s otherwise, stops when the tab is
 * hidden and resyncs on return. The ticking number is aria-hidden; a polite status announces only the
 * key moments (attention, 10 min, 1 min, expiry). No blinking; the bar moves only by transform.
 * PAYMENT_PENDING / DISPUTED get a static date (the `informational` view): no ticking, amber or bar.
 * Flat inside the stage card: no surface of its own, so no box inside a box.
 */
import { AlertTriangle, Clock } from 'lucide-react'
import { ExplanationPopover } from '../ui/ExplanationPopover'
import { FaqLink } from '../faq/FaqLink'
import { Progress } from '../ui/progress'
import { cn } from '../../lib/utils'
import { t } from '../../i18n'
import { deadlineMilestone, escrowDeadlineView, MILESTONE_ANNOUNCEMENT } from '../../lib/escrowDeadline'
import { useMilestoneAnnouncement, useTickingNow } from './useDeadlineClock'
import { serverNow } from '../../lib/serverClock'
import type { EscrowStatus } from '../../types'

export function EscrowCountdown({
  expiresAt,
  timelockHours,
  status,
}: {
  expiresAt: string | null
  timelockHours: number
  status: EscrowStatus
}) {
  // The view's kind does not depend on the time; only an active one ticks.
  const active = escrowDeadlineView({ expiresAt, timelockHours, status }, 0)?.kind === 'active'
  // Server clock (Date header offset), like the dispute countdown: a wrong device clock must not move the deadline.
  const now = useTickingNow(active && expiresAt ? Date.parse(expiresAt) : null, serverNow)
  const view = escrowDeadlineView({ expiresAt, timelockHours, status }, now)

  // Announce only when a later milestone is reached while the page is open (never on load).
  const milestone = view?.kind === 'active' ? deadlineMilestone(view.remainingMs, view.tone) : 0
  const announcement = useMilestoneAnnouncement(milestone)

  if (!view) return null

  const attention = view.kind === 'active' && view.tone !== 'neutral'
  const Icon = attention ? AlertTriangle : Clock
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className={cn('flex items-center gap-1.5 text-caption font-medium', attention ? 'text-brand-warning-fg' : 'text-brand-text-secondary')}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t('trade.countdown.title')}
          <ExplanationPopover explanation={view.explanation} label={t('trade.countdown.explainLabel')} className="ml-0.5" />
          <FaqLink slug="prazo" className="ml-1" />
        </p>
        {view.kind === 'active' && <p className="text-caption tabular-nums text-brand-text-muted">{view.deadlineText}</p>}
      </div>

      {view.kind === 'active' ? (
        <>
          <p className={cn('mt-1', view.tone === 'expired' ? 'text-subheading' : 'money-lg tabular-nums', attention ? 'text-brand-warning-fg' : 'text-brand-text')}>
            <span aria-hidden="true">{view.remainingText}</span>
            <span className="sr-only">{view.tone === 'expired' ? MILESTONE_ANNOUNCEMENT[4] : t(view.tone === 'attention' ? 'trade.countdown.remainingSoon' : 'trade.countdown.remaining', { time: view.remainingText })}</span>
          </p>
          {view.progress !== null && view.tone !== 'expired' && (
            <Progress value={view.progress} label={t('trade.countdown.progress')} tone={attention ? 'warning' : 'brand'} className="mt-2" />
          )}
        </>
      ) : (
        <p className="mt-1 text-body-sm text-brand-text-secondary">{view.text}</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  )
}
