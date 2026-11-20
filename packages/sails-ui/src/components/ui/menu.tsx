/**
 * Layer A: menu (DESIGN_SYSTEM.md 5.8), a list of commands opened from a button.
 * Built on the installed Radix Popover (positioning, Esc, outside click, focus
 * return to the trigger); the menu semantics are ours: role=menu/menuitem,
 * Arrow Up/Down, Home/End, typeahead, Tab closes. Opening from the keyboard
 * (Enter, Space, Arrow Down/Up) focuses the first/last item. Floating surface,
 * elevation-2, items 32 fine / 44 touch with a 16px icon, focus = 12 % layer
 * (no box inside the menu). `role="menu"` is only allowed here (guard).
 */
import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Divider } from './divider'
import { cn } from '../../lib/utils'
import { moveActive, typeaheadIndex } from '../../lib/combobox'

const CloseCtx = React.createContext<() => void>(() => {})
const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])'

export function Menu({ open: openProp, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) {
  const [own, setOwn] = React.useState(false)
  const open = openProp ?? own
  const setOpen = React.useCallback((o: boolean) => { setOwn(o); onOpenChange?.(o) }, [onOpenChange])
  return (
    <CloseCtx.Provider value={() => setOpen(false)}>
      <Popover open={open} onOpenChange={setOpen}>{children}</Popover>
    </CloseCtx.Provider>
  )
}

// Which end of the list to focus when the menu opens (set by the trigger's key).
const focusEnd = { current: 'first' as 'first' | 'last' }

export const MenuTrigger = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof PopoverTrigger>>(
  ({ onKeyDown, ...props }, ref) => (
    <PopoverTrigger
      ref={ref}
      aria-haspopup="menu"
      onKeyDown={(e) => {
        focusEnd.current = e.key === 'ArrowUp' ? 'last' : 'first'
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.currentTarget.click() }
        onKeyDown?.(e)
      }}
      {...props}
    />
  )
)
MenuTrigger.displayName = 'MenuTrigger'

export function MenuContent({ className, children, label, align = 'end', ...props }: React.ComponentPropsWithoutRef<typeof PopoverContent> & { label: string }) {
  const close = React.useContext(CloseCtx)
  const ref = React.useRef<HTMLDivElement>(null)
  const typed = React.useRef({ text: '', at: 0 })
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[moveActive(index, list.length, e.key)]?.focus()
    } else if (e.key === 'Tab') {
      close()
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      // Typeahead: letters typed within 500 ms build one prefix.
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 500 ? typed.current.text : '') + e.key, at: now }
      const next = typeaheadIndex(list.map((el) => el.textContent ?? ''), typed.current.text, typed.current.text.length > 1 ? index - 1 : index)
      if (next >= 0) list[next].focus()
    }
  }
  return (
    <PopoverContent
      ref={ref}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      align={align}
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        const list = items()
        ;(focusEnd.current === 'last' ? list[list.length - 1] : list[0])?.focus()
        focusEnd.current = 'first'
      }}
      onKeyDown={onKeyDown}
      className={cn('w-60 p-1', className)}
      {...props}
    >
      {children}
    </PopoverContent>
  )
}

type MenuItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Render the single child (e.g. a router Link) as the item instead of a button. */
  asChild?: boolean
  destructive?: boolean
  onSelect?: () => void
}

export const MenuItem = React.forwardRef<HTMLButtonElement, MenuItemProps>(
  ({ asChild, destructive, onSelect, onClick, onKeyDown, className, children, ...props }, ref) => {
    const close = React.useContext(CloseCtx)
    const itemProps = {
      ...props,
      ref,
      role: 'menuitem',
      tabIndex: -1,
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => { onClick?.(e); onSelect?.(); close() },
      // Links activate on Enter only; a menu item also activates on Space.
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e)
        if (e.key === ' ' && asChild) { e.preventDefault(); e.currentTarget.click() }
      },
      className: cn(
        'flex w-full items-center gap-2 rounded-sm px-2 min-h-8 touch:min-h-11 text-sm text-left state-layer state-focus [&_svg]:size-icon-sm [&_svg]:shrink-0',
        destructive ? 'text-brand-danger-fg' : 'text-brand-text [&_svg]:text-brand-text-secondary',
        className
      ),
    }
    if (asChild && React.isValidElement(children)) return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, itemProps)
    return <button type="button" {...itemProps}>{children}</button>
  }
)
MenuItem.displayName = 'MenuItem'

export function MenuSeparator() {
  return <Divider className="my-1" />
}

/** Non-interactive header inside the menu (e.g. the account name). */
export function MenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div role="presentation" className={cn('px-2 py-1.5', className)}>{children}</div>
}
