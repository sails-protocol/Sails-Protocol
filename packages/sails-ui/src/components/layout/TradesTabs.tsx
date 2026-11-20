import { TabLinks } from '../ui/tabs'

const TABS = [
  { to: '/profile/active', label: 'Ativos' },
  { to: '/profile/history', label: 'Histórico' },
] as const

/**
 * "Ativos | Histórico" tabs under the one "Trades" page title (each trade
 * list page renders it inside its PageHeader). Route tabs (TabLinks): links
 * with aria-current, not ARIA tabs, because each tab is its own URL.
 */
export function TradesTabs() {
  return <TabLinks label="Trades" items={TABS} />
}
