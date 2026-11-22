import { FlaskConical } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Layer A: the one marker for something simulated in the demo (PO, 2026-11-22). Neutral tonal pill with an icon and a
 * visible label (caller copy, e.g. "Simulado"); never green, never orange, never a status color. A span, so it can sit
 * inside a line of text (a row description, a heading).
 */
export function SimulatedBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-brand-tonal px-2.5 py-0.5 text-xs font-medium text-brand-text-secondary', className)}>
      <FlaskConical aria-hidden="true" className="size-icon-xs shrink-0" />{label}
    </span>
  )
}
