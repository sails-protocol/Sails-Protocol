/**
 * NAVIGATION-FILTER-1 §4.5 — extracted from `Marketplace.tsx`'s own
 * inline `activeFilterCount` (used for the toolbar "Filtros" button's
 * badge) so `FilterPanel.tsx`'s new in-drawer active-filter summary
 * counts the exact same thing, not a second, driftable definition.
 */
import type { MarketplaceFilters } from '../types'

export function countActiveFilters(filters: MarketplaceFilters): number {
  return [
    filters.negotiableOnly,
    filters.previouslyTradedOnly,
    filters.amount !== '',
    filters.paymentMethods.length > 0,
    filters.country !== 'Todos',
  ].filter(Boolean).length
}
