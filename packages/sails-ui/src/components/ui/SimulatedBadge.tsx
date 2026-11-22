import { FlaskConical } from 'lucide-react'
import { Badge } from './badge'
import { cn } from '../../lib/utils'

/**
 * Layer A: the one marker for something simulated in the demo (PO, 2026-11-22). Neutral tonal pill with an icon and a
 * visible label (caller copy, e.g. "Simulado"); never green, never orange, never a status color.
 */
export function SimulatedBadge({ label, className }: { label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1 border-transparent bg-brand-tonal font-medium text-brand-text-secondary', className)}>
      <FlaskConical aria-hidden="true" className="size-icon-xs shrink-0" />{label}
    </Badge>
  )
}
