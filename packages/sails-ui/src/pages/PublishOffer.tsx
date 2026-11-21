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
 * 2. Non-USD publication is blocked (CTO 118): no validated FX or
 *    multi-fiat contract exists. The entered USD decimal is submitted
 *    unchanged, never calculated from an illustrative rate.
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
import { Link, useNavigate } from 'react-router'
import { toast } from '../components/ui/toast'
import { useAuth } from '../context/AuthContext'
import { AssetPicker } from '../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../components/marketplace/CurrencyPicker'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { SEGMENT_TRACK, segmentItemClass } from '../components/ui/SegmentedControl'
import { cn } from '../lib/utils'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'
import { Combobox } from '../components/ui/combobox'
import { PaymentMethods } from '../components/ui/PaymentMethods'
import { ArrowLeft } from 'lucide-react'
import { fetchOffers } from '../lib/realOffers'
import { ASSETS, PAYMENT_METHODS, COUNTRIES } from '../data/mock'
import { formatByCurrency } from '../lib/currency'
import { publicationPriceUsd } from '../lib/publicationPrice'
import { PAYMENT_METHOD_LABELS } from '../lib/labels'
import { sailsClient } from '../lib/sailsClient'
import { isDemoMode } from '../lib/demoMarkers'
import { MAX_PAYMENT_METHODS } from '../lib/paymentMethods'
import type { AssetType, FiatCurrency, TradeSide } from '../types'

const STEPS = ['Tipo e preço', 'Valor e método', 'Condições']

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
  // comment). The picker offers only `available` catalog pairs (plus the
  // dev test rail), all enum values; this keeps the rest out of the type too.
  const [asset, setAsset] = useState<(typeof ASSETS)[number] | 'Todos'>('Todos')
  const [currency, setCurrency] = useState<FiatCurrency | 'Todas'>('USD')
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
  // Dev demo only: up to MAX_PAYMENT_METHODS methods, stored by the demo backend. The real publish()
  // takes ONE paymentMethod (multi-method contract: issue #735), so real mode keeps the single Select.
  const [demo] = useState(isDemoMode)
  const [demoMethods, setDemoMethods] = useState<(typeof PAYMENT_METHODS)[number][]>(['PIX'])
  const method = demo ? demoMethods[0] : paymentMethod
  const methodsAtLimit = demoMethods.length >= MAX_PAYMENT_METHODS
  const toggleDemoMethod = (m: (typeof PAYMENT_METHODS)[number]) => {
    if (demoMethods.includes(m)) setDemoMethods(demoMethods.filter((x) => x !== m))
    else if (!methodsAtLimit) setDemoMethods([...demoMethods, m])
  }
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
  }, [asset, side, price, currency, minAmount, maxAmount, paymentMethod, demoMethods])

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

  const priceUsd = publicationPriceUsd(price, currency)
  const step1Valid = asset !== 'Todos' && priceType === 'FIXED' && priceUsd !== null
  const step2Valid = Number(minAmount) > 0 && Number(maxAmount) > Number(minAmount) && method !== undefined && paymentDetails.trim().length > 0

  const goNext = () => {
    if (step === 1 && !step1Valid) {
      toast.error('Selecione o ativo, a moeda e informe um preço válido')
      return
    }
    if (step === 2 && !step2Valid) {
      toast.error(method === undefined ? 'Escolha ao menos um método de pagamento' : 'Informe limites válidos e os detalhes do pagamento')
      return
    }
    setStep((s) => Math.min(s + 1, 3))
  }

  const [publishing, setPublishing] = useState(false)

  const handlePublish = async () => {
    if (!user || asset === 'Todos') return
    if (priceUsd === null || priceType !== 'FIXED') {
      toast.error('Publicação disponível apenas com preço fixo em USD válido, sem conversão de câmbio.')
      return
    }
    if (!step2Valid || method === undefined) {
      toast.error('Informe limites válidos e os detalhes do pagamento')
      return
    }

    setPublishing(true)
    try {
      // Real @satsails/p2p-trading-sdk call — POST /v1/liquidity/offers (requires the
      // active session identity.authenticate() already established).
      // priceUsd/minAmount/maxAmount as decimal strings, never number
      // (RFC-009 — packages/sails-sdk/src/types.ts's own header comment).
      await sailsClient.liquidity.publish({
        asset,
        side,
        priceUsd,
        minAmount: minAmount,
        maxAmount: maxAmount,
        paymentMethod: method,
        // Demo backend only; never part of a real request (the SDK input has no such field).
        ...(demo ? { demoPaymentMethods: demoMethods } : {}),
        paymentDetails: paymentDetails.trim(),
        network: NETWORK_BY_ASSET[asset],
        description: description.trim() || undefined,
        idempotencyKey: offerIdempotencyKeyRef.current,
      })
      offerIdempotencyKeyRef.current = crypto.randomUUID() // this attempt is now settled — a new key for whatever comes next
      toast.success('Oferta publicada')
      navigate(TRADES_ROUTES.offers)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao publicar oferta')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Page width="form">
      <PageHeader
        back={
          <Link to={TRADES_ROUTES.offers} className="min-h-11 md:min-h-0 text-body-sm text-brand-text-secondary hover:text-brand-text inline-flex items-center gap-1 w-fit">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Minhas ofertas
          </Link>
        }
        title="Publicar oferta"
      />

      <Card>
        {/* One-line stepper in the card header. */}
        <ol aria-label="Etapas" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 border-b border-brand-border-subtle">
          {STEPS.map((label, i) => {
            const n = i + 1
            const current = n === step
            return (
              <li key={label} aria-current={current ? 'step' : undefined} className="flex items-center gap-2 text-body-sm">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${n <= step ? 'bg-primary text-primary-foreground' : 'bg-brand-elevated text-brand-text-muted'}`}>
                  {n}
                </span>
                <span className={current ? 'text-brand-text font-medium' : 'text-brand-text-muted'}>{label}</span>
                {n < STEPS.length && <span aria-hidden="true" className="w-6 h-px bg-brand-border-subtle" />}
              </li>
            )
          })}
        </ol>
      <div className="p-5">
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block" id="publish-side-label">Eu quero</label>
              <div role="group" aria-labelledby="publish-side-label" className={cn('flex gap-1', SEGMENT_TRACK)}>
                {(['SELL', 'BUY'] as TradeSide[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSide(s)}
                    aria-pressed={side === s}
                    className={cn('flex-1 h-8 touch:h-11', segmentItemClass(side === s))}
                  >
                    {s === 'SELL' ? 'Vender' : 'Comprar'}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 [&_.toolbar-chip]:w-full">
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">Ativo</label>
                <AssetPicker
                  allLabel="Selecione o ativo"
                  hideAllOption
                  value={asset}
                  onChange={(a) => setAsset(a as (typeof ASSETS)[number] | 'Todos')}
                />
              </div>
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">com moeda fiduciária</label>
                <CurrencyPicker value={currency} onChange={setCurrency} />
                <p className="text-xs text-brand-text-muted mt-1.5" role="status">
                  {currency === 'USD'
                    ? 'Preço informado em USD, sem conversão de câmbio.'
                    : 'Publicação nesta moeda indisponível. Selecione USD; conversão de câmbio ainda não habilitada.'}
                </p>
              </div>
            </div>

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 flex items-center gap-1">
                Tipo de preço
                <InfoTooltip text="Flutuante (atrelado a uma cotação de mercado ao vivo) ainda não é suportado — não existe integração com uma fonte de câmbio em tempo real no backend hoje. Publicar sempre envia um preço fixo." />
              </label>
              <Select value={priceType} onValueChange={(v) => setPriceType(v as 'FIXED' | 'FLOATING')}>
                <SelectTrigger aria-label="Tipo de preço" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FIXED">Fixo</SelectItem>
                  <SelectItem value="FLOATING" disabled>Flutuante (em breve)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {priceType === 'FIXED' ? (
              <div>
                <label className="text-xs text-brand-text-muted mb-1.5 block">Preço fixo</label>
                <div className="flex items-center input-field field-focus-within !p-0 h-9 touch:h-11">
                  <button onClick={() => setPrice(String(Math.max(0, Number(price || 0) - 1)))} aria-label="Diminuir preço" className="h-full min-w-11 px-3 rounded-lg text-brand-text-secondary hover:text-brand-text focus-visible:-outline-offset-2">−</button>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    type="number"
                    aria-label="Preço fixo"
                    className="flex-1 min-w-0 bg-transparent text-center text-field font-medium tabular-nums outline-none text-brand-text [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="0"
                  />
                  <button onClick={() => setPrice(String(Number(price || 0) + 1))} aria-label="Aumentar preço" className="h-full min-w-11 px-3 rounded-lg text-brand-text-secondary hover:text-brand-text focus-visible:-outline-offset-2">+</button>
                </div>
                {loadingSuggestedRange && (
                  <p className="text-xs text-brand-text-muted mt-1.5">Buscando faixa de preço…</p>
                )}
                {!loadingSuggestedRange && suggestedRange && (
                  <p className="text-xs text-brand-text-muted mt-1.5">
                    Faixa de preço sugerida: {formatByCurrency(suggestedRange.min, currency as FiatCurrency)} – {formatByCurrency(suggestedRange.max, currency as FiatCurrency)}
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-brand-elevated rounded-md p-3 text-xs text-brand-text-secondary">
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

            {demo ? (
            <div>
              <span className="text-xs text-brand-text-muted mb-1.5 block" aria-hidden="true">Métodos de pagamento</span>
              <Combobox
                multiple
                label="Métodos de pagamento"
                valueText={`${demoMethods.length} de ${MAX_PAYMENT_METHODS}${demoMethods.length ? `, ${demoMethods.map((m) => PAYMENT_METHOD_LABELS[m]).join(', ')}` : ''}`}
                options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m], disabled: methodsAtLimit && !demoMethods.includes(m) }))}
                selected={demoMethods}
                onSelect={toggleDemoMethod}
                triggerClassName="w-full"
                contentClassName="w-[var(--radix-popover-trigger-width)]"
                trigger={<span className="truncate">{demoMethods.length === 0 ? 'Selecione os métodos' : demoMethods.length === 1 ? PAYMENT_METHOD_LABELS[demoMethods[0]] : `${demoMethods.length} métodos`}</span>}
                searchPlaceholder="Buscar método de pagamento…"
                emptyText={() => 'Nenhum método encontrado com esse nome.'}
                footer={methodsAtLimit ? () => (
                  <p className="px-3 py-2 text-xs text-brand-text-secondary">Limite de {MAX_PAYMENT_METHODS} métodos atingido. Remova um para escolher outro.</p>
                ) : undefined}
              />
              {demoMethods.length > 1 && <PaymentMethods labels={demoMethods.map((m) => PAYMENT_METHOD_LABELS[m])} className="mt-2" />}
              <p role="status" className="text-xs text-brand-text-muted mt-1.5">
                <span className="tabular-nums">{demoMethods.length} de {MAX_PAYMENT_METHODS}</span>
                {demoMethods.length === 0 ? ' · Escolha ao menos um método.' : methodsAtLimit ? ` · Limite de ${MAX_PAYMENT_METHODS} métodos atingido.` : ''}
              </p>
              <p className="text-xs text-brand-text-muted mt-1">Modo demonstração: vários métodos existem só nesta simulação. Uma oferta real aceita um método.</p>
            </div>
            ) : (
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
            )}

            <div>
              <label className="text-xs text-brand-text-muted mb-1.5 block">
                Detalhes do pagamento
                <Input
                  value={paymentDetails}
                  onChange={(e) => setPaymentDetails(e.target.value)}
                  className="w-full mt-1.5"
                  placeholder={method === 'PIX' ? 'Sua chave PIX' : 'Dados para o comprador enviar o pagamento'}
                />
              </label>
            </div>
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
                placeholder="Instruções extras para a contraparte…"
              />
            </div>
          </div>
        )}
      </div>

      {/* Actions in the card footer: back on the left, the one primary on the right. */}
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-brand-border-subtle">
        {step > 1 ? (
          <Button variant="ghost" onClick={() => setStep((s) => s - 1)} className="min-h-10 touch:min-h-11">
            Voltar
          </Button>
        ) : <span />}
        {step < 3 ? (
          <Button onClick={goNext} disabled={step === 1 ? !step1Valid : !step2Valid} className="min-h-10 touch:min-h-11 px-6">
            Próximo
          </Button>
        ) : (
          <Button onClick={handlePublish} loading={publishing} disabled={!step1Valid || !step2Valid} className="min-h-10 touch:min-h-11 px-6">
            {publishing ? 'Publicando…' : 'Publicar oferta'}
          </Button>
        )}
      </div>
      </Card>
    </Page>
  )
}
