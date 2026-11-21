import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import { AssetBadge, TradeStatusBadge } from '../components/ui/StatusBadges'
import { formatUsd, formatAmount, formatDateTime } from '../lib/format'
import { Card } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { badgeVariants } from '../components/ui/badge'
import { cn } from '../lib/utils'
import type { TradeStatus } from '../types'

const FILTERS: { value: TradeStatus | 'Todos'; label: string }[] = [
  { value: 'Todos', label: 'Todos' },
  { value: 'COMPLETED', label: 'Concluído' },
  { value: 'DISPUTED', label: 'Em disputa' },
  { value: 'CANCELLED', label: 'Cancelado' },
]

// Real getTrades() (openp2p.ts's own comment: "Fase 2 addition ... no
// such endpoint existed before" — this page used MOCK_TRADE_HISTORY
// until 2026-08-02, same gap ActiveTrades.tsx already closed for the
// in-flight statuses). DISPUTED intentionally shows in both pages —
// see ActiveTrades.tsx's own comment on why that's not a bug.
const HISTORY_STATUSES: ReadonlyArray<TradeStatus> = ['COMPLETED', 'DISPUTED', 'CANCELLED']

export function TradeHistory() {
  const { user, loading: authLoading } = useAuth()
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TradeStatus | 'Todos'>('Todos')

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
        setTrades(page.trades.filter((t) => HISTORY_STATUSES.includes(t.status)))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Falha ao carregar histórico')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(load, [user])

  const filtered = useMemo(
    () => trades.filter((t) => filter === 'Todos' || t.status === filter),
    [trades, filter]
  )

  // The SDK exposes totalUsd; no FX conversion is available here.
  const totalVolume = trades.reduce((sum, t) => sum + Number(t.totalUsd), 0)
  const completed = trades.filter((t) => t.status === 'COMPLETED').length
  const disputeRate = trades.length === 0 ? 0 : Math.round((trades.filter((t) => t.status === 'DISPUTED').length / trades.length) * 100)

  if (authLoading || loading) {
    return <div className="text-center py-16 text-brand-text-muted">Carregando histórico...</div>
  }

  if (!user) {
    return (
      <div className="text-center py-16">
        <p className="text-brand-text-secondary">Conecte sua carteira para ver seu histórico de trades.</p>
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
      <h1 className="text-2xl font-display font-bold tracking-tight text-brand-text">Histórico de Trades</h1>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <SummaryStat value={formatUsd(totalVolume)} label="Volume total (USD)" />
        <SummaryStat value={completed} label="Concluídos" />
        <SummaryStat value={`${disputeRate}%`} label="Taxa de disputa" />
      </div>

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(badgeVariants({ variant: filter === f.value ? 'default' : 'secondary' }), 'rounded-full px-3 py-1')}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {filtered.map((t) => (
          <Card key={t.id} className="p-4 flex flex-col md:flex-row md:items-center gap-2">
            <div className="flex items-center gap-2">
              <AssetBadge asset={t.asset} />
              <span className="font-medium text-sm text-brand-text">{formatAmount(Number(t.amount))}</span>
            </div>
            <div className="flex items-center gap-2 md:ml-4">
              <span className={`text-xs px-2 py-0.5 rounded-full ${t.buyerId === user.id ? 'bg-blue-500/10 text-blue-500' : 'bg-green-500/10 text-green-500'}`}>
                {t.buyerId === user.id ? 'Comprador' : 'Vendedor'}
              </span>
              <span className="text-xs text-brand-text-muted">{formatDateTime(t.createdAt)}</span>
            </div>
            <div className="md:ml-auto flex items-center gap-3">
              <span className="font-bold text-brand-text">{formatUsd(Number(t.totalUsd))} USD</span>
              <TradeStatusBadge status={t.status} />
              <Link to={`/trade/${t.id}`} className="text-xs text-brand-text-muted hover:text-brand-text">Ver Trade</Link>
            </div>
          </Card>
        ))}
        {filtered.length === 0 && <p className="text-center text-brand-text-muted py-10">Nenhum trade encontrado.</p>}
      </div>
    </div>
  )
}

function SummaryStat({ value, label }: { value: string | number; label: string }) {
  return (
    <Card className="p-3 text-center">
      <div className="text-lg font-display font-bold text-brand-text">{value}</div>
      <div className="text-xs text-brand-text-muted">{label}</div>
    </Card>
  )
}
