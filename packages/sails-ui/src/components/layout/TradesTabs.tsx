import { NavLink } from 'react-router'

const TABS = [
  { to: '/profile/active', label: 'Ativos' },
  { to: '/profile/history', label: 'Histórico' },
] as const

/**
 * "Ativos | Histórico" tabs under the one "Trades" page title (each trade
 * list page renders it inside its PageHeader). Links, not ARIA tabs: each
 * tab is its own URL. Desktop only for now; mobile keeps BottomNav's
 * separate entries until the mobile lot.
 */
export function TradesTabs() {
  return (
    <nav aria-label="Trades" className="hidden md:flex gap-1 border-b border-brand-border-subtle">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }: { isActive: boolean }) =>
            `-mb-px h-10 inline-flex items-center px-3 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange-accent ${
              isActive
                ? 'border-brand-orange-accent text-brand-text'
                : 'border-transparent text-brand-text-secondary hover:text-brand-text'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Desktop shows the one "Trades" title above the tabs; mobile (no tabs yet) keeps the specific list name. */
export function TradesTitle({ mobile }: { mobile: string }) {
  return (
    <>
      <span className="md:hidden">{mobile}</span>
      <span className="hidden md:inline">Trades</span>
    </>
  )
}
