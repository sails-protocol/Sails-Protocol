/**
 * Layer C: the paid part of "Criar mercado" (PO, 2026-11-22: buying a space is part of creating a market; one entry
 * point). A Satsails commercial service, kept in its own module (lib/spaceCatalog.ts), never in the markets/SDK code;
 * the Sails Protocol stays permissionless (developers create markets with the SDKs without paying).
 * - SpaceTypePicker: the three kinds of space, each with its demo price and "pagamento único". Disabled in real mode.
 * - SpaceCheckout: demo only. Revisar e pagar (asset and a network the asset catalog lists, a demo equivalent at a FIXED
 *   fictional quote) → simulated payment (Aguardando → Confirmando (simulado) → Pagamento confirmado). Never an
 *   address, QR code, copy button or invoice: someone could send real funds.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleSlash } from 'lucide-react'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { AssetLogo, AssetPairIcon } from '../../components/ui/AssetIcon'
import { ASSET_CATALOG, ASSET_LOGO } from '../../lib/assetCatalog'
import { formatAmount, formatUsd } from '../../lib/format'
import {
  FUTURE_PAYMENT_ASSETS, SPACE_PRODUCTS, checkoutNetworks, demoEquivalent, nextCheckoutStep,
  type CheckoutStep, type PayAsset, type SpaceProduct, type SpaceProductId,
} from '../../lib/spaceCatalog'
import { DEMO_QUOTE_USD } from '../../demo/spaceShop'
import { cn } from '../../lib/utils'
import { t } from '../../i18n'

// Only pairs the enum can carry (available, or with a reference rail): never a pair that is only "Em breve".
const PAYABLE_PAIRS = ASSET_CATALOG.filter((p) => p.assetType !== null)
const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'
export const spaceName = (id: SpaceProductId) => t(`shop.product.${id}`)

/** `disabled` (real mode): the kinds as "Em breve", without prices (none is defined). */
export function SpaceTypePicker({ value, onPick, disabled = false }: { value: SpaceProductId | null; onPick: (id: SpaceProductId) => void; disabled?: boolean }) {
  return (
    <div>
      <RadioGroup legend={t('spaces.create.chooseType')} legendHidden listClassName="grid gap-2 md:grid-cols-3">
        {SPACE_PRODUCTS.map((p) => (
          <RadioCard key={p.id} name="space-product" value={p.id} checked={value === p.id} disabled={disabled} onChange={() => onPick(p.id)} className="h-full items-start">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">{spaceName(p.id)}{disabled && <Badge variant="outline" className={TAG}>{t('common.soon')}</Badge>}</span>
              <span className="mt-0.5 block text-caption font-normal text-brand-text-secondary">{t(`shop.product.${p.id}Description`)}</span>
              <span className="mt-1 block text-caption font-normal text-brand-text-secondary">{t('spaces.hosting.cardLine')}</span>
              {!disabled && (
                <>
                  <span className="mt-2 block text-caption font-normal text-brand-text-muted">{t('shop.priceLabel')}</span>
                  <span className="block tabular-nums text-subheading">{formatUsd(p.demoPriceUsd)}</span>
                  <span className="block text-caption font-normal text-brand-text-secondary">{t('shop.oneTime')}</span>
                </>
              )}
            </span>
          </RadioCard>
        ))}
      </RadioGroup>
      {!disabled && <p className="mt-2 text-caption text-brand-text-muted">{t('shop.notFinal')}</p>}
      <p className="mt-1 text-body-sm text-brand-text-secondary">{t('shop.developers')}</p>
      <p className="mt-1 text-caption text-brand-text-secondary">{t('spaces.create.merchantNote')}</p>
    </div>
  )
}

function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <dt className="text-caption text-brand-text-muted sm:w-44 sm:shrink-0">{k}</dt>
          <dd className="min-w-0 break-words tabular-nums text-body-sm text-brand-text">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** `rows` = the market summary (name, type, rules…) shown above the payment. */
export function SpaceCheckout({ product, rows, images, primary, stepLabel, onBack, onPaid }: {
  product: SpaceProduct
  rows: readonly (readonly [string, string])[]
  /** The person's own local previews (icon, banner), shown as thumbnails on the review. */
  images?: { icon: string | null; banner: string | null }
  /** Solid orange only with a session (the topbar holds it otherwise). */
  primary: 'default' | 'secondary'
  /** The outer flow's counter ("Passo 3 de 4: Pagar"). */
  stepLabel?: string
  onBack: () => void
  onPaid: () => void
}) {
  const [asset, setAsset] = useState<PayAsset>('BTC')
  const networks = checkoutNetworks(asset, PAYABLE_PAIRS)
  const [pairId, setPairId] = useState(networks[0]?.id ?? '')
  const [step, dispatch] = useReducer(nextCheckoutStep, 'payment' as CheckoutStep)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { headingRef.current?.focus() }, [step === 'payment'])
  // After the simulated payment, straight to "Mercado criado" (no confirmed screen next to an address placeholder).
  useEffect(() => { if (step === 'catalog') onBack(); else if (step === 'confirmed') dispatch({ type: 'next' }); else if (step === 'acquired') onPaid() }, [step, onBack, onPaid])
  // "Confirmando (simulado)" lasts about a second, or none when the system asks for less motion.
  useEffect(() => {
    if (step !== 'confirming') return
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => dispatch({ type: 'settled' }), reduce ? 0 : 1000)
    return () => window.clearTimeout(id)
  }, [step])

  const pair = networks.find((p) => p.id === pairId) ?? networks[0]
  const amount = demoEquivalent(product.demoPriceUsd, asset, DEMO_QUOTE_USD[asset])
  const amountText = amount === null ? t('common.soon') : `${formatAmount(amount, asset === 'BTC' ? 8 : 2)} ${asset}`
  const pickAsset = (a: PayAsset) => { setAsset(a); setPairId(checkoutNetworks(a, PAYABLE_PAIRS)[0]?.id ?? '') }
  const title = t(step === 'payment' ? 'spaces.create.reviewAndPay' : step === 'confirmed' ? 'shop.status.confirmedShort' : 'shop.step.awaiting')
  const back = (label = t('markets.create.back')) => (
    <Button type="button" variant="ghost" onClick={() => dispatch({ type: 'back' })} className="touch:min-h-11"><ArrowLeft aria-hidden="true" />{label}</Button>
  )

  return (
    <div className="space-y-4">
      {/* One counter only: the wizard already numbered its steps, so the paid part is titled, not numbered again. */}
      {stepLabel && <p className="text-caption text-brand-text-secondary">{stepLabel}</p>}
      <h2 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">{title}</h2>
      {/* Visible on every paid step (PO). */}
      <Alert tone="warning" title={t('shop.demoNotice')} />
      {step === 'payment' ? (
        <div className="space-y-5">
          {images && (images.icon || images.banner) && (
            <div className="flex items-center gap-3">
              {images.icon && <img src={images.icon} alt="" width={48} height={48} className="size-12 rounded-lg object-cover" />}
              {images.banner && <img src={images.banner} alt="" width={144} height={48} className="aspect-[3/1] h-12 rounded-lg object-cover" />}
            </div>
          )}
          <Facts rows={[...rows, [t('shop.receiptProduct'), spaceName(product.id)], [t('shop.priceLabel'), formatUsd(product.demoPriceUsd)]]} />
          <RadioGroup legend={t('shop.pay.assetLegend')} listClassName="grid gap-2 sm:grid-cols-3">
            {FUTURE_PAYMENT_ASSETS.map((a) => {
              // An asset with no pair the enum can carry yet (USDC) is listed as "Em breve", as in the asset catalog.
              const soon = checkoutNetworks(a, PAYABLE_PAIRS).length === 0
              return (
                <RadioCard key={a} name="pay-asset" value={a} checked={asset === a} disabled={soon} onChange={() => pickAsset(a)}>
                  <AssetLogo assetSrc={ASSET_LOGO[a]} size="md" />{a}
                  {soon && <span className="ml-auto text-caption font-normal text-brand-text-secondary">{t('common.soon')}</span>}
                </RadioCard>
              )
            })}
          </RadioGroup>
          <RadioGroup legend={t('shop.pay.networkLegend')} listClassName="grid gap-2 sm:grid-cols-2">
            {networks.map((p) => (
              <RadioCard key={p.id} name="pay-network" value={p.id} checked={pair?.id === p.id} onChange={() => setPairId(p.id)}>
                <AssetPairIcon pair={p} size="md" />{p.networkLabel}
              </RadioCard>
            ))}
          </RadioGroup>
          <Facts rows={[[t('shop.pay.equivalent'), amountText]]} />
          <p className="text-caption text-brand-text-muted">{t('shop.pay.quote', { quote: formatUsd(DEMO_QUOTE_USD[asset]), asset })}</p>
          <ul className="space-y-1.5">
            {(['shop.rightsUse', 'shop.rightsNot', 'shop.rightsFunds', 'shop.rightsOnce'] as const).map((k) => (
              <li key={k} className="flex items-start gap-2 text-body-sm text-brand-text">
                <Check aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-text-muted" />{t(k)}
              </li>
            ))}
          </ul>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {back()}
            <Button type="button" variant={primary} disabled={!pair} onClick={() => dispatch({ type: 'next' })} className="touch:min-h-11">{t('shop.toPayment')}<ArrowRight aria-hidden="true" /></Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Deliberately no address, QR code or copy button: nothing here can receive funds. */}
          <div className="flex items-start gap-3 rounded-lg bg-brand-elevated p-4">
            <CircleSlash aria-hidden="true" className="mt-0.5 size-icon shrink-0 text-brand-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-text">{t('shop.await.panelTitle')}</p>
              <p className="mt-0.5 text-caption text-brand-text-secondary">{t('shop.await.panelBody')}</p>
            </div>
          </div>
          <Facts rows={[[t('shop.receiptPayment'), pair?.label ?? asset], [t('shop.pay.equivalent'), amountText]]} />
          <div aria-live="polite">
            <Alert tone="info" title={t(step === 'awaiting' ? 'shop.status.awaiting' : step === 'confirming' ? 'shop.status.confirming' : 'shop.status.confirmed')}>
              {step === 'confirming' ? <Progress className="mt-1" label={t('shop.status.confirming')} /> : null}
            </Alert>
          </div>
          <div className={cn('flex flex-col-reverse gap-2 sm:flex-row', step === 'confirmed' ? 'sm:justify-end' : 'sm:justify-between')}>
            {step !== 'confirmed' && back(t('common.cancel'))}
            {step === 'awaiting' && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'simulatePaid' })} className="touch:min-h-11">{t('shop.await.simulate')}</Button>}
            {step === 'confirmed' && <Button type="button" variant={primary} onClick={() => dispatch({ type: 'next' })} className="touch:min-h-11">{t('shop.finish')}<ArrowRight aria-hidden="true" /></Button>}
          </div>
        </div>
      )}
    </div>
  )
}
