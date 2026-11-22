import { Star } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Radio, RadioGroup } from './radio-group'

/**
 * Layer A: 1-5 star choice built on the RadioGroup primitive (native radios sharing `name`: arrow keys,
 * Tab to the checked star, "3 of 5" from the browser). The radio itself is visually hidden; each star is
 * its label (40 px, 44 px on touch). Chosen stars use the checked color (brand blue, never orange);
 * focus = outline on the star's own label. `valueText` is read out politely when the choice changes.
 */
export function StarRating({ legend, name, value, onChange, starLabel, valueText, invalid, describedBy, disabled }: {
  legend: string
  name: string
  value: number | null
  onChange: (score: number) => void
  /** Accessible name of each star, e.g. n => `${n} estrela(s)`. */
  starLabel: (n: number) => string
  /** Visible text for the current value, e.g. "3 de 5" or a hint when nothing is chosen. */
  valueText: string
  invalid?: boolean
  describedBy?: string
  disabled?: boolean
}) {
  return (
    <RadioGroup legend={legend} listClassName="flex flex-wrap items-center gap-x-1 gap-y-2">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = value !== null && n <= value
        return (
          <label
            key={n}
            className={cn(
              'inline-flex min-h-10 touch:min-h-11 items-center justify-center rounded-md px-2.5 touch:px-3 transition-colors duration-short',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-focus',
              disabled ? 'cursor-not-allowed text-brand-disabled-content' : cn('cursor-pointer state-layer', on ? 'text-brand-checked' : 'text-brand-text-secondary')
            )}
          >
            <Radio
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              disabled={disabled}
              aria-label={starLabel(n)}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              className="sr-only"
            />
            <Star aria-hidden="true" className={cn('h-5 w-5', on && 'fill-current')} />
          </label>
        )
      })}
      <span aria-live="polite" className="ml-2 text-body-sm text-brand-text-secondary tabular-nums">{valueText}</span>
    </RadioGroup>
  )
}
