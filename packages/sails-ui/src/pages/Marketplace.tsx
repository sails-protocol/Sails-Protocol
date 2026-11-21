import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ASSETS_FILTERABLE, HIGH_REPUTATION_THRESHOLD, PAYMENT_METHODS_FILTERABLE } from '../data/mock'
import { fetchOffers } from '../lib/realOffers'
import { countActiveFilters } from '../lib/filters'
import { OfferCard } from '../components/marketplace/OfferCard'
import { AssetPicker } from '../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../components/marketplace/CurrencyPicker'
import { PaymentMethodPicker } from '../components/marketplace/PaymentMethodPicker'
import { FilterPanel, SORT_OPTIONS } from '../components/marketplace/FilterPanel'
import { AgentIntentionPanel } from '../components/agent/AgentIntentionPanel'
import { Button, buttonVariants } from '../components/ui/button'
import { ListSkeleton } from '../components/ui/skeleton'
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet'
import { cn } from '../lib/utils'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'
import { SlidersHorizontal, AlertTriangle, SearchX, Plus, X } from 'lucide-react'
import type { AssetType, FiatCurrency, MarketplaceFilters, TradeSide } from '../types'
import { DEFAULT_FILTERS } from '../types'

const SIDE_FILTERS: { value: TradeSide | 'Todos'; label: string }[] = [
  { value: 'Todos', label: 'Todos' },
  { value: 'BUY', label: 'Comprar' },
  { value: 'SELL', label: 'Vender' },
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
  const mobileFiltersTriggerRef = useRef<HTMLButtonElement>(null)
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
    ;(document.querySelector<HTMLElement>('#marketplace-offer-grid li a') ?? document.getElementById('marketplace-offer-grid'))?.focus()
  })

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
      if (filters.highReputationOnly && o.user.reputationScore < HIGH_REPUTATION_THRESHOLD) return false
      if (filters.previouslyTradedOnly && !o.tradedWithCurrentUser) return false
      if (filters.country !== 'Todos' && o.country !== filters.country) return false
      if (filters.paymentMethods.length > 0 && !filters.paymentMethods.includes(o.paymentMethod)) return false
      const amountNum = Number(filters.amount)
      if (amountNum > 0 && (amountNum < o.minAmount || amountNum > o.maxAmount)) return false
      return true
    })

    result = [...result].sort((a, b) => {
      if (filters.sortBy === 'trades') return b.user.totalTrades - a.user.totalTrades
      if (filters.sortBy === 'reputation') return b.user.reputationScore - a.user.reputationScore
      return a.priceUsd - b.priceUsd
    })

    return result
  }, [allOffers, asset, currency, side, search, filters])

  const sideSegment = (wrapClass: string, buttonClass: string) => (
    <div role="group" aria-label="Lado da oferta" className={cn('flex gap-1 bg-brand-elevated rounded-lg p-1', wrapClass)}>
      {SIDE_FILTERS.map((s) => (
        <button
          key={s.value}
          type="button"
          aria-pressed={side === s.value}
          onClick={() => setSide(s.value)}
          className={cn(
            'rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            buttonClass,
            side === s.value ? 'bg-primary text-primary-foreground font-medium' : 'text-brand-text-secondary hover:text-brand-text'
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  )

  const sortSelect = (triggerClass: string) => (
    <Select value={filters.sortBy} onValueChange={(v) => setFilters({ ...filters, sortBy: v as MarketplaceFilters['sortBy'] })}>
      <SelectTrigger aria-label="Ordenar por" className={cn('text-sm bg-brand-elevated border-brand-border hover:border-brand-border-hover', triggerClass)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SORT_OPTIONS.map((s) => (
          <SelectItem key={s.value} value={s.value}>Ordenar: {s.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-page-title">Market</h1>
          {/* Live region: announces the result count (including 0) as filters change. */}
          <p className="text-metadata mt-1" role="status">{loadingOffers ? 'Carregando ofertas' : `${offers.length} ${offers.length === 1 ? 'oferta disponível' : 'ofertas disponíveis'}`} · Powered by Satsails</p>
        </div>
        {/* Desktop: the side segment sits with the page title (tabs above the filter bar), which keeps
            every other filter plus sort and search on one bar row at 1280. */}
        <div className="flex items-center gap-3 shrink-0">
          {sideSegment('hidden md:flex', 'py-1.5')}
          <Link to="/profile/new-offer" className={cn(buttonVariants({ className: 'shrink-0 min-h-11 md:min-h-10 px-4' }))}>
            <Plus aria-hidden="true" />
            Nova oferta
          </Link>
        </div>
      </div>

      <div className="mt-4">
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
        {sideSegment('flex-1 min-w-0', 'flex-1 min-h-11 px-2')}
        <Button
          ref={mobileFiltersTriggerRef}
          variant="outline"
          onClick={() => setMobileFiltersOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={mobileFiltersOpen}
          aria-label={mobileFilterCount > 0 ? `Filtros, ${mobileFilterCount} ${mobileFilterCount === 1 ? 'ativo' : 'ativos'}` : 'Filtros'}
          className="min-h-11 min-w-11 h-auto px-3 text-sm border-brand-border bg-brand-elevated hover:bg-brand-elevated"
        >
          <SlidersHorizontal aria-hidden="true" />
          <span className="hidden min-[360px]:inline">Filtros</span>
          {mobileFilterCount > 0 && <CountBadge n={mobileFilterCount} />}
        </Button>
      </div>

      <div className="hidden md:flex mt-4 flex-wrap gap-2 items-center rounded-xl border border-brand-border-subtle bg-brand-surface px-3 py-2.5">
        <div className="flex flex-wrap gap-2 items-center">
          <AssetPicker assets={ASSETS_FILTERABLE} value={asset} onChange={setAsset} />
          <CurrencyPicker value={currency} onChange={setCurrency} />
          <PaymentMethodPicker
            methods={PAYMENT_METHODS_FILTERABLE}
            value={filters.paymentMethods}
            onChange={(paymentMethods) => setFilters({ ...filters, paymentMethods })}
          />

          <Button
            variant="outline"
            onClick={() => setFilterPanelOpen(true)}
            aria-label={activeFilterCount > 0 ? `Filtros, ${activeFilterCount} ${activeFilterCount === 1 ? 'ativo' : 'ativos'}` : 'Filtros'}
            className="flex items-center gap-1.5 px-3 py-2 text-sm relative border-brand-border bg-brand-elevated hover:bg-brand-elevated hover:border-brand-border-hover"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filtros
            {activeFilterCount > 0 && <CountBadge n={activeFilterCount} />}
          </Button>
        </div>

        <div className="h-6 w-px bg-brand-border-subtle" aria-hidden="true" />

        {/* Quick sort (2026-07-28): reference platforms (Binance P2P/
            Airtm/HodlHodl/El Dorado) all put sort directly on the main
            toolbar — burying it one click deep inside the Filtros drawer
            made it easy to miss. Same `filters.sortBy` FilterPanel's own
            drawer already edits, just exposed here too — not a second
            source of truth. */}
        {sortSelect('w-auto min-w-0')}

        {/* flex-1 + min/max width: shrinks before it wraps, so at 1280 sort and search stay on the filter row. */}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por vendedor..."
          aria-label="Buscar por vendedor"
          className="ml-auto flex-1 min-w-[10rem] max-w-[220px] bg-brand-elevated border-brand-border"
        />
      </div>

      <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <SheetContent
          side="bottom"
          hideDefaultClose
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // The trigger is a plain button (not SheetTrigger), so return focus to it explicitly.
            e.preventDefault()
            mobileFiltersTriggerRef.current?.focus()
          }}
          className="max-h-[85vh] p-0 gap-0 flex flex-col rounded-t-2xl border-brand-border-subtle bg-brand-surface">
          <div className="flex items-center justify-between gap-3 px-4 py-1 border-b border-brand-border-subtle shrink-0">
            <SheetTitle className="text-base">Filtros</SheetTitle>
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(false)}
              aria-label="Fechar"
              className="-mr-2 h-11 w-11 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* Every control here applies immediately (no staged "Aplicar"); the footer only closes. */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 [&_.toolbar-chip]:w-full [&_.toolbar-chip]:min-h-11">
            <MobileField label="Ativo"><AssetPicker assets={ASSETS_FILTERABLE} value={asset} onChange={setAsset} /></MobileField>
            <MobileField label="Moeda"><CurrencyPicker value={currency} onChange={setCurrency} /></MobileField>
            <MobileField label="Pagamento">
              <PaymentMethodPicker
                methods={PAYMENT_METHODS_FILTERABLE}
                value={filters.paymentMethods}
                onChange={(paymentMethods) => setFilters({ ...filters, paymentMethods })}
              />
            </MobileField>
            <MobileField label="Ordenar">{sortSelect('w-full min-h-11')}</MobileField>
            <MobileField label="Vendedor">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por vendedor..."
                aria-label="Buscar por vendedor"
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
              <span className="flex items-center gap-2"><SlidersHorizontal aria-hidden="true" /> Filtros avançados</span>
              {activeFilterCount > 0 && <CountBadge n={activeFilterCount} />}
            </Button>
          </div>
          <div className="shrink-0 border-t border-brand-border-subtle p-4 flex gap-2">
            <Button variant="outline" onClick={() => clearAll()} disabled={!hasAnyFilter} className="flex-1 min-h-11 text-sm">Limpar</Button>
            <Button onClick={() => setMobileFiltersOpen(false)} className="flex-1 min-h-11 text-sm">
              {loadingOffers ? 'Ver ofertas' : `Ver ${offers.length} ${offers.length === 1 ? 'oferta' : 'ofertas'}`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Single hairline-divided list (2026-07-28), not a card grid —
          matches the Binance P2P/Airtm/El Dorado density this screen is
          modeled on; OfferCard's own `.offer-row` class supplies the
          divider/hover/accent-border treatment per row. */}
      {/* Partial-failure banner — shown alongside whatever offers DID
          load successfully, since a total-outage message would be
          dishonest when some (asset, side) pairs actually succeeded. */}
      {!loadingOffers && offersError && offers.length > 0 && (
        <div className="mt-4 flex items-center gap-2 bg-brand-warning/10 border border-brand-warning/25 text-brand-warning text-xs rounded-lg px-3.5 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Algumas ofertas podem não ter carregado — houve falha ao buscar parte do Marketplace.
        </div>
      )}

      {/* border-brand-border-subtle overrides shadcn Card's own bare
          "border" (card.tsx) — the wireframe look this mission targets
          (§4.1) comes from that base border, not from the .card @layer
          class already softened in index.css. */}
      <Card id="marketplace-offer-grid" tabIndex={-1} aria-label="Resultados" className="mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring overflow-hidden border-brand-border-subtle bg-brand-surface [&_li:last-child>a]:border-b-0">
        {/* Desktop-only column header (Binance P2P/HodlHodl/El Dorado all
            label their offer-list columns) — hidden below `xl` since the
            mobile/tablet layout groups fields into paired rows instead of
            fixed columns, so column labels wouldn't line up with anything.
            Widths mirror OfferCard's own `lg:w-*` values exactly. */}
        <div aria-hidden="true" className="text-label hidden xl:flex items-center gap-4 px-5 py-2 border-b border-brand-border-subtle">
          <span className="w-44 shrink-0">Anunciante</span>
          <span className="w-36 shrink-0">Ativo</span>
          <span className="flex-1">Preço</span>
          <span className="w-36 shrink-0">Limites</span>
          <span className="w-40 shrink-0">Pagamento</span>
          <span className="w-28 shrink-0 text-right">Ação</span>
        </div>
        {loadingOffers ? (
          <ListSkeleton label="Carregando ofertas" rows={5} rowClassName="h-[10.125rem] xl:h-[4.375rem] xl:px-5" />
        ) : (
          <>
            {offers.length > 0 && (
              <ul aria-label="Ofertas">
                {offers.map((offer) => (
                  <li key={offer.id}><OfferCard offer={offer} /></li>
                ))}
              </ul>
            )}
            {/* UI-FOUNDATION-1-VISUAL-CORRECTION §4.6 — was a single flat
                line of muted text; a market with zero results deserves the
                same intentional-empty-state treatment as any real product
                (icon + primary message + supporting detail), not something
                that reads like an error the layout forgot to fill. */}
            {offers.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
                {offersError ? (
                  <AlertTriangle className="h-8 w-8 text-brand-warning/70" aria-hidden="true" />
                ) : (
                  <SearchX className="h-8 w-8 text-brand-text-muted" aria-hidden="true" />
                )}
                <p className="text-section-title">
                  {offersError ? 'Não foi possível carregar as ofertas' : 'Nenhuma oferta encontrada'}
                </p>
                <p className="text-metadata max-w-xs">
                  {offersError
                    ? 'Verifique sua conexão e tente novamente.'
                    : 'Ajuste os filtros ou o ativo selecionado para ver mais resultados.'}
                </p>
                {offersError ? (
                  <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-11 md:min-h-9 px-4 text-sm">Tentar novamente</Button>
                ) : hasAnyFilter && (
                  <Button variant="outline" onClick={() => clearAll(true)} className="min-h-11 md:min-h-9 px-4 text-sm">Limpar filtros</Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      <FilterPanel
        open={filterPanelOpen}
        onClose={() => setFilterPanelOpen(false)}
        filters={filters}
        onChange={setFilters}
        currency={currency === 'Todas' ? 'BRL' : currency}
      />
    </div>
  )
}

function CountBadge({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="min-w-5 h-5 px-1 flex items-center justify-center bg-brand-orange text-primary-foreground text-xs font-semibold tabular-nums rounded-full">
      {n}
    </span>
  )
}

function MobileField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-label mb-1.5">{label}</div>
      {children}
    </div>
  )
}
