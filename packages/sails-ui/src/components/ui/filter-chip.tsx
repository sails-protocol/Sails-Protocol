/**
 * Layer A: filter chip (DESIGN_SYSTEM.md 5.12). Two uses, one look:
 * - toggle (`onToggle`): one option of a multi-choice filter; aria-pressed.
 * - active filter (`onClear`): a filter that is applied; the label is plain
 *   text and the clear button (`clearLabel`, e.g. "Remover filtro Pix") is
 *   its own target, 24px visual inside a 32 / 44 (touch) hit area.
 * Tonal fill, no border (a chip is a trigger, not a field). Selected =
 * `--color-checked` at 12 % + check icon + brand-blue text (blue = chosen,
 * never orange). 32px fine / 44 touch, rounded-full.
 */
import { Check, X } from 'lucide-react'
import { cn } from '../../lib/utils'

const BASE = 'inline-flex items-center gap-1.5 rounded-full text-body-sm font-medium transition-colors duration-short'
const SIZE = 'min-h-8 touch:min-h-11'
const tone = (selected: boolean) => (selected ? 'bg-brand-checked/12 text-brand-blue-fg' : 'bg-brand-tonal text-brand-text-secondary hover:text-brand-text')

export function FilterChip({ label, selected = false, onToggle, onClear, clearLabel, className }: {
  label: string
  selected?: boolean
  onToggle?: () => void
  onClear?: () => void
  /** Accessible name of the clear button (caller copy); required with onClear. */
  clearLabel?: string
  className?: string
}) {
  if (onClear) {
    return (
      <span className={cn(BASE, SIZE, tone(true), 'pl-3 pr-0.5', className)}>
        {label}
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel ?? label}
          className="inline-flex size-7 touch:size-10 items-center justify-center rounded-full state-layer"
        >
          <X aria-hidden="true" className="size-icon-sm" />
        </button>
      </span>
    )
  }
  return (
    <button type="button" aria-pressed={selected} onClick={onToggle} className={cn(BASE, SIZE, tone(selected), 'px-3 state-layer', selected && 'pl-2', className)}>
      {selected && <Check aria-hidden="true" className="size-icon-sm" />}
      {label}
    </button>
  )
}
