import { NavLink } from 'react-router'

const TABS = [
  { to: '/profile/active', label: 'Ativos' },
  { to: '/profile/history', label: 'Histórico' },
] as const

/**
 * "Ativos | Histórico" tabs under the one "Trades" page title (each trade
 * list page renders it inside its PageHeader). Links, not ARIA tabs: each
 * tab is its own URL. Same tabs at every width (44px tall below md).
 */
export function TradesTabs() {
  return (
    <nav aria-label="Trades" className="flex gap-1 border-b border-brand-border-subtle">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }: { isActive: boolean }) =>
            `-mb-px h-11 md:h-10 inline-flex items-center px-3 text-sm font-medium border-b-2 transition-colors focus-visible:-outline-offset-2 ${
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

