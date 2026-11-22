/**
 * Layer A: a level track (stepper) for a tiered program. A real list, the current level marked with
 * aria-current="step": a vertical list on phones, a horizontal track from md. The current level is a filled dot;
 * the others an outlined dot with a lock and their note (icon + text, never colour alone). Neutral tokens plus one
 * brand dot, never a status colour: a level is not a success. All copy comes from props.
 */
import { Lock } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface TrackLevel {
  id: string
  label: string
  /** Shown under the label: "Você está em …" for the current level, the state ("Em preparação") for the others. */
  note: string
  current?: boolean
}

export function LevelTrack({ levels, label, className }: { levels: readonly TrackLevel[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn('flex flex-col md:flex-row', className)}>
      {levels.map((l, i) => (
        <li
          key={l.id}
          aria-current={l.current ? 'step' : undefined}
          className="relative flex items-start gap-3 pb-5 last:pb-0 md:flex-1 md:flex-col md:items-center md:gap-2 md:pb-0 md:text-center"
        >
          {/* Connector to the next level: down on phones, right from md (it runs under the next dot). */}
          {i < levels.length - 1 && (
            <span aria-hidden="true" className="absolute left-3 top-6 bottom-0 w-px bg-brand-border md:left-1/2 md:-right-1/2 md:top-3 md:bottom-auto md:h-px md:w-auto" />
          )}
          <span
            aria-hidden="true"
            className={cn(
              'relative flex size-6 shrink-0 items-center justify-center rounded-full',
              l.current ? 'bg-brand-orange-accent' : 'border-2 border-brand-border bg-brand-surface',
            )}
          >
            {l.current && <span className="size-2 rounded-full bg-brand-surface" />}
          </span>
          <span className="min-w-0">
            <span className={cn('block text-sm', l.current ? 'font-semibold text-brand-text' : 'font-medium text-brand-text-secondary')}>{l.label}</span>
            <span className={cn('mt-0.5 flex items-center gap-1 text-caption md:justify-center', l.current ? 'font-medium text-brand-text' : 'text-brand-text-muted')}>
              {!l.current && <Lock aria-hidden="true" className="size-icon-xs shrink-0" />}
              {l.note}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}
