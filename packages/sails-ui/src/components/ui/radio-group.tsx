/**
 * Layer A: radio group (DESIGN_SYSTEM.md 5.3), one required choice among a few.
 * Native <input type="radio"> sharing one `name`, so arrow keys, Tab-in to the
 * checked option, form semantics and screen-reader "1 of 3" come from the
 * browser. Radio: 18px circle, 2px secondary-text ring (3:1 on tonal and selected fills too), checked = brand blue
 * ring + dot (checked, never orange). `RadioCard`: the whole card is the label
 * (44px+ target), tonal fill without an outline; selected = selected fill (blue
 * 12 %) + the checked radio; focus = its own border (field-focus-within).
 */
import * as React from 'react'
import { cn } from '../../lib/utils'

export function RadioGroup({ legend, legendHidden = false, description, children, className, listClassName }: {
  legend: React.ReactNode
  legendHidden?: boolean
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
  listClassName?: string
}) {
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className={legendHidden ? 'sr-only' : 'text-sm font-medium text-brand-text'}>{legend}</legend>
      {description && <p className="mt-0.5 max-w-[68ch] text-xs text-brand-text-muted">{description}</p>}
      <div className={cn(!legendHidden || description ? 'mt-3' : '', listClassName)}>{children}</div>
    </fieldset>
  )
}

export const Radio = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="radio"
    className={cn(
      'size-[1.125rem] shrink-0 appearance-none rounded-full border-2 border-brand-text-secondary bg-transparent transition-colors duration-short',
      'checked:border-brand-checked checked:bg-[radial-gradient(circle,rgb(var(--color-checked))_0_36%,transparent_40%)]',
      'disabled:border-brand-disabled-content disabled:cursor-not-allowed',
      className
    )}
    {...props}
  />
))
Radio.displayName = 'Radio'

export function RadioCard({ checked, disabled, children, className, ...input }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  checked: boolean
  children: React.ReactNode
}) {
  return (
    <label
      className={cn(
        // Transparent border so focus can draw on the card's own edge (one boundary); only the fill animates, so the
        // keyboard focus border shows at once.
        'flex min-h-11 items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm transition-[background-color] duration-short field-focus-within',
        disabled
          ? 'cursor-not-allowed bg-brand-disabled-container text-brand-text-secondary'
          : cn('cursor-pointer state-layer', checked ? 'bg-brand-selected text-brand-text font-medium' : 'bg-brand-tonal text-brand-text'),
        className
      )}
    >
      <Radio checked={checked} disabled={disabled} {...input} />
      {children}
    </label>
  )
}
