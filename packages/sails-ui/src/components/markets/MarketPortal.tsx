/**
 * Layer A: the market portal (DECISIONS.md "Modelo mundo aberto"). One discreet button with the current market's
 * icon and name next to the Market title ("Mercado aberto ▾"). It opens a panel (popover from md, bottom sheet below)
 * with the person's markets first and then the actions (explore, invite, create). People who only use the open
 * market are never bothered; switching takes two taps. Markets that cannot be entered yet are listed, disabled, with
 * their reason. No routing here: the caller renders each action link through `renderLink`. Copy from props.
 */
import { useId, useState, type ReactNode } from 'react'
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
  yourMarkets: string
  actionsTitle: string
  current: string
  close: string
  /** Second line of a market row (visibility · relation). */
  marketLine: (m: MarketView) => string
  /** Tonal tag on a market that cannot be entered yet ("Em breve"). */
  unavailable: string
  unavailableReason: (m: MarketView) => string
  illustrative: string
}

export interface MarketPortalAction {
  id: string
  label: string
  description?: string
  icon: LucideIcon
  to: string
}

const ROW = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left focus-visible:-outline-offset-2'
const TAG = 'rounded-sm bg-brand-tonal px-1.5 text-caption font-medium leading-4 text-brand-text-secondary'

export function MarketPortal({ current, markets, isSelectable, onSelect, actions, renderLink, copy, className }: {
  current: MarketView
  /** The person's markets, current included, in display order. */
  markets: readonly MarketView[]
  isSelectable: (m: MarketView) => boolean
  onSelect: (id: string) => void
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

  const body = (
    <div className="flex flex-col gap-1">
      <p id={`${id}-mine`} className="px-2 pb-1 pt-1 text-caption font-medium text-brand-text-muted">{copy.yourMarkets}</p>
      <ul aria-labelledby={`${id}-mine`} className="flex flex-col gap-0.5">
        {markets.map((m) => {
          const selectable = isSelectable(m)
          const isCurrent = m.id === current.id
          const reasonId = `${id}-reason-${m.id}`
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-current={isCurrent ? 'true' : undefined}
                aria-disabled={selectable ? undefined : 'true'}
                aria-describedby={selectable ? undefined : reasonId}
                onClick={() => { if (!selectable) return; close(); if (!isCurrent) onSelect(m.id) }}
                className={cn(ROW, isCurrent ? 'bg-brand-selected' : selectable ? 'state-layer' : 'cursor-not-allowed')}
              >
                <MarketIcon market={m} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cn('font-medium', selectable ? 'text-brand-text' : 'text-brand-text-secondary')}>{m.name}</span>
                    {!selectable && <span className={TAG}>{copy.unavailable}</span>}
                    {m.illustrative && <span className={TAG}>{copy.illustrative}</span>}
                  </span>
                  <span className="block text-caption text-brand-text-secondary">{copy.marketLine(m)}</span>
                  {!selectable && <span id={reasonId} className="block text-caption text-brand-text-muted">{copy.unavailableReason(m)}</span>}
                </span>
                {isCurrent && (
                  <span className="shrink-0 text-brand-checked">
                    <Check aria-hidden="true" className="h-4 w-4" />
                    <span className="sr-only">{copy.current}</span>
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <Divider className="my-1" />
      <p id={`${id}-actions`} className="sr-only">{copy.actionsTitle}</p>
      <ul aria-labelledby={`${id}-actions`} className="flex flex-col gap-0.5">
        {actions.map((a) => (
          <li key={a.id}>
            {renderLink({
              to: a.to,
              onClick: close,
              className: cn(ROW, 'state-layer'),
              children: (
                <>
                  <ActionIcon icon={a.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-brand-text">{a.label}</span>
                    {a.description && <span className="block text-caption text-brand-text-secondary">{a.description}</span>}
                  </span>
                </>
              ),
            })}
          </li>
        ))}
      </ul>
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
        <div className="overflow-y-auto overscroll-contain px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{body}</div>
      </SheetContent>
    </Sheet>
  )
}
