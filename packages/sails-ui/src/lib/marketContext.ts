/**
 * Market Context Navigation view-model (NAVIGATION-FILTER-1, docs/SAILS_DESIGN_LANGUAGE.md §16.1/§16.6).
 * Prototype only: the protocol has no market/community discovery or membership today, so nothing
 * in the real app produces these values yet. Pure helpers, no I/O.
 */

export type MarketContextKind = 'public' | 'community' | 'private'
export type MarketContextAccess = 'open' | 'restricted' | 'unavailable'
export type MarketContextMemberStatus = 'member' | 'invited' | 'none'
export type MarketContextListState = 'ready' | 'empty' | 'unavailable' | 'loading'

export interface MarketContextView {
  id: string
  name: string
  kind: MarketContextKind
  description?: string
  memberStatus?: MarketContextMemberStatus
  access: MarketContextAccess
  unavailableReason?: string
}

/** All user-facing copy for the selector. Working labels ("Mercado", "Comunidade") pending a naming decision (PROJECT_CONTEXT §2F.3). */
export interface MarketContextCopy {
  label: string
  kind: Record<MarketContextKind, string>
  member: Record<MarketContextMemberStatus, string>
  current: string
  listTitle: string
  loading: string
  loadError: string
  retry: string
  empty: string
  close: string
}

const KIND_ORDER: Record<MarketContextKind, number> = { public: 0, community: 1, private: 2 }

/** Public first, then communities, then private markets; alphabetical inside each kind. Does not mutate. */
export function orderMarketContexts(options: readonly MarketContextView[]): MarketContextView[] {
  return [...options].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, 'pt-BR'))
}

/** An `unavailable` context is listed (with its reason) but can never become the active one. */
export function isSelectableContext(view: MarketContextView): boolean {
  return view.access !== 'unavailable'
}

/** The id to activate for a user choice, or null when the choice must be ignored (unknown or unavailable). */
export function resolveContextSelection(options: readonly MarketContextView[], id: string): string | null {
  const view = options.find((o) => o.id === id)
  return view && isSelectableContext(view) ? view.id : null
}

/** Whether the active context may show its content: a restricted one only for members. */
export function canViewContextContent(view: MarketContextView): boolean {
  if (view.access === 'open') return true
  return view.access === 'restricted' && view.memberStatus === 'member'
}

/** True when there is nothing to choose besides public contexts (the "empty" state for communities). */
export function hasOnlyPublicContexts(options: readonly MarketContextView[]): boolean {
  return options.every((o) => o.kind === 'public')
}
