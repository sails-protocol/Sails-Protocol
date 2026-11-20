import { useEffect, useMemo, useState } from 'react'
import { ASSETS_FILTERABLE, HIGH_REPUTATION_THRESHOLD, PAYMENT_METHODS_FILTERABLE } from '../data/mock'
import { fetchOffers } from '../lib/realOffers'
import { countActiveFilters } from '../lib/filters'
import { OfferCard } from '../components/marketplace/OfferCard'
import { AssetPicker } from '../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../components/marketplace/CurrencyPicker'
import { PaymentMethodPicker } from '../components/marketplace/PaymentMethodPicker'
import { FilterPanel, SORT_OPTIONS } from '../components/marketplace/FilterPanel'
import { AgentIntentionPanel } from '../components/agent/AgentIntentionPanel'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'
import { SlidersHorizontal, AlertTriangle, SearchX, Loader2 } from 'lucide-react'
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
      .finally(() => { if (!cancelled) setLoadingOffers(false) })
    return () => { cancelled = true }
  }, [asset, side])

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

  return (
    <div>
      <h1 className="text-page-title">Market</h1>
      <p className="text-metadata mt-1">{offers.length} ofertas disponíveis · Powered by Satsails</p>

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
      <div className="mt-4 flex flex-wrap gap-2 items-center rounded-xl border border-brand-border-subtle bg-brand-surface px-3 py-2.5">
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
            className="flex items-center gap-1.5 px-3 py-2 text-sm relative border-brand-border-subtle bg-brand-elevated hover:bg-brand-elevated hover:border-brand-border"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filtros
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 flex items-center justify-center bg-brand-orange-accent text-white text-[10px] rounded-full">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>

        <div className="h-6 w-px bg-brand-border-subtle hidden sm:block" aria-hidden="true" />

        <div className="flex gap-1 bg-brand-elevated rounded-lg p-1">
          {SIDE_FILTERS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSide(s.value)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                side === s.value
                  ? 'bg-brand-orange-accent/15 text-brand-orange-accent font-medium'
                  : 'text-brand-text-secondary hover:text-brand-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Quick sort (2026-07-28): reference platforms (Binance P2P/
            Airtm/HodlHodl/El Dorado) all put sort directly on the main
            toolbar — burying it one click deep inside the Filtros drawer
            made it easy to miss. Same `filters.sortBy` FilterPanel's own
            drawer already edits, just exposed here too — not a second
            source of truth. */}
        <Select
          value={filters.sortBy}
          onValueChange={(v) => setFilters({ ...filters, sortBy: v as MarketplaceFilters['sortBy'] })}
        >
          <SelectTrigger
            aria-label="Ordenar por"
            className="text-sm w-auto min-w-0 bg-brand-elevated border-brand-border-subtle hover:border-brand-border"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>Ordenar: {s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por vendedor..."
          aria-label="Buscar por vendedor"
          className="ml-auto sm:max-w-[220px] bg-brand-elevated border-brand-border-subtle"
        />
      </div>

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
      <Card id="marketplace-offer-grid" className="mt-4 overflow-hidden border-brand-border-subtle bg-brand-surface [&>a:last-child]:border-b-0">
        {/* Desktop-only column header (Binance P2P/HodlHodl/El Dorado all
            label their offer-list columns) — hidden below `lg` since the
            mobile/tablet layout groups fields into paired rows instead of
            fixed columns, so column labels wouldn't line up with anything.
            Widths mirror OfferCard's own `lg:w-*` values exactly. */}
        <div className="text-label hidden lg:flex items-center gap-6 px-5 py-2 border-b border-brand-border-subtle">
          <span className="w-44 shrink-0">Anunciante</span>
          <span className="w-48 shrink-0">Ativo</span>
          <span className="flex-1">Preço</span>
          <span className="w-40 shrink-0">Limites</span>
          <span className="w-32 shrink-0">Pagamento</span>
          <span className="w-28 shrink-0 text-right">Ação</span>
        </div>
        {loadingOffers ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <Loader2 className="h-5 w-5 text-brand-text-muted animate-spin" aria-hidden="true" />
            <p className="text-metadata">Carregando ofertas...</p>
          </div>
        ) : (
          <>
            {offers.map((offer) => (
              <OfferCard key={offer.id} offer={offer} />
            ))}
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
