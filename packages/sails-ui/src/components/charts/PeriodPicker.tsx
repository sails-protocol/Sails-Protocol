import { useId, useRef, useState, type FormEvent } from 'react'
import { CalendarRange, Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SEGMENT_TRACK, segmentItemClass } from '../ui/SegmentedControl'
import { cn } from '../../lib/utils'
import { PERIOD_PRESETS, toDateInput, validateRange, type DateRange, type Period, type PeriodPreset, type RangeError } from '../../lib/periods'

export interface PeriodPickerCopy {
  /** Accessible name of the preset group. */
  group: string
  presets: Record<PeriodPreset, string>
  custom: string
  /** Popover heading. */
  customTitle: string
  from: string
  to: string
  apply: string
  errors: Record<RangeError, string>
}

/**
 * Layer A: the dashboards' period selector (PO 2026-11-23). Segmented presets, then "Personalizado", a popover with
 * two native date fields (De / Até), validation and "Aplicar"; Esc closes it and focus returns to its trigger (Radix).
 * The chosen range shows as readable text (`rangeText`, formatted by the caller in the interface language).
 */
export function PeriodPicker({ value, onChange, start, today, rangeText, range, copy, className }: {
  value: Period
  onChange: (p: Period) => void
  /** First day with possible data (account or market start): the earliest custom date. */
  start: Date
  today: Date
  /** The resolved range of `value`, prefilled in the custom fields. */
  range: DateRange
  rangeText: string
  copy: PeriodPickerCopy
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<RangeError | null>(null)
  const id = useId()
  const fromRef = useRef<HTMLInputElement>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const custom = value.kind === 'custom'

  const openChange = (o: boolean) => {
    if (o) { setFrom(toDateInput(range.from)); setTo(toDateInput(range.to)); setError(null) }
    setOpen(o)
  }
  const apply = (e: FormEvent) => {
    e.preventDefault()
    const err = validateRange(from, to, { today, min: start })
    setError(err)
    // Focus the first field the error is about (Vercel WIG: focus first error on submit).
    if (err) { (err === 'future' ? toRef : fromRef).current?.focus(); return }
    onChange({ kind: 'custom', from, to })
    setOpen(false)
  }
  const errorId = `${id}-error`
  const invalid = (field: 'from' | 'to') => !!error && (error === 'order' || error === 'invalid' || (field === 'to' ? error === 'future' : error === 'beforeStart'))

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <div role="group" aria-label={copy.group} className={cn('inline-flex max-w-full gap-1 overflow-x-auto', SEGMENT_TRACK)}>
        {PERIOD_PRESETS.map((p) => {
          const selected = value.kind === 'preset' && value.preset === p
          return (
            <button key={p} type="button" aria-pressed={selected} onClick={() => onChange({ kind: 'preset', preset: p })} className={cn('shrink-0 whitespace-nowrap h-8 touch:h-11 px-3', segmentItemClass(selected))}>
              {copy.presets[p]}
            </button>
          )
        })}
      </div>
      <Popover open={open} onOpenChange={openChange}>
        <PopoverTrigger asChild>
          <Button type="button" variant="secondary" size="sm" aria-pressed={custom} className={cn('touch:min-h-11', custom && 'bg-brand-selected text-brand-text')}>
            {custom ? <Check aria-hidden="true" /> : <CalendarRange aria-hidden="true" />}
            {copy.custom}
            <ChevronDown aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-labelledby={`${id}-title`} className="w-80 max-w-[calc(100vw-2rem)]">
          <form onSubmit={apply} noValidate className="space-y-3">
            <h3 id={`${id}-title`} className="text-subheading text-brand-text">{copy.customTitle}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <label htmlFor={`${id}-from`} className="text-control text-brand-text">{copy.from}</label>
                <Input ref={fromRef} id={`${id}-from`} name="from" autoComplete="off" type="date" value={from} min={toDateInput(start)} max={toDateInput(today)} onChange={(e) => setFrom(e.target.value)} aria-invalid={invalid('from') || undefined} aria-describedby={error ? errorId : undefined} className="mt-1" />
              </div>
              <div className="min-w-0">
                <label htmlFor={`${id}-to`} className="text-control text-brand-text">{copy.to}</label>
                <Input ref={toRef} id={`${id}-to`} name="to" autoComplete="off" type="date" value={to} min={toDateInput(start)} max={toDateInput(today)} onChange={(e) => setTo(e.target.value)} aria-invalid={invalid('to') || undefined} aria-describedby={error ? errorId : undefined} className="mt-1" />
              </div>
            </div>
            {error && <p id={errorId} role="alert" className="text-caption text-brand-danger-fg">{copy.errors[error]}</p>}
            <div className="flex justify-end">
              <Button type="submit" size="sm" variant="secondary" className="touch:min-h-11">{copy.apply}</Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      <p aria-live="polite" className="basis-full text-caption tabular-nums text-brand-text-secondary">{rangeText}</p>
    </div>
  )
}
