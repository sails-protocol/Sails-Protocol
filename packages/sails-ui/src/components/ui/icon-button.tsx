/**
 * Layer A: icon button (DESIGN_SYSTEM.md 5.10). An icon-only button must have a
 * name: `label` is required and becomes both the aria-label and the tooltip
 * (shown on hover and keyboard focus; never `title=`). Visual 32px box on a
 * fine pointer (36 hit area), 44 on touch. Variants: ghost (default), tonal.
 * `pressed` makes it a toggle (aria-pressed; on = brand blue icon). `loading`
 * and `aria-disabled` behave like Button; a disabled-looking button keeps its
 * tooltip by using aria-disabled instead of the disabled attribute.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> {
  /** Accessible name and tooltip text (caller copy). */
  label: string
  /** Toggle state; omit for a plain action. */
  pressed?: boolean
  variant?: 'ghost' | 'tonal'
  size?: 'sm' | 'md'
  loading?: boolean
  /** Tooltip side; the tooltip is skipped on touch-only devices by Radix (no hover). */
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, pressed, variant = 'ghost', size = 'md', loading = false, tooltipSide = 'top', className, children, onClick, ...props }, ref) => {
    const inactive = props['aria-disabled'] === true || props['aria-disabled'] === 'true'
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            aria-busy={loading || undefined}
            onClick={(e) => {
              if (loading || inactive) { e.preventDefault(); return }
              onClick?.(e)
            }}
            className={cn(
              'relative inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-short state-layer',
              size === 'md' ? 'size-9 touch:size-11 [&_svg]:size-icon' : 'size-8 touch:size-11 [&_svg]:size-icon-sm',
              variant === 'tonal' ? 'bg-brand-tonal' : '',
              pressed ? 'text-brand-blue-fg' : 'text-brand-text-secondary hover:text-brand-text',
              'disabled:cursor-not-allowed disabled:text-brand-disabled-content aria-disabled:cursor-not-allowed aria-disabled:text-brand-disabled-content',
              loading && 'cursor-progress',
              className
            )}
            {...props}
          >
            {loading ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : children}
          </button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{label}</TooltipContent>
      </Tooltip>
    )
  }
)
IconButton.displayName = 'IconButton'
