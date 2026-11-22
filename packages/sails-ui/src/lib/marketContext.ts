/**
 * Market Context Navigation view-model (NAVIGATION-FILTER-1, docs/SAILS_DESIGN_LANGUAGE.md §16.1/§16.6).
 * Prototype only: the protocol has no market/community discovery or membership today, so nothing
 * in the real app produces these values yet. Pure helpers, no I/O.
 */
import { getLocale } from './locale'

export type MarketContextKind = 'public' | 'community' | 'restricted'
export type MarketContextAccess = 'open' | 'restricted' | 'unavailable'
export type MarketContextMemberStatus = 'member' | 'invited' | 'none'
export type MarketContextListState = 'ready' | 'empty' | 'unavailable' | 'loading'
/** Why a context cannot be entered: access was not granted to the user, or the market itself cannot be reached now. */
export type MarketContextBlock = 'not-granted' | 'unavailable'

export interface MarketContextView {
  id: string
  name: string
  kind: MarketContextKind
  description?: string
  memberStatus?: MarketContextMemberStatus
  access: MarketContextAccess
  unavailableReason?: string
}

/** All user-facing copy for the selector. Working labels pending a naming decision (PROJECT_CONTEXT §2F.3). */
export interface MarketContextCopy {
  label: string
  kind: Record<MarketContextKind, string>
  group: Record<MarketContextKind, string>
  member: Record<MarketContextMemberStatus, string>
  block: Record<MarketContextBlock, string>
  current: string
  listTitle: string
  loading: string
  loadError: string
  retry: string
  empty: string
  close: string
}

const KIND_ORDER: MarketContextKind[] = ['public', 'community', 'restricted']

/** Public first, then communities, then restricted markets; alphabetical inside each kind. Does not mutate. */
export function orderMarketContexts(options: readonly MarketContextView[]): MarketContextView[] {
  return [...options].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name, getLocale()))
}

/** Ordered, non-empty groups by kind, for a sectioned list. */
export function groupMarketContexts(options: readonly MarketContextView[]): { kind: MarketContextKind; items: MarketContextView[] }[] {
  const ordered = orderMarketContexts(options)
  return KIND_ORDER.map((kind) => ({ kind, items: ordered.filter((o) => o.kind === kind) })).filter((g) => g.items.length > 0)
}

/** Null when the context can be entered. A restricted market without membership is 'not-granted'. */
export function contextBlock(view: MarketContextView): MarketContextBlock | null {
  if (view.access === 'unavailable') return 'unavailable'
  if (view.access === 'restricted' && view.memberStatus !== 'member') return 'not-granted'
  return null
}

/** Blocked contexts are listed (disabled, with their reason) but can never become the active one. */
export function isSelectableContext(view: MarketContextView): boolean {
  return contextBlock(view) === null
}

/** The id to activate for a user choice, or null when the choice must be ignored (unknown or blocked). */
export function resolveContextSelection(options: readonly MarketContextView[], id: string): string | null {
  const view = options.find((o) => o.id === id)
  return view && isSelectableContext(view) ? view.id : null
}

/** True when there is nothing to choose besides public contexts (the "empty" state for communities). */
export function hasOnlyPublicContexts(options: readonly MarketContextView[]): boolean {
  return options.every((o) => o.kind === 'public')
}
