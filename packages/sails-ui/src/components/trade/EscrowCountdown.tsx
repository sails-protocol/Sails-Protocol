/**
 * Escrow deadline timer in the current-stage card (UX-029, DESIGN_SYSTEM.md 5.6). Presentational: the
 * view, thresholds and copy come from lib/escrowDeadline.ts, from `escrow.expiresAt` only (CTO 437:
 * no invented deadline). Ticks every second under 1 h, every 30 s otherwise, stops when the tab is
 * hidden and resyncs on return. The ticking number is aria-hidden; a polite status announces only the
 * key moments (attention, 10 min, 1 min, expiry). No blinking; the bar moves only by transform.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clock } from 'lucide-react'
import { ExplanationPopover } from '../ui/ExplanationPopover'
import { Progress } from '../ui/progress'
import { cn } from '../../lib/utils'
import { deadlineMilestone, escrowDeadlineView, MILESTONE_ANNOUNCEMENT } from '../../lib/escrowDeadline'
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
  const [now, setNow] = useState(() => Date.now())
  const view = escrowDeadlineView({ expiresAt, timelockHours, status }, now)
  const remaining = view?.kind === 'active' ? view.remainingMs : null
  const running = remaining !== null && remaining > 0
  const fast = running && remaining < 3_600_000

  useEffect(() => {
    if (!running) return
    let id: number | undefined
    const start = () => { setNow(Date.now()); id = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000) }
    const onVisibility = () => { window.clearInterval(id); if (!document.hidden) start() }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisibility) }
  }, [running, fast])

  // Announce only when a later milestone is reached while the page is open (never on load).
  const milestone = view?.kind === 'active' ? deadlineMilestone(view.remainingMs, view.tone) : 0
  const seen = useRef(milestone)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (milestone > seen.current) setAnnouncement(MILESTONE_ANNOUNCEMENT[milestone as 1 | 2 | 3 | 4])
    seen.current = milestone
  }, [milestone])

  if (!view) return null

  const attention = view.kind === 'active' && view.tone !== 'neutral'
  const Icon = attention ? AlertTriangle : Clock
  return (
    <div className="mt-4 rounded-md bg-brand-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className={cn('flex items-center gap-1.5 text-caption font-medium', attention ? 'text-brand-warning-fg' : 'text-brand-text-secondary')}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          Prazo do escrow
          <ExplanationPopover explanation={view.explanation} label="O que é o prazo do escrow" className="ml-0.5" />
        </p>
        {view.kind === 'active' && <p className="text-caption tabular-nums text-brand-text-muted">{view.deadlineText}</p>}
      </div>

      {view.kind === 'active' ? (
        <>
          <p className={cn('mt-1', view.tone === 'expired' ? 'text-subheading' : 'money-lg tabular-nums', attention ? 'text-brand-warning-fg' : 'text-brand-text')}>
            <span aria-hidden="true">{view.remainingText}</span>
            <span className="sr-only">{view.tone === 'expired' ? MILESTONE_ANNOUNCEMENT[4] : `${view.tone === 'attention' ? 'Falta pouco. ' : ''}Faltam ${view.remainingText}`}</span>
          </p>
          {view.progress !== null && view.tone !== 'expired' && (
            <Progress value={view.progress} label="Tempo decorrido do prazo do escrow" className="mt-2" />
          )}
        </>
      ) : (
        <p className="mt-1 text-body-sm text-brand-text-secondary">{view.text}</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  )
}
