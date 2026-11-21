/**
 * Mission 3 Slice 1 (docs/PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md
 * §15) — closes P3-F08.1/F08.2 together. Mounted once, inside
 * <BrowserRouter> (App.tsx), so it has router context — AuthContext
 * itself sits OUTSIDE the router and can't call useNavigate()/useLocation()
 * directly, so this is the one place the "a session just went stale"
 * signal (AuthContext's own `sessionExpiry`) actually becomes a redirect.
 *
 * Deliberately reuses Login.tsx's EXISTING return-path convention
 * (`navigate('/login', { state: { from } })`, consumed by Login.tsx's own
 * post-login `navigate(state?.from ?? '/', ...)`) rather than inventing a
 * second one — OfferDetail.tsx already established this exact pattern for
 * the INITIAL auth gate; this is the same mechanism reused for a NEW
 * trigger (a forced mid-flow re-auth), not a new mechanism. See the design
 * doc's own §8 for why "return to the same URL" is sufficient trade-
 * context continuity here (Trade.tsx/OfferDetail.tsx/etc. all rebuild
 * their view from the URL param on mount) and what it deliberately does
 * NOT cover (in-memory draft state — disclosed there, not fixed here).
 *
 * Mission 3 R2 — AuthContext's own `sessionExpiry` is now set AT MOST
 * ONCE per real expiry episode, even when several requests sharing one
 * session independently 401 (`lib/sessionEpochGate.ts`'s own header has
 * the full mechanism) — this component no longer needs to defend against
 * receiving the SAME episode twice for that reason, but keeps the guard
 * below anyway (cheap, and correct regardless of upstream behavior) using
 * the real `episode` counter instead of a wall-clock timestamp.
 */
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from '../ui/toast'
import { useAuth } from '../../context/AuthContext'
import { t } from '../../i18n'

export function SessionExpiryRedirect() {
  const { sessionExpiry } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  // Guards against redirecting twice for the SAME expiry (e.g. a second
  // render before navigation commits) — compares the expiry's own
  // `episode` counter, not a boolean, so a genuinely NEW expiry later
  // still fires.
  const lastHandledEpisode = useRef<number | null>(null)

  useEffect(() => {
    if (!sessionExpiry || sessionExpiry.episode === lastHandledEpisode.current) return
    lastHandledEpisode.current = sessionExpiry.episode

    if (location.pathname === '/login') return // already there — nothing to redirect away from

    toast.error(t('auth.session.expired'))
    navigate('/login', { state: { from: sessionExpiry.path } })
    // Deliberately depends only on `sessionExpiry` — `navigate`/`location`
    // are read for their CURRENT value at the moment this fires, not
    // watched for changes (this must react to a NEW expiry, never to
    // ordinary navigation).
  }, [sessionExpiry])

  return null
}
