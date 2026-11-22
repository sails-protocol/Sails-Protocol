/**
 * Layer A: linear progress (DESIGN_SYSTEM.md 5.3). 4px track in border-subtle,
 * indicator in brand blue (4.74+:1 vs every surface), or warning for a deadline
 * that needs attention (vs the track 7.48 dark / 3.84 light; never danger). Determinate (`value`
 * 0-100, aria-valuenow) for real, measured progress only; indeterminate (no
 * value) for waits of unknown length. Never fake a percentage for a protocol
 * wait (CTO 437). Reduced motion: the indeterminate bar stops moving and stays
 * as a static partial bar, the label still says it is working.
 */
import { cn } from '../../lib/utils'

export function Progress({ value, label, tone = 'brand', className }: {
  /** 0-100; omit for indeterminate. */
  value?: number
  /** Accessible name (caller copy), e.g. "Enviando comprovante". */
  label: string
  /** Indicator color: brand blue, or warning (amber) when the caller's text is already amber. */
  tone?: 'brand' | 'warning'
  className?: string
}) {
  const determinate = typeof value === 'number'
  const v = determinate ? Math.min(100, Math.max(0, value)) : undefined
  const fill = tone === 'warning' ? 'bg-brand-warning' : 'bg-brand-blue'
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={v}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-brand-border-subtle', className)}
    >
      {determinate ? (
        <div className={cn('h-full origin-left rounded-full transition-transform duration-medium ease-standard', fill)} style={{ transform: `scaleX(${v! / 100})` }} />
      ) : (
        <div className={cn('absolute inset-y-0 left-0 w-2/5 rounded-full motion-safe:animate-progress', fill)} />
      )}
    </div>
  )
}
