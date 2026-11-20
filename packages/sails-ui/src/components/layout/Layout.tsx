import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { BottomNav } from './BottomNav'
import { AccountMenu } from './AccountMenu'
import { OnboardingTour } from '../onboarding/OnboardingTour'
import { useAuth } from '../../context/AuthContext'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { hasSeenOnboarding, markOnboardingSeen } from '../../lib/onboarding'
import { SailsLogo } from '../brand/SailsLogo'
import { useNavPosition } from '../../lib/navPosition'

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
  // Settings → Aparência → "Posição do menu"; only changes the layout from 1024 px (lg).
  const [navPosition] = useNavPosition()
  const topNav = navPosition === 'top'

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
      {/* First stop for keyboard users in both menu positions: jump past the navigation. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-brand-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-text focus:shadow-elevation-2"
      >
        Pular para o conteúdo
      </a>
      <Sidebar hideFromLg={topNav} />
      <div className="flex-1 min-w-0">
        <Topbar withNav={topNav} />
        {/* Mobile-only bar: logo + session, nothing else. Theme and "Rever tour" live in Configurações at
            every width (reachable from BottomNav). */}
        <header className="md:hidden h-14 flex items-center justify-between gap-3 px-4 border-b border-brand-border-subtle sticky top-0 z-40 bg-brand-bg/90 backdrop-blur">
          <Link to="/" aria-label="Sails Market, início" className="rounded-md">
            <SailsLogo size="sm" />
          </Link>
          {user ? (
            <AccountMenu user={user} compact />
          ) : (
            <Link to="/login" state={{ from: location.pathname }} className={cn(buttonVariants({ size: 'sm', className: 'min-h-11 px-3' }))}>
              Conectar wallet
            </Link>
          )}
        </header>
        {/* UI-FOUNDATION-1 — max-w-6xl -> max-w-7xl: the sidebar now
            reserves its own width (Sidebar.tsx), so the old cap left a
            visibly asymmetric empty band on the right at wide desktop
            widths once content had a nav column beside it instead of
            spanning edge-to-edge. A modest widen, not full-bleed —
            dense market/table content still benefits from a line-length
            cap, just a less conservative one now that a sidebar exists. */}
        <main id="main-content" tabIndex={-1} className="max-w-7xl mx-auto px-4 md:px-6 xl:px-8 py-6 pb-20 md:pb-8">
          <Outlet context={{ replayTour: () => setTourOpen(true) } satisfies LayoutOutletContext} />
        </main>
      </div>
      <BottomNav />
      <OnboardingTour open={tourOpen} onOpenChange={closeTour} />
    </div>
  )
}
