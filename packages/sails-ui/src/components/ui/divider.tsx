/**
 * Layer A: divider (DESIGN_SYSTEM.md 5.3). A 1px `border-subtle` line inside
 * one surface (menu groups, list sections); decorative by default. Pass
 * `semantic` for a real thematic break (role=separator). Never a box border.
 */
import { cn } from '../../lib/utils'

export function Divider({ orientation = 'horizontal', inset = false, semantic = false, className }: {
  orientation?: 'horizontal' | 'vertical'
  /** Horizontal only: starts at the content edge (16px), like list rows. */
  inset?: boolean
  semantic?: boolean
  className?: string
}) {
  return (
    <div
      role={semantic ? 'separator' : 'none'}
      aria-orientation={semantic ? orientation : undefined}
      className={cn(
        'shrink-0 bg-brand-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        inset && orientation === 'horizontal' && 'ml-4 w-auto',
        className
      )}
    />
  )
}
