/**
 * DEV-ONLY floating panel on the trade page: shows the viewer's role and
 * the escrow status, and plays the counterparty's next step, since the
 * PM is only ever one of the two parties.
 */
import { useEffect, useState } from 'react'
import { toast } from '../components/ui/toast'
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
      const { label, live } = simulateCounterparty(tradeId)
      toast.success(`Simulado: ${label}`)
      if (!live) refreshTradePage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na simulação')
    }
  }

  if (!tradeId) return null

  return (
    // In the page flow under the demo banner (not floating), collapsed by default: it never covers page content.
    <details className="border-b border-brand-border bg-brand-surface text-brand-text">
      <summary className="cursor-pointer select-none px-4 min-h-[44px] flex items-center text-sm font-semibold">Controles da demonstração</summary>
      <div className="px-4 pb-3 space-y-2 text-sm max-w-md">
        {view ? (
          <>
            <p>{ROLE_LABEL[view.role]}</p>
            <p className="flex items-center gap-2">
              <span className="text-brand-text-secondary">Escrow:</span>
              {view.escrowStatus ? <EscrowStatusBadge status={view.escrowStatus} /> : <span>ainda não criado</span>}
            </p>
            <Button onClick={simulate} disabled={!view.nextCounterpartyStep} className="w-full min-h-[44px] whitespace-normal">
              Simular próximo passo da outra parte
            </Button>
            <p className="text-xs text-brand-text-secondary">
              {view.nextCounterpartyStep ? `Próximo passo: ${view.nextCounterpartyStep.toLowerCase()}.` : 'Nenhuma ação pendente da outra parte agora.'}
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
