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
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TradesTabs } from '../components/layout/TradesTabs'
import { StateBlock } from '../components/ui/StateBlock'
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
// Same columns as TradeHistory (Valor | Papel | Status | 1fr | Data | ›), so the two tabs line up.
const COLS = 'lg:grid lg:grid-cols-[10rem_6.5rem_8rem_minmax(0,1fr)_7rem_1rem] lg:items-center lg:gap-4'

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

  const yourTurnCount = rows.filter((r) => r.next?.yourTurn).length
  const signedOut = !authLoading && !user
  const meta = !signedOut && !error && !loading && rows.length > 0
    ? `${rows.length} ${rows.length === 1 ? 'trade em andamento' : 'trades em andamento'}${yourTurnCount > 0 ? ` · ${yourTurnCount} ${yourTurnCount === 1 ? 'aguarda' : 'aguardam'} você` : ''}`
    : undefined

  return (
    <Page>
      <PageHeader title="Trades" meta={meta}>
        <TradesTabs />
      </PageHeader>

      {signedOut ? (
        <StateBlock
          kind="signedOut"
          title="Conecte sua wallet"
          description="Conecte sua wallet para ver seus trades ativos."
          action={<Link to="/login" state={{ from: '/profile/active' }} className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Conectar wallet</Link>}
        />
      ) : error ? (
        <StateBlock
          kind="error"
          title="Não foi possível carregar seus trades"
          description={error}
          action={<Button variant="outline" onClick={load} className="min-h-11 md:min-h-9 px-4">Tentar novamente</Button>}
        />
      ) : authLoading || loading ? (
        <Card className="overflow-hidden">
          <ListSkeleton label="Carregando trades ativos" rows={3} rowClassName="h-[6.125rem] lg:h-[3.75rem]" />
        </Card>
      ) : rows.length === 0 ? (
        <StateBlock
          kind="empty"
          title="Nenhum trade ativo"
          description="Quando você iniciar um trade a partir de uma oferta, ele aparece aqui com o próximo passo."
          action={<Link to="/" className={cn(buttonVariants({ className: 'min-h-11 md:min-h-10 px-4' }))}>Explorar Market</Link>}
        />
      ) : (
        <Card className="overflow-hidden">
          <div aria-hidden="true" className={cn('text-label hidden px-4 py-2.5 border-b border-brand-border-subtle', COLS)}>
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
                  className={cn('flex flex-col gap-1 px-4 py-3 transition-colors state-layer focus-visible:-outline-offset-2', COLS)}
                >
                  <span className="flex items-center justify-between gap-3 lg:block">
                    <span className="min-w-0">
                      <span className="money block text-brand-text">{formatAmount(Number(t.amount))} {ASSET_SHORT_LABELS[t.asset]}</span>
                      <span className="hidden lg:block text-xs text-brand-text-muted tabular-nums">{formatUsd(Number(t.totalUsd))} USD</span>
                    </span>
                    <span className="lg:hidden"><TradeStatusBadge status={t.status} /></span>
                  </span>
                  <span className="hidden lg:block text-sm text-brand-text-secondary">{isBuyer ? 'Comprador' : 'Vendedor'}</span>
                  <span className="hidden lg:block"><TradeStatusBadge status={t.status} /></span>
                  <span className={cn('text-sm', next?.yourTurn ? 'font-medium text-brand-orange-accent' : 'text-brand-text-secondary')}>
                    {next ? next.text : 'Próxima ação não disponível'}
                  </span>
                  <span className="text-xs text-brand-text-muted tabular-nums lg:text-right">
                    <span className="lg:hidden">{isBuyer ? 'Comprador' : 'Vendedor'} · {formatUsd(Number(t.totalUsd))} USD · </span>
                    {formatDateTime(t.updatedAt)}
                  </span>
                  <ChevronRight className="hidden lg:block h-4 w-4 text-brand-text-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  )
}
