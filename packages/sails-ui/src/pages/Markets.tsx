/**
 * Markets hub (/markets, CTO final correction for plan 1.4, issue #147): markets are the product and live inside the
 * Market area, under the same "Market" menu item. Four route tabs: Explorar mercados, Meus mercados, Criar mercado,
 * Entrar com convite. The offer list at '/' stays the Market's landing. Everything here is a prototype: no market
 * contract exists, so real mode shows only the default public market and every backend action is "Em breve"; demo
 * mode (?demo=1) adds fictional markets and lets the create and invite flows be walked, clearly marked.
 */
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, UsersRound } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { MARKETS_ROUTES } from '../components/layout/navMatch'
import { TabLinks } from '../components/ui/tabs'
import { Card } from '../components/ui/card'
import { Alert } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { buttonVariants } from '../components/ui/button'
import { MarketList } from '../components/markets/MarketList'
import { FactList } from '../components/markets/FactList'
import { CreateMarketWizard, type CreateMarketCopy } from '../components/markets/CreateMarketWizard'
import { isDemoMode } from '../lib/demoMarkers'
import { cn } from '../lib/utils'
import { guarantees, identifiers, JoinMarketPanel, marketListCopy, marketsValueLine, WireNote, WirePlanned, useVisibleMarkets } from './markets/shared'
import { MarketIcon, MARKET_ACTION_ICON } from '../components/markets/MarketIcon'
import { ownMarkets } from '../lib/myMarkets'
import { getLocale } from '../lib/locale'
import { t } from '../i18n'

const TAB_ICON = 'h-4 w-4 shrink-0'
const tabs = () => [
  { to: MARKETS_ROUTES.explore, label: <><MARKET_ACTION_ICON.explore aria-hidden="true" className={TAB_ICON} />{t('markets.action.explore')}</> },
  { to: MARKETS_ROUTES.mine, label: <><UsersRound aria-hidden="true" className={TAB_ICON} />{t('markets.action.mine')}</> },
  { to: MARKETS_ROUTES.create, label: <><MARKET_ACTION_ICON.create aria-hidden="true" className={TAB_ICON} />{t('markets.action.create')}</> },
  { to: MARKETS_ROUTES.join, label: <><MARKET_ACTION_ICON.invite aria-hidden="true" className={TAB_ICON} />{t('markets.action.join')}</> },
]

const SURFACE = 'border-brand-border-subtle bg-brand-surface p-4'

function createCopy(): CreateMarketCopy {
  const list = marketListCopy()
  const steps = {
    identity: t('markets.create.step.identity'),
    visibility: t('markets.create.step.visibility'),
    participation: t('markets.create.step.participation'),
    infrastructure: t('markets.create.step.infrastructure'),
    review: t('markets.create.step.review'),
    invites: t('markets.create.step.invites'),
  }
  return {
    steps,
    // at/total as strings: step numbers, not quantities.
    progress: (at, total, title) => t('markets.create.progress', { at: String(at), total: String(total), title }),
    name: t('markets.create.name'),
    nameHelp: (max) => t('markets.create.nameHelp', { max }),
    description: t('markets.create.description'),
    descriptionOptional: t('markets.optional'),
    visibility: [
      { value: 'public', label: list.visibility.public, description: t('markets.create.visibility.publicDescription') },
      { value: 'private', label: list.visibility.private, description: t('markets.create.visibility.privateDescription') },
    ],
    visibilityNote: t('markets.create.visibilityNote'),
    participation: [
      { value: 'vitrine', label: list.preset.vitrine, description: t('markets.create.participation.vitrineDescription') },
      { value: 'comunidade', label: list.preset.comunidade, description: t('markets.create.participation.comunidadeDescription') },
      { value: 'personalizado', label: t('markets.create.participation.personalizadoLabel'), description: t('markets.create.participation.personalizadoDescription'), disabled: true },
    ],
    participationNote: t('markets.create.participationNote'),
    infrastructure: [
      { value: 'network', label: t('markets.create.infrastructure.networkLabel'), description: t('markets.create.infrastructure.networkDescription') },
      { value: 'own', label: t('markets.create.infrastructure.ownLabel'), description: t('markets.create.infrastructure.ownDescription') },
    ],
    infrastructureNote: t('markets.create.infrastructureNote'),
    review: {
      name: t('markets.create.review.name'), description: t('markets.create.description'), visibility: steps.visibility,
      participation: t('markets.create.review.participation'), infrastructure: steps.infrastructure, empty: t('markets.create.review.empty'),
    },
    back: t('markets.create.back'),
    next: t('markets.create.next'),
    create: t('markets.action.create'),
  }
}

// The 2×2 of visibility × infrastructure (CTO final correction): one example each, all independent choices.
function examples(): readonly { key: string; visibility: string; infrastructure: string; example: string }[] {
  const pub = t('markets.list.visibility.public')
  const priv = t('markets.list.visibility.private')
  const own = t('markets.create.infrastructure.ownLabel')
  return [
    { key: 'public-network', visibility: pub, infrastructure: 'Rede Sails', example: t('markets.create.example.publicNetwork') },
    { key: 'public-own', visibility: pub, infrastructure: own, example: t('markets.create.example.publicOwn') },
    { key: 'private-network', visibility: priv, infrastructure: 'Rede Sails', example: t('markets.create.example.privateNetwork') },
    { key: 'private-own', visibility: priv, infrastructure: own, example: t('markets.create.example.privateOwn') },
  ]
}

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

/** Showcase of public markets (DECISIONS.md "Modelo mundo aberto"): its own shareable route, /markets. */
function ExploreView() {
  const publics = useVisibleMarkets().filter((m) => m.visibility === 'public')
  const list = marketListCopy()
  const soon = t('common.soon')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-surface p-4">
        <p className="min-w-0 flex-1 basis-60 text-body-sm text-brand-text">{marketsValueLine()}</p>
        <Link to={MARKETS_ROUTES.create} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0 touch:min-h-11')}>
          <MARKET_ACTION_ICON.create aria-hidden="true" />{t('markets.action.create')}
        </Link>
      </div>
      <ul aria-label={t('markets.explore.listLabel')} className="grid gap-3 sm:grid-cols-2">
        {publics.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 rounded-lg bg-brand-surface p-4">
            <div className="flex items-start gap-3">
              <MarketIcon market={m} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-sm font-medium text-brand-text">{m.name}</h2>
                  {m.illustrative && <Badge variant="outline" className={TAG}>{list.illustrative}</Badge>}
                </div>
                <p className="mt-0.5 text-caption text-brand-text-secondary">{m.description}</p>
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
              <div className="flex gap-1">
                <dt className="text-brand-text-muted">{t('markets.explore.participants')}</dt>
                <dd className="tabular-nums text-brand-text">{m.participants !== undefined ? m.participants.toLocaleString(getLocale()) : soon}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-brand-text-muted">{t('markets.explore.model')}</dt>
                <dd className="text-brand-text">{m.preset ? list.preset[m.preset] : m.relation === 'default' ? t('markets.explore.openToAll') : soon}</dd>
              </div>
            </dl>
            <div className="mt-auto">
              {m.relation === 'default'
                ? <Link to="/" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>{t('markets.explore.open')}<span className="sr-only"> {m.name}</span></Link>
                : <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{soon}</Badge>}
            </div>
          </li>
        ))}
      </ul>
      {publics.length === 1 && <WirePlanned id="marketDiscovery" description={t('markets.explore.discoveryPlanned')} />}
    </div>
  )
}

function MineView() {
  const markets = ownMarkets(useVisibleMarkets())
  return (
    <Card className={cn(SURFACE, 'space-y-4')}>
      <MarketList markets={markets} copy={{ ...marketListCopy(), label: t('markets.action.mine') }} />
      {markets.length === 1 && <WirePlanned id="marketMembership" description={t('markets.mine.membershipPlanned')} />}
      <WirePlanned id="marketPortability" description={t('markets.mine.portabilityPlanned')} />
    </Card>
  )
}

function CreateView() {
  const demo = isDemoMode()
  const [created, setCreated] = useState<string | null>(null)
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        {created ? (
          <Alert tone="info" live title={t('markets.create.demoTitle')}>
            {t('markets.create.demoBody', { name: created })}
          </Alert>
        ) : (
          <CreateMarketWizard
            copy={createCopy()}
            brandingSlot={<WirePlanned id="marketBranding" description={t('markets.create.brandingPlanned')} />}
            invitesSlot={<WirePlanned id="marketInvite" label={t('markets.create.invitesLabel')} description={t('markets.create.invitesPlanned')} />}
            createAvailable={demo}
            unavailableNote={<WireNote ids={['createMarket']} />}
            onCreate={(d) => setCreated(d.name.trim())}
          />
        )}
      </Card>
      <section aria-labelledby="markets-examples">
        <h2 id="markets-examples" className="text-section-title">{t('markets.create.examplesTitle')}</h2>
        <p className="mt-1 text-body-sm text-brand-text-secondary">{t('markets.create.examplesLead')}</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {examples().map((e) => (
            <li key={e.key} className="rounded-lg bg-brand-surface p-3">
              <p className="text-caption text-brand-text-secondary">{e.visibility} · {e.infrastructure}</p>
              <p className="mt-0.5 text-body-sm text-brand-text">{e.example}</p>
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <FactList title={t('markets.guarantees.title')} facts={guarantees()} />
        <div>
          <FactList title={t('markets.identifiers.title')} facts={identifiers()} />
          <p className="mt-2 text-caption text-brand-text-muted">{t('markets.identifiers.formatsPending')}</p>
        </div>
      </div>
    </div>
  )
}

function JoinView() {
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        <p className="mb-4 text-body-sm text-brand-text-secondary">{t('markets.join.intro')}</p>
        <JoinMarketPanel />
      </Card>
      <FactList title={t('markets.guarantees.title')} facts={guarantees()} />
    </div>
  )
}

export function Markets() {
  const { pathname } = useLocation()
  const view = pathname.replace(/\/+$/, '')
  return (
    <Page width="detail">
      <PageHeader
        title={t('markets.title')}
        meta={t('markets.meta')}
        back={
          <Link to="/" className="inline-flex min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text md:min-h-0">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market
          </Link>
        }
      >
        <TabLinks label={t('markets.title')} items={tabs()} className="overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none]" />
      </PageHeader>
      {view === MARKETS_ROUTES.mine ? <MineView /> : view === MARKETS_ROUTES.create ? <CreateView /> : view === MARKETS_ROUTES.join ? <JoinView /> : <ExploreView />}
    </Page>
  )
}
