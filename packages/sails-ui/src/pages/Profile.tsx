import { Link, useNavigate } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../context/AuthContext'
import { UserAvatar } from '../components/ui/UserAvatar'
import { CopyButton } from '../components/ui/CopyButton'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { AssetBadge, SideBadge, OfferStatusBadge, OFFER_STATUS_LABEL, PowerTraderBadge } from '../components/ui/StatusBadges'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { badgeVariants } from '../components/ui/badge'
import { cn } from '../lib/utils'
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react'
import { sailsClient } from '../lib/sailsClient'
import { formatDateTime } from '../lib/format'
import { ASSET_SHORT_LABELS } from '../lib/labels'
import { ACCOUNT_DISPUTE_RATE_DEFINITION, formatAccountDisputeRate, formatReputation, isPowerTrader } from '../lib/reputation'
import { errorMessage } from '../lib/errors'
import { ListSkeleton } from '../components/ui/skeleton'
import { formatPrice } from '../lib/currency'
import type { Offer, OfferStatus, User } from '../types'

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
  // The Disputas link is shown only to an assigned arbiter: a one-row
  // listDisputes() read (scoped server-side to the caller). On a failed read
  // the link stays visible rather than hiding real assigned disputes.
  const [hasDisputes, setHasDisputes] = useState(false)
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

  useEffect(() => {
    if (!user) return
    let cancelled = false
    sailsClient.settlement
      .listDisputes({ limit: 1 })
      .then((page) => { if (!cancelled) setHasDisputes(page.total > 0) })
      .catch(() => { if (!cancelled) setHasDisputes(true) })
    return () => { cancelled = true }
  }, [user])

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
    <div>
      <div className="flex flex-col md:flex-row gap-6 items-start pb-6 border-b border-brand-border">
        <UserAvatar user={user} size="xl" />
        <div className="min-w-0 max-w-full">
          <h1 className="text-page-title flex items-center gap-2 flex-wrap">
            {user.displayName}
            {user.verified && (
              <span title="Verificado">
                <Check className="h-4 w-4 text-brand-orange-accent" />
              </span>
            )}
            {isPowerTrader(user) && <PowerTraderBadge />}
          </h1>
          {/* Real gap found directly by the owner: this key was shown with
              no label at all — after seeing Keet call the equivalent value
              "Public Key" with no further context, it wasn't clear this
              was even the same kind of key, let alone *the user's own*.
              It genuinely is the same key: PearNode's own Ed25519 keypair
              IS the identity keypair (docs/ARCHITECTURE.md, pear.service.ts
              `getKeyPair()`) — one primitive, not two, so the explainer
              below says so plainly instead of inventing a distinction. */}
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-xs text-brand-text-muted">Sua chave pública</span>
            <InfoTooltip text={KEY_EXPLAINER} />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="mono-id text-brand-text-secondary truncate max-w-xs">{user.publicKey}</span>
            <CopyButton value={user.publicKey} className="min-h-11 md:min-h-0 shrink-0" />
          </div>
          <p className="text-xs text-brand-text-muted mt-1">Membro desde {new Date(user.createdAt).toLocaleDateString('pt-BR')}</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:ml-auto w-full md:w-auto">
          <Stat value={user.totalTrades} label="Trades" />
          <Stat value={user.totalVolumeBtc.toFixed(2)} label="Volume BTC" />
          <Stat value={formatAccountDisputeRate(user)} label="Disputa" info={ACCOUNT_DISPUTE_RATE_DEFINITION} />
          <Stat value={formatReputation(user.reputationScore)} label="Reputação" />
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-brand-text">Minhas Ofertas</h3>
          <Button onClick={() => navigate('/profile/new-offer')} className="text-xs px-3 min-h-11 md:min-h-10">Nova Oferta</Button>
        </div>

        <div className="mt-3 flex gap-2 flex-wrap" role="group" aria-label="Filtrar ofertas por status">
          {OFFER_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={statusFilter === f.value}
              onClick={() => setStatusFilter(f.value)}
              className={cn(badgeVariants({ variant: statusFilter === f.value ? 'default' : 'secondary' }), 'rounded-full px-3 min-h-11 md:min-h-8')}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="mt-3 space-y-2">
          {loadingOffers && (
            <ListSkeleton label="Carregando ofertas" rows={2} rowClassName="h-[8.625rem] md:h-[5.75rem] rounded-xl border border-brand-border-subtle last:border-b" className="space-y-2" />
          )}
          {!loadingOffers && offersError && (
            <div className="rounded-xl border border-brand-border-subtle px-4 py-6 text-center">
              <p className="text-sm text-red-700 dark:text-red-300">{offersError}</p>
              <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="mt-3 min-h-11 md:min-h-9 px-4 text-sm">Tentar novamente</Button>
            </div>
          )}
          {!loadingOffers && !offersError && myOffers.length === 0 && (
            statusFilter === 'Todos' ? (
              <div className="rounded-xl border border-brand-border-subtle px-4 py-8 text-center">
                <p className="text-sm text-brand-text">Nenhuma oferta publicada ainda.</p>
                <p className="text-metadata mt-1">Publique uma oferta para aparecer no Market.</p>
                <Button onClick={() => navigate('/profile/new-offer')} className="mt-3 min-h-11 md:min-h-10 px-4">Publicar oferta</Button>
              </div>
            ) : (
              <p className="text-sm text-brand-text-muted">{`Nenhuma oferta com status "${OFFER_STATUS_LABEL[statusFilter]}".`}</p>
            )
          )}
          {!loadingOffers && myOffers.length > 0 && (
          <ul className="space-y-2">
          {myOffers.map((o) => {
            const canManage = o.status === 'ACTIVE' || o.status === 'PAUSED'
            return (
              <li key={o.id}>
              <Card className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SideBadge side={o.side} />
                  <AssetBadge asset={o.asset} />
                  <span className="font-medium text-sm text-brand-text tabular-nums">{formatPrice(o.priceUsd, o.fiatCurrency)}</span>
                  <OfferStatusBadge status={o.status} />
                  <span className="text-xs text-brand-text-muted tabular-nums ml-auto">
                    {o.minAmount}–{o.maxAmount} {ASSET_SHORT_LABELS[o.asset]}
                  </span>
                </div>

                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-brand-text-muted">Criada em {formatDateTime(o.createdAt)}</span>
                  <div className="flex items-center gap-2">
                    {canManage && confirmingCancelId !== o.id && (
                      <>
                        <button
                          onClick={() =>
                            o.status === 'ACTIVE'
                              ? applyStatus(o.id, 'PAUSED', 'Oferta pausada — não aparece mais no Marketplace')
                              : applyStatus(o.id, 'ACTIVE', 'Oferta reativada')
                          }
                          className="min-h-11 md:min-h-8 text-xs text-brand-text-muted hover:text-brand-text border border-brand-border rounded-md px-3 transition-colors"
                        >
                          {o.status === 'ACTIVE' ? 'Pausar' : 'Ativar'}
                        </button>
                        {/* Destructive action one step away (overflow), with the same confirmation below. */}
                        <Popover>
                          <PopoverTrigger
                            aria-label="Mais ações da oferta"
                            className="h-11 w-11 md:h-8 md:w-8 flex items-center justify-center rounded-md text-brand-text-muted hover:text-brand-text hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </PopoverTrigger>
                          <PopoverContent align="end" className="w-48 p-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmingCancelId(o.id)}
                              className="w-full min-h-11 rounded-md px-2.5 py-2 text-left text-sm text-red-700 dark:text-red-300 hover:bg-brand-elevated"
                            >
                              Cancelar oferta
                            </button>
                          </PopoverContent>
                        </Popover>
                      </>
                    )}
                    <Link to={`/offer/${o.id}`} className="min-h-11 md:min-h-8 px-2 -mr-2 text-xs text-brand-text-muted hover:text-brand-text flex items-center">
                      Ver <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>

                {confirmingCancelId === o.id && (
                  <div className="mt-2 rounded-md bg-red-500/5 border border-red-500/20 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-brand-text-secondary">
                      Cancelar esta oferta? Ela sai do Marketplace imediatamente e não pode ser reativada — publique uma nova se mudar de ideia.
                    </span>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => applyStatus(o.id, 'CANCELLED', 'Oferta cancelada')}
                        className="min-h-11 md:min-h-8 text-xs bg-red-700 hover:bg-red-600 text-white rounded-md px-2.5 py-1 font-semibold transition-colors"
                      >
                        Sim, cancelar
                      </button>
                      <Button variant="outline" autoFocus onClick={() => setConfirmingCancelId(null)} className="text-xs px-2.5 py-1 h-auto min-h-11 md:min-h-8">Voltar</Button>
                    </div>
                  </div>
                )}
              </Card>
              </li>
            )
          })}
          </ul>
          )}
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-2">
        <Link to="/profile/history" className="w-fit min-h-11 md:min-h-0 text-sm text-brand-orange-accent underline inline-flex items-center gap-0.5">
          Ver histórico completo de trades <ChevronRight className="h-4 w-4" />
        </Link>
        {/* Mobile parity — Sidebar (desktop-only) links here directly;
            BottomNav has no dedicated tab for this (a real, but
            infrequent, arbiter-only feature), shown only when one is assigned. */}
        {hasDisputes && (
          <Link to="/disputes" className="w-fit min-h-11 md:min-h-0 text-sm text-brand-orange-accent underline inline-flex items-center gap-0.5">
            Disputas atribuídas a você <ChevronRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </div>
  )
}

function Stat({ value, label, info }: { value: string | number; label: string; info?: string }) {
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
