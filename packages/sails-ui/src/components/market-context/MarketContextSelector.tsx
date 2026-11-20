/**
 * Market Context Navigation selector (Layer A, NAVIGATION-FILTER-1 / docs/SAILS_DESIGN_LANGUAGE.md §16.6).
 * "Which market or community am I exploring?" — navigation, never a Screen Filter: it deliberately does not
 * use `.toolbar-chip` and must not be placed inside the filter toolbar. No data fetching, no routing; all copy
 * comes from the caller. From 768px (the app's md breakpoint, same as App.tsx MOBILE_QUERY) it opens a popover;
 * below that, a bottom sheet. Focus returns to the trigger on close. Blocked contexts are listed disabled with
 * their reason (access not granted vs market unavailable); there is no gate screen and no request-access flow.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronsUpDown, CircleDashed, Globe, UserCheck, UserX, Users, X, type LucideIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '../ui/sheet'
import { ListSkeleton } from '../ui/skeleton'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  contextBlock,
  groupMarketContexts,
  resolveContextSelection,
  type MarketContextBlock,
  type MarketContextCopy,
  type MarketContextKind,
  type MarketContextListState,
  type MarketContextView,
} from '../../lib/marketContext'

export interface MarketContextSelectorProps {
  current: MarketContextView
  options: MarketContextView[]
  onSelect: (id: string) => void
  state: MarketContextListState
  copy: MarketContextCopy
  /** Shown as a retry action when `state` is 'unavailable'. */
  onRetry?: () => void
  className?: string
}

// Restricted = a group of admitted participants (UserCheck); deliberately no lock or shield (no security claim).
const KIND_ICON: Record<MarketContextKind, LucideIcon> = { public: Globe, community: Users, restricted: UserCheck }
const BLOCK_ICON: Record<MarketContextBlock, LucideIcon> = { 'not-granted': UserX, unavailable: CircleDashed }
const DESKTOP_QUERY = '(min-width: 768px)'

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => setDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

function KindTile({ kind, muted }: { kind: MarketContextKind; muted?: boolean }) {
  const Icon = KIND_ICON[kind]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
        muted ? 'border-brand-border-subtle bg-brand-elevated text-brand-text-muted' : 'border-brand-orange-accent/40 bg-brand-orange-accent/10 text-brand-orange-accent'
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  )
}

function KindBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-brand-border px-1.5 py-px text-caption font-medium leading-4 text-brand-text-secondary">
      {children}
    </span>
  )
}

export function MarketContextSelector({ current, options, onSelect, state, copy, onRetry, className }: MarketContextSelectorProps) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const kindLabel = copy.kind[current.kind]
  const labelId = useId()

  const choose = (id: string) => {
    const next = resolveContextSelection(options, id)
    if (!next) return
    setOpen(false)
    if (next !== current.id) onSelect(next)
  }

  // Arrow/Home/End move focus between options; Tab still works as usual.
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-context-option]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (to === null || items.length === 0) return
    e.preventDefault()
    items[(to + items.length) % items.length].focus()
  }

  const focusCurrent = (e: Event) => {
    const target = listRef.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? listRef.current?.querySelector<HTMLButtonElement>('button')
    if (target) {
      e.preventDefault()
      target.focus()
    }
  }

  // Full-width bordered control (never a chip): name + one-line subtitle, so it reads as a place, not a filter value.
  const trigger = (
    <button
      type="button"
      aria-labelledby={`${labelId} ${labelId}-current`}
      className={cn(
        'flex min-h-14 w-full items-center gap-3 rounded-lg border border-brand-border bg-brand-surface py-2 pl-2.5 pr-4 text-left transition-colors',
        'hover:border-brand-border-hover field-focus',
        className
      )}
    >
      <KindTile kind={current.kind} />
      <span id={`${labelId}-current`} className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 md:flex-nowrap">
          <span className="font-display text-heading text-brand-text md:truncate">{current.name}</span>
          {current.kind !== 'public' && <KindBadge>{kindLabel}</KindBadge>}
        </span>
        {current.description && <span className="block truncate text-body-sm leading-5 text-brand-text-secondary">{current.description}</span>}
      </span>
      <ChevronsUpDown aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-text-secondary" />
    </button>
  )

  let body: ReactNode
  if (state === 'loading') {
    body = <ListSkeleton label={copy.loading} rows={3} rowClassName="h-14" />
  } else if (state === 'unavailable') {
    body = (
      <div role="alert" className="px-3 py-4">
        <p className="text-sm text-brand-text">{copy.loadError}</p>
        {onRetry && (
          <Button variant="outline" onClick={onRetry} className="mt-3 min-h-11">
            {copy.retry}
          </Button>
        )}
      </div>
    )
  } else {
    body = (
      <>
        <ul ref={listRef} role="list" aria-label={copy.listTitle} onKeyDown={onListKeyDown} className="flex flex-col gap-1">
          {groupMarketContexts(options).map((g) => (
            <li key={g.kind}>
              <div id={`${labelId}-group-${g.kind}`} className="px-2 pb-1 pt-2 text-caption font-medium uppercase tracking-wider text-brand-text-muted">{copy.group[g.kind]}</div>
              <ul role="list" aria-labelledby={`${labelId}-group-${g.kind}`} className="flex flex-col gap-0.5">
                {g.items.map((o) => {
                  const block = contextBlock(o)
                  const isCurrent = o.id === current.id
                  const reasonId = `${labelId}-reason-${o.id}`
                  const BlockIcon = block ? BLOCK_ICON[block] : null
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        data-context-option=""
                        aria-current={isCurrent ? 'true' : undefined}
                        aria-disabled={block ? 'true' : undefined}
                        aria-describedby={block ? reasonId : undefined}
                        onClick={() => choose(o.id)}
                        className={cn(
                          'flex min-h-12 w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors focus-visible:-outline-offset-2',
                          isCurrent ? 'bg-brand-elevated' : block ? 'cursor-not-allowed' : 'state-layer'
                        )}
                      >
                        <KindTile kind={o.kind} muted={!!block} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className={cn('font-medium', block ? 'text-brand-text-secondary' : 'text-brand-text')}>{o.name}</span>
                            {!block && o.memberStatus === 'member' && <span className="text-xs text-brand-text-secondary">{copy.member.member}</span>}
                          </span>
                          {!block && o.description && <span className="block text-body-sm leading-5 text-brand-text-secondary">{o.description}</span>}
                          {block && BlockIcon && (
                            <span id={reasonId} className="mt-0.5 block text-body-sm leading-5 text-brand-text-muted">
                              <span className="mr-1.5 inline-flex items-center gap-1 rounded-sm border border-brand-border px-1.5 align-[1px] text-caption font-medium leading-4 text-brand-text-secondary">
                                <BlockIcon aria-hidden="true" className="h-3 w-3" />
                                {copy.block[block]}
                              </span>
                              {o.unavailableReason}
                            </span>
                          )}
                        </span>
                        {isCurrent && (
                          <span className="mt-2 flex shrink-0 items-center text-brand-orange-accent">
                            <Check aria-hidden="true" className="h-4 w-4" />
                            <span className="sr-only">{copy.current}</span>
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
        {state === 'empty' && <p className="mt-2 border-t border-brand-border-subtle px-2 pt-3 pb-1 text-sm text-brand-text-secondary">{copy.empty}</p>}
      </>
    )
  }

  const sectionLabel = <span id={labelId} className="mb-1 block text-xs font-medium uppercase tracking-wider text-brand-text-muted">{copy.label}</span>

  if (desktop) {
    return (
      <div>
        {sectionLabel}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={copy.listTitle}
            onOpenAutoFocus={focusCurrent}
            className="w-[var(--radix-popover-trigger-width)] max-w-[560px] border-brand-border bg-brand-surface p-1.5"
          >
            {body}
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <div>
      {sectionLabel}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          hideDefaultClose
          aria-describedby={undefined}
          onOpenAutoFocus={focusCurrent}
          className="max-h-[85vh] gap-0 flex flex-col rounded-t-2xl border-brand-border-subtle bg-brand-surface p-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-brand-border-subtle px-4 py-1">
            <SheetTitle className="text-heading">{copy.listTitle}</SheetTitle>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={copy.close}
              className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-brand-text-secondary state-layer hover:text-brand-text"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{body}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
