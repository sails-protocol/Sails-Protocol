import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { BottomNav } from './BottomNav'
import { ThemeToggle } from '../ui/ThemeToggle'
import { AccountMenu } from './AccountMenu'
import { OnboardingTour } from '../onboarding/OnboardingTour'
import { useAuth } from '../../context/AuthContext'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { HelpCircle } from 'lucide-react'
import { hasSeenOnboarding, markOnboardingSeen } from '../../lib/onboarding'

/** What Layout hands its pages via `useOutletContext` (Configurações' "Rever tour"). */
export interface LayoutOutletContext {
  replayTour: () => void
}

export function Layout() {
  // Real bug found in a cold-start UX walkthrough: on mobile, TopNav
  // (the only place login/wallet state was shown) is hidden entirely,
  // and this bar showed nothing about it — a first-time mobile user had
  // no way to tell whether they were connected without opening Perfil.
  // Mirrors TopNav's own avatar+name / "Conectar" pattern so the same
  // signal exists on both breakpoints.
  const { user } = useAuth()
  const location = useLocation()

  // First-time onboarding (2026-08-04) — owned here rather than inside
  // OnboardingTour itself, since Layout already knows `user` and wraps
  // every authenticated route. Fires once per browser on the first
  // render where a session exists and the flag hasn't been set yet —
  // not tied to the login action itself, so a session restored on page
  // load (AuthContext's own silent re-authenticate effect) triggers it
  // exactly the same as a fresh "Conectar wallet" click would.
  const [tourOpen, setTourOpen] = useState(false)
  useEffect(() => {
    if (user && !hasSeenOnboarding()) setTourOpen(true)
  }, [user])

  const closeTour = (open: boolean) => {
    setTourOpen(open)
    if (!open) markOnboardingSeen()
  }

  return (
    // UI-FOUNDATION-1 — hybrid sidebar + topbar shell
    // (docs/SAILS_MARKET_DESIGN_DIRECTION.md §7a's recommended option):
    // Sidebar is a fixed-height flex sibling (own `h-screen sticky`),
    // not part of the scrolling document — the row layout below just
    // reserves its width. Mobile is completely untouched: same header +
    // BottomNav as before, `md:hidden`-gated exactly as they already were.
    <div className="min-h-screen bg-brand-bg md:flex">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        {/* Mobile-only bar — desktop nav now lives in Sidebar/Topbar;
            mobile needs its own since BottomNav is reserved for primary
            navigation. Theme and "Rever tour" stay here on mobile until
            the mobile lot; on desktop they live in Configurações. */}
        <header className="md:hidden h-14 flex items-center justify-between px-4 border-b border-brand-border-subtle sticky top-0 z-40 bg-brand-bg/90 backdrop-blur">
          <Link to="/" className="font-display font-semibold text-brand-text tracking-tight">
            Sails <span className="text-brand-orange-accent">Market</span>
          </Link>
          <div className="flex items-center gap-5">
            {user && (
              <button
                type="button"
                onClick={() => setTourOpen(true)}
                title="Rever tour de boas-vindas"
                aria-label="Rever tour de boas-vindas"
                className="p-3.5 -m-3.5 text-brand-text-secondary hover:text-brand-text"
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            )}
            <ThemeToggle />
            {user ? (
              <AccountMenu user={user} compact />
            ) : (
              <Link to="/login" state={{ from: location.pathname }} className={cn(buttonVariants({ className: 'text-xs px-3 py-1.5' }))}>
                Conectar wallet
              </Link>
            )}
          </div>
        </header>
        {/* UI-FOUNDATION-1 — max-w-6xl -> max-w-7xl: the sidebar now
            reserves its own width (Sidebar.tsx), so the old cap left a
            visibly asymmetric empty band on the right at wide desktop
            widths once content had a nav column beside it instead of
            spanning edge-to-edge. A modest widen, not full-bleed —
            dense market/table content still benefits from a line-length
            cap, just a less conservative one now that a sidebar exists. */}
        <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 pb-20 md:pb-8">
          <Outlet context={{ replayTour: () => setTourOpen(true) } satisfies LayoutOutletContext} />
        </main>
      </div>
      <BottomNav />
      <OnboardingTour open={tourOpen} onOpenChange={closeTour} />
    </div>
  )
}
