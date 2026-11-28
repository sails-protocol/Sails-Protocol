/**
 * Layer A: the trade rail. Stages from deriveTradeState() (done / current /
 * not yet), the recorded state as the rail's status line, the record fields
 * each stage carries, and the bastão: one brand marker on the current stage
 * naming who acts now. No marker when the host passes none (the records do
 * not say). Horizontal from 1024px; below that a compact summary that
 * expands into a vertical list. Colors follow stageTone() (DESIGN_SYSTEM.md
 * 5.5): done blue, your turn orange, waiting blue ring, attention amber,
 * upcoming neutral. Presentational only: no routing, no SDK.
 */
import { useId, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { stageTone, type Baton as BatonView, type StageTone, type StatusTone, type TradeStep } from '../../lib/tradeState'
import { formatDateTime } from '../../lib/format'
import { TONE_CLASS } from '../../lib/tone'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { t } from '../../i18n'

const STATE_KEY = { done: 'trade.rail.stateDone', current: 'trade.rail.stateCurrent', upcoming: 'trade.rail.stateUpcoming' } as const

// Static class strings so Tailwind generates them. Rings/fills >= 3:1 on surface and elevated (DESIGN_SYSTEM.md 5.5).
const CIRCLE: Record<StageTone, string> = {
  done: 'border-brand-blue bg-brand-blue text-brand-surface',
  yours: 'border-brand-orange-accent bg-brand-surface text-brand-orange-accent',
  waiting: 'border-brand-blue bg-brand-surface text-brand-blue-fg',
  attention: 'border-brand-warning bg-brand-surface text-brand-warning-fg',
  upcoming: 'border-brand-border bg-brand-surface text-brand-text-secondary',
}
const DOT: Record<StageTone, string> = {
  done: 'h-2 w-2 bg-brand-blue',
  yours: 'h-2.5 w-2.5 border-2 border-brand-orange-accent',
  waiting: 'h-2.5 w-2.5 border-2 border-brand-blue',
  attention: 'h-2.5 w-2.5 border-2 border-brand-warning',
  upcoming: 'h-2 w-2 border border-brand-border',
}

/** Long ids stay readable in a narrow stage: start and end, the full value is in the Registro. */
const shortId = (v: string) => (v.length > 20 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v)

interface Props {
  steps: TradeStep[]
  status: { label: string; tone: StatusTone }
  /** Bastão for the current stage ("Sua vez", "Com o árbitro"); null shows no marker. Neutral tone = a wait the viewer cannot act on here. */
  baton: BatonView | null
  /** The viewer's side: their actionable stage is orange ("Sua vez"); null = an observer. */
  viewer?: 'buyer' | 'seller' | null
  /** Accessible title of the rail. */
  title?: string
}

type BatonLook = 'yours' | 'attention' | 'other'

function Baton({ baton, look }: { baton: BatonView; look: BatonLook }) {
  // "Sua vez" = neutral chip with an orange dot (status-dot pattern): the step action stays the screen's one solid
  // orange (DECISIONS.md 2026-11-21), and orange text on an orange tint fails AA in light (4.13). Amber on a
  // disputed/expired stage; someone else's turn is brand blue; a wait is neutral.
  return (
    <span className={cn('inline-flex w-fit max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-balance', baton.tone === 'neutral' ? cn('border', TONE_CLASS.neutral) : look === 'yours' ? 'border border-brand-border bg-brand-elevated text-brand-text' : look === 'attention' ? cn('border', TONE_CLASS.warning) : 'border border-brand-blue-border bg-brand-blue-bg text-brand-blue-fg')}>
      {look === 'yours' && baton.tone !== 'neutral' && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />}
      {baton.text}
    </span>
  )
}

export function TradeRail({ steps, status, baton, viewer = null, title = t('trade.rail.title') }: Props) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const listId = useId()
  const current = steps.find((s) => s.state === 'current')
  // "Sua vez" stays orange even on a disputed stage (a ruling round the viewer signs); the ring there is amber.
  const look: BatonLook = !!viewer && !current?.blocked && !!current?.actors?.includes(viewer) ? 'yours'
    : current && stageTone(current, viewer) === 'attention' ? 'attention' : 'other'

  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={titleId} className="text-sm font-semibold text-brand-text">{title}</h2>
        {/* The recorded state of the trade: the one status line of the page. */}
        <span role="status" className={cn('inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', TONE_CLASS[status.tone])}>
          {status.label}
        </span>
        {baton && <span className="lg:hidden"><Baton baton={baton} look={look} /></span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="ml-auto lg:hidden"
        >
          {t(open ? 'trade.rail.hideSteps' : 'trade.rail.showSteps')}
          <ChevronDown className={cn('size-icon-sm transition-transform duration-short ease-standard', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </div>

      {/* Compact progress (below 1024): one dot per stage, the current one named. */}
      <div className="mt-3 flex items-center gap-2 lg:hidden">
        <span className="flex items-center gap-1" aria-hidden="true">
          {steps.map((s) => (
            <span key={s.id} className={cn('rounded-full', DOT[stageTone(s, viewer)])} />
          ))}
        </span>
        {current && <span className="min-w-0 text-xs text-brand-text-secondary [overflow-wrap:anywhere]"><span className="sr-only">{t('trade.rail.currentStep')} </span>{current.label}</span>}
      </div>

      <ol id={listId} className={cn('mt-4 lg:grid lg:auto-cols-fr lg:grid-flow-col', open ? 'block' : 'hidden')}>
        {steps.map((s, i) => {
          const last = i === steps.length - 1
          const tone = stageTone(s, viewer)
          return (
            <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className="relative flex gap-3 pb-4 last:pb-0 lg:flex-col lg:gap-2 lg:pb-0 lg:pr-3">
              {!last && (
                <span
                  aria-hidden="true"
                  className={cn(
                    // Done fills the line to the next stage in brand blue (2px); the rest stays a 1px neutral line.
                    'absolute left-[13px] top-7 bottom-0 lg:left-8 lg:right-1 lg:top-[13px] lg:bottom-auto lg:w-auto',
                    s.state === 'done' ? 'w-0.5 bg-brand-blue lg:h-0.5' : 'w-px bg-brand-border lg:h-px',
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  // Done = recorded, never success: brand blue with a check, never green (CTO 437, DESIGN_SYSTEM.md 5.5).
                  CIRCLE[tone],
                )}
              >
                {tone === 'yours' && <span className="absolute -inset-0.5 rounded-full border-2 border-brand-orange-accent opacity-0 motion-safe:animate-rail-pulse" />}
                {s.state === 'done' ? <Check className="size-icon-sm" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1 pt-0.5 lg:pt-0">
                <p className={cn('text-sm [overflow-wrap:anywhere]', s.state === 'upcoming' ? 'text-brand-text-secondary' : 'font-medium text-brand-text')}>
                  {s.label}
                  <span className="sr-only"> — {t(STATE_KEY[s.state])}</span>
                </p>
                {s.at && <p className="text-xs text-brand-text-secondary">{formatDateTime(s.at)}</p>}
                {s.evidence?.map((e) => (
                  <p key={e.label} className="text-xs text-brand-text-secondary [overflow-wrap:anywhere]">
                    {e.label}: <span translate={e.mono ? 'no' : undefined} className={cn('text-brand-text', e.mono && 'font-mono')}>{e.mono ? shortId(e.value) : e.value}</span>
                  </p>
                ))}
                {s.state === 'current' && baton && <span className="hidden lg:block"><Baton baton={baton} look={look} /></span>}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
