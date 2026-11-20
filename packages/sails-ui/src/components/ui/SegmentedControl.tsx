import { cn } from '../../lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/** Layer A: one exclusive choice among a few options (status filters), same look as the Market side switch. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, className }: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible name of the group (caller copy). */
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-brand-elevated p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'shrink-0 whitespace-nowrap min-h-11 md:min-h-0 md:h-7 rounded-md px-3 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            // Selected: surface fill + a control-strength outline (>= 3:1), not colour alone.
            value === o.value ? 'bg-brand-surface font-medium text-brand-text ring-1 ring-brand-border' : 'text-brand-text-secondary hover:text-brand-text'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
