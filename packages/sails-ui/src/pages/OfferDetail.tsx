import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { AssetBadge, SideBadge, PaymentBadge, PowerTraderBadge } from '../components/ui/StatusBadges'
import { UserAvatar } from '../components/ui/UserAvatar'
import { FavoriteButton } from '../components/ui/FavoriteButton'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { cn } from '../lib/utils'
import { ArrowLeft, Check, Lock, AlertTriangle } from 'lucide-react'
import { formatAmount } from '../lib/format'
import { formatByCurrency } from '../lib/currency'
import { sailsClient } from '../lib/sailsClient'
import { SailsTransportError, type EconomicPolicy, type PublicOfferDetail, type PublicOfferSeller } from '@satsails/p2p-trading-sdk'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../lib/labels'
import { bindSellerPaymentAccount, protectedEscrowEligibility, tradeAdmissionRefusalMessage, unboundSellOfferBlocked } from '../lib/paymentAccountBinding'
import { disputeRatePct, isPowerTraderFromCanonical } from '../lib/reputation'
import { useAuth } from '../context/AuthContext'
import type { FiatCurrency } from '../types'

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
  seller: PublicOfferSeller
  asset: PublicOfferDetail['asset']
  side: PublicOfferDetail['side']
  priceUsd: number
  fiatCurrency: FiatCurrency
  priceFiat: number
  minAmount: number
  maxAmount: number
  paymentMethod: PublicOfferDetail['paymentMethod']
  paymentAccountBound: boolean
  network?: string
  description?: string
}

function toOfferDetailView(raw: PublicOfferDetail): OfferDetailView {
  const priceUsd = Number(raw.priceUsd)
  const priceBrl = raw.priceBrl ? Number(raw.priceBrl) : priceUsd
  return {
    id: raw.id,
    seller: raw.seller,
    asset: raw.asset,
    side: raw.side,
    priceUsd,
    fiatCurrency: 'BRL', // real Offer only ever models a BRL fiat price (priceBrl) — see types.ts's own header comment
    priceFiat: priceBrl,
    minAmount: Number(raw.minAmount),
    maxAmount: Number(raw.maxAmount),
    paymentMethod: raw.paymentMethod,
    paymentAccountBound: raw.paymentAccountBound,
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
  const [fetchError, setFetchError] = useState(false)
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
  // #235 R7H-E3B — on a BUY offer the taker is the seller, so the taker (never the publisher) commits the
  // receiving account the buyer will pay into. Kept only in this component's state: never in navigation state,
  // storage or logs. The policy comes from the server; without it no trade is started (fail closed).
  const [receivingKey, setReceivingKey] = useState('')
  const [confirmAccountBinding, setConfirmAccountBinding] = useState(false)
  const [policy, setPolicy] = useState<EconomicPolicy | null>(null)
  const [policyError, setPolicyError] = useState(false)
  useEffect(() => {
    let cancelled = false
    sailsClient.settlement.economicPolicy()
      .then((p) => { if (!cancelled) setPolicy(p) })
      .catch(() => { if (!cancelled) setPolicyError(true) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { setConfirmAccountBinding(false) }, [receivingKey])

  const tradeIdempotencyKeyRef = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    // A different receiving account is a different trade request too (the server hashes it into the key's payload).
    tradeIdempotencyKeyRef.current = crypto.randomUUID()
  }, [amount, receivingKey])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setFetchError(false)
    sailsClient.liquidity
      .getOffer(id)
      .then((raw) => { if (!cancelled) setOffer(toOfferDetailView(raw)) })
      .catch((err) => {
        if (cancelled) return
        setOffer(null)
        if (!(err instanceof SailsTransportError) || err.statusCode !== 404) setFetchError(true)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return <div className="text-center py-16 text-brand-text-muted">Carregando oferta...</div>
  }

  if (!offer) {
    return (
      <div className="text-center py-16">
        <p className={fetchError ? 'text-red-500' : 'text-brand-text-secondary'}>
          {fetchError ? 'Não foi possível carregar esta oferta agora — tente novamente.' : 'Oferta não encontrada.'}
        </p>
        <Link to="/" className="text-sm text-brand-orange-accent underline mt-2 inline-block">Voltar ao Marketplace</Link>
      </div>
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
  const eligibility = policy ? protectedEscrowEligibility(policy, offer.asset, offer.paymentMethod) : null
  const methodBlocked = eligibility?.governed === true && !eligibility.eligible ? eligibility : null
  const takerBindsAccount = offer.side === 'BUY' && eligibility?.governed === true && !methodBlocked
  // #235 R7H-E3C — the server admits no trade on a governed SELL offer without its seller's committed account.
  const unboundOffer = unboundSellOfferBlocked(eligibility, offer.side, offer.paymentAccountBound)

  const handleStartTrade = async () => {
    if (!user) {
      toast.error('Conecte sua carteira primeiro')
      // Carrega para onde voltar e o valor já digitado — sem isso o
      // usuário conectava a carteira e caía no Marketplace, tendo que
      // reencontrar a oferta e digitar tudo de novo.
      navigate('/login', { state: { from: location.pathname, amount: amountNum || undefined } })
      return
    }
    if (isOwnOffer) {
      toast.error('Você não pode negociar com sua própria oferta')
      return
    }
    if (!amountNum || !withinLimits) {
      toast.error('Informe uma quantidade dentro do limite da oferta')
      return
    }
    if (!policy) {
      toast.error('Não foi possível verificar a política de escrow protegido — recarregue a página.')
      return
    }
    if (unboundOffer) {
      toast.error('Esta oferta não tem uma conta de recebimento do vendedor vinculada e não pode ser negociada com escrow protegido.')
      return
    }
    if (methodBlocked) {
      toast.error('Esta oferta não pode ter escrow protegido: o método de pagamento não é aceito pela política vigente.')
      return
    }
    if (takerBindsAccount && !confirmAccountBinding) {
      toast.error(receivingKey.trim() ? 'Confirme o vínculo da sua chave de recebimento a este trade.' : 'Informe a sua chave de recebimento.')
      return
    }
    setStartingTrade(true)
    try {
      // #235 R7H-E3B — registered (or re-resolved) and proven to be this user's own account before the trade exists.
      const binding = takerBindsAccount ? await bindSellerPaymentAccount(sailsClient, user.id, offer.paymentMethod, receivingKey) : null
      // Real @satsails/p2p-trading-sdk call — POST /v1/openp2p/trades (requires the
      // active session; the server derives the counterparty from it,
      // trade.routes.ts). This is the real trade.service.ts's
      // createTrade(), which also walks the offer's real Intent through
      // DISCOVERING -> MATCHED -> NEGOTIATING (RFC-018) — not a client-
      // side mock Trade built from whatever was picked here.
      const trade = await sailsClient.openp2p.trade(offer.id, String(amountNum), tradeIdempotencyKeyRef.current, binding?.accountHash)
      // A NEW key for whatever this user does next — this one is now
      // either COMPLETED or (if the whole request somehow still fails
      // downstream of trade creation) irrelevant, since navigation below
      // leaves this screen.
      tradeIdempotencyKeyRef.current = crypto.randomUUID()
      toast.success('Trade iniciado')
      navigate(`/trade/${trade.id}`, { state: { offer, amount: amountNum } })
    } catch (err) {
      toast.error(tradeAdmissionRefusalMessage(err) ?? (err instanceof Error ? err.message : 'Falha ao iniciar trade'))
    } finally {
      setStartingTrade(false)
    }
  }

  return (
    <div>
      <Link to="/" className="text-sm text-brand-text-secondary hover:text-brand-text flex items-center gap-1 w-fit">
        <ArrowLeft className="h-4 w-4" /> Voltar ao Marketplace
      </Link>

      <div className="mt-4 grid lg:grid-cols-[1fr_360px] gap-6">
        <div>
          <Card className="p-6">
            <div className="flex gap-2">
              <AssetBadge asset={offer.asset} />
              <SideBadge side={offer.side} />
              <PaymentBadge method={offer.paymentMethod} />
            </div>
            <div className="mt-4 text-4xl font-display font-bold tabular-nums text-brand-text">{formatByCurrency(offer.priceFiat, offer.fiatCurrency)}</div>
            <div className="text-sm text-brand-text-muted mt-1">
              por {ASSET_LABELS[offer.asset]}
              {offer.fiatCurrency !== 'USD' && ` · ≈ $${offer.priceUsd} USD`}
            </div>
          </Card>

          <Card className="mt-4 p-5">
            <div className="flex items-center gap-3">
              <UserAvatar user={offer.seller} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold flex items-center gap-1.5 flex-wrap text-brand-text">
                  {offer.seller.displayName}
                  {offer.seller.verified && (
                    <span title="Verificado">
                      <Check className="h-4 w-4 text-brand-orange-accent" />
                    </span>
                  )}
                  {isPowerTraderFromCanonical(offer.seller) && <PowerTraderBadge />}
                </div>
              </div>
              <FavoriteButton userId={offer.seller.id} />
            </div>

            <div className="mt-4">
              <div className="flex justify-between text-xs text-brand-text-muted mb-1">
                <span>Reputação</span>
                <span className="font-semibold text-brand-text">{offer.seller.reputationScore.toFixed(1)} / 100</span>
              </div>
              <div className="h-1.5 bg-brand-elevated rounded-full">
                <div className="h-1.5 bg-brand-orange-accent rounded-full" style={{ width: `${offer.seller.reputationScore}%` }} />
              </div>
            </div>

            {/* Technical Debt #61 — Total Trades / Dispute Rate / Reputation,
                exactly the canonical public disclosure contract's own
                fields (docs/TECHNICAL_DEBT_AUDIT.md #61); raw disputeCount,
                totalVolumeBtc, and "member since" are no longer part of the
                public response and are not reconstructed here. */}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="bg-brand-elevated rounded-lg p-2">
                <div className="font-bold text-brand-text">{offer.seller.totalTrades}</div>
                <div className="text-xs text-brand-text-muted">trades</div>
              </div>
              <div className="bg-brand-elevated rounded-lg p-2">
                <div className="font-bold text-brand-text">{disputeRatePct(offer.seller.disputeRate)}%</div>
                <div className="text-xs text-brand-text-muted">taxa de disputas</div>
              </div>
              <div className="bg-brand-elevated rounded-lg p-2">
                <div className="font-bold text-brand-text">{offer.seller.reputationScore.toFixed(1)}</div>
                <div className="text-xs text-brand-text-muted">reputação</div>
              </div>
            </div>
          </Card>

          <Card className="mt-4 divide-y divide-brand-border">
            <Row label="Rede" value={offer.network ?? '—'} />
            <Row label="Método de pagamento" value={PAYMENT_METHOD_LABELS[offer.paymentMethod]} />
            <Row label="Limites" value={`${formatAmount(offer.minAmount)} – ${formatAmount(offer.maxAmount)} ${ASSET_SHORT_LABELS[offer.asset]}`} />
          </Card>
        </div>

        <div className="lg:sticky lg:top-20 h-fit">
          {isOwnOffer ? (
            <Card className="p-5">
              <h3 className="font-semibold text-brand-text">Esta é a sua oferta</h3>
              <p className="text-sm text-brand-text-muted mt-2">
                Você não pode iniciar uma negociação com o seu próprio anúncio.
                Gerencie-o em "Minhas Ofertas", no seu perfil.
              </p>
              <Link to="/profile" className={cn(buttonVariants({ variant: 'outline', className: 'mt-4 w-full py-3 text-sm text-center block' }))}>
                Ir para Minhas Ofertas
              </Link>
            </Card>
          ) : (
            <Card className="p-5">
              <h3 className="font-semibold text-brand-text">Iniciar negociação</h3>

              <label className="block text-xs text-brand-text-muted mt-4 mb-1">
                Quanto você quer {offer.side === 'SELL' ? 'comprar' : 'vender'}?
                <div className="relative">
                  <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    type="number"
                    className="w-full text-lg font-bold"
                    placeholder="0.00"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-brand-text-muted">{ASSET_SHORT_LABELS[offer.asset]}</span>
                </div>
              </label>
              {amount && !withinLimits && (
                <p className="text-xs text-red-500 mt-1">Fora do limite: {formatAmount(offer.minAmount)} – {formatAmount(offer.maxAmount)}</p>
              )}

              <div className="mt-4 pt-4 border-t border-brand-border">
                <div className="text-xs text-brand-text-muted">Você {offer.side === 'SELL' ? 'paga' : 'recebe'}</div>
                <div className="text-2xl font-display font-bold tabular-nums mt-1 text-brand-text">{formatByCurrency(totalFiat || 0, offer.fiatCurrency)}</div>
              </div>

              <div className="mt-4 bg-brand-orange-accent/5 border border-brand-orange-accent/20 rounded-lg p-3 text-xs text-brand-text-secondary flex items-start gap-2">
                <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                Escrow não custodial — fundos só liberados após confirmação de pagamento.
              </div>

              {/* HodlHodl/Binance P2P both show this exact caution before
                  a first trade with a brand-new counterparty — real data
                  (offer.seller.totalTrades), not mocked: a real 0 here means
                  a real trader with no completed trades yet. */}
              {offer.seller.totalTrades === 0 && (
                <div className="mt-3 bg-yellow-500/10 border border-yellow-500/25 rounded-lg p-3 text-xs text-yellow-500 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Este vendedor ainda não concluiu nenhum trade — negocie com cautela, especialmente em valores maiores.</span>
                </div>
              )}

              {policyError && (
                <p role="alert" className="mt-3 text-xs text-red-500">
                  Não foi possível verificar a política de escrow protegido. Recarregue a página para continuar.
                </p>
              )}
              {unboundOffer && (
                <div role="alert" className="mt-3 bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-xs text-red-500">
                  Esta oferta foi publicada sem uma conta de recebimento do vendedor vinculada e não pode ser negociada com escrow
                  protegido. Escolha outra oferta.
                </div>
              )}
              {methodBlocked && (
                <div role="alert" className="mt-3 bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-xs text-red-500">
                  {PAYMENT_METHOD_LABELS[offer.paymentMethod]} não é aceito para escrow protegido em {ASSET_SHORT_LABELS[offer.asset]} pela
                  política vigente — esta oferta não pode ser negociada com escrow protegido.
                </div>
              )}
              {takerBindsAccount && (
                <div className="mt-4">
                  <label className="text-xs text-brand-text-muted block">
                    Sua chave de recebimento ({PAYMENT_METHOD_LABELS[offer.paymentMethod]})
                    <Input
                      value={receivingKey}
                      onChange={(e) => setReceivingKey(e.target.value)}
                      className="w-full mt-1.5"
                      placeholder={offer.paymentMethod === 'PIX' ? 'Sua chave PIX' : 'Conta em que você recebe o pagamento'}
                      autoComplete="off"
                    />
                  </label>
                  <label className="mt-2 flex items-start gap-2 text-xs text-brand-text-secondary bg-brand-elevated border border-brand-border rounded-lg p-3">
                    <input
                      type="checkbox"
                      checked={confirmAccountBinding}
                      onChange={(e) => setConfirmAccountBinding(e.target.checked)}
                      disabled={!receivingKey.trim()}
                      className="mt-0.5"
                    />
                    <span>
                      Vincular esta chave como a minha conta de recebimento deste trade. Ela fica registrada na minha conta
                      Sails e é a conta em que o comprador paga — envie-a a ele pelo chat do trade. O escrow protegido só pode
                      ser criado com ela.
                    </span>
                  </label>
                </div>
              )}

              <Button onClick={handleStartTrade} disabled={startingTrade || methodBlocked !== null || unboundOffer} className="mt-4 w-full py-3">
                {startingTrade ? 'Iniciando...' : 'Iniciar Trade'}
              </Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between px-5 py-3 text-sm">
      <span className="text-brand-text-muted">{label}</span>
      <span className="font-medium text-brand-text">{value}</span>
    </div>
  )
}
