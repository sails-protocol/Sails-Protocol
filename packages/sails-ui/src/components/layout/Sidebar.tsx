import { Link, NavLink, useLocation } from 'react-router'
import { ShoppingCart, ArrowLeftRight, User, Scale, Settings } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { isNavActive } from './navMatch'

/**
 * Desktop product navigation (UI-FOUNDATION-1 hybrid sidebar + topbar
 * shell). Five real destinations: Market, Trades, Disputas, Perfil,
 * Configurações. No "coming soon" entries: an item appears here only when
 * its route exists. Planned capabilities (servers, other wallets,
 * security, communities, help) are listed as disabled rows INSIDE
 * Configurações (pages/Settings.tsx), never as menu entries.
 *
 * "Trades" opens /profile/active and stays active on /profile/history
 * too (`also`): both pages remain separate, linked by a shared tab header
 * (TradesTabs.tsx). `Perfil` is exact-match (`end`) so it does not light
 * up on its /profile/* children. `Disputas` keeps its session guard (no
 * admin/operator gate exists; a signed-out visitor just doesn't see it).
 */
const NAV_ITEMS = [
  { to: '/', label: 'Market', icon: ShoppingCart, end: true, requiresAuth: false },
  { to: '/profile/active', also: ['/profile/history'], label: 'Trades', icon: ArrowLeftRight, end: false, requiresAuth: false },
  { to: '/disputes', label: 'Disputas', icon: Scale, end: false, requiresAuth: true },
  { to: '/profile', label: 'Perfil', icon: User, end: true, requiresAuth: false },
  { to: '/settings', label: 'Configurações', icon: Settings, end: false, requiresAuth: false },
] as const

export function Sidebar() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const items = NAV_ITEMS.filter((item) => !item.requiresAuth || user)

  return (
    <aside
      aria-label="Navegação principal"
      className="hidden md:flex md:flex-col md:w-16 lg:w-56 shrink-0 border-r border-brand-border-subtle bg-brand-surface h-screen sticky top-0"
    >
      <div className="h-14 flex items-center justify-center lg:justify-start lg:px-5 border-b border-brand-border-subtle shrink-0">
        <NavLink to="/" className="font-display font-semibold tracking-tight text-brand-text lg:text-lg" aria-label="Sails Market">
          <span className="lg:hidden">S</span>
          <span className="hidden lg:inline">Sails <span className="text-brand-orange-accent">Market</span></span>
        </NavLink>
      </div>
      <nav className="flex-1 py-3 flex flex-col gap-1 px-2">
        {items.map((item) => {
          const isActive = isNavActive(pathname, item)
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={
                // UI-FOUNDATION-1-VISUAL-CORRECTION §4.2 — a plain elevated-bg
                // active state read as "gray", not "active". Orange is the
                // sole primary brand/action accent (design direction §5), so
                // the active item gets a tinted orange background + orange
                // icon/text (no side rail since 2026-11-20: the tint already marks it).
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors justify-center lg:justify-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? 'bg-brand-orange-accent/10 text-brand-orange-hover'
                    : 'text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'
                }`}
            >
              <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span className="hidden lg:inline">{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
