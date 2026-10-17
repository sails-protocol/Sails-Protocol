/**
 * "Publicar Anúncio" — a 3-step wizard matching the Binance P2P ad-
 * posting flow, requested directly with a reference screenshot: Definir
 * tipo e preço → Definir valor e método → Definir condições.
 *
 * Every field that reaches `handlePublish()`'s final `Offer` object maps
 * onto a real field in the backend's `CreateOfferInput`
 * (`src/modules/open-liquidity/liquidity.service.ts`, checked before
 * building this): asset, side, priceUsd, priceBrl, minAmount, maxAmount,
 * paymentMethod, paymentDetails, network, description.
 * `requiresKyc` was removed 2026-08-09 (project correction: the protocol
 * is non-custodial and never centralizes identity/visibility — see
 * `docs/SECURITY_MODEL.md`'s "no KYC at the protocol level" principle;
 * a per-offer identity-verification flag doesn't belong here even as an
 * opt-in). Two things in this wizard are honestly NOT backed by that real shape:
 *
 * 1. "Tipo de Preço: Flutuante" (a price pegged to a live market rate,
 *    matching Binance's own picker) — `liquidity.service.ts` has no live
 *    FX/price-feed integration at all (`lib/currency.ts`'s
 *    `AMOUNT_PRESETS` comment already flags this same gap). Selectable
 *    in the UI for fidelity to the reference screenshot, but disabled
 *    with an explanatory tooltip — publishing always sends a fixed price.
 * 2. `priceUsd` itself, when the user prices in a non-USD currency —
 *    derived from `lib/currency.ts`'s `ILLUSTRATIVE_FX_TO_USD`, the same
 *    "illustrative, not a live rate" honesty boundary `AMOUNT_PRESETS`
 *    already uses, since `CreateOfferInput.priceUsd` is mandatory on the
 *    real backend regardless of which fiat the user prices in.
 *
 * `handlePublish()` calls the real `sailsClient.liquidity.publish()`
 * (`POST /v1/liquidity/offers`) directly (corrected 2026-08-04 — this
 * comment used to say otherwise, back when `lib/offersStore.ts`/
 * `localStorage` stood in for it; that file is gone now). The step-1
 * "suggested price range" hint also reads real comparable offers now
 * (`lib/realOffers.ts`'s `fetchOffers()`, same `liquidity.discover()`
 * fan-out Marketplace.tsx uses) instead of the seed `MOCK_OFFERS` —
 * filtered to the same side being published (if you're selling, you
 * want to see what other sellers charge, not buyers' bids), unlike the
 * old mock filter, which ignored side entirely.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth } from '../context/AuthContext'
import { AssetPicker } from '../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../components/marketplace/CurrencyPicker'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'
import { ArrowLeft } from 'lucide-react'
import { fetchOffers } from '../lib/realOffers'
import { ASSETS, PAYMENT_METHODS, COUNTRIES } from '../data/mock'
import { ILLUSTRATIVE_FX_TO_USD, formatByCurrency } from '../lib/currency'
import { PAYMENT_METHOD_LABELS } from '../lib/labels'
import { sailsClient } from '../lib/sailsClient'
import { bindSellerPaymentAccount, protectedEscrowEligibility } from '../lib/paymentAccountBinding'
import type { EconomicPolicy, AssetType as SdkAssetType } from '@satsails/p2p-trading-sdk'
import type { AssetType, FiatCurrency, TradeSide } from '../types'

const STEPS = ['Definir tipo e preço', 'Definir valor e método', 'Definir condições']

const NETWORK_BY_ASSET: Partial<Record<AssetType, string>> = {
  BTC: 'bitcoin', LN_BTC: 'lightning', LIQUID_BTC: 'liquid',
  USDT_ERC20: 'ethereum', USDT_TRC20: 'tron', USDT_LIQUID: 'liquid', USDT_LIGHTNING: 'lightning',
}

export function PublishOffer() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)

  // Step 1
  const [side, setSide] = useState<TradeSide>('SELL')
  // Narrower than the UI's own `AssetType` on purpose — same reasoning
  // as `paymentMethod` below: this page submits straight to the real
  // `liquidity.publish()` call, which has no `DEPIX` (see types.ts's own
  // comment). `ASSETS` (not `ASSETS_FILTERABLE`) already keeps it out of
  // the picker's options; this keeps it out of the type too.
  const [asset, setAsset] = useState<(typeof ASSETS)[number] | 'Todos'>('Todos')
  const [currency, setCurrency] = useState<FiatCurrency | 'Todas'>('BRL')
  const [priceType, setPriceType] = useState<'FIXED' | 'FLOATING'>('FIXED')
  const [price, setPrice] = useState('')

  // Step 2
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  // Narrower than the UI's own `PaymentMethod` type on purpose: this
  // page submits straight to the real `liquidity.publish()` call
  // (@satsails/p2p-trading-sdk's real, backend-matching `PaymentMethod`), which has
  // none of the UI-only additions researched in from HodlHodl/Airtm/El
  // Dorado/Noones (see types.ts's own comment). Derived directly from
  // `PAYMENT_METHODS` (the real list, already what the <select>'s
  // options use below) rather than hand-listing every UI-only value to
  // exclude — stays correct automatically if that list ever grows again.
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>('PIX')
  const [paymentDetails, setPaymentDetails] = useState('')

  // Step 3
  const [country, setCountry] = useState('BR')
  const [description, setDescription] = useState('')

  // Real comparable-offer prices (2026-08-04) — same liquidity.discover()
  // fan-out Marketplace.tsx uses, scoped to a single (asset, side) pair
  // here so it's one real request, not twenty. Filtered by `side` too,
  // unlike the old MOCK_OFFERS-based version: a seller wants to see
  // what other sellers charge, not the buy-side spread.
  const [suggestedRange, setSuggestedRange] = useState<{ min: number; max: number } | null>(null)
  const [loadingSuggestedRange, setLoadingSuggestedRange] = useState(false)

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37, 2026-09-13) — one
  // idempotency key per genuinely-new "publish this offer" intent,
  // reused across a manual retry of the SAME attempt, regenerated
  // whenever an economically-relevant field changes (a different price/
  // amount/payment method is a different logical offer, never a retry
  // of the prior one) — mirrors the server's own requestHash fields in
  // `liquidity.service.ts`'s `createOffer()`. See
  // `sailsClient.liquidity.publish()`'s own doc comment for the full
  // contract this closes.
  const offerIdempotencyKeyRef = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    offerIdempotencyKeyRef.current = crypto.randomUUID()
  }, [asset, side, price, currency, minAmount, maxAmount, paymentMethod, paymentDetails])

  // #235 R7H-E3B — a SELL offer on a rail the trade-limit policy governs (V1: BTC/MULTISIG) can carry a protected
  // escrow only if its payment method is eligible and the seller's receiving account is bound to it. The policy
  // comes from the server (GET /v1/settlement/economic-policy); without it nothing is published (fail closed).
  const [policy, setPolicy] = useState<EconomicPolicy | null>(null)
  const [policyError, setPolicyError] = useState(false)
  const [confirmAccountBinding, setConfirmAccountBinding] = useState(false)
  useEffect(() => {
    let cancelled = false
    sailsClient.settlement.economicPolicy()
      .then((p) => { if (!cancelled) setPolicy(p) })
      .catch(() => { if (!cancelled) setPolicyError(true) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { setConfirmAccountBinding(false) }, [side, asset, paymentMethod, paymentDetails])
  const eligibility = policy && asset !== 'Todos' ? protectedEscrowEligibility(policy, asset as SdkAssetType, paymentMethod) : null
  const protectedSell = side === 'SELL' && eligibility?.governed === true
  const methodBlocked = eligibility?.governed === true && !eligibility.eligible ? eligibility : null

  useEffect(() => {
    if (asset === 'Todos' || currency === 'Todas') {
      setSuggestedRange(null)
      return
    }
    let cancelled = false
    setLoadingSuggestedRange(true)
    fetchOffers(asset, side)
      .then(({ offers }) => {
        if (cancelled) return
        const comparable = offers.filter((o) => o.fiatCurrency === currency)
        if (comparable.length === 0) {
          setSuggestedRange(null)
          return
        }
        const prices = comparable.map((o) => o.priceFiat)
        setSuggestedRange({ min: Math.min(...prices), max: Math.max(...prices) })
      })
      .catch(() => { if (!cancelled) setSuggestedRange(null) })
      .finally(() => { if (!cancelled) setLoadingSuggestedRange(false) })
    return () => { cancelled = true }
  }, [asset, side, currency])

  const step1Valid = asset !== 'Todos' && currency !== 'Todas' && Number(price) > 0
  const step2Valid = Number(minAmount) > 0 && Number(maxAmount) > Number(minAmount) && paymentDetails.trim().length > 0
    && policy !== null && !methodBlocked && (!protectedSell || confirmAccountBinding)

  const goNext = () => {
    if (step === 1 && !step1Valid) {
      toast.error('Selecione o ativo, a moeda e informe um preço válido')
      return
    }
    if (step === 2 && !step2Valid) {
      toast.error(
        policy === null ? 'Não foi possível verificar a política de escrow protegido — recarregue a página.'
          : methodBlocked ? 'Este método de pagamento não é aceito para escrow protegido neste ativo.'
            : protectedSell && !confirmAccountBinding && paymentDetails.trim() ? 'Confirme o vínculo da sua chave de recebimento ao anúncio.'
              : 'Informe limites válidos e os detalhes do pagamento',
      )
      return
    }
    setStep((s) => Math.min(s + 1, 3))
  }

  const [publishing, setPublishing] = useState(false)

  const handlePublish = async () => {
    if (!user || asset === 'Todos' || currency === 'Todas') return

    const priceFiat = Number(price)
    // Real CreateOfferInput.priceUsd is mandatory regardless of which
    // fiat the offer is priced in — see this file's own doc comment for
    // why this conversion is illustrative, not live.
    //
    // Bug fixed here (found by e2e/flows/*.spec.ts using small BRL test
    // prices): this used to round to 2 decimals with `.toFixed(2)`
    // *before* the `.toFixed(8)` decimal-string conversion below — any
    // BRL price whose USD equivalent was under half a cent silently
    // became priceUsd="0.00000000", a real, live, non-obvious offer
    // with a free price. Kept at full precision here; `.toFixed(8)`
    // below is the only rounding step now, matching the column's real
    // Decimal(24,8) precision (RFC-009).
    const priceUsd = currency === 'USD' ? priceFiat : priceFiat * ILLUSTRATIVE_FX_TO_USD[currency]

    if (priceUsd <= 0) {
      toast.error('O preço convertido para USD ficou zerado — informe um preço mais alto')
      return
    }

    setPublishing(true)
    try {
      // #235 R7H-E3B — a protected SELL offer commits the seller's receiving account first: registered (or
      // re-resolved) and proven to belong to this seller, or nothing is published.
      const binding = protectedSell ? await bindSellerPaymentAccount(sailsClient, user.id, paymentMethod, paymentDetails) : null
      // Real @satsails/p2p-trading-sdk call — POST /v1/liquidity/offers (requires the
      // active session identity.authenticate() already established).
      // priceUsd/minAmount/maxAmount as decimal strings, never number
      // (RFC-009 — packages/sails-sdk/src/types.ts's own header comment).
      await sailsClient.liquidity.publish({
        asset,
        side,
        priceUsd: priceUsd.toFixed(8),
        priceBrl: currency === 'BRL' ? priceFiat.toFixed(8) : undefined,
        minAmount: minAmount,
        maxAmount: maxAmount,
        paymentMethod,
        paymentDetails: paymentDetails.trim(),
        network: NETWORK_BY_ASSET[asset],
        description: description.trim() || undefined,
        idempotencyKey: offerIdempotencyKeyRef.current,
        ...(binding ? { paymentAccountHash: binding.accountHash } : {}),
      })
      offerIdempotencyKeyRef.current = crypto.randomUUID() // this attempt is now settled — a new key for whatever comes next
      toast.success('Anúncio publicado!')
      navigate('/profile')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao publicar anúncio')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => (step === 1 ? navigate('/profile') : setStep((s) => s - 1))} className="p-2 -m-2 text-brand-text-secondary hover:text-brand-text">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-display font-bold text-brand-text">Publicar Anúncio</h1>
      </div>

      <div className="flex items-center mb-8">
        {STEPS.map((label, i) => {
          const n = i + 1
          const active = n <= step
          return (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${active ? 'bg-brand-orange text-white' : 'bg-brand-elevated text-brand-text-muted'}`}>
                  {n}
                </div>
                <span className={`text-[10px] text-center max-w-[70px] ${active ? 'text-brand-text font-medium' : 'text-brand-text-muted'}`}>{label}</span>
              </div>
              {n < STEPS.length && <div className={`flex-1 h-px mx-2 mb-4 ${step > n ? 'bg-brand-orange-accent' : 'bg-brand-border'}`} />}
            </div>
          )
        })}
      </div>

      <Card className="p-5">
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block" id="publish-side-label">Eu quero</label>
              <div role="group" aria-labelledby="publish-side-label" className="flex gap-1 bg-brand-elevated rounded-lg p-1">
                {(['SELL', 'BUY'] as TradeSide[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSide(s)}
                    aria-pressed={side === s}
                    className={`flex-1 rounded-md py-2 text-sm transition-colors ${side === s ? 'bg-brand-surface shadow-sm font-medium text-brand-text' : 'text-brand-text-secondary'}`}
                  >
                    {s === 'SELL' ? 'Vender' : 'Comprar'}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">Ativo</label>
                <AssetPicker
                  assets={ASSETS}
                  value={asset}
                  onChange={(a) => setAsset(a as (typeof ASSETS)[number] | 'Todos')}
                />
              </div>
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">com moeda fiduciária</label>
                <CurrencyPicker value={currency} onChange={setCurrency} />
              </div>
            </div>

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 flex items-center gap-1">
                Tipo de Preço
                <InfoTooltip text="Flutuante (atrelado a uma cotação de mercado ao vivo) ainda não é suportado — não existe integração com uma fonte de câmbio em tempo real no backend hoje. Publicar sempre envia um preço fixo." />
              </label>
              <Select value={priceType} onValueChange={(v) => setPriceType(v as 'FIXED' | 'FLOATING')}>
                <SelectTrigger aria-label="Tipo de Preço" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FIXED">Fixo</SelectItem>
                  <SelectItem value="FLOATING">Flutuante (em breve)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {priceType === 'FIXED' ? (
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">Preço fixo</label>
                <div className="flex items-center input-field !p-0">
                  <button onClick={() => setPrice(String(Math.max(0, Number(price || 0) - 1)))} aria-label="Diminuir preço" className="px-4 py-3 text-brand-text-secondary hover:text-brand-text">−</button>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    type="number"
                    aria-label="Preço fixo"
                    className="flex-1 bg-transparent text-center text-lg font-bold outline-none text-brand-text"
                    placeholder="0"
                  />
                  <button onClick={() => setPrice(String(Number(price || 0) + 1))} aria-label="Aumentar preço" className="px-4 py-3 text-brand-text-secondary hover:text-brand-text">+</button>
                </div>
                {loadingSuggestedRange && (
                  <p className="text-xs text-brand-text-muted mt-1.5">Buscando faixa de preço...</p>
                )}
                {!loadingSuggestedRange && suggestedRange && (
                  <p className="text-xs text-brand-text-muted mt-1.5">
                    Faixa de preço sugerida: {formatByCurrency(suggestedRange.min, currency as FiatCurrency)} – {formatByCurrency(suggestedRange.max, currency as FiatCurrency)}
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-brand-elevated border border-brand-border rounded-lg p-3 text-xs text-brand-text-muted">
                Preço flutuante ainda não suportado neste protótipo — selecione "Fixo" para continuar.
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">
                  Quantidade mínima
                  <Input value={minAmount} onChange={(e) => setMinAmount(e.target.value)} type="number" className="w-full mt-1.5" placeholder="0.00" />
                </label>
              </div>
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">
                  Quantidade máxima
                  <Input value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} type="number" className="w-full mt-1.5" placeholder="0.00" />
                </label>
              </div>
            </div>

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block">Método de pagamento</label>
              <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as (typeof PAYMENT_METHODS)[number])}>
                <SelectTrigger aria-label="Método de pagamento" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {policyError && (
              <p role="alert" className="text-xs text-red-500">
                Não foi possível verificar a política de escrow protegido. Recarregue a página para continuar.
              </p>
            )}
            {methodBlocked && (
              <div role="alert" className="bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-xs text-red-500">
                {PAYMENT_METHOD_LABELS[paymentMethod]} não é aceito para escrow protegido em {asset} pela política vigente
                {methodBlocked.eligibleMethods.length > 0
                  ? ` — use ${methodBlocked.eligibleMethods.map((m) => PAYMENT_METHOD_LABELS[m]).join(', ')}.`
                  : '.'}
              </div>
            )}

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block">
                {protectedSell ? 'Sua chave de recebimento' : 'Detalhes do pagamento'}
                <Input
                  value={paymentDetails}
                  onChange={(e) => setPaymentDetails(e.target.value)}
                  className="w-full mt-1.5"
                  placeholder={paymentMethod === 'PIX' ? 'Sua chave PIX' : 'Dados para o comprador enviar o pagamento'}
                />
              </label>
            </div>

            {protectedSell && !methodBlocked && (
              <label className="flex items-start gap-2 text-xs text-brand-text-secondary bg-brand-elevated border border-brand-border rounded-lg p-3">
                <input
                  type="checkbox"
                  checked={confirmAccountBinding}
                  onChange={(e) => setConfirmAccountBinding(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Vincular esta chave como a minha conta de recebimento deste anúncio. Ela fica registrada na minha conta
                  Sails e é a conta em que o comprador paga; o escrow protegido só pode ser criado com ela.
                </span>
              </label>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block">País/Região</label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger aria-label="País/Região" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block">Descrição (opcional)</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full"
                rows={3}
                placeholder="Instruções extras para a contraparte..."
              />
            </div>
          </div>
        )}
      </Card>

      <div className="mt-6 flex gap-2">
        {step > 1 && (
          <Button variant="outline" onClick={() => setStep((s) => s - 1)} className="flex-1 py-3">
            Voltar
          </Button>
        )}
        {step < 3 ? (
          <Button onClick={goNext} className="flex-1 py-3">
            Próximo
          </Button>
        ) : (
          <Button onClick={handlePublish} disabled={publishing} className="flex-1 py-3">
            {publishing ? 'Publicando...' : 'Publicar'}
          </Button>
        )}
      </div>
    </div>
  )
}
