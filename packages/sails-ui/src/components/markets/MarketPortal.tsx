/**
 * Layer A: the market portal (DECISIONS.md "Modelo mundo aberto"; PO 2026-11-22: the portal is navigation). One
 * discreet button with the current market's icon and name next to the Market title ("Mercado aberto ▾"). It opens a
 * panel (popover from md, bottom sheet below) with the current market only, then the actions, each with its icon and
 * one line (explore, my markets with a count, invite, create, and optional quieter ones). The list of the person's
 * markets is not here: it lives in Meus mercados. No routing here: the caller renders each action link through
 * `renderLink`. Copy from props.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, X, type LucideIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '../ui/sheet'
import { Divider } from '../ui/divider'
import { useIsDesktop } from '../market-context/MarketContextSelector'
import { cn } from '../../lib/utils'
import type { MarketView } from '../../lib/myMarkets'
import { ActionIcon, MarketIcon } from './MarketIcon'

export interface MarketPortalCopy {
  /** Accessible prefix of the trigger ("Mercado:"). */
  triggerPrefix: string
  title: string
  /** Accessible name of the current-market group ("Mercado atual"). */
  currentTitle: string
  actionsTitle: string
  current: string
  close: string
  /** Second line of the current market row. */
  currentLine: (m: MarketView) => string
}

export interface MarketPortalAction {
  id: string
  label: string
  description?: string
  icon: LucideIcon
  to: string
  /** Short trailing text, e.g. "4 mercados". */
  meta?: string
  /** Quieter row (e.g. a demo-only commercial action), shown after the main ones. */
  secondary?: boolean
}

const ROW = 'portal-row flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left focus-visible:-outline-offset-2'

/** Arrow keys, Home and End move between the rows, as in the Menu primitive (Tab still leaves the panel). */
function onRowKeys(e: KeyboardEvent<HTMLDivElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.portal-row')]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null
  if (next === null || rows.length === 0) return
  e.preventDefault()
  rows[(next + rows.length) % rows.length]?.focus()
}

export function MarketPortal({ current, actions, renderLink, copy, className }: {
  current: MarketView
  actions: readonly MarketPortalAction[]
  renderLink: (a: { to: string; className: string; onClick: () => void; children: ReactNode }) => ReactNode
  copy: MarketPortalCopy
  className?: string
}) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)
  const id = useId()
  const close = () => setOpen(false)

  const trigger = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(
        'inline-flex min-h-9 touch:min-h-11 max-w-full items-center gap-2 rounded-lg bg-brand-tonal py-1 pl-1 pr-2.5 text-sm font-medium text-brand-text transition-colors duration-short state-layer',
        className
      )}
    >
      <MarketIcon market={current} size="sm" className="bg-transparent" />
      <span className="sr-only">{copy.triggerPrefix} </span>
      <span className="min-w-0 truncate">{current.name}</span>
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" />
    </button>
  )

  const actionRow = (a: MarketPortalAction) => (
    <li key={a.id}>
      {renderLink({
        to: a.to,
        onClick: close,
        className: cn(ROW, 'state-layer'),
        children: (
          <>
            <ActionIcon icon={a.icon} />
            <span className="min-w-0 flex-1">
              <span className={cn('block font-medium', a.secondary ? 'text-brand-text-secondary' : 'text-brand-text')}>{a.label}</span>
              {a.description && <span className="block text-caption text-brand-text-secondary">{a.description}</span>}
            </span>
            {a.meta && <span className="shrink-0 tabular-nums text-caption text-brand-text-secondary">{a.meta}</span>}
          </>
        ),
      })}
    </li>
  )
  const main = actions.filter((a) => !a.secondary)
  const extra = actions.filter((a) => a.secondary)

  const body = (
    <div className="flex flex-col gap-1" onKeyDown={onRowKeys}>
      <p id={`${id}-current`} className="sr-only">{copy.currentTitle}</p>
      <div role="group" aria-labelledby={`${id}-current`}>
        <button type="button" aria-current="true" onClick={close} className={cn(ROW, 'bg-brand-selected')}>
          <MarketIcon market={current} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-brand-text">{current.name}</span>
            <span className="block text-caption text-brand-text-secondary">{copy.currentLine(current)}</span>
          </span>
          <span className="shrink-0 text-brand-checked">
            <Check aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">{copy.current}</span>
          </span>
        </button>
      </div>
      <Divider className="my-1" />
      <p id={`${id}-actions`} className="sr-only">{copy.actionsTitle}</p>
      <ul aria-labelledby={`${id}-actions`} className="flex flex-col gap-0.5">
        {main.map(actionRow)}
      </ul>
      {extra.length > 0 && (
        <>
          <Divider className="my-1" />
          <ul aria-labelledby={`${id}-actions`} className="flex flex-col gap-0.5">{extra.map(actionRow)}</ul>
        </>
      )}
    </div>
  )

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" aria-label={copy.title} className="w-[22rem] max-w-[calc(100vw-2rem)] p-1.5">{body}</PopoverContent>
      </Popover>
    )
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="bottom" hideDefaultClose aria-describedby={undefined} className="max-h-[85vh] gap-0 flex flex-col rounded-t-lg border-brand-border-subtle bg-brand-surface p-0">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-brand-border-subtle px-4 py-1">
          <SheetTitle className="text-heading">{copy.title}</SheetTitle>
          <button type="button" onClick={close} aria-label={copy.close} className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-brand-text-secondary state-layer hover:text-brand-text">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-2 py-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{body}</div>
      </SheetContent>
    </Sheet>
  )
}
