import { Link, useNavigate } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from '../components/ui/toast'
import { useAuth } from '../context/AuthContext'
import { UserAvatar } from '../components/ui/UserAvatar'
import { CopyButton } from '../components/ui/CopyButton'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { SideBadge, OfferStatusBadge, OFFER_STATUS_LABEL } from '../components/ui/StatusBadges'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { StateBlock } from '../components/ui/StateBlock'
import { TABLE_HEAD_ROW, TABLE_ROW } from '../components/ui/table'
import { StatStrip } from '../components/ui/StatStrip'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { cn } from '../lib/utils'
import { Check, ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { sailsClient } from '../lib/sailsClient'
import { formatAmount, formatDateTime, formatMonthYear } from '../lib/format'
import { ASSET_LABELS, ASSET_SHORT_LABELS } from '../lib/labels'
import { ACCOUNT_DISPUTE_RATE_DEFINITION, formatAccountDisputeRate, RATINGS_EXPLANATION, REPUTATION_EXPLANATION } from '../lib/reputation'
import { PlannedItem } from '../components/ui/PlannedItem'
import { LOOSE_WIRES } from '../lib/looseWires'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import { errorMessage } from '../lib/errors'
import { ListSkeleton } from '../components/ui/skeleton'
import { formatPrice } from '../lib/currency'
import type { Offer, OfferStatus, User } from '../types'

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

const OFFER_FILTERS: { value: OfferStatus | 'Todos'; label: string }[] = [
  { value: 'Todos', label: 'Todos' },
  { value: 'ACTIVE', label: OFFER_STATUS_LABEL.ACTIVE },
  { value: 'PAUSED', label: OFFER_STATUS_LABEL.PAUSED },
  { value: 'COMPLETED', label: OFFER_STATUS_LABEL.COMPLETED },
  { value: 'CANCELLED', label: OFFER_STATUS_LABEL.CANCELLED },
]

const KEY_EXPLAINER =
  'Este é o identificador único da sua conta: a mesma chave assina suas ações e identifica você na conexão direta com outros usuários. É segura para compartilhar; sua chave privada nunca sai do seu dispositivo.'

export function Profile() {
  const { user } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    // `state: { from: '/profile' }` added 2026-08-15 — without it, a
    // session lost to a reload bounced here to '/', not back to Profile
    // (Login.tsx's own `handleConnect()` falls back to '/' when
    // `location.state.from` is unset), the same real return-path gap
    // OfferDetail.tsx's handleStartTrade() and Trade.tsx's own reconnect
    // button already close for their pages.
    if (!user) navigate('/login', { state: { from: '/profile' } })
  }, [user, navigate])

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
        setOffersError(errorMessage(err, 'Não foi possível carregar suas ofertas agora.'))
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

  if (!user) return null

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
        toast.error('Não foi possível atualizar a oferta — tente novamente.')
      })
  }

  return (
    <Page width="detail">
      <PageHeader
        title="Perfil"
        actions={
          <Link to="/profile/new-offer" className={cn(buttonVariants({ className: 'shrink-0 min-h-10 touch:min-h-11 px-4' }))}>
            <Plus aria-hidden="true" />
            Nova oferta
          </Link>
        }
      />

      <Card className="p-5">
        <div className="flex gap-4 items-start sm:items-center">
          <UserAvatar user={user} size="lg" />
          <div className="min-w-0">
            <h2 className="text-section-title flex items-center gap-1.5 flex-wrap">
              {user.displayName}
              {user.verified && <Check aria-label="Verificado" className="h-4 w-4 text-brand-orange-accent" />}
            </h2>
            {/* Real gap found directly by the owner: this key was shown with no label at all. It genuinely is
                the same key: PearNode's own Ed25519 keypair IS the identity keypair (docs/ARCHITECTURE.md,
                pear.service.ts getKeyPair()), so the explainer says so plainly. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex items-center gap-1 text-xs text-brand-text-muted">
                Sua chave pública
                <InfoTooltip text={KEY_EXPLAINER} />
              </span>
              <span className="mono-id text-body-sm text-brand-text-secondary truncate max-w-[16rem]">{user.publicKey}</span>
              <CopyButton value={user.publicKey} className="min-h-11 md:min-h-0 shrink-0" />
            </div>
            {formatMonthYear(user.createdAt) && <p className="text-xs text-brand-text-muted mt-1">Membro desde {formatMonthYear(user.createdAt)}</p>}
          </div>
        </div>
        <StatStrip
          className="mt-5 pt-4 border-t border-brand-border-subtle"
          items={[
            { label: 'Trades', value: user.totalTrades },
            { label: 'Volume (BTC)', value: formatAmount(user.totalVolumeBtc, 2) },
            { label: 'Taxa de disputa', value: formatAccountDisputeRate(user), info: ACCOUNT_DISPUTE_RATE_DEFINITION },
            { label: 'Reputação', value: <span className="inline-flex items-center gap-1.5">{user.reputationScore.toFixed(0)}<ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} /></span> },
          ]}
        />
        {/* Ratings exist (reputation.rate()) but cannot be read back yet: no number, only the planned item. */}
        <PlannedItem
          className="mt-4 pt-4 border-t border-brand-border-subtle"
          icon={LOOSE_WIRES.readRatings.icon}
          label={LOOSE_WIRES.readRatings.label}
          soonLabel="Em breve"
          description="Notas de 1 a 5 estrelas que as contrapartes dão ao fim de um trade. Não mudam a reputação."
          explanation={RATINGS_EXPLANATION}
        />
      </Card>

      <section aria-labelledby="my-offers-title" className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="my-offers-title" className="text-section-title">Minhas ofertas</h2>
          <SegmentedControl label="Filtrar ofertas por status" options={OFFER_FILTERS} value={statusFilter} onChange={setStatusFilter} />
        </div>

        {!loadingOffers && offersError ? (
          <StateBlock
            kind="error"
            className="mt-3"
            title="Não foi possível carregar suas ofertas"
            description={offersError}
            action={<Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-9 touch:min-h-11 px-4">Tentar novamente</Button>}
          />
        ) : !loadingOffers && offers.length === 0 ? (
          <StateBlock
            kind="empty"
            className="mt-3"
            title="Nenhuma oferta publicada ainda"
            description="Publique uma oferta para aparecer no Market."
            action={<Link to="/profile/new-offer" className={cn(buttonVariants({ variant: 'outline', className: 'min-h-9 touch:min-h-11 px-4' }))}>Publicar oferta</Link>}
          />
        ) : (
          <Card className="mt-3 overflow-hidden">
            <div aria-hidden="true" className={cn(TABLE_HEAD_ROW, 'hidden', OFFER_COLS)}>
              <span>Lado</span>
              <span>Ativo</span>
              <span>Preço (USD)</span>
              <span>Limites</span>
              <span>Status</span>
              <span>Criada em</span>
              <span className="text-right">Ações</span>
            </div>
            {loadingOffers ? (
              <ListSkeleton label="Carregando ofertas" rows={2} rowClassName="h-[7.5rem] xl:h-14" />
            ) : myOffers.length === 0 ? (
              <StateBlock bare kind="empty" title={`Nenhuma oferta com status "${statusFilter === 'Todos' ? '' : OFFER_STATUS_LABEL[statusFilter]}"`} />
            ) : (
              <ul>
                {myOffers.map((o) => {
                  const canManage = o.status === 'ACTIVE' || o.status === 'PAUSED'
                  return (
                    <li key={o.id} className={cn(TABLE_ROW, 'px-4 py-3')}>
                      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', OFFER_COLS)}>
                        <span><SideBadge side={o.side} /></span>
                        <span className="text-sm text-brand-text-secondary truncate">{ASSET_LABELS[o.asset]}</span>
                        {/* priceUsd is a USD value: always formatted as USD, never with the offer's fiat symbol. */}
                        <span className="text-sm font-medium text-brand-text tabular-nums">{formatPrice(o.priceUsd, 'USD')}</span>
                        <span className="text-body-sm text-brand-text-secondary tabular-nums">
                          {formatAmount(o.minAmount)}–{formatAmount(o.maxAmount)} {ASSET_SHORT_LABELS[o.asset]}
                        </span>
                        <span><OfferStatusBadge status={o.status} /></span>
                        <span className="text-xs text-brand-text-muted tabular-nums basis-full xl:basis-auto"><span className="xl:hidden">Criada em </span>{formatDateTime(o.createdAt)}</span>
                        <span className="flex items-center gap-1 xl:justify-end ml-auto xl:ml-0">
                          {canManage && confirmingCancelId !== o.id && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  o.status === 'ACTIVE'
                                    ? applyStatus(o.id, 'PAUSED', 'Oferta pausada — não aparece mais no Market')
                                    : applyStatus(o.id, 'ACTIVE', 'Oferta reativada')
                                }
                                className="min-h-11 md:min-h-0 text-body-sm"
                              >
                                {o.status === 'ACTIVE' ? 'Pausar' : 'Ativar'}
                              </Button>
                              {/* Destructive action one step away (overflow), with the same confirmation below. */}
                              <Popover>
                                <PopoverTrigger
                                  aria-label="Mais ações da oferta"
                                  className="h-11 w-11 md:h-9 md:w-9 flex items-center justify-center rounded-md text-brand-text-muted hover:text-brand-text state-layer"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </PopoverTrigger>
                                <PopoverContent align="end" className="w-48 p-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmingCancelId(o.id)}
                                    className="w-full min-h-9 touch:min-h-11 rounded-md px-2.5 py-2 text-left text-sm text-brand-danger-fg state-layer"
                                  >
                                    Cancelar oferta
                                  </button>
                                </PopoverContent>
                              </Popover>
                            </>
                          )}
                          <Link
                            to={`/offer/${o.id}`}
                            aria-label={`Ver oferta de ${ASSET_LABELS[o.asset]}`}
                            className="min-h-9 touch:min-h-11 px-2 -mr-2 text-body-sm text-brand-text-secondary hover:text-brand-text flex items-center rounded-md"
                          >
                            Ver <ChevronRight className="h-4 w-4" aria-hidden="true" />
                          </Link>
                        </span>
                      </div>

                      {confirmingCancelId === o.id && (
                        <div className="mt-3 rounded-md bg-brand-danger/5 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-xs text-brand-text-secondary">
                            Cancelar esta oferta? Ela sai do Market imediatamente e não pode ser reativada — publique uma nova se mudar de ideia.
                          </span>
                          <div className="flex gap-2 shrink-0">
                            <Button variant="destructive" size="sm" onClick={() => applyStatus(o.id, 'CANCELLED', 'Oferta cancelada')} className="min-h-11 md:min-h-0 text-body-sm">
                              Sim, cancelar
                            </Button>
                            <Button variant="outline" size="sm" autoFocus onClick={() => setConfirmingCancelId(null)} className="min-h-11 md:min-h-0 text-body-sm">Voltar</Button>
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

    </Page>
  )
}
