import { Link } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { Plus, ChevronRight, MoreHorizontal } from 'lucide-react'
import { toast } from '../components/ui/toast'
import { useAuth } from '../context/AuthContext'
import { SideBadge, OfferStatusBadge, OFFER_STATUS_LABEL } from '../components/ui/StatusBadges'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { StateBlock } from '../components/ui/StateBlock'
import { TABLE_HEAD_ROW, TABLE_ROW } from '../components/ui/table'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { ListSkeleton } from '../components/ui/skeleton'
import { AssetNetworkLabel } from '../components/ui/AssetIcon'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TradesTabs } from '../components/layout/TradesTabs'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { cn } from '../lib/utils'
import { sailsClient } from '../lib/sailsClient'
import { formatAmount, formatDateTime } from '../lib/format'
import { ASSET_LABELS, ASSET_SHORT_LABELS } from '../lib/labels'
import { errorMessage } from '../lib/errors'
import { formatPrice } from '../lib/currency'
import type { Offer, OfferStatus, User } from '../types'
import { t } from '../i18n'

// Moved here from Profile.tsx unchanged (2026-11-20, DECISIONS.md "Reorganização pela visão do usuário"):
// "Minhas ofertas" is a Trades tab now; Perfil renders the same section, so nothing left either screen.

// Desktop columns for "Minhas ofertas", same table idiom as the Market: Lado | Ativo | Preço | Limites | Status | Criada em | Ações.
const OFFER_COLS = 'xl:grid xl:grid-cols-[5.5rem_minmax(0,1fr)_8rem_9rem_6.5rem_6.5rem_11rem] xl:gap-4 xl:flex-nowrap'

// Real, persisted Offer rows (GET /v1/liquidity/offers/mine) — the
// route doesn't join the `user` relation (a self-view never needs to
// look itself up), so the caller's own already-known User (useAuth())
// fills that in. Same field-by-field mapping OfferDetail.tsx's own
// toOffer() uses, minus the user lookup. Real fix, 2026-08-01 — see
// README.md's "What this is not" for the bug this closes (a
// just-published real offer never showed up here, since this screen
// used to read lib/offersStore.ts/localStorage instead).
function toOffer(raw: Awaited<ReturnType<typeof sailsClient.liquidity.getMyOffers>>[number], user: User): Offer {
  const priceUsd = Number(raw.priceUsd)
  return {
    id: raw.id,
    userId: raw.userId,
    user,
    asset: raw.asset,
    side: raw.side,
    priceUsd,
    fiatCurrency: 'USD', // same priceUsd unit as discovery and the trade contract
    priceFiat: priceUsd,
    minAmount: Number(raw.minAmount),
    maxAmount: Number(raw.maxAmount),
    paymentMethod: raw.paymentMethod,
    paymentDetails: raw.paymentDetails ?? undefined,
    status: raw.status,
    network: raw.network ?? undefined,
    description: raw.description ?? undefined,
    country: 'BR', // no real country field on Offer yet — same gap types.ts's header already discloses
    tradedWithCurrentUser: false,
    blockedRelationship: false,
    createdAt: raw.createdAt,
  }
}

// A function, not a constant: the labels follow the interface language.
const offerFilters = (): { value: OfferStatus | 'Todos'; label: string }[] => [
  { value: 'Todos', label: t('trades.filter.all') },
  { value: 'ACTIVE', label: OFFER_STATUS_LABEL.ACTIVE },
  { value: 'PAUSED', label: OFFER_STATUS_LABEL.PAUSED },
  { value: 'COMPLETED', label: OFFER_STATUS_LABEL.COMPLETED },
  { value: 'CANCELLED', label: OFFER_STATUS_LABEL.CANCELLED },
]

/** The viewer's own offers: dated, filterable list with pause/activate/cancel (real SDK calls). */
export function MyOffersSection({ user, className }: { user: User; className?: string }) {
  const [offers, setOffers] = useState<Offer[]>([])
  const [loadingOffers, setLoadingOffers] = useState(true)
  // offersError (2026-08-02) — a fetch failure used to silently become
  // `setOffers([])`, rendering identically to "you haven't published
  // anything yet" (SLC audit's 🟡 finding). Now a distinct message.
  const [offersError, setOffersError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState<OfferStatus | 'Todos'>('Todos')
  const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null)

  // Real, wired to @satsails/p2p-trading-sdk (2026-08-01) — GET /v1/liquidity/offers/mine
  // already filters by the authenticated session, so a just-published
  // offer shows up here on the next mount (no client-side userId filter
  // needed, unlike the old localStorage-backed version).
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoadingOffers(true)
    setOffersError(null)
    sailsClient.liquidity
      .getMyOffers()
      .then((raw) => { if (!cancelled) setOffers(raw.map((o) => toOffer(o, user))) })
      .catch((err) => {
        if (cancelled) return
        setOffers([])
        setOffersError(errorMessage(err, t('trades.offers.loadFailed')))
      })
      .finally(() => { if (!cancelled) setLoadingOffers(false) })
    return () => { cancelled = true }
  }, [user, reloadKey])

  // Real gap found directly by the owner: "Minhas Ordens" had no
  // date/time and no way to know what happened or remove an order —
  // sorted newest-first (an actual history, not an unordered dump) and
  // filterable by status, matching Binance P2P "My Ads" / Bisq "My Open
  // Offers" / HodlHodl "My Contracts" / El Dorado / P2P.me, which all
  // show a dated, filterable list of a user's own listings.
  const myOffers = useMemo(() => {
    return offers
      .filter((o) => statusFilter === 'Todos' || o.status === statusFilter)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [offers, statusFilter])

  // Optimistic update + real PATCH /v1/liquidity/offers/:id/status
  // (2026-08-01) — reverts the optimistic change and shows an error
  // toast if the real call fails, instead of silently drifting from the
  // server's actual state the way the old localStorage-only version
  // could never detect a failure at all.
  const applyStatus = (id: string, status: OfferStatus, message: string) => {
    const previousStatus = offers.find((o) => o.id === id)?.status
    setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)))
    setConfirmingCancelId(null)
    sailsClient.liquidity
      .updateStatus(id, status)
      .then(() => toast.success(message))
      .catch(() => {
        if (previousStatus) setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, status: previousStatus } : o)))
        toast.error(t('trades.offers.updateFailed'))
      })
  }

  return (
    <section aria-labelledby="my-offers-title" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="my-offers-title" className="text-section-title">{t('trades.offers.title')}</h2>
        <SegmentedControl label={t('trades.offers.filterLabel')} options={offerFilters()} value={statusFilter} onChange={setStatusFilter} />
      </div>

      {!loadingOffers && offersError ? (
        <StateBlock
          kind="error"
          className="mt-3"
          title={t('trades.offers.errorTitle')}
          description={offersError}
          action={<Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-9 touch:min-h-11 px-4">{t('trades.retry')}</Button>}
        />
      ) : !loadingOffers && offers.length === 0 ? (
        <StateBlock
          kind="empty"
          className="mt-3"
          title={t('trades.offers.emptyTitle')}
          description={t('trades.offers.emptyDescription')}
          action={<Link to={TRADES_ROUTES.newOffer} className={cn(buttonVariants({ variant: 'outline', className: 'min-h-9 touch:min-h-11 px-4' }))}>{t('trades.offers.publish')}</Link>}
        />
      ) : (
        <Card className="mt-3 overflow-hidden">
          <div aria-hidden="true" className={cn(TABLE_HEAD_ROW, 'hidden', OFFER_COLS)}>
            <span>{t('trades.offers.col.side')}</span>
            <span>{t('trades.offers.col.asset')}</span>
            <span>{t('trades.offers.col.price')}</span>
            <span>{t('trades.offers.col.limits')}</span>
            <span>{t('trades.col.status')}</span>
            <span>{t('trades.offers.col.created')}</span>
            <span className="text-right">{t('trades.offers.col.actions')}</span>
          </div>
          {loadingOffers ? (
            <ListSkeleton label={t('trades.offers.loading')} rows={2} rowClassName="h-[7.5rem] xl:h-14" />
          ) : myOffers.length === 0 ? (
            <StateBlock bare kind="empty" title={t('trades.offers.noneWithStatus', { status: statusFilter === 'Todos' ? '' : OFFER_STATUS_LABEL[statusFilter] })} />
          ) : (
            <ul>
              {myOffers.map((o) => {
                const canManage = o.status === 'ACTIVE' || o.status === 'PAUSED'
                return (
                  <li key={o.id} className={cn(TABLE_ROW, 'px-4 py-3')}>
                    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', OFFER_COLS)}>
                      <span><SideBadge side={o.side} /></span>
                      <AssetNetworkLabel asset={o.asset} className="text-sm text-brand-text-secondary" />
                      {/* priceUsd is a USD value: always formatted as USD, never with the offer's fiat symbol. */}
                      <span className="text-sm font-medium text-brand-text tabular-nums">{formatPrice(o.priceUsd, 'USD')}</span>
                      <span className="text-body-sm text-brand-text-secondary tabular-nums">
                        {formatAmount(o.minAmount)} – {formatAmount(o.maxAmount)} {ASSET_SHORT_LABELS[o.asset]}
                      </span>
                      <span><OfferStatusBadge status={o.status} /></span>
                      <span className="text-xs text-brand-text-muted tabular-nums basis-full xl:basis-auto"><span className="xl:hidden">{t('trades.offers.col.created')} </span>{formatDateTime(o.createdAt)}</span>
                      <span className="flex items-center gap-1 xl:justify-end ml-auto xl:ml-0">
                        {canManage && confirmingCancelId !== o.id && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                o.status === 'ACTIVE'
                                  ? applyStatus(o.id, 'PAUSED', t('trades.offers.paused'))
                                  : applyStatus(o.id, 'ACTIVE', t('trades.offers.reactivated'))
                              }
                              className="touch:min-h-11 text-body-sm"
                            >
                              {t(o.status === 'ACTIVE' ? 'trades.offers.pause' : 'trades.offers.activate')}
                            </Button>
                            {/* Destructive action one step away (overflow), with the same confirmation below. */}
                            <Popover>
                              <PopoverTrigger
                                aria-label={t('trades.offers.moreActions')}
                                className="h-9 w-9 touch:h-11 touch:w-11 flex items-center justify-center rounded-md text-brand-text-muted hover:text-brand-text state-layer"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </PopoverTrigger>
                              <PopoverContent align="end" className="w-48 p-1.5">
                                <button
                                  type="button"
                                  onClick={() => setConfirmingCancelId(o.id)}
                                  className="w-full min-h-9 touch:min-h-11 rounded-md px-2.5 py-2 text-left text-sm text-brand-danger-fg state-layer"
                                >
                                  {t('trades.offers.cancelOffer')}
                                </button>
                              </PopoverContent>
                            </Popover>
                          </>
                        )}
                        <Link
                          to={`/offer/${o.id}`}
                          aria-label={t('trades.offers.viewAria', { asset: ASSET_LABELS[o.asset] })}
                          className="min-h-9 touch:min-h-11 px-2 -mr-2 text-body-sm text-brand-text-secondary hover:text-brand-text flex items-center rounded-md"
                        >
                          {t('trades.offers.view')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </Link>
                      </span>
                    </div>

                    {confirmingCancelId === o.id && (
                      <div className="mt-3 rounded-md bg-brand-danger/5 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-xs text-brand-text-secondary">
                          {t('trades.offers.confirmCancel')}
                        </span>
                        <div className="flex gap-2 shrink-0">
                          <Button variant="destructive" size="sm" onClick={() => applyStatus(o.id, 'CANCELLED', t('trades.offers.cancelled'))} className="touch:min-h-11 text-body-sm">
                            {t('trades.offers.yesCancel')}
                          </Button>
                          <Button variant="outline" size="sm" autoFocus onClick={() => setConfirmingCancelId(null)} className="touch:min-h-11 text-body-sm">{t('trades.back')}</Button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}
    </section>
  )
}

/** Trades → Minhas ofertas (/trades/offers): the management list plus the "Nova oferta" entry point. */
export function MyOffers() {
  const { user, loading } = useAuth()
  return (
    <Page>
      <PageHeader
        title="Trades"
        actions={user ? (
          <Link to={TRADES_ROUTES.newOffer} className={cn(buttonVariants({ className: 'shrink-0 min-h-10 touch:min-h-11 px-4' }))}>
            <Plus aria-hidden="true" />
            {t('trades.offers.new')}
          </Link>
        ) : undefined}
      >
        <TradesTabs />
      </PageHeader>
      {user ? (
        <MyOffersSection user={user} />
      ) : loading ? (
        <Card className="overflow-hidden"><ListSkeleton label={t('trades.offers.checkingSession')} rows={2} rowClassName="h-14" /></Card>
      ) : (
        <StateBlock
          kind="signedOut"
          title={t('trades.connectTitle')}
          description={t('trades.offers.signedOutDescription')}
          action={<Link to="/login" state={{ from: TRADES_ROUTES.offers }} className={cn(buttonVariants({ variant: 'secondary', className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('trades.connect')}</Link>}
        />
      )}
    </Page>
  )
}
