/**
 * Layer A: tabs (DESIGN_SYSTEM.md 5.4). Two kinds, one look:
 * - `Tabs`: in-page tabs that switch a panel without changing the URL.
 *   role=tablist/tab, aria-selected, aria-controls, roving tabindex, arrow keys
 *   (Left/Right, or Up/Down when vertical), Home/End; selection follows focus.
 * - `TabLinks`: tabs that navigate routes (each tab is its own URL). A `nav` of
 *   links with aria-current="page"; Tab moves between them like any link.
 * Active = text color + 2px orange-accent indicator ("you are here", like the
 * rest of navigation); inactive = secondary text. Height 40 fine / 44 touch.
 * Not for filters (use SegmentedControl).
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { NavLink } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { moveActive } from '../../lib/combobox'

export interface TabItem<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
}

type Orientation = 'horizontal' | 'vertical'

/** Shared tab look. Horizontal: underline; vertical (section lists): leading bar + tint. */
export function tabClass(active: boolean, orientation: Orientation = 'horizontal') {
  return cn(
    'inline-flex items-center gap-2 text-control font-medium transition-colors duration-short state-layer focus-visible:-outline-offset-2',
    orientation === 'horizontal'
      ? 'h-10 touch:h-11 -mb-px px-3 border-b-2'
      : 'h-9 touch:h-11 w-full rounded-md px-3 text-left border-l-2',
    active
      ? cn('border-brand-orange-accent text-brand-text', orientation === 'vertical' && 'bg-brand-orange-accent/10')
      : 'border-transparent text-brand-text-secondary hover:text-brand-text'
  )
}
const LIST = { horizontal: 'flex gap-1 border-b border-brand-border-subtle', vertical: 'flex flex-col gap-1' } as const

export function Tabs<T extends string>({ items, value, onChange, label, idBase, orientation = 'horizontal', className }: {
  items: ReadonlyArray<TabItem<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible name of the tab list (caller copy). */
  label: string
  /** Prefix for ids: tab = `${idBase}-tab-${value}`, panel = `${idBase}-panel-${value}` (use `tabPanelProps`). */
  idBase: string
  orientation?: Orientation
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const [next_, prev] = orientation === 'horizontal' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowDown', 'ArrowUp']
    const key = e.key === 'Home' || e.key === 'End' ? e.key : e.key === next_ ? 'ArrowDown' : e.key === prev ? 'ArrowUp' : null
    if (!key) return
    e.preventDefault()
    const next = moveActive(index, items.length, key)
    refs.current[next]?.focus()
    onChange(items[next].value)
  }
  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className={cn(LIST[orientation], className)}>
      {items.map((t, i) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.value}`}
            aria-selected={active}
            aria-controls={`${idBase}-panel-${t.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={tabClass(active, orientation)}
          >
            {t.icon && <t.icon className="size-icon-sm shrink-0" aria-hidden="true" />}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

/** Props for the panel of one tab of `Tabs` (role, ids, and focusable so the panel is reachable). */
export function tabPanelProps(idBase: string, value: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${value}`, 'aria-labelledby': `${idBase}-tab-${value}`, tabIndex: 0 }
}

/** Route tabs: links, not ARIA tabs (each one is a URL). */
export function TabLinks({ items, label, className }: {
  items: ReadonlyArray<{ to: string; label: ReactNode }>
  label: string
  className?: string
}) {
  return (
    <nav aria-label={label} className={cn(LIST.horizontal, className)}>
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end className={({ isActive }: { isActive: boolean }) => tabClass(isActive)}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}
