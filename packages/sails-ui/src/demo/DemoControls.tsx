/**
 * DEV-ONLY floating panel on the trade page: shows the viewer's role and
 * the escrow status, and plays the counterparty's next step, since the
 * PM is only ever one of the two parties.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { EscrowStatusBadge } from '../components/ui/StatusBadges'
import { REFRESH_TRADE_ID, resetDemoAndReload, simulateCounterparty, viewTrade, type DemoTradeView } from './demoBackend'

const ROLE_LABEL: Record<DemoTradeView['role'], string> = {
  buyer: 'Você é o comprador',
  seller: 'Você é o vendedor',
  none: 'Você não é parte deste trade',
  'signed-out': 'Conecte sua wallet',
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
  const [path, setPath] = useState(window.location.pathname)
  const [, setTick] = useState(0)
  // shortcut: polls the URL and demo state (separate React root, no router access); fine for a dev-only tool.
  useEffect(() => {
    const t = setInterval(() => { setPath(window.location.pathname); setTick((n) => n + 1) }, 500)
    return () => clearInterval(t)
  }, [])

  const tradeId = /^\/trade\/([^/]+)$/.exec(path)?.[1]
  const view = tradeId && tradeId !== REFRESH_TRADE_ID ? viewTrade(tradeId) : null

  const simulate = () => {
    if (!tradeId) return
    try {
      toast.success(`Contraparte simulada: ${simulateCounterparty(tradeId)}`)
      refreshTradePage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na simulação')
    }
  }

  if (!tradeId) return null

  return (
    <details open className="fixed z-50 left-4 bottom-20 md:bottom-4 w-[min(300px,calc(100vw-2rem))] rounded-lg border border-brand-border bg-brand-surface text-brand-text shadow-lg">
      <summary className="cursor-pointer select-none px-3 min-h-[44px] flex items-center text-sm font-semibold">Controles da demonstração</summary>
      <div className="px-3 pb-3 space-y-2 text-sm">
        {view ? (
          <>
            <p>{ROLE_LABEL[view.role]}</p>
            <p className="flex items-center gap-2">
              <span className="text-brand-text-secondary">Escrow:</span>
              {view.escrowStatus ? <EscrowStatusBadge status={view.escrowStatus} /> : <span>ainda não criado</span>}
            </p>
            <Button onClick={simulate} disabled={!view.nextCounterpartyStep} className="w-full min-h-[44px] whitespace-normal">
              Simular ação da contraparte
            </Button>
            <p className="text-xs text-brand-text-secondary">
              {view.nextCounterpartyStep ? `Próximo passo: ${view.nextCounterpartyStep.toLowerCase()}.` : 'Nenhuma ação pendente da contraparte agora.'}
            </p>
          </>
        ) : (
          <p className="text-brand-text-secondary">Carregando trade...</p>
        )}
        <Button variant="outline" onClick={resetDemoAndReload} className="w-full min-h-[44px]">Reiniciar demonstração</Button>
      </div>
    </details>
  )
}
