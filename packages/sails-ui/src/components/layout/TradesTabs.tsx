import { NavLink, Outlet } from 'react-router'

const TABS = [
  { to: '/profile/active', label: 'Ativos' },
  { to: '/profile/history', label: 'Histórico' },
] as const

/**
 * Shared "Ativos | Histórico" header for the two trade list pages (wired as
 * a pathless layout route in App.tsx, so both routes and pages stay as they
 * are). Links, not ARIA tabs: each tab is its own URL. Desktop only for now;
 * mobile keeps BottomNav's separate entries until the mobile lot.
 */
export function TradesTabs() {
  return (
    <>
      <nav aria-label="Trades" className="hidden md:flex gap-1 mb-5 border-b border-brand-border-subtle">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }: { isActive: boolean }) =>
              `-mb-px min-h-11 inline-flex items-center px-4 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange-accent ${
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
      <Outlet />
    </>
  )
}
