import { Link, useLocation } from 'react-router'
import { useAuth } from '../../context/AuthContext'
import { AccountMenu } from './AccountMenu'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'

/**
 * Desktop topbar (UI-FOUNDATION-1 — hybrid sidebar + topbar shell).
 * Session/identity ONLY — product navigation lives in `Sidebar.tsx`; the
 * theme toggle and "Rever tour" moved to Configurações (pages/Settings.tsx)
 * on desktop. No search or notifications entry: neither has a real backend
 * today (`docs/PROJECT_CONTEXT.md` §2E), and a placeholder would present an
 * unavailable capability as available.
 */
export function Topbar() {
  const { user } = useAuth()
  const location = useLocation()

  return (
    <header className="hidden md:flex h-14 items-center justify-end gap-3 border-b border-brand-border-subtle bg-brand-bg/90 backdrop-blur px-6 sticky top-0 z-40">
      {user ? (
        <AccountMenu user={user} />
      ) : (
        <Link to="/login" state={{ from: location.pathname }} className={cn(buttonVariants({ className: 'text-sm px-4 py-2' }))}>
          Conectar wallet
        </Link>
      )}
    </header>
  )
}
