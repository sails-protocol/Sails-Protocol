/**
 * Layer C: "Comprar espaço", a Satsails commercial service (lib/spaceCatalog.ts), deliberately apart from the markets
 * and SDK code: it is not part of the Sails Protocol, which stays permissionless. Demo only (?demo=1): fictional
 * prices (not the final ones), one-time purchase (no subscription, plan or renewal), nothing charged. The space works
 * like a unique item in the Sails network: it is the buyer's, tied to their identity, and they choose what it will be
 * (the flow ends in Criar mercado, prefilled).
 *
 * Simulated checkout (PO, 2026-11-22): Pagamento (BTC/USDT/USDC and a network the asset catalog lists, with a demo
 * equivalent at a FIXED fictional quote) → Revisar → Aguardando pagamento (simulado) → Espaço adquirido. There is never
 * an address, QR code, copy button or invoice: someone could send real funds. Real mode shows the planned item only.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, ArrowRight, Check, CircleSlash } from 'lucide-react'
import { Page, PageHeader } from '../../components/layout/PageHeader'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'
import { Alert } from '../../components/ui/alert'
import { Button, buttonVariants } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { AssetLogo, AssetPairIcon } from '../../components/ui/AssetIcon'
import { ASSET_CATALOG, ASSET_LOGO } from '../../lib/assetCatalog'
import { isDemoMode } from '../../lib/demoMarkers'
import { formatAmount, formatUsd } from '../../lib/format'
import {
  CHECKOUT_STEPS, FUTURE_PAYMENT_ASSETS, SPACE_PRODUCTS, checkoutNetworks, checkoutStepNumber, demoEquivalent, nextCheckoutStep, spaceProduct,
  type CheckoutStep, type PayAsset, type SpaceProductId,
} from '../../lib/spaceCatalog'
import { DEMO_QUOTE_USD } from '../../demo/spaceShop'
import { cn } from '../../lib/utils'
import { simulatedToast, WirePlanned } from '../markets/shared'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { t } from '../../i18n'
import { useAuth } from '../../context/AuthContext'

const SECTION = 'rounded-lg bg-brand-surface p-4'
const STEP_TITLE: Partial<Record<CheckoutStep, () => string>> = {
  payment: () => t('shop.step.payment'),
  awaiting: () => t('shop.step.awaiting'), confirming: () => t('shop.step.awaiting'), confirmed: () => t('shop.step.awaiting'),
  acquired: () => t('shop.step.acquired'),
}

function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <dt className="text-caption text-brand-text-muted sm:w-44 sm:shrink-0">{k}</dt>
          <dd className="min-w-0 tabular-nums text-body-sm text-brand-text">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SpaceShop() {
  const { user } = useAuth()
  const demo = isDemoMode()
  const [choice, setChoice] = useState<SpaceProductId>('community')
  const [asset, setAsset] = useState<PayAsset>('BTC')
  const [host, setHost] = useState<'own' | 'managed'>('own')
  const networks = checkoutNetworks(asset, ASSET_CATALOG)
  const [pairId, setPairId] = useState(networks[0]?.id ?? '')
  const [step, dispatch] = useReducer(nextCheckoutStep, 'catalog')
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Land keyboard and screen-reader users on each new step (not on first render).
  const moved = useRef(false)
  useEffect(() => { if (moved.current) headingRef.current?.focus(); moved.current = true }, [step])
  // "Confirmando (simulado)" lasts about a second, or none when the system asks for less motion.
  useEffect(() => {
    if (step !== 'confirming') return
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => dispatch({ type: 'settled' }), reduce ? 0 : 1000)
    return () => window.clearTimeout(id)
  }, [step])

  const name = (id: SpaceProductId) => t(`shop.product.${id}`)
  // Private and business spaces live on one node (Day 0): the person picks where. Only their own node exists today.
  const hosted = (id: SpaceProductId) => id !== 'community'
  // One solid orange per screen: without a session the topbar "Conectar wallet" holds it (DECISIONS.md).
  const primary = user ? 'default' : 'secondary'
  const back = (
    <Link to={MARKETS_ROUTES.explore} className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('spaces.page.back')}
    </Link>
  )
  const notRequired = <p className="text-body-sm text-brand-text">{t('shop.notRequired')}</p>

  if (!demo) {
    return (
      <Page width="detail">
        <PageHeader title={t('shop.title')} meta={t('shop.meta')} back={back} />
        <div className={cn(SECTION, 'space-y-3')}>
          {notRequired}
          <WirePlanned id="spacePurchase" description={t('shop.planned')} />
        </div>
      </Page>
    )
  }

  const product = spaceProduct(choice) ?? SPACE_PRODUCTS[0]
  const pair = networks.find((p) => p.id === pairId) ?? networks[0]
  const amount = demoEquivalent(product.demoPriceUsd, asset, DEMO_QUOTE_USD[asset])
  const amountText = amount === null ? t('common.soon') : `${formatAmount(amount, asset === 'BTC' ? 8 : 2)} ${asset}`
  const pickAsset = (a: PayAsset) => { setAsset(a); setPairId(checkoutNetworks(a, ASSET_CATALOG)[0]?.id ?? '') }
  const summary: (readonly [string, string])[] = [
    [t('shop.receiptProduct'), name(product.id)],
    ...(hosted(product.id) ? [[t('spaces.hosting.receipt'), host === 'managed' ? `${t('spaces.hosting.managed')} (${t('spaces.simulated')})` : t('spaces.hosting.own')] as const] : []),
    [t('shop.receiptPayment'), pair?.label ?? asset],
    [t('shop.priceLabel'), formatUsd(product.demoPriceUsd)],
    [t('shop.pay.equivalent'), amountText],
  ]
  const number = checkoutStepNumber(step)
  const title = STEP_TITLE[step]?.() ?? ''
  const backButton = (label = t('markets.create.back')) => (
    <Button type="button" variant="ghost" onClick={() => dispatch({ type: 'back' })} className="touch:min-h-11"><ArrowLeft aria-hidden="true" />{label}</Button>
  )

  return (
    <Page width="detail">
      <PageHeader title={t('shop.title')} meta={t('shop.meta')} back={back} />
      <div className="space-y-4">
        {/* Visible on every step (PO). */}
        <Alert tone="warning" title={t('shop.demoNotice')}>{notRequired}</Alert>

        {number !== null && (
          <div>
            <h2 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">{t('shop.progress', { at: String(number), total: String(CHECKOUT_STEPS), title })}</h2>
            <Progress className="mt-2" value={(number / CHECKOUT_STEPS) * 100} label={t('shop.progress', { at: String(number), total: String(CHECKOUT_STEPS), title })} />
          </div>
        )}

        {step === 'catalog' && (
          <>
            <section aria-labelledby="shop-choose" className={SECTION}>
              <h2 ref={headingRef} id="shop-choose" tabIndex={-1} className="text-section-title outline-none">{t('shop.headline')}</h2>
              <p className="mt-1 text-body-sm text-brand-text-secondary">{t('shop.lead')}</p>
              <RadioGroup legend={t('shop.chooseLegend')} className="mt-4" listClassName="grid gap-2 md:grid-cols-3">
                {SPACE_PRODUCTS.map((p) => (
                  <RadioCard key={p.id} name="space-product" value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} className="h-full items-start">
                    <span className="min-w-0">
                      <span className="block">{name(p.id)}</span>
                      <span className="mt-0.5 block text-caption font-normal text-brand-text-secondary">{t(`shop.product.${p.id}Description`)}</span>
                      <span className="mt-2 block text-caption font-normal text-brand-text-muted">{t('shop.priceLabel')}</span>
                      <span className="block tabular-nums text-subheading">{formatUsd(p.demoPriceUsd)}</span>
                      <span className="block text-caption font-normal text-brand-text-secondary">{t('shop.oneTime')}</span>
                    </span>
                  </RadioCard>
                ))}
              </RadioGroup>
              <p className="mt-2 text-caption text-brand-text-muted">{t('shop.notFinal')}</p>
            </section>

            {hosted(choice) && (
              <section aria-labelledby="shop-host" className={SECTION}>
                <RadioGroup legend={<span id="shop-host">{t('spaces.hosting.title')}</span>} description={t('spaces.page.singleNode')} listClassName="grid gap-2 md:grid-cols-2">
                  <RadioCard name="space-host" value="managed" checked={host === 'managed'} onChange={() => { setHost('managed'); simulatedToast(t('spaces.hosting.provisioned')) }} className="items-start">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">{t('spaces.hosting.managed')}<SimulatedBadge label={t('spaces.simulated')} /></span>
                      <span className="block text-caption font-normal text-brand-text-secondary">{host === 'managed' ? t('spaces.hosting.provisioned') : t('spaces.hosting.managedNote')}</span>
                    </span>
                  </RadioCard>
                  <RadioCard name="space-host" value="own" checked={host === 'own'} onChange={() => setHost('own')} className="items-start">
                    <span className="min-w-0">
                      <span className="block">{t('spaces.hosting.own')}</span>
                      <span className="block text-caption font-normal text-brand-text-secondary">{t('spaces.hosting.ownNote')}</span>
                    </span>
                  </RadioCard>
                </RadioGroup>
              </section>
            )}

            <section aria-labelledby="shop-rights" className={SECTION}>
              <h2 id="shop-rights" className="text-section-title">{t('shop.rightsTitle')}</h2>
              <ul className="mt-2 space-y-1.5">
                {(['shop.rightsUse', 'shop.rightsChoose', 'shop.rightsNot', 'shop.rightsFunds', 'shop.rightsOnce'] as const).map((k) => (
                  <li key={k} className="flex items-start gap-2 text-body-sm text-brand-text">
                    <Check aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-text-muted" />{t(k)}
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex justify-end">
              <Button type="button" variant={primary} onClick={() => dispatch({ type: 'next' })} className="touch:min-h-11">{t('shop.continueToPay')}<ArrowRight aria-hidden="true" /></Button>
            </div>
          </>
        )}

        {step === 'payment' && (
          <section className={cn(SECTION, 'space-y-5')}>
            <RadioGroup legend={t('shop.pay.assetLegend')} listClassName="grid gap-2 sm:grid-cols-3">
              {FUTURE_PAYMENT_ASSETS.map((a) => (
                <RadioCard key={a} name="pay-asset" value={a} checked={asset === a} onChange={() => pickAsset(a)}>
                  <AssetLogo assetSrc={ASSET_LOGO[a]} size="sm" />{a}
                </RadioCard>
              ))}
            </RadioGroup>
            <RadioGroup legend={t('shop.pay.networkLegend')} listClassName="grid gap-2 sm:grid-cols-2">
              {networks.map((p) => (
                <RadioCard key={p.id} name="pay-network" value={p.id} checked={pair?.id === p.id} onChange={() => setPairId(p.id)}>
                  <AssetPairIcon pair={p} size="sm" />{p.networkLabel}
                </RadioCard>
              ))}
            </RadioGroup>
            <Facts rows={summary} />
            <p className="text-caption text-brand-text-muted">{t('shop.pay.quote', { quote: formatUsd(DEMO_QUOTE_USD[asset]), asset })}</p>
            <ul className="space-y-1.5">
              {(['shop.oneTime', 'shop.notRequiredShort'] as const).map((k) => (
                <li key={k} className="flex items-start gap-2 text-body-sm text-brand-text">
                  <Check aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-text-muted" />{t(k)}
                </li>
              ))}
            </ul>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {backButton()}
              <Button type="button" variant={primary} disabled={!pair} onClick={() => dispatch({ type: 'next' })} className="touch:min-h-11">{t('shop.toPayment')}<ArrowRight aria-hidden="true" /></Button>
            </div>
          </section>
        )}

        {(step === 'awaiting' || step === 'confirming' || step === 'confirmed') && (
          <section className={cn(SECTION, 'space-y-4')}>
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
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {step !== 'confirmed' ? backButton(t('common.cancel')) : <span />}
              {step === 'awaiting' && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'simulatePaid' })} className="touch:min-h-11">{t('shop.await.simulate')}</Button>}
              {step === 'confirmed' && <Button type="button" variant={primary} onClick={() => dispatch({ type: 'next' })} className="touch:min-h-11">{t('markets.create.next')}<ArrowRight aria-hidden="true" /></Button>}
            </div>
          </section>
        )}

        {step === 'acquired' && (
          <section className={cn(SECTION, 'space-y-3')}>
            <p className="text-sm font-medium text-brand-text">{t('shop.receiptTitle')}</p>
            <p className="text-body-sm text-brand-text-secondary">{t('shop.receiptBody')}</p>
            <Facts rows={summary} />
            <p className="text-body-sm text-brand-text">{t('shop.nextStep')}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link to={`${MARKETS_ROUTES.create}?space=${product.id}${hosted(product.id) && host === 'own' ? '&node=own' : ''}`} className={cn(buttonVariants({ variant: primary }), 'touch:min-h-11')}>{t('shop.configure')}</Link>
              <Button type="button" variant="ghost" onClick={() => dispatch({ type: 'reset' })} className="touch:min-h-11">{t('shop.again')}</Button>
            </div>
          </section>
        )}
      </div>
    </Page>
  )
}
