import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/toast'
import { Layout } from './components/layout/Layout'
import { SessionExpiryRedirect } from './components/auth/SessionExpiryRedirect'
import { LEGACY_REDIRECTS, legacyRedirect, MARKETS_ROUTES, TRADES_ROUTES } from './components/layout/navMatch'

// Route-level code splitting (2026-08-11) — vite build's own warning
// (a single ~2.6MB chunk) was every page in one bundle regardless of
// which one a visitor actually loads first. Each page is a named
// export, not default, so `.then()` re-shapes it into what `lazy()`
// requires. `Login` stays a normal (non-lazy) import — it's the one
// page an unauthenticated first visit always needs immediately, so
// deferring it would just move the same waterfall one step earlier.
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
const Marketplace = lazy(() => import('./pages/Marketplace').then((m) => ({ default: m.Marketplace })))
const OfferDetail = lazy(() => import('./pages/OfferDetail').then((m) => ({ default: m.OfferDetail })))
const Trade = lazy(() => import('./pages/Trade').then((m) => ({ default: m.Trade })))
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })))
const PublishOffer = lazy(() => import('./pages/PublishOffer').then((m) => ({ default: m.PublishOffer })))
const TradeHistory = lazy(() => import('./pages/TradeHistory').then((m) => ({ default: m.TradeHistory })))
const ActiveTrades = lazy(() => import('./pages/ActiveTrades').then((m) => ({ default: m.ActiveTrades })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const Markets = lazy(() => import('./pages/Markets').then((m) => ({ default: m.Markets })))
const Disputes = lazy(() => import('./pages/Disputes').then((m) => ({ default: m.Disputes })))
const MyOffers = lazy(() => import('./pages/MyOffers').then((m) => ({ default: m.MyOffers })))
// Dev-only preview: import.meta.env.DEV is statically false in production builds, so Rollup drops this chunk.
const CurrentActionPreview = import.meta.env.DEV ? lazy(() => import('./pages/dev/CurrentActionPreview').then((m) => ({ default: m.CurrentActionPreview }))) : null
const SigningRequestPreview = import.meta.env.DEV ? lazy(() => import('./pages/dev/SigningRequestPreview').then((m) => ({ default: m.SigningRequestPreview }))) : null
const FundingInstructionPreview = import.meta.env.DEV ? lazy(() => import('./pages/dev/FundingInstructionPreview').then((m) => ({ default: m.FundingInstructionPreview }))) : null
const MarketContextPreview = import.meta.env.DEV ? lazy(() => import('./pages/dev/MarketContextPreview').then((m) => ({ default: m.MarketContextPreview }))) : null
const DesignSystemPreview = import.meta.env.DEV ? lazy(() => import('./pages/dev/DesignSystemPreview').then((m) => ({ default: m.DesignSystemPreview }))) : null

// Mobile: top, so a toast never covers the page's primary action or the bottom nav.
const MOBILE_QUERY = '(max-width: 767px)'
function ThemedToaster() {
  const { theme } = useTheme()
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return <Toaster position={mobile ? 'top-center' : 'bottom-right'} theme={theme} />
}

// Same loading copy/style Trade.tsx's own initial-load state already
// uses — one consistent "carregando" look across the app, not a new one
// invented just for route transitions.
function RouteFallback() {
  return <div className="text-center py-16 text-brand-text-muted">Carregando…</div>
}

// Old address -> its new home (navMatch.ts LEGACY_REDIRECTS), replacing the history entry and keeping
// query, hash and router state (e.g. Login's `from`).
function LegacyRedirect() {
  const location = useLocation()
  const to = legacyRedirect(location)
  return to ? <Navigate replace to={to} state={location.state} /> : <NotFound />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <BrowserRouter>
            <ThemedToaster />
            <SessionExpiryRedirect />
            <Routes>
              <Route element={<Layout />}>
                {/* Connect-wallet dialog over the Market: the app stays open without a session */}
                <Route path="/login" element={<><Suspense fallback={<RouteFallback />}><Marketplace /></Suspense><Login /></>} />
                <Route path="/" element={<Suspense fallback={<RouteFallback />}><Marketplace /></Suspense>} />
                <Route path="/offer/:id" element={<Suspense fallback={<RouteFallback />}><OfferDetail /></Suspense>} />
                <Route path="/trade/:id" element={<Suspense fallback={<RouteFallback />}><Trade /></Suspense>} />
                <Route path="/profile" element={<Suspense fallback={<RouteFallback />}><Profile /></Suspense>} />
                <Route path={TRADES_ROUTES.active} element={<Suspense fallback={<RouteFallback />}><ActiveTrades /></Suspense>} />
                <Route path={TRADES_ROUTES.history} element={<Suspense fallback={<RouteFallback />}><TradeHistory /></Suspense>} />
                <Route path={TRADES_ROUTES.offers} element={<Suspense fallback={<RouteFallback />}><MyOffers /></Suspense>} />
                <Route path={TRADES_ROUTES.newOffer} element={<Suspense fallback={<RouteFallback />}><PublishOffer /></Suspense>} />
                <Route path={TRADES_ROUTES.disputes} element={<Suspense fallback={<RouteFallback />}><Disputes /></Suspense>} />
                <Route path="/settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />
                {Object.values(MARKETS_ROUTES).map((path) => <Route key={path} path={path} element={<Suspense fallback={<RouteFallback />}><Markets /></Suspense>} />)}
                {Object.keys(LEGACY_REDIRECTS).map((from) => <Route key={from} path={from} element={<LegacyRedirect />} />)}
                {CurrentActionPreview && <Route path="/dev/current-action" element={<Suspense fallback={<RouteFallback />}><CurrentActionPreview /></Suspense>} />}
                {SigningRequestPreview && <Route path="/dev/signing-request" element={<Suspense fallback={<RouteFallback />}><SigningRequestPreview /></Suspense>} />}
                {FundingInstructionPreview && <Route path="/dev/funding-instruction" element={<Suspense fallback={<RouteFallback />}><FundingInstructionPreview /></Suspense>} />}
                {MarketContextPreview && <Route path="/dev/market-context" element={<Suspense fallback={<RouteFallback />}><MarketContextPreview /></Suspense>} />}
                {DesignSystemPreview && <Route path="/dev/design-system" element={<Suspense fallback={<RouteFallback />}><DesignSystemPreview /></Suspense>} />}
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
