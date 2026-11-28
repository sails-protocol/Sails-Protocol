import { cn } from '../../lib/utils'
import type { TradeSide } from '../../types'
import { SIDE_SEGMENT_SELECTED } from './StatusBadges'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/**
 * Shared look (DESIGN_SYSTEM.md 5.1), also used by the Market side switch and the
 * publish-offer side picker. Track: tonal fill, no outline. Selected thumb: raised
 * fill + shadow-elevation-1, full text color, weight 500; unselected: secondary text.
 * Selection is carried by fill, elevation, text color and weight together, plus aria-pressed.
 */
// radius 8 - padding 4 = thumb radius 4 (concentric). Own track tone: deeper than tonal in light (thumb 1.50+).
export const SEGMENT_TRACK = 'rounded-lg bg-brand-segment-track p-1'
/** `side` colors the selected thumb with the trade side (SIDE_SEGMENT_SELECTED, StatusBadges.tsx). */
export function segmentItemClass(selected: boolean, side?: TradeSide) {
  return cn(
    'rounded-sm text-body-sm transition-colors duration-short state-layer',
    // Selected: fill + elevation + weight, plus a 1px inner boundary in light (>= 3:1 against the track, WCAG 1.4.11).
    selected ? cn('ring-1 ring-inset ring-brand-segment-selected-border', side ? SIDE_SEGMENT_SELECTED[side] : 'bg-brand-raised shadow-elevation-1 font-medium text-brand-text') : 'text-brand-text-secondary hover:text-brand-text'
  )
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
    <div role="group" aria-label={label} className={cn('inline-flex max-w-full gap-1 overflow-x-auto', SEGMENT_TRACK, className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('shrink-0 whitespace-nowrap h-8 touch:h-11 px-3', segmentItemClass(value === o.value))}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
