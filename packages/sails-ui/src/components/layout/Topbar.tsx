import { Link, NavLink, useLocation } from 'react-router'
import { useAuth } from '../../context/AuthContext'
import { AccountMenu } from './AccountMenu'
import { isNavActive } from './navMatch'
import { NAV_ITEMS, NavIcon, navItemTone } from './Sidebar'
import { SailsLogo } from '../brand/SailsLogo'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { t } from '../../i18n'

/**
 * Desktop topbar (UI-FOUNDATION-1 — hybrid sidebar + topbar shell).
 * Session/identity ONLY — product navigation lives in `Sidebar.tsx`; the
 * theme toggle and "Rever tour" moved to Configurações (pages/Settings.tsx)
 * on desktop. No search or notifications entry: neither has a real backend
 * today (`docs/PROJECT_CONTEXT.md` §2E), and a placeholder would present an
 * unavailable capability as available.
 *
 * `withNav` (the viewer chose "Posição do menu: Superior"): from 1024 px the bar also carries the logo on
 * the left and the Sidebar's four destinations in the center (same items, order, routes and active tone);
 * the Sidebar hides at that width. Below 1024 px the bar is exactly the session-only bar above.
 */
export function Topbar({ withNav = false }: { withNav?: boolean }) {
  const { user } = useAuth()
  const location = useLocation()
  const items = NAV_ITEMS.filter((item) => !item.requiresAuth || user)

  return (
    <header
      className={cn(
        'hidden md:flex h-14 items-center justify-end gap-3 border-b border-brand-border-subtle bg-brand-bg/90 backdrop-blur px-6 sticky top-0 z-40',
        // Three columns: the nav stays centered while both sides fit; a side never shrinks below its content (no wrapped key).
        withNav && 'lg:grid lg:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] lg:gap-6'
      )}
    >
      {withNav && (
        <NavLink to="/" aria-label="Sails Market" className="hidden lg:inline-flex items-center justify-self-start min-h-9 touch:min-h-11 rounded-md">
          <SailsLogo />
        </NavLink>
      )}
      {withNav && (
        <nav aria-label={t('shell.nav.main')} className="hidden lg:flex items-center gap-1">
          {items.map((item) => {
            const isActive = isNavActive(location.pathname, item)
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={cn('flex h-9 touch:h-11 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap transition-colors', navItemTone(isActive))}
              >
                <span className="flex w-6 shrink-0 justify-center"><NavIcon item={item} active={isActive} /></span>
                {item.label}
              </Link>
            )
          })}
        </nav>
      )}
      <div className="flex items-center justify-self-end">
        {user ? (
          <AccountMenu user={user} />
        ) : (
          <Link to="/login" state={{ from: location.pathname }} className={cn(buttonVariants({ className: 'text-sm px-4 py-2' }))}>
            {t('shell.session.connectWallet')}
          </Link>
        )}
      </div>
    </header>
  )
}
