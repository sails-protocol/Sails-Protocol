import { NavLink } from 'react-router'
import { ShoppingCart, Hourglass, ArrowLeftRight, User, Scale } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

/**
 * Desktop product navigation (UI-FOUNDATION-1 — hybrid sidebar + topbar
 * shell, `docs/SAILS_MARKET_DESIGN_DIRECTION.md` §7a's recommended
 * option). Deliberately the SAME 5 destinations `TopNav.tsx` already
 * linked to (`docs/PROJECT_CONTEXT.md` §2E's capability map — these are
 * the only Real, Journey-complete surfaces today) — no OpenLiquidity/
 * OpenAgents/OTC/Private Markets/Portfolio/Settings entry, since none of
 * those has a real destination route yet (§2E item 5). Adding a disabled
 * or "coming soon" entry for them would be exactly the "disabled-menu
 * graveyard" this mission was told to avoid — a real destination gets a
 * sidebar entry when it exists, not before.
 *
 * `Disputas` keeps the same conditional-on-session guard `TopNav.tsx`
 * used — no admin/operator gate exists (`Disputes.tsx`'s own header
 * comment), a signed-out visitor simply doesn't see the entry.
 *
 * DESIGN-LANGUAGE-1 §2.1 — `Perfil`'s `end` was `false`, so react-router's
 * default NavLink matching (active if the current path === `to` OR starts
 * with `to + '/'`) made `/profile` match `/profile/active` and
 * `/profile/history` too — both of those routes lit up BOTH their own
 * item and `Perfil` simultaneously. `end: true` restricts `Perfil` to the
 * exact `/profile` path, the standard react-router fix for a parent path
 * that collides with its own children. `/profile/new-offer` (reached from
 * inside Profile, not linked directly from this nav) now activates no
 * item rather than a wrong one — a known, acceptable gap, not a new bug.
 */
const NAV_ITEMS = [
  { to: '/', label: 'Market', icon: ShoppingCart, end: true, requiresAuth: false },
  { to: '/profile/active', label: 'Trades Ativos', icon: Hourglass, end: false, requiresAuth: false },
  { to: '/profile/history', label: 'Meus Trades', icon: ArrowLeftRight, end: false, requiresAuth: false },
  { to: '/disputes', label: 'Disputas', icon: Scale, end: false, requiresAuth: true },
  { to: '/profile', label: 'Perfil', icon: User, end: true, requiresAuth: false },
] as const

export function Sidebar() {
  const { user } = useAuth()
  const items = NAV_ITEMS.filter((item) => !item.requiresAuth || user)

  return (
    <aside
      aria-label="Navegação principal"
      className="hidden md:flex md:flex-col md:w-16 lg:w-56 shrink-0 border-r border-brand-border-subtle bg-brand-surface h-screen sticky top-0"
    >
      <div className="h-14 flex items-center justify-center lg:justify-start lg:px-5 border-b border-brand-border-subtle shrink-0">
        <NavLink to="/" className="font-display font-bold tracking-tight text-brand-text lg:text-lg" aria-label="Sails Market">
          <span className="lg:hidden">S</span>
          <span className="hidden lg:inline">Sails <span className="text-brand-orange-accent">Market</span></span>
        </NavLink>
      </div>
      <nav className="flex-1 py-3 flex flex-col gap-1 px-2">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={item.label}
            className={({ isActive }: { isActive: boolean }) =>
              // UI-FOUNDATION-1-VISUAL-CORRECTION §4.2 — a plain elevated-bg
              // active state read as "gray", not "active". Orange is the
              // sole primary brand/action accent (design direction §5), so
              // the active item gets an orange left rail + tinted orange
              // background + orange icon/text; the inactive state reserves
              // an equal-width transparent border so nothing shifts on toggle.
              `flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-sm font-medium transition-colors justify-center lg:justify-start ${
                isActive
                  ? 'border-brand-orange-accent bg-brand-orange-accent/10 text-brand-orange-hover'
                  : 'border-transparent text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'
              }`
            }
          >
            <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
