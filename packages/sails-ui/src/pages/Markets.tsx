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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Button, buttonVariants } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { FilterChip } from '../components/ui/filter-chip'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { MarketCard } from '../components/markets/MarketCard'
import { MarketList } from '../components/markets/MarketList'
import { FactList } from '../components/markets/FactList'
import { CreateMarketWizard, type CreateMarketCopy } from '../components/markets/CreateMarketWizard'
import { marketPreview, parseUsdWhole, type MarketDraft, type MarketPreviewModel } from '../lib/createMarket'
import { addDemoCreatedMarket, demoMarketPage, isDemoMode, isRetainedPreview } from '../lib/demoMarkers'
import { MARKET_CATEGORIES, filterByCategory, offersForMarket, pageOf, readViewMode, saveViewMode, type CategoryFilter, type ViewMode } from '../lib/marketSpaces'
import { spaceProduct, type SpaceProductId } from '../lib/spaceCatalog'
import { SpaceCheckout, SpaceTypePicker, spaceName } from './spaces/SpaceCheckout'
import { formatAmount, formatUsd } from '../lib/format'
import { IMAGE_MAX_BYTES, IMAGE_SPECS, formatPx, type ImageKind } from '../lib/imageCheck'
import { getLocale } from '../lib/locale'
import type { ImagePickerCopy } from '../components/markets/ImagePicker'
import type { MarketView } from '../lib/myMarkets'
import type { Offer } from '../types'
import { fetchOffers } from '../lib/realOffers'
import { pairForAssetType } from '../lib/assetCatalog'
import { cn } from '../lib/utils'
import { categoryLabel, DemoVerifiedSeal, entryText, guarantees, identifiers, JoinMarketPanel, marketCardCopy, marketListCopy, marketsValueLine, PrivateHostingNote, profileLabel, RoleLinks, simulatedToast, SOCIAL_OPTIONS, WireNote, WirePlanned, useVisibleMarkets } from './markets/shared'
import { MarketIcon, MARKET_ACTION_ICON } from '../components/markets/MarketIcon'
import { ownMarkets } from '../lib/myMarkets'
import { useAuth } from '../context/AuthContext'
import { t } from '../i18n'
import { MarketRoleLine, RecoveryAuthorityChoice, RecoveryObjectionBanner } from '../components/settings/PortableIdentityDemo'

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
const imageCopy = (kind: ImageKind, label: string, name: string): ImagePickerCopy => {
  const spec = IMAGE_SPECS[kind]
  const locale = getLocale()
  const formats = t(kind === 'icon' ? 'spaces.create.formatsIcon' : 'spaces.create.formatsPhoto')
  const max = t('spaces.create.maxSize', { mb: IMAGE_MAX_BYTES / 1024 / 1024 })
  const rec = formatPx(spec.recommended, locale)
  return {
    label,
    help: t('spaces.create.imageHelp', { ratio: spec.ratioLabel, rec, min: formatPx(spec.minimum, locale), formats, max }) + (kind === 'icon' ? '' : ` ${t('spaces.create.safeArea')}`),
    choose: t('spaces.create.choose'), replace: t('spaces.create.replace'), remove: t('spaces.create.remove'),
    names: Object.fromEntries((['choose', 'replace', 'remove'] as const).map((a) => [a, t('spaces.create.imageActionName', { action: t(`spaces.create.${a}`), image: name })])) as ImagePickerCopy['names'],
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
      // CTO 36 (C): simulated in the demo, "Em breve" (not selectable) in real mode.
      { value: 'managed', label: `${t('markets.create.infrastructure.managedLabel')} (${isDemoMode() ? t('spaces.simulated') : t('common.soon')})`, description: t('markets.create.infrastructure.managedDescription'), disabled: !isDemoMode() },
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
      icon: imageCopy('icon', t('spaces.create.icon'), t('spaces.create.iconName')),
      banner: imageCopy('banner', t('spaces.create.banner'), t('spaces.create.bannerName')),
      cover: imageCopy('cover', t('spaces.create.cover'), t('spaces.create.coverName')),
      coverToggle: t('spaces.create.coverToggle'),
      note: t('spaces.create.imagesNote'),
    },
    advanced: t('spaces.create.advanced'),
    hostingLegend: t('spaces.create.hostingLegend'),
    privateHostingNote: t('spaces.page.singleNode'),
    requiredHint: t('spaces.create.requiredHint'),
    entry: {
      lead: t('spaces.create.entryLead'),
      kycLegend: t('spaces.create.kycLegend'),
      kyc: [
        { value: 'none', label: t('spaces.kyc.none'), description: t('spaces.create.kyc.noneDescription') },
        { value: 'above_threshold', label: t('spaces.create.kyc.above'), description: t('spaces.create.kyc.aboveDescription') },
        { value: 'all', label: t('spaces.create.kyc.all'), description: t('spaces.create.kyc.allDescription') },
      ],
      threshold: t('spaces.create.threshold'), thresholdHelp: t('spaces.create.thresholdHelp', { amount: formatAmount(10000, 0) }), thresholdError: t('spaces.create.thresholdError'),
      provider: t('spaces.create.provider'), providerHelp: t('spaces.create.providerHelp'), providerError: t('spaces.create.providerError'),
      providerName: t('spaces.create.providerName'), providerNameHelp: t('spaces.create.providerNameHelp'),
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

// The 2×2 of visibility × infrastructure (CTO final correction): one example each, all independent choices.
function examples(): readonly { key: string; visibility: string; infrastructure: string; example: string }[] {
  const pub = t('markets.list.visibility.public')
  const priv = t('markets.list.visibility.private')
  const own = t('markets.create.infrastructure.ownLabel')
  const network = t('markets.create.infrastructure.networkLabel')
  return [
    { key: 'public-network', visibility: pub, infrastructure: network, example: t('markets.create.example.publicNetwork') },
    { key: 'public-own', visibility: pub, infrastructure: own, example: t('markets.create.example.publicOwn') },
    { key: 'private-network', visibility: priv, infrastructure: network, example: t('markets.create.example.privateNetwork') },
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
  // "Mais ativas" first (demo: negociações em 30 dias); members as the other order.
  const [sort, setSort] = useState<'active' | 'members'>('active')
  // Demo: the asset chips come from the same offers the market page lists, so they always match.
  const [demoOffers, setDemoOffers] = useState<Offer[]>([])
  useEffect(() => {
    if (!isDemoMode()) return
    let cancelled = false
    fetchOffers('Todos', 'Todos').then(({ offers }) => { if (!cancelled) setDemoOffers(offers) })
    return () => { cancelled = true }
  }, [])
  const withAssets = (m: MarketView): MarketView => ({ ...m, assets: [...new Set(offersForMarket(demoOffers, m.id).map((o) => pairForAssetType(o.asset)?.label ?? o.asset))] })
  const [limit, setLimit] = useState(PAGE_SIZE)
  // Shaped like sails.markets.discover({ limit, offset }) so the swap keeps the paging.
  const sorted = [...filterByCategory(communities, category)].sort((a, b) => (sort === 'active' ? (b.activity30d ?? 0) - (a.activity30d ?? 0) : (b.participants ?? 0) - (a.participants ?? 0)))
  const page = pageOf(sorted.map(withAssets), limit)
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
            <SegmentedControl label={t('spaces.explore.sortLabel')} value={sort} onChange={setSort} options={[{ value: 'active', label: t('spaces.explore.sortActive') }, { value: 'members', label: t('spaces.explore.sortMembers') }]} />
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
  // "Seu espaço": markets the person administers or created. Transferir is simulated in the demo (no transfer exists).
  const [transferring, setTransferring] = useState<MarketView | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const yours = (m: MarketView) => m.relation === 'admin' || !!m.ownedByYou
  // CTO 29 (marketOwnershipRecovery wire), demo only: role and hosting in plain words.
  // shortcut: the contract has adminIdentity but no owner/delegate role, so every demo space of yours reads "Proprietário"; use the role field when the Principal adds it.
  const roleLine = (m: MarketView, className?: string) => (demo && yours(m) ? <MarketRoleLine role="owner" infrastructure={m.infrastructure} className={className} /> : null)
  const transferButton = (m: MarketView) => (
    <Button type="button" size="sm" variant="ghost" onClick={() => setTransferring(m)} className="relative z-10 touch:min-h-11">{t('spaces.transfer')}<span className="sr-only"> {m.name}</span></Button>
  )
  // "Painel do espaço" lives on the market page (tab Painel), owner only.
  const dashboardLink = (m: MarketView) => (
    <Link to={`${marketPath(m.id)}?tab=dashboard`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'relative z-10 touch:min-h-11')}>{t('stats.space.tab')}<span className="sr-only"> {m.name}</span></Link>
  )
  // CTO 29, demo: the owner's notice of a pending recovery of one of their markets (the old device's view).
  const recoveryNotice = demo ? markets.find(yours) : undefined
  return (
    <div className="space-y-4">
      {recoveryNotice && <RecoveryObjectionBanner marketName={recoveryNotice.name} />}
      {/* Transferir (demo): the target identity, then the same 7-day safety period with objection as a recovery (CTO 29). */}
      <Dialog open={transferring !== null} onOpenChange={(o) => { if (!o) { setTransferring(null); setTransferTo('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('spaces.transferTitle', { name: transferring?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('spaces.transferBody')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              const to = transferTo.trim()
              if (!to || !transferring) return
              simulatedToast(t('spaces.transferToast', { name: transferring.name, to: to.length > 20 ? `${to.slice(0, 10)}…${to.slice(-6)}` : to }))
              setTransferring(null)
              setTransferTo('')
            }}
          >
            <label htmlFor="transfer-to" className="text-sm font-medium text-brand-text">{t('spaces.transferTo')}</label>
            <Input id="transfer-to" name="transfer-to" autoComplete="off" spellCheck={false} value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="font-mono" />
            <p className="text-caption text-brand-text-secondary">{t('spaces.transferSafety')}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={() => { setTransferring(null); setTransferTo('') }} className="touch:min-h-11">{t('common.cancel')}</Button>
              <Button type="submit" disabled={!transferTo.trim()} className="touch:min-h-11">{t('spaces.transfer')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The page h1 already says Meus mercados: this h2 names the list by its size. */}
        <h2 className="text-section-title">{t('spaces.portal.mineCount', { count: markets.length })}</h2>
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
              <MarketCard
                market={m} copy={cardCopy} className="w-full"
                badges={yours(m) ? <><Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{t('spaces.yourSpace')}</Badge>{roleLine(m, 'basis-full')}</> : undefined}
                action={<div className="flex flex-wrap gap-2"><OpenLink m={m} />{yours(m) && dashboardLink(m)}{yours(m) && transferButton(m)}</div>}
              />
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
              <div className="flex flex-wrap items-center justify-end gap-1">
                {roleLine(m, 'w-full text-right sm:w-auto')}
                {yours(m) && <Badge variant="outline" className="hidden border-transparent bg-brand-tonal font-medium text-brand-text sm:inline-flex">{t('spaces.yourSpace')}</Badge>}
                {yours(m) && dashboardLink(m)}
                {yours(m) && transferButton(m)}
                <Link to={m.relation === 'default' ? '/' : marketPath(m.id)} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'touch:min-h-11')}>
                  {t('markets.explore.open')}<span className="sr-only"> {m.name}</span>
                </Link>
              </div>
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
  // Communities start on "Todos publicam"; private markets are invite-only, so their preset is never asked.
  return product === 'private' ? { visibility: 'private', preset: 'comunidade', ...infra }
    : product === 'business' ? { visibility: 'public', preset: 'comunidade', profile: 'EMPRESA_OTC', category: 'COMMERCE', ...infra }
      : { visibility: 'public', preset: 'comunidade', ...infra }
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
      entryPolicy: { kyc: paying.entry.kyc, thresholdUsd: paying.entry.thresholdUsd ?? undefined, providerUrl: paying.entry.providerUrl ?? undefined, providerName: paying.entry.providerName ?? undefined, social: paying.entry.social },
    })
    if (id) setCreated({ id, name: paying.name })
  }, [paying])
  const facts = (p: MarketPreviewModel): [string, string][] => [
    [t('markets.create.review.name'), p.name],
    [t('spaces.create.review.category'), categoryLabel(p) ?? ''],
    [t('spaces.create.review.profile'), profileLabel(p) ?? ''],
    [t('spaces.create.review.entry'), entryText({ kyc: p.entry.kyc, thresholdUsd: p.entry.thresholdUsd ?? undefined, providerUrl: p.entry.providerUrl ?? undefined, social: p.entry.social })],
    ...(p.visibility === 'private' ? [] : [[t('markets.create.review.participation'), marketListCopy().preset[p.preset]] as [string, string]]),
    [t('spaces.create.hostingLegend'), marketListCopy().infrastructure[p.infrastructure]],
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
        recoverySlot={<RecoveryAuthorityChoice name="market-recovery" />}
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
              {paying && <SpaceCheckout product={space} rows={facts(paying)} images={{ icon: paying.iconUrl, banner: paying.bannerUrl }} primary={primary} stepLabel={flowStep(3)} onBack={backToWizard} onPaid={createDemo} />}
            </>
          )
        ) : (
          <>
            {/* Real mode (PM 2026-11-22, refining the PO decision of 2026-11-21): the kinds as "Em breve" and one honest
                note, never the step form underneath, so the screen does not offer and deny creation at once. */}
            <div className="space-y-3">
              <h2 className="text-section-title">{t('spaces.create.chooseType')}</h2>
              <SpaceTypePicker value={null} onPick={() => undefined} disabled />
              <Alert tone="info" title={t('common.soon')}>{t('spaces.create.realNote')}</Alert>
            </div>
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
      <FactList level={2} title={t('markets.guarantees.title')} facts={guarantees()} />
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
      {/* Owning a market lives here; the other two roles (CTO 36 note) are one link away. */}
      {(view === MARKETS_ROUTES.mine || view === MARKETS_ROUTES.create) && <RoleLinks here="market" className="mt-6" />}
    </Page>
  )
}
