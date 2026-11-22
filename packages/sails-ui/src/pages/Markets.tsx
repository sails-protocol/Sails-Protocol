/**
 * Markets hub (/markets, CTO final correction for plan 1.4, issue #147): markets are the product and live inside the
 * Market area, under the same "Market" menu item. Four route tabs: Explorar mercados, Meus mercados, Criar mercado,
 * Entrar com convite. The offer list at '/' stays the Market's landing. Everything here is a prototype: no market
 * contract exists, so real mode shows only the default public market and every backend action is "Em breve"; demo
 * mode (?demo=1) adds fictional markets and lets the create and invite flows be walked, clearly marked.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, CheckCircle2, UsersRound } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { MARKETS_ROUTES, marketPath } from '../components/layout/navMatch'
import { TabLinks } from '../components/ui/tabs'
import { Card } from '../components/ui/card'
import { Alert } from '../components/ui/alert'
import { ConfirmActionDialog } from '../components/ui/ConfirmActionDialog'
import { Button, buttonVariants } from '../components/ui/button'
import { FilterChip } from '../components/ui/filter-chip'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { MarketCard } from '../components/markets/MarketCard'
import { MarketList } from '../components/markets/MarketList'
import { FactList } from '../components/markets/FactList'
import { CreateMarketWizard, type CreateMarketCopy } from '../components/markets/CreateMarketWizard'
import { MarketPreview, type MarketPreviewCopy } from '../components/markets/MarketPreview'
import { marketPreview, parseUsdWhole, type MarketDraft, type MarketPreviewModel } from '../lib/createMarket'
import { addDemoCreatedMarket, demoMarketPage, isDemoMode, isRetainedPreview } from '../lib/demoMarkers'
import { MARKET_CATEGORIES, filterByCategory, pageOf, readViewMode, saveViewMode, type CategoryFilter, type ViewMode } from '../lib/marketSpaces'
import { spaceProduct, type SpaceProductId } from '../lib/spaceCatalog'
import { SpaceCheckout, SpaceTypePicker, spaceName } from './spaces/SpaceCheckout'
import { formatUsd } from '../lib/format'
import { IMAGE_MAX_BYTES, IMAGE_SPECS, formatPx, type ImageKind } from '../lib/imageCheck'
import { getLocale } from '../lib/locale'
import type { ImagePickerCopy } from '../components/markets/ImagePicker'
import type { MarketView } from '../lib/myMarkets'
import { cn } from '../lib/utils'
import { categoryLabel, DemoVerifiedSeal, entryText, guarantees, identifiers, JoinMarketPanel, marketCardCopy, marketListCopy, marketsValueLine, PrivateHostingNote, profileLabel, SOCIAL_OPTIONS, WireNote, WirePlanned, useVisibleMarkets } from './markets/shared'
import { MarketIcon, MARKET_ACTION_ICON } from '../components/markets/MarketIcon'
import { ownMarkets } from '../lib/myMarkets'
import { useAuth } from '../context/AuthContext'
import { t } from '../i18n'

const TAB_ICON = 'h-4 w-4 shrink-0'
const tabs = () => [
  { to: MARKETS_ROUTES.explore, label: <><MARKET_ACTION_ICON.explore aria-hidden="true" className={TAB_ICON} />{t('markets.action.explore')}</> },
  { to: MARKETS_ROUTES.mine, label: <><UsersRound aria-hidden="true" className={TAB_ICON} />{t('markets.action.mine')}</> },
  { to: MARKETS_ROUTES.create, label: <><MARKET_ACTION_ICON.create aria-hidden="true" className={TAB_ICON} />{t('markets.action.create')}</> },
  { to: MARKETS_ROUTES.join, label: <><MARKET_ACTION_ICON.invite aria-hidden="true" className={TAB_ICON} />{t('markets.action.join')}</> },
]

const SURFACE = 'border-brand-border-subtle bg-brand-surface p-4'
const safeLocalStorage = () => { try { return window.localStorage } catch { return undefined } }

// Pixel sizes and formats from lib/imageCheck.ts, written in the interface language (PO, 2026-11-22).
const imageCopy = (kind: ImageKind, label: string): ImagePickerCopy => {
  const spec = IMAGE_SPECS[kind]
  const locale = getLocale()
  const formats = t(kind === 'icon' ? 'spaces.create.formatsIcon' : 'spaces.create.formatsPhoto')
  const max = t('spaces.create.maxSize', { mb: IMAGE_MAX_BYTES / 1024 / 1024 })
  const rec = formatPx(spec.recommended, locale)
  return {
    label,
    help: t('spaces.create.imageHelp', { ratio: spec.ratioLabel, rec, min: formatPx(spec.minimum, locale), formats, max }) + (kind === 'icon' ? '' : ` ${t('spaces.create.safeArea')}`),
    choose: t('spaces.create.choose'), replace: t('spaces.create.replace'), remove: t('spaces.create.remove'),
    wrongType: t('spaces.create.wrongType', { formats }),
    tooBig: t('spaces.create.tooBig', { max }),
    warnSmall: t('spaces.create.warnSmall', { rec }),
    warnRatio: t('spaces.create.warnRatio', { ratio: spec.ratioLabel }),
  }
}

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
    category: { legend: t('spaces.create.category'), options: MARKET_CATEGORIES.map((c) => ({ value: c, label: t(`spaces.category.${c}`) })) },
    profile: {
      legend: t('spaces.create.profile'), note: t('spaces.create.profileNote'),
      options: [
        { value: 'P2P', label: t('spaces.profile.P2P'), description: t('spaces.create.profile.p2p') },
        { value: 'EMPRESA_OTC', label: t('spaces.profile.EMPRESA_OTC'), description: t('spaces.create.profile.otc') },
      ],
    },
    images: {
      icon: imageCopy('icon', t('spaces.create.icon')),
      banner: imageCopy('banner', t('spaces.create.banner')),
      cover: imageCopy('cover', t('spaces.create.cover')),
      coverToggle: t('spaces.create.coverToggle'),
      note: t('spaces.create.imagesNote'),
    },
    advanced: t('spaces.create.advanced'),
    entry: {
      lead: t('spaces.create.entryLead'),
      kycLegend: t('spaces.create.kycLegend'),
      kyc: [
        { value: 'none', label: t('spaces.kyc.none'), description: t('spaces.create.kyc.noneDescription') },
        { value: 'above_threshold', label: t('spaces.create.kyc.above'), description: t('spaces.create.kyc.aboveDescription') },
        { value: 'all', label: t('spaces.create.kyc.all'), description: t('spaces.create.kyc.allDescription') },
      ],
      threshold: t('spaces.create.threshold'), thresholdHelp: t('spaces.create.thresholdHelp'), thresholdError: t('spaces.create.thresholdError'),
      provider: t('spaces.create.provider'), providerHelp: t('spaces.create.providerHelp'), providerError: t('spaces.create.providerError'),
      socialLegend: t('spaces.create.socialLegend'), socialHelp: t('spaces.create.socialHelp'), social: SOCIAL_OPTIONS,
      responsibility: t('spaces.create.responsibility'),
      limits: t('spaces.create.limits'),
      summary: (d) => entryText({ kyc: d.kyc, thresholdUsd: parseUsdWhole(d.kycThreshold) ?? undefined, providerUrl: d.kycProviderUrl, social: d.social }),
    },
    review: {
      name: t('markets.create.review.name'), description: t('markets.create.description'), visibility: steps.visibility,
      participation: t('markets.create.review.participation'), infrastructure: steps.infrastructure, empty: t('markets.create.review.empty'),
      category: t('spaces.create.review.category'), profile: t('spaces.create.review.profile'), entry: t('spaces.create.review.entry'),
    },
    invites: {
      identifier: t('markets.create.invites.identifier'),
      identifierHelp: t('markets.create.invites.identifierHelp'),
      identifierPlaceholder: t('markets.formatPending'),
      generate: t('markets.create.invites.generate'),
      listLabel: t('markets.create.invites.listLabel'),
      empty: t('markets.create.invites.empty'),
      pending: t('markets.create.invites.pending'),
      remove: (identifier) => t('markets.create.invites.remove', { identifier }),
    },
    back: t('markets.create.back'),
    next: t('markets.create.next'),
    create: t('markets.create.previewAction'),
  }
}

const SHOWN_INVITE_STATES = ['pending', 'granted', 'failed'] as const

function previewCopy(): MarketPreviewCopy {
  const list = marketListCopy()
  const members = t('markets.preview.rules.members')
  return {
    title: t('markets.preview.title'),
    visibility: list.visibility,
    noDescription: t('markets.preview.noDescription'),
    facts: {
      marketId: 'Sails Market ID', marketIdPending: t('markets.formatPending'),
      brand: t('markets.preview.brand'), brandPending: t('markets.preview.brandPending'),
      participation: t('markets.create.review.participation'),
      publishes: t('markets.preview.publishes'), trades: t('markets.preview.trades'),
      infrastructure: t('markets.create.step.infrastructure'),
    },
    preset: {
      vitrine: { label: list.preset.vitrine, publishes: t('markets.preview.rules.vitrinePublishes'), trades: t('markets.preview.rules.vitrineTrades') },
      comunidade: { label: list.preset.comunidade, publishes: members, trades: members },
    },
    infrastructure: { network: 'Rede Sails', own: t('markets.create.infrastructure.ownLabel') },
    offersTitle: t('markets.preview.offersTitle'),
    offersEmptyTitle: t('markets.preview.offersEmptyTitle'),
    offersEmptyBody: t('markets.preview.offersEmptyBody'),
    invitesTitle: t('markets.preview.invitesTitle'),
    invitesLead: t('markets.preview.invitesLead'),
    invitesEmpty: t('markets.create.invites.empty'),
    pending: t('markets.create.invites.pending'),
    statesTitle: t('markets.preview.statesTitle'),
    states: SHOWN_INVITE_STATES.map((s) => ({ key: s, title: t(`markets.invite.${s}.title`), description: t(`markets.invite.${s}.description`) })),
    edit: t('markets.preview.edit'),
    discard: t('markets.preview.discard'),
  }
}

/** The preview's persistent label: real mode names the contracts it waits for; demo mode marks the market fictional. */
function PreviewBanner({ preview, demo }: { preview: MarketPreviewModel; demo: boolean }) {
  return demo ? (
    <Alert tone="info" title={t('spaces.create.demoPreviewTitle')}>{t('spaces.create.demoPreviewBody', { name: preview.name })}</Alert>
  ) : (
    <Alert tone="info" title={t('markets.preview.bannerTitle')}>
      <p>{t('markets.preview.bannerBody')}</p>
      <div className="mt-2"><WireNote ids={preview.dependsOn} /></div>
    </Alert>
  )
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

// Stretched link: the whole card is the target; the visible label stays a small secondary button.
const CARD_LINK = cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11 after:absolute after:inset-0 after:content-[""]')
const PAGE_SIZE = 6

function OpenLink({ m }: { m: MarketView }) {
  return (
    <Link to={m.relation === 'default' ? '/' : marketPath(m.id)} className={CARD_LINK}>
      {t('markets.explore.open')}<span className="sr-only"> {m.name}</span>
    </Link>
  )
}

/** Showcase (DECISIONS.md "Modelo mundo aberto", Market Spaces): Mercado aberto on top, then the Comunidades. */
function ExploreView() {
  const visible = useVisibleMarkets()
  // The open market is the whole network; the communities are listed apart from it.
  const open = visible.find((m) => m.relation === 'default')
  const communities = visible.filter((m) => m.visibility === 'public' && m.relation !== 'default')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  // Shaped like sails.markets.discover({ limit, offset }) so the swap keeps the paging.
  const page = pageOf(filterByCategory(communities, category), limit)
  const cardCopy = marketCardCopy()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-surface p-4">
        <p className="min-w-0 flex-1 basis-60 text-body-sm text-brand-text">{marketsValueLine()}</p>
        <div className="flex flex-wrap gap-2">
          <Link to={MARKETS_ROUTES.create} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>
            <MARKET_ACTION_ICON.create aria-hidden="true" />{t('markets.action.create')}
          </Link>
        </div>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-surface p-4">
          <MarketIcon market={open} size="lg" />
          <div className="min-w-0 flex-1 basis-48">
            <h2 className="text-sm font-medium text-brand-text">{open.name}</h2>
            <p className="mt-0.5 text-caption text-brand-text-secondary">{open.description}</p>
          </div>
          <Link to="/" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0 touch:min-h-11')}>{t('markets.explore.open')}<span className="sr-only"> {open.name}</span></Link>
        </div>
      )}
      <section aria-labelledby="explore-public" className="space-y-3">
        <h2 id="explore-public" className="text-section-title">{t('markets.explore.listLabel')}</h2>
        {communities.length === 0 ? <WirePlanned id="marketDiscovery" description={t('markets.explore.discoveryPlanned')} /> : (
          <>
            <div role="group" aria-label={t('spaces.category.filterLabel')} className="flex flex-wrap gap-2">
              {(['all', ...MARKET_CATEGORIES] as const).map((c) => (
                <FilterChip key={c} label={t(c === 'all' ? 'spaces.category.all' : `spaces.category.${c}`)} selected={category === c} onToggle={() => { setCategory(c); setLimit(PAGE_SIZE) }} />
              ))}
            </div>
            {page.items.length === 0 ? (
              <p className="rounded-lg bg-brand-surface p-4 text-body-sm text-brand-text-secondary">{t('spaces.explore.empty')}</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {page.items.map((m) => (
                  <li key={m.id} className="flex">
                    <MarketCard market={m} copy={cardCopy} className="w-full" badges={m.illustrative && demoMarketPage(m.id)?.verified ? <DemoVerifiedSeal /> : undefined} action={<OpenLink m={m} />} />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-caption tabular-nums text-brand-text-muted" aria-live="polite">{t('spaces.explore.shown', { shown: page.items.length, total: page.total })}</p>
              {page.items.length < page.total && (
                <Button type="button" size="sm" variant="secondary" onClick={() => setLimit((l) => l + PAGE_SIZE)} className="touch:min-h-11">{t('spaces.explore.more')}</Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function MineView() {
  const markets = ownMarkets(useVisibleMarkets())
  const demo = isDemoMode()
  // Nothing stored: list on phones (< 640 px), grid above.
  const [mode, setMode] = useState<ViewMode>(() => readViewMode(safeLocalStorage(), typeof window !== 'undefined' && window.innerWidth < 640 ? 'list' : 'grid'))
  const choose = (m: ViewMode) => { setMode(m); saveViewMode(safeLocalStorage(), m) }
  const cardCopy = marketCardCopy()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-section-title">{t('markets.action.mine')}</h2>
        <SegmentedControl
          label={t('spaces.mine.viewLabel')}
          value={mode}
          onChange={choose}
          options={[{ value: 'grid', label: t('spaces.mine.grid') }, { value: 'list', label: t('spaces.mine.list') }]}
        />
      </div>
      {mode === 'grid' ? (
        <ul aria-label={t('markets.action.mine')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {markets.map((m) => (
            <li key={m.id} className="flex">
              <MarketCard market={m} copy={cardCopy} className="w-full" action={<OpenLink m={m} />} />
            </li>
          ))}
        </ul>
      ) : (
        <Card className={SURFACE}>
          <MarketList
            compact
            markets={markets}
            copy={{ ...marketListCopy(), label: t('markets.action.mine') }}
            action={(m) => (
              <Link to={m.relation === 'default' ? '/' : marketPath(m.id)} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'touch:min-h-11')}>
                {t('markets.explore.open')}<span className="sr-only"> {m.name}</span>
              </Link>
            )}
          />
        </Card>
      )}
      <Card className={cn(SURFACE, 'space-y-3')}>
        {/* Outside the demo no private market can be read (no access-control contract): honest "Em preparação" (CTO 31). */}
        {!demo && <WirePlanned id="marketMembership" label={t('spaces.mine.privateLabel')} badge={t('spaces.preparing')} description={t('spaces.mine.privatePreparing')} />}
        {markets.length === 1 && <WirePlanned id="marketMembership" description={t('markets.mine.membershipPlanned')} />}
        <WirePlanned id="marketPortability" description={t('markets.mine.portabilityPlanned')} />
        {/* Moved from the portal (PO 2026-11-22): the honest note lives next to the list it explains. */}
        <p className="text-caption text-brand-text-muted">{t('markets.portal.unavailableReason')}</p>
      </Card>
    </div>
  )
}

/** The wizard's starting values for a kind of space (PO 2026-11-22): only a start, everything stays editable. */
function spaceDraft(product: SpaceProductId | null, node: string | null): Partial<MarketDraft> | undefined {
  if (!product) return undefined
  const infra = node === 'own' ? { infrastructure: 'own' as const } : {}
  return product === 'private' ? { visibility: 'private', ...infra }
    : product === 'business' ? { visibility: 'public', profile: 'EMPRESA_OTC', category: 'BUSINESS_OTC', ...infra }
      : { visibility: 'public', ...infra }
}

/**
 * Criar mercado (PO 2026-11-22: buying a space is part of creating a market; one entry point). Demo: 1 Escolha o tipo
 * (price shown up front) → 2 Configure (few fields, advanced options collapsed) → 3 Revisar e pagar (simulated
 * checkout) → Mercado criado. Real mode: the types and prices only as "Em breve", then today's honest walk-through
 * ending in "Prévia: a criação real depende do protocolo"; never a checkout.
 */
function CreateView() {
  const demo = isDemoMode()
  const { user } = useAuth()
  const { search } = useLocation()
  const query = new URLSearchParams(search)
  const [product, setProduct] = useState<SpaceProductId | null>(() => spaceProduct(query.get('space'))?.id ?? null)
  const initial = spaceDraft(product, query.get('node'))
  // Real mode: the final step opens a preview, never a created market (DECISIONS.md "Criar mercado, fluxo completo").
  const [preview, setPreview] = useState<MarketPreviewModel | null>(null)
  // Demo: the draft being paid for, then the fictional market it became ("Mercado criado").
  const [paying, setPaying] = useState<MarketPreviewModel | null>(null)
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null)
  // Bumped by "Descartar prévia" (and by a new type) to start the wizard over with an empty draft.
  const [draftKey, setDraftKey] = useState(0)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const wizardRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (created) createdRef.current?.focus() }, [created])
  const backToWizard = () => {
    setPreview(null)
    setPaying(null)
    // The wizard stayed mounted (hidden), so its draft and step are kept; put focus back on its step heading.
    requestAnimationFrame(() => wizardRef.current?.querySelector<HTMLElement>('h2')?.focus())
  }
  const startOver = () => { setCreated(null); setPreview(null); setPaying(null); setProduct(null); setDraftKey((k) => k + 1) }
  const createDemo = useCallback(() => {
    if (!paying) return
    // Local image previews stay with the wizard (revoked with it); the fictional market keeps the token art.
    const id = addDemoCreatedMarket({
      name: paying.name, description: paying.description ?? undefined, visibility: paying.visibility, infrastructure: paying.infrastructure,
      preset: paying.preset, category: paying.category, profile: paying.profile, participants: 1,
      // The person's own local previews (kept alive by retainUrl below), never uploaded.
      brandImage: paying.iconUrl ?? undefined, bannerImage: paying.bannerUrl ?? undefined,
      entryPolicy: { kyc: paying.entry.kyc, thresholdUsd: paying.entry.thresholdUsd ?? undefined, providerUrl: paying.entry.providerUrl ?? undefined, social: paying.entry.social },
    })
    if (id) setCreated({ id, name: paying.name })
  }, [paying])
  const facts = (p: MarketPreviewModel): [string, string][] => [
    [t('markets.create.review.name'), p.name],
    [t('spaces.create.review.category'), categoryLabel(p) ?? ''],
    [t('spaces.create.review.profile'), profileLabel(p) ?? ''],
    [t('spaces.create.review.entry'), entryText({ kyc: p.entry.kyc, thresholdUsd: p.entry.thresholdUsd ?? undefined, providerUrl: p.entry.providerUrl ?? undefined, social: p.entry.social })],
    [t('markets.create.review.participation'), marketListCopy().preset[p.preset]],
    [t('markets.create.step.infrastructure'), p.infrastructure === 'own' ? t('markets.create.infrastructure.ownLabel') : t('markets.create.infrastructure.networkLabel')],
  ]
  const primary = user ? 'default' : 'secondary'
  const space = spaceProduct(product)
  const [pick, setPick] = useState<SpaceProductId | null>(product)
  // One counter for the whole demo flow: Tipo, Configurar, Pagar, Pronto.
  const FLOW = ['spaces.create.flow.type', 'spaces.create.flow.configure', 'spaces.create.flow.pay', 'spaces.create.flow.done'] as const
  const flowStep = (n: 1 | 2 | 3 | 4) => t('markets.create.progress', { at: String(n), total: '4', title: t(FLOW[n - 1]) })
  const wizard = (simple: boolean) => (
    <div ref={wizardRef} hidden={preview !== null || paying !== null}>
      {simple && space && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-brand-elevated px-3 py-2">
          <p className="text-body-sm text-brand-text">{spaceName(space.id)} · <span className="tabular-nums">{formatUsd(space.demoPriceUsd)}</span> · {t('shop.oneTime')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setProduct(null); setDraftKey((k) => k + 1) }} className="touch:min-h-11">{t('spaces.create.changeType')}</Button>
        </div>
      )}
      <CreateMarketWizard
        key={`${draftKey}-${product ?? 'none'}`}
        copy={createCopy()}
        initial={initial}
        simple={simple}
        createLabel={simple ? t('spaces.create.reviewAndPay') : undefined}
        flow={simple ? { at: 2, total: 4, title: t('spaces.create.flow.configure') } : undefined}
        retainUrl={isRetainedPreview}
        privateHostingSlot={<PrivateHostingNote own={<p className="text-caption text-brand-text-secondary"><span className="font-medium text-brand-text">{t('spaces.hosting.own')}.</span> {t(simple ? 'spaces.hosting.ownNote' : 'spaces.hosting.ownInWizard')}</p>} />}
        brandingSlot={<WirePlanned id="marketBranding" description={t('markets.create.brandingPlanned')} />}
        invitesSlot={<WirePlanned id="marketInvite" label={t('markets.create.invitesLabel')} description={t('markets.create.invitesPlanned')} />}
        createAvailable={demo}
        unavailableNote={<WireNote ids={['createMarket']} />}
        participantsAvailable={demo}
        participantsUnavailableNote={<WireNote ids={['marketInvite']} />}
        onCreate={(d) => (simple ? setPaying(marketPreview(d)) : setPreview(marketPreview(d)))}
        primarySolid={!!user}
      />
    </div>
  )
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        {demo ? (
          created ? (
            <div className="space-y-4">
              <p className="text-caption text-brand-text-secondary">{flowStep(4)}</p>
              {/* A real success state: icon, title, one primary action (it is the interface's own confirmation). */}
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <CheckCircle2 aria-hidden="true" className="size-icon-lg text-brand-success" />
                <h2 ref={createdRef} tabIndex={-1} className="text-section-title outline-none">{t('spaces.created.title')}</h2>
                <p className="max-w-prose text-body-sm text-brand-text-secondary">{t('spaces.created.body', { name: created.name })}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                <Link to={marketPath(created.id)} className={cn(buttonVariants({ variant: primary }), 'touch:min-h-11')}>{t('spaces.created.open')}</Link>
                <Button type="button" variant="ghost" onClick={startOver} className="touch:min-h-11">{t('spaces.created.another')}</Button>
              </div>
            </div>
          ) : !space ? (
            <div className="space-y-4">
              <h2 className="text-section-title">{flowStep(1)}</h2>
              {/* Select, then Continuar: choosing never advances by itself. */}
              <SpaceTypePicker value={pick} onPick={setPick} />
              <div className="flex justify-end">
                <Button type="button" variant={primary} disabled={!pick} onClick={() => { setProduct(pick); setDraftKey((k) => k + 1) }} className="touch:min-h-11">{t('markets.create.next')}</Button>
              </div>
            </div>
          ) : (
            <>
              {wizard(true)}
              {paying && <SpaceCheckout product={space} rows={facts(paying)} primary={primary} stepLabel={flowStep(3)} onBack={backToWizard} onPaid={createDemo} />}
            </>
          )
        ) : (
          <>
            <div className="mb-6 space-y-3">
              <h2 className="text-section-title">{t('spaces.create.chooseType')}</h2>
              <SpaceTypePicker value={null} onPick={() => undefined} disabled />
              <WireNote ids={['spacePurchase']} />
            </div>
            {wizard(false)}
            {preview && (
              <MarketPreview
                preview={preview}
                copy={previewCopy()}
                banner={<PreviewBanner preview={preview} demo={demo} />}
                extraFacts={[
                  ...facts(preview).slice(1),
                  ...(preview.visibility === 'private' ? [[t('markets.list.visibility.private'), t('spaces.page.singleNode')] as [string, string]] : []),
                ]}
                onEdit={backToWizard}
                onDiscard={() => setConfirmDiscard(true)}
              />
            )}
          </>
        )}
        {/* The draft lives only in memory: discarding it cannot be undone, so it is confirmed first. */}
        <ConfirmActionDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t('markets.preview.discardTitle')}
          consequence={t('markets.preview.discardConsequence')}
          confirmLabel={t('markets.preview.discard')}
          onConfirm={() => { setConfirmDiscard(false); setDraftKey((k) => k + 1); backToWizard() }}
        />
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
  const { user } = useAuth()
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        <p className="mb-4 text-body-sm text-brand-text-secondary">{t('markets.join.intro')}</p>
        {isDemoMode() && <p className="-mt-2 mb-4 text-caption text-brand-text-muted">{t('spaces.page.privateAccess')}</p>}
        <JoinMarketPanel primarySolid={!!user} />
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
        // Each sub-page has its own title (the tab strip is the way between them).
        title={view === MARKETS_ROUTES.mine ? t('markets.action.mine') : view === MARKETS_ROUTES.create ? t('markets.action.create') : view === MARKETS_ROUTES.join ? t('markets.action.join') : t('markets.action.explore')}
        meta={t('markets.meta')}
        back={
          <Link to="/" className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market
          </Link>
        }
      >
        {/* Phones: scrolls sideways with faded edges; TabLinks brings the current tab into view. */}
        <TabLinks label={t('markets.title')} items={tabs()} className="overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]" />
      </PageHeader>
      {view === MARKETS_ROUTES.mine ? <MineView /> : view === MARKETS_ROUTES.create ? <CreateView /> : view === MARKETS_ROUTES.join ? <JoinView /> : <ExploreView />}
    </Page>
  )
}
