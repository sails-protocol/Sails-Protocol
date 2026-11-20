import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { ChevronRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import { errorMessage } from '../lib/errors'
import { TradeStatusBadge } from '../components/ui/StatusBadges'
import { ListSkeleton } from '../components/ui/skeleton'
import { formatUsd, formatAmount, formatDateTime } from '../lib/format'
import { ASSET_SHORT_LABELS } from '../lib/labels'
import { ACCOUNT_DISPUTE_RATE_DEFINITION, formatAccountDisputeRate } from '../lib/reputation'
import { Card } from '../components/ui/card'
import { Button, buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TradesTabs } from '../components/layout/TradesTabs'
import { StateBlock } from '../components/ui/StateBlock'
import { StatStrip } from '../components/ui/StatStrip'
import { SegmentedControl } from '../components/ui/SegmentedControl'
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
// Same columns as ActiveTrades (Valor | Papel | Status | 1fr | Data | ›), so the two tabs line up.
const COLS = 'lg:grid lg:grid-cols-[10rem_6.5rem_8rem_minmax(0,1fr)_7rem_1rem] lg:items-center lg:gap-4'

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

  const signedOut = !authLoading && !user
  const busy = authLoading || loading || !user
  // The SDK exposes totalUsd; no FX conversion is available here.
  const totalVolume = trades.reduce((sum, t) => sum + Number(t.totalUsd), 0)
  const completed = trades.filter((t) => t.status === 'COMPLETED').length

  return (
    <Page>
      <PageHeader title="Trades">
        <TradesTabs />
      </PageHeader>

      {signedOut ? (
        <StateBlock
          kind="signedOut"
          title="Conecte sua wallet"
          description="Conecte sua wallet para ver seu histórico de trades."
          action={<Link to="/login" state={{ from: '/profile/history' }} className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Conectar wallet</Link>}
        />
      ) : error ? (
        <StateBlock
          kind="error"
          title="Não foi possível carregar o histórico"
          description={error}
          action={<Button variant="outline" onClick={load} className="min-h-11 md:min-h-9 px-4">Tentar novamente</Button>}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <StatStrip
              items={[
                { label: 'Volume (USD)', value: busy ? '—' : formatUsd(totalVolume) },
                { label: 'Concluídos', value: busy ? '—' : completed },
                { label: 'Taxa de disputa', value: busy || !user ? '—' : formatAccountDisputeRate(user), info: ACCOUNT_DISPUTE_RATE_DEFINITION },
              ]}
            />
            <SegmentedControl label="Filtrar por status" options={FILTERS} value={filter} onChange={setFilter} />
          </div>

          {busy ? (
            <Card className="mt-4 overflow-hidden">
              <ListSkeleton label="Carregando histórico" rows={4} rowClassName="h-[4.4375rem] lg:h-[3.125rem]" />
            </Card>
          ) : trades.length === 0 ? (
            <StateBlock
              kind="empty"
              className="mt-4"
              title="Nenhum trade no histórico ainda"
              description="Trades concluídos, cancelados ou em disputa aparecem aqui."
              action={<Link to="/" className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Explorar Market</Link>}
            />
          ) : (
            <Card className="mt-4 overflow-hidden">
              <div aria-hidden="true" className={cn('text-label hidden px-4 py-2.5 border-b border-brand-border-subtle', COLS)}>
                <span>Valor</span>
                <span>Papel</span>
                <span>Status</span>
                <span className="text-right">Total</span>
                <span className="text-right">Data</span>
                <span />
              </div>
              {filtered.length === 0 ? (
                <StateBlock bare kind="empty" title="Nenhum trade com este status" />
              ) : (
                <ul>
                  {filtered.map((t) => (
                    <li key={t.id} className="border-b border-brand-border-subtle last:border-b-0">
                      <Link
                        to={`/trade/${t.id}`}
                        className={cn('flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-brand-elevated focus-visible:-outline-offset-2', COLS)}
                      >
                        <span className="flex items-center justify-between gap-3 lg:block">
                          <span className="money text-brand-text">{formatAmount(Number(t.amount))} {ASSET_SHORT_LABELS[t.asset]}</span>
                          <span className="lg:hidden"><TradeStatusBadge status={t.status} /></span>
                        </span>
                        <span className="hidden lg:block text-sm text-brand-text-secondary">{t.buyerId === user?.id ? 'Comprador' : 'Vendedor'}</span>
                        <span className="hidden lg:block"><TradeStatusBadge status={t.status} /></span>
                        <span className="hidden lg:block text-sm text-right text-brand-text tabular-nums">{formatUsd(Number(t.totalUsd))}</span>
                        <span className="text-xs text-brand-text-muted tabular-nums lg:text-right">
                          <span className="lg:hidden">{t.buyerId === user?.id ? 'Comprador' : 'Vendedor'} · {formatUsd(Number(t.totalUsd))} USD · </span>
                          {formatDateTime(t.createdAt)}
                        </span>
                        <ChevronRight className="hidden lg:block h-4 w-4 text-brand-text-muted" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  )
}
