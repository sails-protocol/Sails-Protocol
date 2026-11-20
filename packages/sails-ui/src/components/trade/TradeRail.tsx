/**
 * Layer A: the trade rail. Stages from deriveTradeState() (done / current /
 * not yet), the recorded state as the rail's status line, the record fields
 * each stage carries, and the bastão: one brand marker on the current stage
 * naming who acts now. No marker when the host passes none (the records do
 * not say). Horizontal from 1024px; below that a compact summary that
 * expands into a vertical list. Presentational only: no routing, no SDK.
 */
import { useId, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { StatusTone, TradeStep } from '../../lib/tradeState'
import { formatDateTime } from '../../lib/format'
import { TONE_CLASS } from '../../lib/tone'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

const STATE_TEXT = { done: 'concluída', current: 'etapa atual', upcoming: 'ainda não' } as const

/** Long ids stay readable in a narrow stage: start and end, the full value is in the Registro. */
const shortId = (v: string) => (v.length > 20 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v)

interface Props {
  steps: TradeStep[]
  status: { label: string; tone: StatusTone }
  /** Bastão text for the current stage ("Sua vez", "Com o árbitro"); null shows no marker. */
  baton: string | null
  /** Accessible title of the rail. */
  title?: string
}

function Baton({ text }: { text: string }) {
  return <span className="inline-flex w-fit items-center rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">{text}</span>
}

export function TradeRail({ steps, status, baton, title = 'Andamento do trade' }: Props) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const listId = useId()
  const current = steps.find((s) => s.state === 'current')

  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={titleId} className="text-sm font-semibold text-brand-text">{title}</h2>
        {/* The recorded state of the trade: the one status line of the page. */}
        <span role="status" className={cn('inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', TONE_CLASS[status.tone])}>
          {status.label}
        </span>
        {baton && <span className="lg:hidden"><Baton text={baton} /></span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="ml-auto lg:hidden"
        >
          {open ? 'Ocultar etapas' : 'Ver etapas'}
          <ChevronDown className={cn('size-icon-sm transition-transform duration-short ease-standard', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </div>

      {/* Compact progress (below 1024): one dot per stage, the current one named. */}
      <div className="mt-3 flex items-center gap-2 lg:hidden">
        <span className="flex items-center gap-1" aria-hidden="true">
          {steps.map((s) => (
            <span key={s.id} className={cn('h-2 w-2 rounded-full', s.state === 'done' ? 'bg-brand-text-secondary' : s.state === 'current' ? 'bg-brand-orange-accent' : 'border border-brand-border')} />
          ))}
        </span>
        {current && <span className="min-w-0 text-xs text-brand-text-secondary [overflow-wrap:anywhere]"><span className="sr-only">Etapa atual: </span>{current.label}</span>}
      </div>

      <ol id={listId} className={cn('mt-4 lg:grid lg:auto-cols-fr lg:grid-flow-col', open ? 'block' : 'hidden')}>
        {steps.map((s, i) => {
          const last = i === steps.length - 1
          const currentTone = s.tone === 'danger' ? 'border-brand-danger text-brand-danger-fg'
            : s.tone === 'warning' ? 'border-brand-warning text-brand-warning'
            : 'border-brand-orange-accent text-brand-orange-accent'
          return (
            <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className="relative flex gap-3 pb-4 last:pb-0 lg:flex-col lg:gap-2 lg:pb-0 lg:pr-3">
              {!last && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute left-[13px] top-7 bottom-0 w-px lg:left-8 lg:right-1 lg:top-[13px] lg:bottom-auto lg:h-px lg:w-auto',
                    s.state === 'done' ? 'bg-brand-text-muted' : 'bg-brand-border',
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  // Done = recorded, never success: a neutral fill with a check (CTO 437, DESIGN_SYSTEM.md 2).
                  s.state === 'done' ? 'border-brand-text-secondary bg-brand-text-secondary text-brand-surface'
                    : s.state === 'current' ? cn('bg-brand-surface', currentTone)
                    : 'border-brand-border bg-brand-surface text-brand-text-secondary',
                )}
              >
                {s.state === 'done' ? <Check className="size-icon-sm" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1 pt-0.5 lg:pt-0">
                <p className={cn('text-sm [overflow-wrap:anywhere]', s.state === 'upcoming' ? 'text-brand-text-secondary' : 'font-medium text-brand-text')}>
                  {s.label}
                  <span className="sr-only"> — {STATE_TEXT[s.state]}</span>
                </p>
                {s.at && <p className="text-xs text-brand-text-secondary">{formatDateTime(s.at)}</p>}
                {s.evidence?.map((e) => (
                  <p key={e.label} className="text-xs text-brand-text-secondary [overflow-wrap:anywhere]">
                    {e.label}: <span translate={e.mono ? 'no' : undefined} className={cn('text-brand-text', e.mono && 'font-mono')}>{e.mono ? shortId(e.value) : e.value}</span>
                  </p>
                ))}
                {s.state === 'current' && baton && <span className="hidden lg:block"><Baton text={baton} /></span>}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
