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
import { accountDisputeRateDefinition, formatAccountDisputeRate } from '../lib/reputation'
import { Card } from '../components/ui/card'
import { Button, buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TradesTabs } from '../components/layout/TradesTabs'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { StateBlock } from '../components/ui/StateBlock'
import { TABLE_HEAD_ROW, TABLE_ROW, TABLE_ROW_INTERACTIVE } from '../components/ui/table'
import { StatStrip } from '../components/ui/StatStrip'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import type { TradeStatus } from '../types'
import { t } from '../i18n'

// A function, not a constant: the labels follow the interface language.
const filters = (): { value: TradeStatus | 'Todos'; label: string }[] => [
  { value: 'Todos', label: t('trades.filter.all') },
  { value: 'COMPLETED', label: t('trades.history.filter.completed') },
  { value: 'DISPUTED', label: t('trades.history.filter.disputed') },
  { value: 'CANCELLED', label: t('trades.history.filter.cancelled') },
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
        setError(errorMessage(err, t('trades.history.loadFailed')))
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
          title={t('trades.connectTitle')}
          description={t('trades.history.signedOutDescription')}
          action={<Link to="/login" state={{ from: TRADES_ROUTES.history }} className={cn(buttonVariants({ variant: 'secondary', className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('trades.connect')}</Link>}
        />
      ) : error ? (
        <StateBlock
          kind="error"
          title={t('trades.history.errorTitle')}
          description={error}
          action={<Button variant="outline" onClick={load} className="min-h-9 touch:min-h-11 px-4">{t('trades.retry')}</Button>}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <StatStrip
              items={[
                { label: t('trades.history.stat.volume'), value: busy ? '—' : formatUsd(totalVolume) },
                { label: t('trades.history.stat.completed'), value: busy ? '—' : completed },
                { label: t('trades.history.stat.disputeRate'), value: busy || !user ? '—' : formatAccountDisputeRate(user), info: accountDisputeRateDefinition() },
              ]}
            />
            <SegmentedControl label={t('trades.history.filterLabel')} options={filters()} value={filter} onChange={setFilter} />
          </div>

          {busy ? (
            <Card className="mt-4 overflow-hidden">
              <ListSkeleton label={t('trades.history.loading')} rows={4} rowClassName="h-[4.4375rem] lg:h-[3.125rem]" />
            </Card>
          ) : trades.length === 0 ? (
            <StateBlock
              kind="empty"
              className="mt-4"
              title={t('trades.history.emptyTitle')}
              description={t('trades.history.emptyDescription')}
              action={<Link to="/" className={cn(buttonVariants({ className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('trades.exploreMarket')}</Link>}
            />
          ) : (
            <Card className="mt-4 overflow-hidden">
              <div aria-hidden="true" className={cn(TABLE_HEAD_ROW, 'hidden', COLS)}>
                <span>{t('trades.col.amount')}</span>
                <span>{t('trades.col.role')}</span>
                <span>{t('trades.col.status')}</span>
                <span className="text-right">{t('trades.history.col.total')}</span>
                <span className="text-right">{t('trades.history.col.date')}</span>
                <span />
              </div>
              {filtered.length === 0 ? (
                <StateBlock bare kind="empty" title={t('trades.history.noneWithStatus')} />
              ) : (
                <ul>
                  {filtered.map((tr) => (
                    <li key={tr.id} className={TABLE_ROW}>
                      <Link
                        to={`/trade/${tr.id}`}
                        className={cn('flex flex-col gap-1 px-4 py-3', TABLE_ROW_INTERACTIVE, COLS)}
                      >
                        <span className="flex items-center justify-between gap-3 lg:block">
                          <span className="money text-brand-text">{formatAmount(Number(tr.amount))} {ASSET_SHORT_LABELS[tr.asset]}</span>
                          <span className="lg:hidden"><TradeStatusBadge status={tr.status} /></span>
                        </span>
                        <span className="hidden lg:block text-sm text-brand-text-secondary">{t(tr.buyerId === user?.id ? 'trades.role.buyer' : 'trades.role.seller')}</span>
                        <span className="hidden lg:block"><TradeStatusBadge status={tr.status} /></span>
                        <span className="hidden lg:block text-sm text-right text-brand-text tabular-nums">{formatUsd(Number(tr.totalUsd))}</span>
                        <span className="text-xs text-brand-text-muted tabular-nums lg:text-right">
                          <span className="lg:hidden">{t(tr.buyerId === user?.id ? 'trades.role.buyer' : 'trades.role.seller')} · {formatUsd(Number(tr.totalUsd))} USD · </span>
                          {formatDateTime(tr.createdAt)}
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
