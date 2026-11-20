import { Link, useLocation } from 'react-router'
import { useAuth } from '../../context/AuthContext'
import { isNavActive } from './navMatch'
import { NAV_ITEMS, NavIcon } from './Sidebar'
import { cn } from '../../lib/utils'

/**
 * Mobile navigation (below md): the Sidebar's own destinations, icons and labels (NAV_ITEMS), so the
 * product has one navigation at every width. Items size to their label (`flex-auto`) so the longest
 * one ("Configurações") fits at 320px without shrinking the 12px text floor.
 */
export function BottomNav() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const items = NAV_ITEMS.filter((item) => !item.requiresAuth || user)

  return (
    <nav aria-label="Navegação principal" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-brand-surface border-t border-brand-border-subtle flex pb-[env(safe-area-inset-bottom)]">
      {items.map((item) => {
        const isActive = isNavActive(pathname, item)
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              // Active: a top accent bar plus orange label, the same language as the Sidebar's tint.
              'relative flex-auto min-w-0 min-h-14 px-1 flex flex-col items-center justify-center gap-1 text-xs transition-colors focus-visible:-outline-offset-2',
              isActive ? 'text-brand-orange-hover font-semibold' : 'text-brand-text-secondary'
            )}
          >
            {isActive && <span className="absolute top-0 inset-x-1/4 h-0.5 rounded-full bg-brand-orange-accent" aria-hidden="true" />}
            <span className="flex h-6 items-center"><NavIcon item={item} active={isActive} /></span>
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
