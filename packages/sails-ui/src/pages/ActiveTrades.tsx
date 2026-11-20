import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import { TradeCard } from '../components/trade/TradeCard'
import { Button } from '../components/ui/button'

// Trades still awaiting resolution from this trader's own point of view —
// COMPLETED/CANCELLED already have a home in TradeHistory.tsx. DISPUTED
// stays here (not "closed" from the trader's perspective, even though
// TradeHistory.tsx's own filter list also surfaces it there).
const ACTIVE_STATUSES: ReadonlyArray<Trade['status']> = ['PENDING', 'ACTIVE', 'DISPUTED']

// GET /v1/openp2p/trades (openp2p.ts's own getTrades() comment: "Fase 2
// addition ... no such endpoint existed before" — sails-ui had no page
// consuming it yet; TradeHistory.tsx closed that same gap for the
// COMPLETED/DISPUTED/CANCELLED statuses, 2026-08-02).
// `onRelease` is intentionally never passed to TradeCard below — the real
// release flow (MULTISIG/LIGHTNING_HODL signing) only exists on Trade.tsx,
// and rendering a `<button>` inside this page's own `<Link>` per row would
// be a real button-in-anchor invalid-HTML bug, the same class this
// codebase already hit once (OfferCard.tsx's own comment on that).
export function ActiveTrades() {
  const { user, loading: authLoading } = useAuth()
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Extracted so the error state's "Tentar novamente" button below can
  // re-run the same fetch instead of stranding the user with no recovery
  // path but a full page reload.
  const load = () => {
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    sailsClient.openp2p
      .getTrades({ limit: 50 })
      .then((page) => {
        if (cancelled) return
        setTrades(page.trades.filter((t) => ACTIVE_STATUSES.includes(t.status)))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Falha ao carregar trades')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(load, [user])

  if (authLoading || loading) {
    return <div className="text-center py-16 text-brand-text-muted">Carregando trades ativos...</div>
  }

  if (!user) {
    return (
      <div className="text-center py-16">
        <p className="text-brand-text-secondary">Conecte sua wallet para ver seus trades ativos.</p>
        <Link to="/login" className="text-sm text-brand-orange-accent underline mt-2 inline-block">Conectar</Link>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-red-500 text-sm">{error}</p>
        <Button variant="outline" onClick={load} className="mt-3 text-xs px-3 py-1.5">Tentar novamente</Button>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-display font-bold tracking-tight text-brand-text">Trades Ativos</h1>

      {trades.length === 0 ? (
        <p className="text-center text-brand-text-muted py-10">Nenhum trade ativo no momento.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {trades.map((t) => (
            <Link key={t.id} to={`/trade/${t.id}`} className="block">
              <TradeCard trade={t} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
