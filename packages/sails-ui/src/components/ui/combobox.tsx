/**
 * Layer A: combobox (DESIGN_SYSTEM.md 5.13), a searchable select for long
 * lists (asset, currency, payment method). Trigger = toolbar chip (field
 * anatomy + chevron), aria-haspopup=listbox, its name says the current value.
 * Popup on the floating surface (installed Radix Popover: positioning, Esc,
 * outside click, focus return). Inside: a search input with role=combobox that
 * keeps focus (Home/End move the caret, as in any text box); Arrow Up/Down move the active option
 * (aria-activedescendant, 12 % focus layer), Enter picks it, Esc closes.
 * Search ignores case and accents (lib/combobox.ts). Single choice closes on
 * pick; `multiple` stays open and toggles (aria-multiselectable). Selected =
 * selected fill (blue 12 %) + check, never orange. The popup is the one
 * boundary: the search row has no box of its own, a divider separates it.
 */
import * as React from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Divider } from './divider'
import { cn } from '../../lib/utils'
import { filterOptions, moveActive } from '../../lib/combobox'

export interface ComboboxOption<T extends string> {
  value: T
  label: string
  /** Extra search terms (e.g. the raw asset code). */
  keywords?: readonly string[]
  /** Leading visual (asset icon). */
  leading?: React.ReactNode
  /** Trailing secondary text (currency name). */
  detail?: React.ReactNode
}

export function Combobox<T extends string>({
  label, valueText, options, selected, onSelect, multiple = false, trigger, triggerClassName,
  searchPlaceholder, emptyText, footer, contentClassName, align = 'start',
}: {
  /** What is being chosen (caller copy): names the trigger, the search box and the list. */
  label: string
  /** Current value in words, added to the trigger's name ("Ativo: Bitcoin"). */
  valueText: string
  options: ReadonlyArray<ComboboxOption<T>>
  selected: readonly T[]
  onSelect: (value: T) => void
  multiple?: boolean
  /** Visible trigger content (chevron added). */
  trigger: React.ReactNode
  triggerClassName?: string
  searchPlaceholder: string
  /** Shown when nothing matches; receives the query. */
  emptyText: (query: string) => React.ReactNode
  /** Below the list (e.g. "Limpar seleção"). */
  footer?: (close: () => void) => React.ReactNode
  contentClassName?: string
  align?: 'start' | 'center' | 'end'
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(-1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const id = React.useId()
  const listId = `${id}-list`
  const optionId = (i: number) => `${id}-opt-${i}`
  const shown = React.useMemo(() => filterOptions(options, query), [options, query])

  const setOpenState = (o: boolean) => {
    setOpen(o)
    if (o) {
      setQuery('')
      setActive(Math.max(0, options.findIndex((opt) => selected.includes(opt.value))))
    }
  }
  const close = () => setOpenState(false)
  const pick = (i: number) => {
    const opt = shown[i]
    if (!opt) return
    onSelect(opt.value)
    if (!multiple) close()
    else setActive(i)
  }

  React.useEffect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active]) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => moveActive(a, shown.length, e.key as 'ArrowDown' | 'ArrowUp'))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(active)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger
        aria-label={`${label}: ${valueText}`}
        aria-haspopup="listbox"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpenState(true) }
        }}
        className={cn('toolbar-chip flex items-center gap-2 justify-between', triggerClassName)}
      >
        {trigger}
        <ChevronDown aria-hidden="true" className="size-icon-sm text-brand-text-muted shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn('w-72 p-0', contentClassName)}
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus() }}
      >
        <div className="flex items-center gap-2 px-3">
          <Search aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label={label}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 && shown[active] ? optionId(active) : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            // The popup's own edge is the boundary; focus stays here while open (caret + active option show it).
            className="h-10 touch:h-11 min-w-0 flex-1 bg-transparent text-field text-brand-text placeholder:text-brand-text-muted outline-none"
          />
        </div>
        <Divider />
        <div id={listId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="max-h-64 overflow-y-auto overscroll-contain p-1">
          {shown.map((o, i) => {
            const isSelected = selected.includes(o.value)
            return (
              <div
                key={o.value}
                id={optionId(i)}
                role="option"
                data-value={o.value}
                aria-selected={isSelected}
                data-active={i === active || undefined}
                // Keep focus in the search box; a click picks.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={cn(
                  'flex min-h-8 touch:min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-brand-text state-layer state-focus',
                  isSelected && 'bg-brand-selected font-medium'
                )}
              >
                {o.leading}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.detail && <span className="shrink-0 text-xs text-brand-text-muted">{o.detail}</span>}
                <Check aria-hidden="true" className={cn('size-icon-sm shrink-0 text-brand-blue-fg', !isSelected && 'invisible')} />
              </div>
            )
          })}
          {shown.length === 0 && <p role="status" className="px-2 py-2 text-xs text-brand-text-muted">{emptyText(query)}</p>}
        </div>
        {footer && <><Divider />{footer(close)}</>}
      </PopoverContent>
    </Popover>
  )
}
