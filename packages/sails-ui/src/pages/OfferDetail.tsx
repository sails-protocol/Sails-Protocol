import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { toast } from '../components/ui/toast'
import { PaymentMethods } from '../components/ui/PaymentMethods'
import { PlannedItem } from '../components/ui/PlannedItem'
import { LOOSE_WIRES } from '../lib/looseWires'
import { offerPaymentMethods } from '../lib/paymentMethods'
import { demoMemberSinceOf, demoPaymentMethodsOf, demoRatingsOf } from '../lib/demoMarkers'
import { ratingFullText, ratingSrText, sellerMemberSince, sellerRatings, type DemoRatingFields } from '../lib/ratings'
import { UserAvatar } from '../components/ui/UserAvatar'
import { FavoriteButton } from '../components/ui/FavoriteButton'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { cn } from '../lib/utils'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { StateBlock } from '../components/ui/StateBlock'
import { ArrowLeft, Check, Lock, SearchX } from 'lucide-react'
import { Alert } from '../components/ui/alert'
import { formatAmount } from '../lib/format'
import { formatByCurrency, formatPrice } from '../lib/currency'
import { sailsClient } from '../lib/sailsClient'
import { errorMessage } from '../lib/errors'
import { SailsNotFoundError, SailsTransportError, type PublicOfferDetail, type PublicOfferSeller } from '@satsails/p2p-trading-sdk'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../lib/labels'
import { AssetNetworkLabel } from '../components/ui/AssetIcon'
import { disputeRatePct, RATINGS_DEMO_EXPLANATION, RATINGS_EXPLANATION, REPUTATION_EXPLANATION, trustItems } from '../lib/reputation'
import { RatingSummaryLine } from '../components/ui/RatingSummaryLine'
import { TrustLine } from '../components/ui/TrustLine'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import { useAuth } from '../context/AuthContext'
import type { FiatCurrency } from '../types'
import { t } from '../i18n'

// Technical Debt #61 (2026-09-10) — this view model now maps directly
// from the SDK's own PublicOfferDetail (liquidity.getOffer()'s real
// return shape, docs/TECHNICAL_DEBT_AUDIT.md #61), not the app's shared
// `Offer`/`User` types from ../types — those still correctly describe
// OTHER data sources (an authenticated caller's own offers, `publish()`,
// `updateStatus()`) that legitimately return the full raw row. Reusing
// them here would either silently re-widen this screen back to fields
// the public route no longer sends, or require fabricating values for
// fields (paymentDetails, disputeCount, totalVolumeBtc, seller.createdAt,
// country, tradedWithCurrentUser, blockedRelationship) this file never
// actually read in its own render even before this remediation —
// confirmed directly (grep across this file), not assumed.
interface OfferDetailView {
  id: string
  seller: PublicOfferSeller & DemoRatingFields
  asset: PublicOfferDetail['asset']
  side: PublicOfferDetail['side']
  priceUsd: number
  fiatCurrency: FiatCurrency
  priceFiat: number
  minAmount: number
  maxAmount: number
  paymentMethod: PublicOfferDetail['paymentMethod']
  demoPaymentMethods?: PublicOfferDetail['paymentMethod'][]
  network?: string
  description?: string
}

function toOfferDetailView(raw: PublicOfferDetail): OfferDetailView {
  const priceUsd = Number(raw.priceUsd)
  return {
    id: raw.id,
    // Ratings and sign-up date: dev demo only (LOOSE_WIRES.readRatings, publicMemberSince); undefined for real data.
    seller: { ...raw.seller, demoRatings: demoRatingsOf(raw.seller), demoMemberSince: demoMemberSinceOf(raw.seller) },
    asset: raw.asset,
    side: raw.side,
    priceUsd,
    // CTO 118: match discovery and Trade.totalUsd; do not infer a quote
    // currency or exchange rate from the optional legacy priceBrl field.
    fiatCurrency: 'USD',
    priceFiat: priceUsd,
    minAmount: Number(raw.minAmount),
    maxAmount: Number(raw.maxAmount),
    paymentMethod: raw.paymentMethod,
    demoPaymentMethods: demoPaymentMethodsOf<PublicOfferDetail['paymentMethod']>(raw), // dev demo only
    network: raw.network ?? undefined,
    description: raw.description ?? undefined,
  }
}

export function OfferDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const [offer, setOffer] = useState<OfferDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingTrade, setStartingTrade] = useState(false)
  // fetchError (2026-08-02) — a genuine 404 (offer really doesn't exist/
  // was cancelled) and a network/backend outage both used to render as
  // the same "Oferta não encontrada." (SLC audit's 🟡 finding: these
  // must not look identical). SailsTransportError carries a real
  // statusCode; only that specific 404 counts as "not found" — anything
  // else (500, timeout, offline) is a real, distinct error state.
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Prefilled when arriving back here after being bounced to /login mid
  // way through starting a trade (see handleStartTrade below) — without
  // this, a round trip through login silently dropped whatever amount
  // the user had already typed.
  const [amount, setAmount] = useState<string>(() => {
    const state = location.state as { amount?: number } | null
    return state?.amount ? String(state.amount) : ''
  })

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37, 2026-09-13) — one
  // idempotency key per genuinely-new "start a trade" intent, reused
  // across a manual retry of the SAME attempt (e.g. clicking the button
  // again after a network error), regenerated whenever the amount
  // itself changes (a different amount is a different logical intent,
  // never a retry of the prior one). See
  // `sailsClient.openp2p.trade()`'s own doc comment for the full
  // contract this closes — createTrade() had no idempotency at all
  // before this mission.
  const tradeIdempotencyKeyRef = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    tradeIdempotencyKeyRef.current = crypto.randomUUID()
  }, [amount])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setFetchError(null)
    sailsClient.liquidity
      .getOffer(id)
      .then((raw) => { if (!cancelled) setOffer(toOfferDetailView(raw)) })
      .catch((err) => {
        if (cancelled) return
        setOffer(null)
        const notFound = err instanceof SailsNotFoundError || (err instanceof SailsTransportError && err.statusCode === 404)
        if (!notFound) setFetchError(errorMessage(err, t('offer.loadErrorFallback')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, reloadKey])

  const back = (
    <Link to="/" className="touch:min-h-11 text-body-sm text-brand-text-secondary hover:text-brand-text inline-flex items-center gap-1 w-fit">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market
    </Link>
  )

  if (loading || !offer) {
    return (
      <Page width="detail">
        <div className="mb-4">{back}</div>
        {loading ? (
          <StateBlock kind="loading" title={t('offer.loading')} />
        ) : (
          <StateBlock
            kind={fetchError ? 'error' : 'empty'}
            icon={fetchError ? undefined : SearchX}
            title={fetchError ? t('offer.error.title') : t('offer.notFound.title')}
            description={fetchError ?? t('offer.notFound.description')}
            action={fetchError
              ? <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-9 touch:min-h-11 px-4">{t('market.retry')}</Button>
              : <Link to="/" className={cn(buttonVariants({ className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('offer.backToMarket')}</Link>}
          />
        )}
      </Page>
    )
  }

  const amountNum = Number(amount) || 0
  const withinLimits = amountNum >= offer.minAmount && amountNum <= offer.maxAmount
  const totalFiat = amountNum * offer.priceFiat
  // Real bug found in a cold-start UX walkthrough: nothing stopped a
  // user from starting a trade against their own offer — the trade
  // opened with the same person as buyer and seller on both sides.
  // Technical Debt #61 — derived from the canonical seller identity
  // (offer.seller.id) now that the raw offer.userId field is gone from
  // the public response; same value, same check.
  const isOwnOffer = user?.id === offer.seller.id

  const handleStartTrade = async () => {
    if (!user) {
      toast.error(t('offer.toast.connectWallet'))
      // Carrega para onde voltar e o valor já digitado — sem isso o
      // usuário conectava a carteira e caía no Marketplace, tendo que
      // reencontrar a oferta e digitar tudo de novo.
      navigate('/login', { state: { from: location.pathname, amount: amountNum || undefined } })
      return
    }
    if (isOwnOffer) {
      toast.error(t('offer.toast.ownOffer'))
      return
    }
    if (!amountNum || !withinLimits) {
      toast.error(t('offer.toast.outOfLimits'))
      return
    }
    setStartingTrade(true)
    try {
      // Real @satsails/p2p-trading-sdk call — POST /v1/openp2p/trades (requires the
      // active session; the server derives the counterparty from it,
      // trade.routes.ts). This is the real trade.service.ts's
      // createTrade(), which also walks the offer's real Intent through
      // DISCOVERING -> MATCHED -> NEGOTIATING (RFC-018) — not a client-
      // side mock Trade built from whatever was picked here.
      const trade = await sailsClient.openp2p.trade(offer.id, String(amountNum), tradeIdempotencyKeyRef.current)
      // A NEW key for whatever this user does next — this one is now
      // either COMPLETED or (if the whole request somehow still fails
      // downstream of trade creation) irrelevant, since navigation below
      // leaves this screen.
      tradeIdempotencyKeyRef.current = crypto.randomUUID()
      toast.success(t('offer.toast.started'))
      navigate(`/trade/${trade.id}`, { state: { offer, amount: amountNum } })
    } catch (err) {
      toast.error(errorMessage(err, t('offer.toast.startFailed')))
    } finally {
      setStartingTrade(false)
    }
  }

  const sellerName = offer.seller.displayName
  const ratings = sellerRatings(offer.seller)
  const memberSince = sellerMemberSince(offer.seller)
  return (
    <Page width="detail">
      <PageHeader back={back} title={t('offer.title', { asset: ASSET_LABELS[offer.asset] })} meta={sellerName ? t('offer.postedBy', { name: sellerName }) : undefined} />

      {/* Below lg one column in reading order: terms, then the action card, then the seller. lg+: terms and
          seller on the left (8), the sticky action card on the right (4). */}
      <div className="grid gap-x-6 gap-y-4 lg:grid-cols-12 lg:items-start">
        {/* One card for the terms: price on the left, the facts on the right; each fact appears once. */}
        <Card className="p-5 lg:col-span-8">
          <h2 className="text-section-title">{t('offer.terms')}</h2>
          <div className="mt-4 grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <div className="text-xs text-brand-text-muted">{t('market.table.price')}</div>
              <div className="mt-1 money-hero text-brand-text">{formatPrice(offer.priceFiat, offer.fiatCurrency)}</div>
              <div className="text-body-sm text-brand-text-muted mt-1">
                {t('offer.perAsset', { asset: ASSET_LABELS[offer.asset] })}
                {offer.fiatCurrency !== 'USD' && ` · ≈ $${offer.priceUsd} USD`}
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 content-start">
              <Fact label={t('market.field.asset')}><AssetNetworkLabel asset={offer.asset} size="md" /></Fact>
              {offer.network && <Fact label={t('offer.network')}>{offer.network}</Fact>}
              {/* Full list here. Real offers carry one method (LOOSE_WIRES.multiPaymentMethods); the method is not chosen at trade time yet (LOOSE_WIRES.tradePaymentMethodChoice). */}
              <Fact label={t('market.field.payment')}><PaymentMethods labels={offerPaymentMethods(offer).map((m) => PAYMENT_METHOD_LABELS[m])} className="text-sm text-brand-text" /></Fact>
              <Fact label={t('market.table.limits')}><span className="tabular-nums">{formatAmount(offer.minAmount)} – {formatAmount(offer.maxAmount)} {ASSET_SHORT_LABELS[offer.asset]}</span></Fact>
            </dl>
          </div>
        </Card>

        <div className="lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-20">
          {isOwnOffer ? (
            <Card className="p-5">
              <h2 className="text-section-title">{t('offer.own.title')}</h2>
              <p className="text-body-sm text-brand-text-secondary mt-2">
                {t('offer.own.body')}
              </p>
              <Link to={TRADES_ROUTES.offers} className={cn(buttonVariants({ variant: 'outline', className: 'mt-4 w-full min-h-10 touch:min-h-11' }))}>
                {t('offer.own.link')}
              </Link>
            </Card>
          ) : (
            <Card className="p-5">
              {/* The viewer's own action, never the advertiser's side (a SELL offer means the viewer buys). */}
              <h2 className="text-section-title">
                {t(offer.side === 'SELL' ? 'offer.ticket.youBuy' : 'offer.ticket.youSell', { asset: ASSET_SHORT_LABELS[offer.asset] })}
              </h2>

              <label className="block text-xs text-brand-text-muted mt-4">
                {t(offer.side === 'SELL' ? 'offer.ticket.amountBuy' : 'offer.ticket.amountSell')}
                <div className="relative mt-1.5">
                  <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    type="number"
                    className="w-full md:h-10 pr-16 text-field font-medium tabular-nums"
                    placeholder="0.00"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-body-sm text-brand-text-muted">{ASSET_SHORT_LABELS[offer.asset]}</span>
                </div>
              </label>
              {amount && !withinLimits && (
                <p className="text-xs text-brand-danger-fg mt-1">{t('offer.ticket.outOfLimits', { min: formatAmount(offer.minAmount), max: formatAmount(offer.maxAmount) })}</p>
              )}

              <div className="mt-4 pt-4 border-t border-brand-border-subtle">
                <div className="text-xs text-brand-text-muted">{t(offer.side === 'SELL' ? 'offer.ticket.youPay' : 'offer.ticket.youReceive')}</div>
                <div className="money-hero mt-1 text-brand-text">{formatByCurrency(totalFiat || 0, offer.fiatCurrency)}</div>
                {/* Itemized from the only two inputs the total has: the offer carries no fee field. */}
                {amountNum > 0 && (
                  <div className="text-xs text-brand-text-muted tabular-nums mt-1">
                    {formatAmount(amountNum)} {ASSET_SHORT_LABELS[offer.asset]} × {formatPrice(offer.priceFiat, offer.fiatCurrency)}
                  </div>
                )}
              </div>

              <p className="mt-4 text-xs text-brand-text-secondary flex items-start gap-2">
                <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                {t('offer.ticket.escrowNote')}
              </p>

              {/* HodlHodl/Binance P2P both show this caution before a first trade with a brand-new
                  counterparty: real data (offer.seller.totalTrades), a real 0 means no completed trades yet. */}
              {offer.seller.totalTrades === 0 && (
                <Alert tone="warning" size="sm" className="mt-3">
                  {t('offer.ticket.newSeller')}
                </Alert>
              )}

              {/* The ticket's one primary is the viewer's side (solid green buy / solid red sell), replacing orange here. */}
              <Button onClick={handleStartTrade} loading={startingTrade} variant={offer.side === 'SELL' ? 'buy' : 'sell'} className="mt-4 w-full min-h-10 touch:min-h-11">
                {startingTrade ? t('offer.ticket.starting') : t(offer.side === 'SELL' ? 'offer.ticket.buy' : 'offer.ticket.sell', { asset: ASSET_SHORT_LABELS[offer.asset] })}
              </Button>
            </Card>
          )}
        </div>

        {/* Technical Debt #61: only the canonical public disclosure fields (trades, dispute rate,
            reputation); raw disputeCount, volume and "member since" are not part of the public response. */}
        <Card className="p-5 lg:col-span-8">
          <h2 className="text-section-title">{t('market.offer.seller')}</h2>
          <div className="mt-3 flex items-center gap-3">
            <UserAvatar user={offer.seller} size="md" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium flex items-center gap-1.5 text-brand-text">
                <span className="truncate">{sellerName}</span>
                {offer.seller.verified && <Check aria-label={t('market.offer.verified')} className="h-4 w-4 shrink-0 text-brand-orange-accent" />}
              </div>
              {/* reputationScore is an unbounded +2/-5 sum (lib/reputation.ts), never a 0-100 scale */}
              <div className="flex items-center gap-1.5 text-xs text-brand-text-muted">
                <TrustLine items={[...trustItems({ reputationScore: offer.seller.reputationScore, totalTrades: offer.seller.totalTrades }), { kind: 'disputeRate', text: t('offer.seller.disputeRate', { pct: String(disputeRatePct(offer.seller.disputeRate)) }) }]} />
                <ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} />
              </div>
            </div>
            <FavoriteButton userId={offer.seller.id} />
          </div>
          {/* No read endpoint for ratings yet (LOOSE_WIRES.readRatings): real data gets the planned item, no number;
              only the dev demo carries a summary (lib/ratings.ts). */}
          {ratings ? (
            <RatingSummaryLine
              className="mt-4 pt-4 border-t border-brand-border-subtle"
              text={ratingFullText(ratings)}
              srText={ratingSrText(ratings)}
              meta={memberSince ? t('offer.seller.memberSince', { date: memberSince }) : undefined}
              description={t('reputation.ratings.description')}
              explanation={RATINGS_DEMO_EXPLANATION}
            />
          ) : (
            <PlannedItem
              className="mt-4 pt-4 border-t border-brand-border-subtle"
              icon={LOOSE_WIRES.readRatings.icon}
              label={LOOSE_WIRES.readRatings.label}
              soonLabel={t('common.soon')}
              description={t('reputation.ratings.description')}
              explanation={RATINGS_EXPLANATION}
            />
          )}
        </Card>
      </div>
    </Page>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-brand-text">{children}</dd>
    </div>
  )
}
