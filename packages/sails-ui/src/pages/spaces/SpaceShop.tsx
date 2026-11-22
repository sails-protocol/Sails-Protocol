/**
 * Layer C: "Comprar espaço", a Satsails commercial service (lib/spaceCatalog.ts), deliberately apart from the markets
 * and SDK code: it is not part of the Sails Protocol, which stays permissionless. Demo only (?demo=1): fictional
 * prices (not the final ones), one-time purchase (no subscription, plan or renewal), BTC/USDT/USDC as future options,
 * no payment field, no address, nothing charged. The space works like a unique item in the Sails network: it is the
 * buyer's, tied to their identity, and they choose what it will be (the flow continues in Criar mercado, prefilled).
 * Real mode shows the planned item only.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Check } from 'lucide-react'
import { Page, PageHeader } from '../../components/layout/PageHeader'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button, buttonVariants } from '../../components/ui/button'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { isDemoMode } from '../../lib/demoMarkers'
import { formatUsd } from '../../lib/format'
import { FUTURE_PAYMENT_ASSETS, SPACE_PRODUCTS, spaceProduct, type SpaceProductId } from '../../lib/spaceCatalog'
import { cn } from '../../lib/utils'
import { WirePlanned } from '../markets/shared'
import { t } from '../../i18n'

const SECTION = 'rounded-lg bg-brand-surface p-4'
const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

export function SpaceShop() {
  const demo = isDemoMode()
  const [choice, setChoice] = useState<SpaceProductId>('community')
  const [confirming, setConfirming] = useState(false)
  const [bought, setBought] = useState<SpaceProductId | null>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (bought) doneRef.current?.focus() }, [bought])
  const name = (id: SpaceProductId) => t(`shop.product.${id}`)
  // Private and business spaces live on one node (Day 0): the person picks where. Only their own node exists today.
  const hosted = (id: SpaceProductId) => id !== 'community'
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

  const product = spaceProduct(bought)
  return (
    <Page width="detail">
      <PageHeader title={t('shop.title')} meta={t('shop.meta')} back={back} />
      <div className="space-y-4">
        <Alert tone="warning" title={t('shop.demoNotice')}>{notRequired}</Alert>

        {product ? (
          <section aria-labelledby="shop-done" className={cn(SECTION, 'space-y-3')}>
            <h2 ref={doneRef} id="shop-done" tabIndex={-1} className="text-section-title outline-none">{t('shop.receiptTitle')}</h2>
            <p className="text-body-sm text-brand-text-secondary">{t('shop.receiptBody')}</p>
            <dl className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
              {([
                [t('shop.receiptProduct'), name(product.id)],
                [t('shop.priceLabel'), formatUsd(product.demoPriceUsd)],
                [t('shop.receiptPayment'), t('shop.receiptPaymentValue')],
                ...(hosted(product.id) ? [[t('spaces.hosting.receipt'), t('spaces.hosting.own')] as const] : []),
              ]).map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
                  <dt className="text-caption text-brand-text-muted sm:w-44 sm:shrink-0">{k}</dt>
                  <dd className="min-w-0 tabular-nums text-body-sm text-brand-text">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-body-sm text-brand-text">{t('shop.nextStep')}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link to={`${MARKETS_ROUTES.create}?space=${product.id}${hosted(product.id) ? '&node=own' : ''}`} className={cn(buttonVariants(), 'touch:min-h-11')}>{t('shop.configure')}</Link>
              <Button type="button" variant="ghost" onClick={() => setBought(null)} className="touch:min-h-11">{t('shop.again')}</Button>
            </div>
          </section>
        ) : (
          <>
            <section aria-labelledby="shop-choose" className={SECTION}>
              <h2 id="shop-choose" className="text-section-title">{t('shop.headline')}</h2>
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
                  <RadioCard name="space-host" value="managed" checked={false} disabled onChange={() => undefined} className="items-start">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">{t('spaces.hosting.managed')}<Badge variant="outline" className={TAG}>{t('common.soon')}</Badge></span>
                      <span className="block text-caption font-normal text-brand-text-secondary">{t('spaces.hosting.managedNote')}</span>
                    </span>
                  </RadioCard>
                  <RadioCard name="space-host" value="own" checked onChange={() => undefined} className="items-start">
                    <span className="min-w-0">
                      <span className="block">{t('spaces.hosting.own')}</span>
                      <span className="block text-caption font-normal text-brand-text-secondary">{t('spaces.hosting.ownNote')}</span>
                    </span>
                  </RadioCard>
                </RadioGroup>
              </section>
            )}

            <section aria-labelledby="shop-pay" className={SECTION}>
              <h2 id="shop-pay" className="text-section-title">{t('shop.payTitle')}</h2>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-body-sm text-brand-text-secondary">
                {FUTURE_PAYMENT_ASSETS.join(' · ')}<Badge variant="outline" className={TAG}>{t('common.soon')}</Badge>
              </p>
              <p className="mt-2 text-caption text-brand-text-secondary">{t('shop.payNote')}</p>
            </section>

            <section aria-labelledby="shop-rights" className={SECTION}>
              <h2 id="shop-rights" className="text-section-title">{t('shop.rightsTitle')}</h2>
              <ul className="mt-2 space-y-1.5">
                {(['shop.rightsUse', 'shop.rightsChoose', 'shop.rightsNot', 'shop.rightsOnce'] as const).map((k) => (
                  <li key={k} className="flex items-start gap-2 text-body-sm text-brand-text">
                    <Check aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-text-muted" />{t(k)}
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex justify-end">
              <Button type="button" onClick={() => setConfirming(true)} className="touch:min-h-11">{t('shop.simulate')}</Button>
            </div>
          </>
        )}
        <ConfirmActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('shop.confirmTitle', { product: name(choice) })}
          consequence={t('shop.confirmBody')}
          confirmLabel={t('shop.simulate')}
          onConfirm={() => { setConfirming(false); setBought(choice) }}
        />
      </div>
    </Page>
  )
}
