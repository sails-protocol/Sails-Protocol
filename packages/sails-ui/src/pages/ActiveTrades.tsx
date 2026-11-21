import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { ChevronRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import { errorMessage } from '../lib/errors'
import { formatAmount, formatDateTime, formatUsd } from '../lib/format'
import { ASSET_SHORT_LABELS } from '../lib/labels'
import { tradeNextStep, type TradeNextStep } from '../lib/tradeNextStep'
import { TradeStatusBadge } from '../components/ui/StatusBadges'
import { ListSkeleton } from '../components/ui/skeleton'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { cn } from '../lib/utils'
import type { EscrowStatus } from '../types'

// Trades still awaiting resolution from this trader's own point of view —
// COMPLETED/CANCELLED already have a home in TradeHistory.tsx. DISPUTED
// stays here (not "closed" from the trader's perspective, even though
// TradeHistory.tsx's own filter list also surfaces it there).
const ACTIVE_STATUSES: ReadonlyArray<Trade['status']> = ['PENDING', 'ACTIVE', 'DISPUTED']

interface Row {
  trade: Trade
  isBuyer: boolean
  next: TradeNextStep | null
}

// Desktop column template, shared by the header and every row so they align.
const COLS = 'md:grid md:grid-cols-[10rem_6.5rem_7.5rem_minmax(0,1fr)_7rem_1rem] md:items-center md:gap-4'

// GET /v1/openp2p/trades carries no escrow status, so each active trade's
// escrow is read with settlement.get() (the same per-row read Disputes.tsx
// and Trade.tsx already make; active trades are few). A failed read leaves
// that row without a next step instead of guessing one. The list carries no
// counterparty name either (only ids), so there is no counterparty column.
export function ActiveTrades() {
  const { user, loading: authLoading } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      .then(async (page) => {
        const active = page.trades.filter((t) => ACTIVE_STATUSES.includes(t.status))
        const statuses = await Promise.all(
          active.map((t) =>
            t.escrowId
              ? sailsClient.settlement.get(t.escrowId).then((e) => e.status as EscrowStatus, () => null)
              : Promise.resolve(undefined)
          )
        )
        if (cancelled) return
        const next = active.map((trade, i) => {
          const isBuyer = trade.buyerId === user.id
          return { trade, isBuyer, next: tradeNextStep(statuses[i], { isBuyer, isSeller: trade.sellerId === user.id }) }
        })
        // "Sua vez" first, then most recently updated.
        next.sort((a, b) => Number(!!b.next?.yourTurn) - Number(!!a.next?.yourTurn) || b.trade.updatedAt.localeCompare(a.trade.updatedAt))
        setRows(next)
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Falha ao carregar trades'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(load, [user])

  if (!authLoading && !user) {
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
        <p className="text-red-700 dark:text-red-300 text-sm">{error}</p>
        <Button variant="outline" onClick={load} className="mt-3 min-h-11 md:min-h-9 px-4 text-sm">Tentar novamente</Button>
      </div>
    )
  }

  const yourTurnCount = rows.filter((r) => r.next?.yourTurn).length

  return (
    <div>
      <h1 className="text-page-title">Trades Ativos</h1>
      {!loading && rows.length > 0 && (
        <p className="text-metadata mt-1">
          {rows.length} {rows.length === 1 ? 'trade em andamento' : 'trades em andamento'}
          {yourTurnCount > 0 && ` · ${yourTurnCount} ${yourTurnCount === 1 ? 'aguarda' : 'aguardam'} você`}
        </p>
      )}

      {authLoading || loading ? (
        <Card className="mt-4 overflow-hidden border-brand-border-subtle bg-brand-surface">
          <ListSkeleton label="Carregando trades ativos" rows={3} rowClassName="h-[6.125rem] md:h-[3.75rem]" />
        </Card>
      ) : rows.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-brand-border-subtle bg-brand-surface px-6 py-12 text-center">
          <p className="text-section-title">Nenhum trade ativo</p>
          <p className="text-metadata max-w-xs">Quando você iniciar um trade a partir de uma oferta, ele aparece aqui com o próximo passo.</p>
          <Link to="/" className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Explorar Market</Link>
        </div>
      ) : (
        <Card className="mt-4 overflow-hidden border-brand-border-subtle bg-brand-surface">
          <div aria-hidden="true" className={cn('text-label hidden px-4 py-2 border-b border-brand-border-subtle', COLS)}>
            <span>Valor</span>
            <span>Papel</span>
            <span>Status</span>
            <span>Próxima ação</span>
            <span className="text-right">Atualizado</span>
            <span />
          </div>
          <ul>
            {rows.map(({ trade: t, isBuyer, next }) => (
              <li key={t.id} className="border-b border-brand-border-subtle last:border-b-0">
                <Link
                  to={`/trade/${t.id}`}
                  className={cn('flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', COLS)}
                >
                  <span className="flex items-center justify-between gap-3 md:block">
                    <span className="min-w-0">
                      <span className="money block text-brand-text">{formatAmount(Number(t.amount))} {ASSET_SHORT_LABELS[t.asset]}</span>
                      <span className="hidden md:block text-xs text-brand-text-muted tabular-nums">{formatUsd(Number(t.totalUsd))} USD</span>
                    </span>
                    <span className="md:hidden"><TradeStatusBadge status={t.status} /></span>
                  </span>
                  <span className="hidden md:block text-sm text-brand-text-secondary">{isBuyer ? 'Comprador' : 'Vendedor'}</span>
                  <span className="hidden md:block"><TradeStatusBadge status={t.status} /></span>
                  <span className={cn('text-sm md:truncate', next?.yourTurn ? 'font-medium text-brand-orange-accent' : 'text-brand-text-secondary')}>
                    {next ? next.text : 'Próxima ação não disponível'}
                  </span>
                  <span className="text-xs text-brand-text-muted tabular-nums md:text-right">
                    <span className="md:hidden">{isBuyer ? 'Comprador' : 'Vendedor'} · {formatUsd(Number(t.totalUsd))} USD · </span>
                    {formatDateTime(t.updatedAt)}
                  </span>
                  <ChevronRight className="hidden md:block h-4 w-4 text-brand-text-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
