/**
 * Layer A: done / current / not-yet steps from deriveTradeState(). A time
 * is shown only when the record carries one for that step.
 */
import type { ReactNode } from 'react'
import type { TradeStep } from '../../lib/tradeState'
import { formatDateTime } from '../../lib/format'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

const STATE_TEXT = { done: 'concluída', current: 'etapa atual', upcoming: 'ainda não' } as const

export function TradeTimeline({ steps, children }: { steps: TradeStep[]; children?: ReactNode }) {
  return (
    <section aria-labelledby="trade-timeline-title" className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <h2 id="trade-timeline-title" className="text-sm font-semibold text-brand-text">Andamento do trade</h2>
      <ol className="mt-3">
        {steps.map((s, i) => {
          const last = i === steps.length - 1
          const currentTone = s.tone === 'danger' ? 'border-brand-danger text-brand-danger-fg'
            : s.tone === 'warning' ? 'border-brand-warning text-brand-warning'
            : 'border-brand-orange-accent text-brand-orange-accent'
          return (
            <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className="relative flex gap-3 pb-4 last:pb-0">
              {!last && <span aria-hidden="true" className={cn('absolute left-[13px] top-7 bottom-0 w-px', s.state === 'done' ? 'bg-brand-success/60' : 'bg-brand-border-subtle')} />}
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  s.state === 'done' ? 'border-brand-success bg-brand-success text-brand-surface'
                    : s.state === 'current' ? cn('bg-brand-surface', currentTone)
                    : 'border-brand-border bg-brand-surface text-brand-text-secondary',
                )}
              >
                {s.state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 pt-0.5">
                <p className={cn('text-sm', s.state === 'upcoming' ? 'text-brand-text-secondary' : 'font-medium text-brand-text')}>
                  {s.label}
                  <span className="sr-only"> — {STATE_TEXT[s.state]}</span>
                </p>
                {s.at && <p className="text-xs text-brand-text-secondary">{formatDateTime(s.at)}</p>}
              </div>
            </li>
          )
        })}
      </ol>
      {children}
    </section>
  )
}
