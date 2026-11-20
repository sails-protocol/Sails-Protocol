import { Link, useLocation } from 'react-router'
import { useAuth } from '../../context/AuthContext'
import { AccountMenu } from './AccountMenu'
import { ThemeToggle } from '../ui/ThemeToggle'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { HelpCircle } from 'lucide-react'

/**
 * Desktop topbar (UI-FOUNDATION-1 — hybrid sidebar + topbar shell).
 * Session/identity/theme/help ONLY — product navigation now lives in
 * `Sidebar.tsx`, so this replaces `TopNav.tsx`'s combined role rather
 * than duplicating its nav links. No search or notifications entry:
 * neither has a real backend today (`docs/PROJECT_CONTEXT.md` §2E's
 * capability map — Notifications is Future/Planned, no system exists at
 * all) — adding either as a placeholder would present an unavailable
 * capability as available, exactly what `PRODUCT-IMPLEMENTATION-READINESS-1`
 * froze against.
 */
export function Topbar({ onReplayTour }: { onReplayTour: () => void }) {
  const { user } = useAuth()
  const location = useLocation()

  return (
    <header className="hidden md:flex h-14 items-center justify-end gap-3 border-b border-brand-border-subtle bg-brand-bg/90 backdrop-blur px-6 sticky top-0 z-40">
      {user && (
        <button
          type="button"
          onClick={onReplayTour}
          title="Rever tour de boas-vindas"
          aria-label="Rever tour de boas-vindas"
          className="p-2 -m-2 text-brand-text-secondary hover:text-brand-text"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      )}
      <ThemeToggle />

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
