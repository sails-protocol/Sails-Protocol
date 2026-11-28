/**
 * DEV-ONLY floating panel on the trade page: shows the viewer's role and
 * the escrow status, and plays the counterparty's next step, since the
 * PM is only ever one of the two parties.
 */
import { useEffect, useState } from 'react'
import { toast } from '../components/ui/toast'
import { Button } from '../components/ui/button'
import { EscrowStatusBadge } from '../components/ui/StatusBadges'
import { firstActiveOwnOffer, REFRESH_TRADE_ID, resetDemoAndReload, simulateCounterparty, simulateIncomingTrade, viewTrade, type DemoTradeView } from './demoBackend'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { useT, type MessageKey } from '../i18n'

const ROLE_LABEL: Record<DemoTradeView['role'], MessageKey> = {
  buyer: 'shell.demo.role.buyer',
  seller: 'shell.demo.role.seller',
  none: 'shell.demo.role.none',
  'signed-out': 'shell.demo.role.signedOut',
}

// Trade.tsx refetches only when its route param changes: hop through a
// placeholder id and back so it reloads the state the simulation changed.
function refreshTradePage() {
  const real = window.location.pathname + window.location.search
  const go = (url: string) => {
    window.history.replaceState(window.history.state, '', url)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }
  go(`/trade/${REFRESH_TRADE_ID}`)
  setTimeout(() => go(real), 50)
}

export function DemoControls() {
  const t = useT()
  const [path, setPath] = useState(window.location.pathname)
  const [, setTick] = useState(0)
  // shortcut: polls the URL and demo state (separate React root, no router access); fine for a dev-only tool.
  useEffect(() => {
    const id = setInterval(() => { setPath(window.location.pathname); setTick((n) => n + 1) }, 500)
    return () => clearInterval(id)
  }, [])

  const tradeId = /^\/trade\/([^/]+)$/.exec(path)?.[1]
  const view = tradeId && tradeId !== REFRESH_TRADE_ID ? viewTrade(tradeId) : null

  const simulate = () => {
    if (!tradeId) return
    try {
      const { label, live } = simulateCounterparty(tradeId)
      toast.success(t('shell.demo.simulated', { label }))
      if (!live) refreshTradePage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('shell.demo.simulateFailed'))
    }
  }

  // A fictional counterparty opens a trade on your first active offer, so the seller journey can be repeated.
  const ownOffer = firstActiveOwnOffer()
  const newTrade = () => {
    try {
      if (!ownOffer) throw new Error(t('shell.demo.noActiveOffer'))
      const id = simulateIncomingTrade(ownOffer)
      toast.success(t('trades.offers.simulatedTrade'))
      window.history.pushState(null, '', `/trade/${id}`)
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('shell.demo.simulateFailed'))
    }
  }
  const newTradeButton = (
    <Button variant="secondary" onClick={newTrade} disabled={!ownOffer} className="w-full min-h-[44px] whitespace-normal">
      {t('trades.offers.simulateTrade')}
    </Button>
  )

  // Shown on a trade and on "Minhas ofertas" (where a new demo trade starts).
  if (!tradeId && path !== TRADES_ROUTES.offers) return null

  return (
    // In the page flow under the demo banner (not floating), collapsed by default: it never covers page content.
    <details className="border-b border-brand-border bg-brand-surface text-brand-text">
      <summary className="cursor-pointer select-none px-4 min-h-[44px] flex items-center text-sm font-semibold">{t('shell.demo.controls')}</summary>
      <div className="px-4 pb-3 space-y-2 text-sm max-w-md">
        {!tradeId ? null : view ? (
          <>
            <p>{t(ROLE_LABEL[view.role])}</p>
            <p className="flex items-center gap-2">
              <span className="text-brand-text-secondary">{t('shell.demo.escrowLabel')}</span>
              {view.escrowStatus ? <EscrowStatusBadge status={view.escrowStatus} /> : <span>{t('shell.demo.escrowNotCreated')}</span>}
            </p>
            <Button variant="secondary" onClick={simulate} disabled={!view.nextCounterpartyStep} className="w-full min-h-[44px] whitespace-normal">
              {t('shell.demo.simulate')}
            </Button>
            <p className="text-xs text-brand-text-secondary">
              {view.nextCounterpartyStep ? t('shell.demo.nextStep', { step: view.nextCounterpartyStep }) : t('shell.demo.noPending')}
            </p>
          </>
        ) : (
          <p className="text-brand-text-secondary">{t('shell.demo.loadingTrade')}</p>
        )}
        {newTradeButton}
        <Button variant="outline" onClick={resetDemoAndReload} className="w-full min-h-[44px]">{t('shell.demo.resetDemo')}</Button>
      </div>
    </details>
  )
}
