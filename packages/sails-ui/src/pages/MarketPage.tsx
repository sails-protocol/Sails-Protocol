/**
 * Layer C: one market's page (/markets/:id, DECISIONS.md "Mercados (Market Spaces)"). Future reads:
 * sails.markets.get(id), liquidity.discover({ marketId }) and, for the admin, sails.markets.members(id) (public keys
 * only). None exists yet, so real mode shows the honest "Em preparação" state, and only demo mode (?demo=1) renders
 * fictional markets, every one marked. A private market the person has not joined answers like the backend will
 * (404): "não encontrado ou sem acesso", never confirming that it exists. The group chat is demonstration/roadmap,
 * apart from the per-trade chat (the only real chat).
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ArrowLeft, ExternalLink, MessageCircle, SearchX, Ticket } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { MARKETS_ROUTES } from '../components/layout/navMatch'
import { Badge } from '../components/ui/badge'
import { buttonVariants } from '../components/ui/button'
import { StateBlock } from '../components/ui/StateBlock'
import { SideBadge } from '../components/ui/StatusBadges'
import { MarketBanner } from '../components/markets/MarketBanner'
import { MarketIcon } from '../components/markets/MarketIcon'
import { AdminImage } from '../components/markets/AdminImage'
import { IconButton } from '../components/ui/icon-button'
import { MarketChats } from './markets/MarketChats'
import { demoMarketPage, demoMarkets, isDemoMode, subscribeDemoMarkets } from '../lib/demoMarkers'
import { canSeeOffers, kycSummary } from '../lib/marketSpaces'
import { formatMonthYear, formatUsd } from '../lib/format'
import { cn } from '../lib/utils'
import { adminImageCopy, categoryLabel, DemoVerifiedSeal, kycText, marketListCopy, profileLabel, socialNames, WireNote, WirePlanned } from './markets/shared'
import { t } from '../i18n'

const SECTION = 'rounded-lg bg-brand-surface p-4'
const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

/** Start and end always visible, the whole key for screen readers (DECISIONS.md "Chave pública no Perfil"). */
function MonoKey({ value }: { value: string }) {
  return (
    <span translate="no" className="font-mono text-caption text-brand-text">
      {value.length <= 20 ? value : <><span aria-hidden="true">{value.slice(0, 10)}…{value.slice(-8)}</span><span className="sr-only">{value}</span></>}
    </span>
  )
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="text-caption text-brand-text-muted sm:w-44 sm:shrink-0">{k}</dt>
      <dd className="min-w-0 break-words text-body-sm text-brand-text">{children}</dd>
    </div>
  )
}

function ExternalAdminLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="inline-flex min-h-8 touch:min-h-11 items-center gap-1 text-brand-link underline-offset-2 hover:underline">
      {label}<ExternalLink aria-hidden="true" className="size-icon-xs shrink-0" />
      <span className="text-caption text-brand-text-muted">({t('spaces.adminLink')})</span>
    </a>
  )
}

function NotFound() {
  return (
    <StateBlock
      kind="empty"
      icon={SearchX}
      title={t('spaces.page.notFoundTitle')}
      description={t('spaces.page.notFoundBody')}
      action={
        <Link to={MARKETS_ROUTES.join} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>
          <Ticket aria-hidden="true" />{t('markets.action.join')}
        </Link>
      }
    />
  )
}

export function MarketPage() {
  const { id = '' } = useParams()
  const snapshot = useSyncExternalStore(subscribeDemoMarkets, demoMarkets)
  if (id === 'public') return <Navigate to="/" replace />
  const demo = isDemoMode()
  const page = demo ? demoMarketPage(id, snapshot) : null
  const back = (
    <Link to={MARKETS_ROUTES.explore} className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('spaces.page.back')}
    </Link>
  )

  // Real mode: no market can be read yet (sails.markets.get), so no page claims to exist.
  if (!demo) {
    return (
      <Page width="detail">
        <PageHeader title={t('spaces.page.preparingTitle')} back={back} />
        <div className={cn(SECTION, 'space-y-3')}>
          <p className="text-body-sm text-brand-text-secondary">{t('spaces.page.preparingBody')}</p>
          <WireNote ids={['marketPage', 'marketMembership']} badge={t('spaces.preparing')} />
        </div>
      </Page>
    )
  }
  // Unknown id, or a private market the person has not joined: the same answer (the backend will return 404).
  if (!page || !canSeeOffers(page.market)) {
    return (
      <Page width="detail">
        <PageHeader title={t('spaces.page.back')} back={back} />
        <NotFound />
      </Page>
    )
  }

  const m = page.market
  const list = marketListCopy()
  const kyc = kycSummary(m.entryPolicy)
  const social = m.entryPolicy?.social ?? []
  const category = categoryLabel(m)
  const profile = profileLabel(m)
  const presetRules = m.preset === 'vitrine'
    ? { publishes: t('markets.preview.rules.vitrinePublishes'), trades: t('markets.preview.rules.vitrineTrades') }
    : { publishes: t('markets.preview.rules.members'), trades: t('markets.preview.rules.members') }
  // Keeps 3:1 in the detail column; capped on wide screens so it never pushes the content below the fold.
  const banner = <MarketBanner market={m} image={m.bannerImage} className="md:max-h-64" />

  return (
    <Page width="detail">
      <PageHeader title={m.name} meta={m.visibility === 'private' ? list.visibility.private : list.visibility.public} back={back} />
      <div className="space-y-4">
        <section aria-label={m.name} className={SECTION}>
          {m.remoteBanner ? <AdminImage url={m.remoteBanner} placeholder={banner} copy={adminImageCopy()} alt="" /> : banner}
          <div className="mt-3 flex items-start gap-3">
            <MarketIcon market={m} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {profile && <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{profile}</Badge>}
                {page.verified && <DemoVerifiedSeal explain />}
                {m.illustrative && <Badge variant="outline" className={TAG}>{list.illustrative}</Badge>}
              </div>
              {m.description && <p className="mt-1 break-words text-body-sm text-brand-text-secondary">{m.description}</p>}
            </div>
          </div>
          <dl className="mt-3 divide-y divide-brand-border-subtle">
            {category && <Fact k={t('spaces.create.category')}>{category}</Fact>}
            <Fact k={t('spaces.page.participants')}><span className="tabular-nums">{m.participants !== undefined ? t('spaces.participants', { count: m.participants }) : t('common.soon')}</span></Fact>
            {m.preset && <Fact k={t('spaces.page.model')}>{list.preset[m.preset]}</Fact>}
            <Fact k={t('spaces.page.createdAt')}>{formatMonthYear(page.createdAt)}</Fact>
            <Fact k={list.infrastructureLabel.replace(/:$/, '')}>{list.infrastructure[m.infrastructure]}</Fact>
          </dl>
          {m.visibility === 'private' && <p className="mt-2 text-caption text-brand-text-secondary">{t('spaces.page.singleNode')}</p>}
        </section>

        <section aria-labelledby="market-rules" className={SECTION}>
          <h2 id="market-rules" className="text-section-title">{t('spaces.page.rulesTitle')}</h2>
          <dl className="mt-2 divide-y divide-brand-border-subtle">
            <Fact k={t('markets.preview.publishes')}>{presetRules.publishes}</Fact>
            <Fact k={t('markets.preview.trades')}>{presetRules.trades}</Fact>
            <Fact k={t('spaces.page.kyc')}>
              {kycText(kyc)}
              {kyc.kind !== 'none' && kyc.formUrl && <div><ExternalAdminLink href={kyc.formUrl} label={t('spaces.page.kycForm')} /></div>}
            </Fact>
            <Fact k={t('spaces.page.social')}>{social.length > 0 ? socialNames(social) : t('spaces.page.socialNone')}</Fact>
          </dl>
          <p className="mt-2 text-caption text-brand-text-secondary">{t('spaces.page.policyNote')}</p>
        </section>

        <section aria-labelledby="market-offers" className={SECTION}>
          <h2 id="market-offers" className="text-section-title">{t('spaces.page.offersTitle')}</h2>
          {page.offers.length === 0 ? (
            <p className="mt-2 text-body-sm text-brand-text-secondary">{t('spaces.page.offersEmpty')}</p>
          ) : (
            <>
              <p className="mt-1 text-caption text-brand-text-muted">{t('spaces.page.offersDemo')}</p>
              {m.visibility === 'private' && <p className="mt-1 text-caption text-brand-text-muted">{t('spaces.page.privateAccess')}</p>}
              <ul className="mt-2 divide-y divide-brand-border-subtle">
                {page.offers.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                    {/* The viewer's action, as in the Market list: a sell offer is bought. */}
                    <SideBadge side={o.side === 'SELL' ? 'BUY' : 'SELL'} />
                    <span className="text-body-sm font-medium text-brand-text">{o.asset}</span>
                    <span className="tabular-nums text-body-sm text-brand-text">{formatUsd(o.priceUsd)}</span>
                    <span className="text-caption text-brand-text-secondary">{o.method}</span>
                    <span className="ml-auto text-caption text-brand-text-secondary">{o.advertiser}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-label={t('spaces.chat.sectionTitle')} className={SECTION}>
          <MarketChats
            membersSlot={m.relation === 'admin' ? (openPrivate) => (
              <div className="pt-2">
                <h3 className="text-sm font-medium text-brand-text">{t('spaces.page.membersTitle')}</h3>
                <p className="mt-0.5 text-caption text-brand-text-secondary">{t('spaces.page.membersLead')}</p>
                {page.memberKeys.length === 0 ? (
                  <p className="mt-2 text-body-sm text-brand-text-secondary">{t('markets.create.invites.empty')}</p>
                ) : (
                  <ul aria-label={t('spaces.page.membersTitle')} className="mt-1 divide-y divide-brand-border-subtle">
                    {page.memberKeys.map((k) => (
                      <li key={k} className="flex items-center gap-2 py-1">
                        <span className="min-w-0 flex-1"><MonoKey value={k} /></span>
                        <IconButton label={t('spaces.chat.privateWith', { name: `${k.slice(0, 10)}…` })} size="sm" onClick={() => openPrivate({ author: `${k.slice(0, 10)}…${k.slice(-8)}`, seed: k })}>
                          <MessageCircle aria-hidden="true" />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : undefined}
          />
          <div className="mt-4 space-y-2">
            <WirePlanned id="marketGroupChat" description={t('spaces.chat.planned')} />
            <WirePlanned id="marketDirectMessage" description={t('spaces.chat.privatePlanned')} />
          </div>
        </section>
      </div>
    </Page>
  )
}
