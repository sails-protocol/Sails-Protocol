import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router'
import { FaqTextLink } from '../components/faq/FaqLink'
import { PAYMENT_METHODS_FILTERABLE } from '../data/mock'
import { fetchOffers } from '../lib/realOffers'
import { countActiveFilters } from '../lib/filters'
import { OfferCard } from '../components/marketplace/OfferCard'
import { OfferTable } from '../components/marketplace/OfferTable'
import { compareOffers, isOwnOffer, offerAcceptsUsdAmount } from '../components/marketplace/offerList'
import { CountBadge, MobileField, MobileFiltersSheet } from '../components/marketplace/MobileFiltersSheet'
import { AssetPicker } from '../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../components/marketplace/CurrencyPicker'
import { PaymentMethodPicker } from '../components/marketplace/PaymentMethodPicker'
import { FilterPanel, SORT_OPTIONS } from '../components/marketplace/FilterPanel'
import { AgentIntentionPanel } from '../components/agent/AgentIntentionPanel'
import { Button, buttonVariants } from '../components/ui/button'
import { ListSkeleton } from '../components/ui/skeleton'
import { cn } from '../lib/utils'
import { SEGMENT_TRACK, segmentItemClass } from '../components/ui/SegmentedControl'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { StateBlock } from '../components/ui/StateBlock'
import { Alert } from '../components/ui/alert'
import { Input } from '../components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'
import { SlidersHorizontal, AlertTriangle, SearchX, Plus, ArrowDownUp } from 'lucide-react'
import { SideArrow } from '../components/ui/StatusBadges'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import type { AssetType, FiatCurrency, MarketplaceFilters, TradeSide } from '../types'
import { DEFAULT_FILTERS } from '../types'
import { REPUTATION_EXPLANATION } from '../lib/reputation'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import { acceptsAnyMethod, offerPaymentMethods } from '../lib/paymentMethods'
import { MarketPortalButton, MarketsCallToAction, MarketsDiscoveryCard } from './markets/MarketsEntry'
import { t } from '../i18n'

const SIDE_FILTERS: { value: TradeSide | 'Todos'; label: () => string }[] = [
  { value: 'Todos', label: () => t('market.side.all') },
  { value: 'BUY', label: () => t('labels.side.buy') },
  { value: 'SELL', label: () => t('labels.side.sell') },
]

const FILTERS_STORAGE_KEY = 'sails_ui_marketplace_filters'

export function Marketplace() {
  const [asset, setAsset] = useState<AssetType | 'Todos'>('Todos')
  const [currency, setCurrency] = useState<FiatCurrency | 'Todas'>('Todas')
  const [side, setSide] = useState<TradeSide | 'Todos'>('Todos')
  const [search, setSearch] = useState('')
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  // Mobile (<md): side segment + one "Filtros" button opening this bottom sheet.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Whichever "Filtros" button opened the sheet (mobile or tablet), so focus returns to it.
  const mobileFiltersTriggerRef = useRef<HTMLButtonElement | null>(null)
  // After "Limpar filtros" in the empty state, focus moves to the results once they render
  // ('afterLoad' waits for the refetch that an asset/side reset triggers).
  const focusResultsRef = useRef<null | 'now' | 'afterLoad'>(null)
  const [filters, setFilters] = useState<MarketplaceFilters>(() => {
    // Real bug found live: an unguarded JSON.parse in a useState
    // initializer throws synchronously during render — a corrupted or
    // pre-existing-incompatible-shape stored value would crash this whole
    // page (the app's own landing page) on every visit, not just fail to
    // load a preference.
    try {
      const stored = localStorage.getItem(FILTERS_STORAGE_KEY)
      return stored ? JSON.parse(stored) : DEFAULT_FILTERS
    } catch {
      return DEFAULT_FILTERS
    }
  })

  useEffect(() => {
    // Best-effort — a quota/private-browsing throw here shouldn't crash
    // the filter UI, just fail to persist the preference.
    try {
      if (filters.saveForNext) localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters))
      else localStorage.removeItem(FILTERS_STORAGE_KEY)
    } catch {
      // ignore — filters still work for this session, just won't survive a reload
    }
  }, [filters])

  // NAVIGATION-FILTER-1 §4.5 — moved to lib/filters.ts so the toolbar
  // badge here and FilterPanel's own in-drawer summary count the exact
  // same thing, not two independently-maintained definitions.
  const activeFilterCount = countActiveFilters(filters)
  // Everything the mobile sheet holds (asset, currency, search + the drawer's own filters).
  const mobileFilterCount = activeFilterCount + Number(asset !== 'Todos') + Number(currency !== 'Todas') + Number(search !== '')
  const hasAnyFilter = mobileFilterCount > 0 || side !== 'Todos'
  const clearAll = (focusResults = false) => {
    if (focusResults) focusResultsRef.current = asset !== 'Todos' || side !== 'Todos' ? 'afterLoad' : 'now'
    setAsset('Todos')
    setCurrency('Todas')
    setSide('Todos')
    setSearch('')
    setFilters((f) => ({ ...DEFAULT_FILTERS, saveForNext: f.saveForNext, sortBy: f.sortBy }))
  }

  // Real @satsails/p2p-trading-sdk liquidity.discover() calls (lib/realOffers.ts),
  // fanned out per asset/side since GET /v1/liquidity/offers only
  // filters by asset+side, not a bare "list everything". Client-side
  // filtering below (country/paymentMethods/etc.) stays, since the real
  // route doesn't support those filters server-side either (verified
  // against liquidity.routes.ts directly).
  const [allOffers, setAllOffers] = useState<import('../types').Offer[]>([])
  const [loadingOffers, setLoadingOffers] = useState(true)
  // hadError (2026-08-02) — distinguishes "backend unreachable" from
  // "no offers match" (SLC audit's own 🟡 finding: these rendered
  // identically before). fetchOffers() never throws itself (it fans out
  // per asset/side and can't map a partial failure to a single reject),
  // so this reads its own hadError flag instead of a .catch().
  const [offersError, setOffersError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadingOffers(true)
    fetchOffers(asset, side)
      .then(({ offers, hadError }) => {
        if (cancelled) return
        setAllOffers(offers)
        setOffersError(hadError)
      })
      .finally(() => {
        if (cancelled) return
        // This fetch started after the reset, so its results are the ones to focus.
        if (focusResultsRef.current === 'afterLoad') focusResultsRef.current = 'now'
        setLoadingOffers(false)
      })
    return () => { cancelled = true }
  }, [asset, side, reloadKey])

  useEffect(() => {
    if (focusResultsRef.current !== 'now' || loadingOffers) return
    focusResultsRef.current = null
    // Table (lg+) and compact list (<lg) are both in the DOM; focus the first link that is actually shown.
    const firstVisible = [...document.querySelectorAll<HTMLElement>('#marketplace-offer-grid a')].find((a) => a.offsetParent !== null)
    ;(firstVisible ?? document.getElementById('marketplace-offer-grid'))?.focus()
  })

  // The viewer's own offer ids (getMyOffers()): the public list carries no owner id, and an own offer
  // shows "Sua oferta" instead of a trade action. A failed read leaves every row with its normal action.
  const { user } = useAuth()
  const [ownOfferIds, setOwnOfferIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!user) {
      setOwnOfferIds(new Set())
      return
    }
    let cancelled = false
    sailsClient.liquidity
      .getMyOffers()
      .then((mine) => { if (!cancelled) setOwnOfferIds(new Set(mine.map((o) => o.id))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [user])
  const isOwn = (o: import('../types').Offer) => isOwnOffer(o, ownOfferIds, user?.id)

  const offers = useMemo(() => {
    let result = allOffers.filter((o) => {
      // Real bug found live: a cancelled/paused offer (Profile.tsx's new
      // "Cancelar oferta"/"Pausar" actions) still showed up here — this
      // filter never checked status at all, since until now nothing in
      // the UI could ever change one away from ACTIVE. Every real P2P
      // marketplace (Binance, Bisq, HodlHodl, ...) hides a paused/
      // cancelled ad from the public listing; only its owner sees it,
      // in Profile.tsx's "Minhas Ofertas".
      if (o.status !== 'ACTIVE') return false
      if (asset !== 'Todos' && o.asset !== asset) return false
      if (currency !== 'Todas' && o.fiatCurrency !== currency) return false
      if (side !== 'Todos' && o.side !== side) return false
      if (search && !o.user.displayName?.toLowerCase().includes(search.toLowerCase())) return false
      if (filters.negotiableOnly && o.blockedRelationship) return false
      if (filters.previouslyTradedOnly && !o.tradedWithCurrentUser) return false
      if (filters.country !== 'Todos' && o.country !== filters.country) return false
      if (!acceptsAnyMethod(offerPaymentMethods(o), filters.paymentMethods)) return false
      if (!offerAcceptsUsdAmount(o, Number(filters.amount))) return false
      return true
    })

    result = [...result].sort(compareOffers(filters.sortBy))

    return result
  }, [allOffers, asset, currency, side, search, filters])

  const sideSegment = (wrapClass: string, buttonClass: string) => (
    <div role="group" aria-label={t('market.side.label')} className={cn('flex gap-1', SEGMENT_TRACK, wrapClass)}>
      {SIDE_FILTERS.map((s) => (
        <button
          key={s.value}
          type="button"
          aria-pressed={side === s.value}
          onClick={() => setSide(s.value)}
          // Quiet selected state: the page's one solid orange is "Nova oferta".
          className={cn('px-3 inline-flex items-center justify-center gap-1', buttonClass, segmentItemClass(side === s.value, s.value === 'Todos' ? undefined : s.value))}
        >
          {s.value !== 'Todos' && <SideArrow side={s.value} />}
          {s.label()}
        </button>
      ))}
    </div>
  )

  const openMobileFilters = (e: MouseEvent<HTMLButtonElement>) => {
    mobileFiltersTriggerRef.current = e.currentTarget
    setMobileFiltersOpen(true)
  }
  const filtersLabel = (n: number) => (n > 0 ? t('market.filters.buttonActive', { count: String(n) }) : t('market.filters.button'))
  const countOf = (n: number) => String(n) // counts as before: no digit grouping
  const chipButton = 'h-9 touch:h-11 px-3 text-sm border-brand-border bg-brand-elevated state-layer hover:border-brand-border-hover'

  const sortSelect = (triggerClass: string) => (
    <Select value={filters.sortBy} onValueChange={(v) => setFilters({ ...filters, sortBy: v as MarketplaceFilters['sortBy'] })}>
      <SelectTrigger aria-label={t('market.sort.label')} className={cn('gap-2 text-sm bg-brand-elevated border-brand-border hover:border-brand-border-hover', triggerClass)}>
        {/* The icon and the accessible name say "Ordenar", so the value stays short enough for one toolbar row. */}
        <ArrowDownUp aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-muted" />
        <span className="mr-auto"><SelectValue /></span>
      </SelectTrigger>
      <SelectContent>
        {SORT_OPTIONS.map((s) => (
          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <Page>
      <PageHeader
        className="mb-4"
        title="Market"
        // The market portal (DECISIONS.md "Modelo mundo aberto"): discreet, next to the title; Mercado aberto is the default.
        titleAside={<MarketPortalButton />}
        // Only the count is a live region (announced as filters change); the attribution is static.
        meta={<><span role="status">{loadingOffers ? t('market.results.loading') : offers.length === 0 ? t('market.results.countZero') : t('market.results.count', { count: countOf(offers.length) })}</span> · Powered by Satsails</>}
        // Desktop: the side segment sits with the page title, which keeps every other filter plus sort and
        // search on one bar row at 1280. One solid primary per screen: signed out, that is the topbar's
        // "Conectar wallet" (it unlocks every action), so "Nova oferta" goes tonal until there is a session.
        actions={<>
          {sideSegment('hidden md:flex', 'h-8 touch:h-11')}
          <Link to={TRADES_ROUTES.newOffer} className={cn(buttonVariants({ variant: user ? 'default' : 'secondary', className: 'shrink-0 min-h-10 touch:min-h-11 px-4' }))}>
            <Plus aria-hidden="true" />
            {t('market.newOffer')}
          </Link>
        </>}
      />

      {/* Discovery at the right moment: dismissible, back after 30 days (lib/discoveryCard.ts). */}
      <MarketsDiscoveryCard className="mb-4" />

      <div>
        <AgentIntentionPanel
          matchCount={offers.length}
          onIntentGenerated={(a, s, c) => {
            setAsset(a)
            setSide(s)
            setCurrency(c)
          }}
          onResetFilters={() => {
            setAsset('Todos')
            setCurrency('Todas')
            setSide('Todos')
          }}
        />
      </div>

      {/* UI-FOUNDATION-1-VISUAL-CORRECTION §4.3/§4.5 — the toolbar now
          lives on its own tonal surface (bg-brand-surface + subtle
          border), separating "controls" from "content" instead of every
          control floating loose at equal weight against the page bg. */}
      {/* Mobile: one side segment + one Filtros button; everything else lives in the bottom sheet. */}
      <div className="md:hidden mt-4 flex gap-2">
        {sideSegment('flex-1 min-w-0', 'flex-1 h-8 touch:h-11 px-2')}
        <Button
          variant="outline"
          onClick={openMobileFilters}
          aria-haspopup="dialog"
          aria-expanded={mobileFiltersOpen}
          aria-label={filtersLabel(mobileFilterCount)}
          className={cn(chipButton, 'min-w-11')}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span className="hidden min-[360px]:inline">{t('market.filters.button')}</span>
          {mobileFilterCount > 0 && <CountBadge n={mobileFilterCount} />}
        </Button>
      </div>

      {/* One control row on the page background, never wrapping. lg+: every picker, Filtros (drawer) and
          search on the left, sort on the right; the search shrinks first. md: the main pickers, one
          Filtros button opening the same sheet as mobile (payment, search and the advanced filters), sort. */}
      <div className="hidden md:flex mt-4 gap-2 items-center">
        <AssetPicker value={asset} onChange={setAsset} />
        <CurrencyPicker value={currency} onChange={setCurrency} />
        <div className="hidden lg:block">
          <PaymentMethodPicker
            methods={PAYMENT_METHODS_FILTERABLE}
            value={filters.paymentMethods}
            onChange={(paymentMethods) => setFilters({ ...filters, paymentMethods })}
          />
        </div>

        <Button
          variant="outline"
          onClick={() => setFilterPanelOpen(true)}
          aria-label={filtersLabel(activeFilterCount)}
          className={cn(chipButton, 'hidden lg:inline-flex shrink-0')}
        >
          <SlidersHorizontal className="h-4 w-4" />
          {t('market.filters.button')}
          {activeFilterCount > 0 && <CountBadge n={activeFilterCount} />}
        </Button>
        <Button
          variant="outline"
          onClick={openMobileFilters}
          aria-haspopup="dialog"
          aria-expanded={mobileFiltersOpen}
          aria-label={filtersLabel(mobileFilterCount)}
          className={cn(chipButton, 'lg:hidden shrink-0')}
        >
          <SlidersHorizontal className="h-4 w-4" />
          {t('market.filters.button')}
          {mobileFilterCount > 0 && <CountBadge n={mobileFilterCount} />}
        </Button>

        {/* Search sits with the filters it narrows and shrinks before anything wraps. */}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('market.search.placeholder')}
          aria-label={t('market.search.label')}
          className="hidden lg:block flex-1 min-w-[7rem] max-w-[200px] bg-brand-elevated border-brand-border"
        />

        {/* Quick sort (2026-07-28): reference platforms (Binance P2P/
            Airtm/HodlHodl/El Dorado) all put sort directly on the main
            toolbar. Same `filters.sortBy` FilterPanel's own drawer edits,
            not a second source of truth. Right-aligned, apart from the filters. */}
        {sortSelect('ml-auto w-auto min-w-0 shrink-0')}
      </div>

      <MobileFiltersSheet
        open={mobileFiltersOpen}
        onOpenChange={setMobileFiltersOpen}
        triggerRef={mobileFiltersTriggerRef}
        title={t('market.filters.button')}
        closeLabel={t('common.close')}
        footer={<>
          <Button variant="outline" onClick={() => clearAll()} disabled={!hasAnyFilter} className="flex-1 min-h-11 text-sm">{t('market.clear')}</Button>
          <Button onClick={() => setMobileFiltersOpen(false)} className="flex-1 min-h-11 text-sm">
            {loadingOffers ? t('market.results.show') : offers.length === 0 ? t('market.results.showCountZero') : t('market.results.showCount', { count: countOf(offers.length) })}
          </Button>
        </>}
      >
        <MobileField label={t('market.field.asset')}><AssetPicker value={asset} onChange={setAsset} /></MobileField>
        <MobileField label={t('market.field.currency')}><CurrencyPicker value={currency} onChange={setCurrency} /></MobileField>
        <MobileField label={t('market.field.payment')}>
          <PaymentMethodPicker
            methods={PAYMENT_METHODS_FILTERABLE}
            value={filters.paymentMethods}
            onChange={(paymentMethods) => setFilters({ ...filters, paymentMethods })}
          />
        </MobileField>
        <MobileField label={t('market.field.sort')}>{sortSelect('w-full min-h-11')}</MobileField>
        <MobileField label={t('market.field.seller')}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('market.search.placeholder')}
            aria-label={t('market.search.label')}
            className="w-full min-h-11 bg-brand-elevated border-brand-border"
          />
        </MobileField>
        <Button
          variant="outline"
          onClick={() => {
            setMobileFiltersOpen(false)
            setFilterPanelOpen(true)
          }}
          className="w-full min-h-11 h-auto justify-between text-sm border-brand-border"
        >
          <span className="flex items-center gap-2"><SlidersHorizontal aria-hidden="true" /> {t('market.filters.advanced')}</span>
          {activeFilterCount > 0 && <CountBadge n={activeFilterCount} />}
        </Button>
      </MobileFiltersSheet>

      {/* Single hairline-divided list (2026-07-28), not a card grid —
          matches the Binance P2P/Airtm/El Dorado density this screen is
          modeled on; OfferCard's own `.offer-row` class supplies the
          divider/hover/accent-border treatment per row. */}
      {/* Partial-failure banner — shown alongside whatever offers DID
          load successfully, since a total-outage message would be
          dishonest when some (asset, side) pairs actually succeeded. */}
      {!loadingOffers && offersError && offers.length > 0 && (
        <Alert tone="warning" size="sm" live className="mt-4">
          {t('market.results.partialError')}
        </Alert>
      )}

      {/* One surface; rows carry at most one hairline. lg+ is a real <table> (OfferTable); below lg the
          same cells fold into compact rows (OfferCard). */}
      <div id="marketplace-offer-grid" tabIndex={-1} aria-label={t('market.results.label')} className="mt-3 rounded-lg border border-brand-border-subtle overflow-hidden bg-brand-surface [&_li:last-child>a]:border-b-0">
        {loadingOffers ? (
          <ListSkeleton label={t('market.results.loading')} rows={5} rowClassName="h-[5.75rem] lg:h-[4.25rem] lg:px-5" />
        ) : (
          <>
            {offers.length > 0 && (
              <>
                <div className="hidden lg:block"><OfferTable offers={offers} isOwn={isOwn} /></div>
                {/* Compact rows are whole-row links, so the reputation explanation sits above them, not inside one. */}
                <div className="lg:hidden flex justify-end border-b border-brand-border-subtle px-4">
                  <ExplanationPopover variant="text" explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.trigger} more={<FaqTextLink slug="reputacao">{t('faq.reputationLink')}</FaqTextLink>} />
                </div>
                <ul aria-label={t('market.results.list')} className="lg:hidden">
                  {offers.map((offer) => (
                    <li key={offer.id}><OfferCard offer={offer} own={isOwn(offer)} /></li>
                  ))}
                </ul>
              </>
            )}
            {/* UI-FOUNDATION-1-VISUAL-CORRECTION §4.6 — was a single flat
                line of muted text; a market with zero results deserves the
                same intentional-empty-state treatment as any real product
                (icon + primary message + supporting detail), not something
                that reads like an error the layout forgot to fill. */}
            {offers.length === 0 && (
              <StateBlock
                bare
                kind={offersError ? 'error' : 'empty'}
                icon={offersError ? AlertTriangle : SearchX}
                title={offersError ? t('market.error.title') : t('market.empty.title')}
                description={offersError ? t('market.error.description') : t('market.empty.description')}
                action={offersError ? (
                  <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-9 touch:min-h-11 px-4">{t('market.retry')}</Button>
                ) : hasAnyFilter ? (
                  <Button variant="outline" onClick={() => clearAll(true)} className="min-h-9 touch:min-h-11 px-4">{t('market.clearFilters')}</Button>
                ) : undefined}
                secondaryAction={offersError ? undefined : <MarketsCallToAction />}
              />
            )}
          </>
        )}
      </div>

      <FilterPanel
        open={filterPanelOpen}
        onClose={() => setFilterPanelOpen(false)}
        filters={filters}
        onChange={setFilters}
        currency="USD" // the amount filter compares in USD, the only unit list prices have (offerAcceptsUsdAmount)
      />
    </Page>
  )
}
