/**
 * Layer A: linear progress (DESIGN_SYSTEM.md 5.3). 4px track in border-subtle,
 * indicator in brand blue (4.74+:1 vs every surface). Determinate (`value`
 * 0-100, aria-valuenow) for real, measured progress only; indeterminate (no
 * value) for waits of unknown length. Never fake a percentage for a protocol
 * wait (CTO 437). Reduced motion: the indeterminate bar stops moving and stays
 * as a static partial bar, the label still says it is working.
 */
import { cn } from '../../lib/utils'

export function Progress({ value, label, className }: {
  /** 0-100; omit for indeterminate. */
  value?: number
  /** Accessible name (caller copy), e.g. "Enviando comprovante". */
  label: string
  className?: string
}) {
  const determinate = typeof value === 'number'
  const v = determinate ? Math.min(100, Math.max(0, value)) : undefined
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
        <div className="h-full origin-left rounded-full bg-brand-blue transition-transform duration-medium ease-standard" style={{ transform: `scaleX(${v! / 100})` }} />
      ) : (
        <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-brand-blue motion-safe:animate-progress" />
      )}
    </div>
  )
}
