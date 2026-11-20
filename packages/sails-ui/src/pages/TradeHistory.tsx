import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { ChevronRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import { errorMessage } from '../lib/errors'
import { TradeStatusBadge } from '../components/ui/StatusBadges'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { ListSkeleton } from '../components/ui/skeleton'
import { formatUsd, formatAmount, formatDateTime } from '../lib/format'
import { ASSET_SHORT_LABELS } from '../lib/labels'
import { ACCOUNT_DISPUTE_RATE_DEFINITION, formatAccountDisputeRate } from '../lib/reputation'
import { Card } from '../components/ui/card'
import { Button, buttonVariants } from '../components/ui/button'
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

// Desktop column template, shared by the header and every row so they align.
const COLS = 'md:grid md:grid-cols-[minmax(0,1fr)_6.5rem_8rem_8rem_7rem_1rem] md:items-center md:gap-4'

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
        setError(errorMessage(err, 'Falha ao carregar histórico'))
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

  if (!authLoading && !user) {
    return (
      <div className="text-center py-16">
        <p className="text-brand-text-secondary">Conecte sua wallet para ver seu histórico de trades.</p>
        <Link to="/login" className="text-sm text-brand-orange-accent underline mt-2 inline-block">Conectar</Link>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-red-700 dark:text-red-300 text-sm">{error}</p>
        <Button variant="outline" onClick={load} className="mt-3 min-h-11 md:min-h-9 px-4 text-sm">Tentar novamente</Button>
      </div>
    )
  }

  const busy = authLoading || loading || !user
  // The SDK exposes totalUsd; no FX conversion is available here.
  const totalVolume = trades.reduce((sum, t) => sum + Number(t.totalUsd), 0)
  const completed = trades.filter((t) => t.status === 'COMPLETED').length

  return (
    <div>
      <h1 className="text-page-title">Meus Trades</h1>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <SummaryStat value={busy ? '—' : formatUsd(totalVolume)} label="Volume (USD)" />
        <SummaryStat value={busy ? '—' : completed} label="Concluídos" />
        <SummaryStat value={busy || !user ? '—' : formatAccountDisputeRate(user)} label="Taxa de disputa" info={ACCOUNT_DISPUTE_RATE_DEFINITION} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por status">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(badgeVariants({ variant: filter === f.value ? 'default' : 'secondary' }), 'rounded-full px-3 min-h-11 md:min-h-8')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {busy ? (
        <Card className="mt-4 overflow-hidden border-brand-border-subtle bg-brand-surface">
          <ListSkeleton label="Carregando histórico" rows={4} rowClassName="h-[4.4375rem] md:h-[3.125rem]" />
        </Card>
      ) : trades.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-brand-border-subtle bg-brand-surface px-6 py-12 text-center">
          <p className="text-section-title">Nenhum trade no histórico ainda</p>
          <p className="text-metadata max-w-xs">Trades concluídos, cancelados ou em disputa aparecem aqui.</p>
          <Link to="/" className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Explorar Market</Link>
        </div>
      ) : (
        <Card className="mt-4 overflow-hidden border-brand-border-subtle bg-brand-surface">
          <div aria-hidden="true" className={cn('text-label hidden px-4 py-2 border-b border-brand-border-subtle', COLS)}>
            <span>Valor</span>
            <span>Papel</span>
            <span className="text-right">Total</span>
            <span>Status</span>
            <span className="text-right">Data</span>
            <span />
          </div>
          {filtered.length === 0 ? (
            <p className="text-center text-metadata py-10">Nenhum trade com este status.</p>
          ) : (
            <ul>
              {filtered.map((t) => (
                <li key={t.id} className="border-b border-brand-border-subtle last:border-b-0">
                  <Link
                    to={`/trade/${t.id}`}
                    className={cn('flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', COLS)}
                  >
                    <span className="flex items-center justify-between gap-3 md:block">
                      <span className="money text-brand-text">{formatAmount(Number(t.amount))} {ASSET_SHORT_LABELS[t.asset]}</span>
                      <span className="md:hidden"><TradeStatusBadge status={t.status} /></span>
                    </span>
                    <span className="hidden md:block text-sm text-brand-text-secondary">{t.buyerId === user?.id ? 'Comprador' : 'Vendedor'}</span>
                    <span className="hidden md:block money text-right text-brand-text">{formatUsd(Number(t.totalUsd))}</span>
                    <span className="hidden md:block"><TradeStatusBadge status={t.status} /></span>
                    <span className="text-xs text-brand-text-muted tabular-nums md:text-right">
                      <span className="md:hidden">{t.buyerId === user?.id ? 'Comprador' : 'Vendedor'} · {formatUsd(Number(t.totalUsd))} USD · </span>
                      {formatDateTime(t.createdAt)}
                    </span>
                    <ChevronRight className="hidden md:block h-4 w-4 text-brand-text-muted" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

function SummaryStat({ value, label, info }: { value: string | number; label: string; info?: string }) {
  return (
    <Card className="p-3 text-center">
      <div className="text-lg font-bold text-brand-text tabular-nums">{value}</div>
      <div className="text-xs text-brand-text-muted flex items-center justify-center gap-1">
        {label}
        {info && <InfoTooltip text={info} />}
      </div>
    </Card>
  )
}
