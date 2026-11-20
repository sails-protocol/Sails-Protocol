/**
 * Dev-only (see App.tsx): Market Context Navigation prototype (D1, NAVIGATION-FILTER-1, docs/SAILS_DESIGN_LANGUAGE.md §16.6).
 * A mock of the Market header: context selector, then the Sails Agent, then the filters. Every market, community and
 * offer here is fictional: the protocol has no market/community discovery or membership today.
 */
import { useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, CircleDot, Info, Plus, SlidersHorizontal, WifiOff } from 'lucide-react'
import { MarketContextSelector } from '../../components/market-context/MarketContextSelector'
import { AssetPicker } from '../../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../../components/marketplace/CurrencyPicker'
import { PaymentMethodPicker } from '../../components/marketplace/PaymentMethodPicker'
import { SORT_OPTIONS } from '../../components/marketplace/FilterPanel'
import { CountBadge, MobileField, MobileFiltersSheet } from '../../components/marketplace/MobileFiltersSheet'
import { OfferCard } from '../../components/marketplace/OfferCard'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { ASSETS_FILTERABLE, PAYMENT_METHODS_FILTERABLE } from '../../data/mock'
import type { MarketContextCopy, MarketContextListState, MarketContextView } from '../../lib/marketContext'
import { cn } from '../../lib/utils'
import type { AssetType, FiatCurrency, MarketplaceFilters, Offer, PaymentMethod, TradeSide } from '../../types'

// All copy in one object so the pending naming decision (PROJECT_CONTEXT §2F.3) is a one-place rename.
const COPY = {
  selector: {
    label: 'Contexto de mercado',
    kind: { public: 'Público', community: 'Comunidade', restricted: 'Mercado restrito' },
    group: { public: 'Mercado público', community: 'Comunidades', restricted: 'Mercados restritos' },
    member: { member: 'Você participa', invited: 'Convite pendente', none: 'Você não participa' },
    block: { 'not-granted': 'Acesso não concedido', unavailable: 'Mercado indisponível' },
    current: 'Selecionado',
    listTitle: 'Escolher mercado',
    loading: 'Carregando mercados',
    loadError: 'Não foi possível carregar a lista de mercados. O Mercado público continua disponível.',
    retry: 'Tentar novamente',
    empty: 'Por enquanto, só o Mercado público está disponível.',
    close: 'Fechar',
  } satisfies MarketContextCopy,
  banner: 'Protótipo — dados fictícios; mercados e comunidades ainda não existem no protocolo',
  scenario: 'Cenário',
  pageTitle: 'Market',
  offersCount: (n: number) => `${n} ${n === 1 ? 'oferta disponível' : 'ofertas disponíveis'}`,
  inContext: (name: string) => `em ${name}`,
  poweredBy: 'Powered by Satsails',
  newOffer: 'Nova oferta',
  publishTo: (name: string) => `Publicar em: ${name} · não disponível no protótipo`,
  notInPrototype: 'não disponível no protótipo',
  // Illustrative only: D2 defines real connection semantics. Never implies server choice, redundancy or multi-node sync.
  connected: 'Conectado (ilustrativo)',
  connectionFailed: 'Falha de conexão (ilustrativo)',
  offlineCount: 'Ofertas não carregadas',
  offlineNotice: 'Sem conexão no momento, então nenhuma oferta foi carregada. Isso não significa que o mercado está vazio; você pode continuar navegando e tentar mais tarde.',
  filtersReset: (name: string) => `Você entrou em ${name}. Os filtros foram redefinidos, porque cada mercado tem os seus.`,
  noOffers: 'Nenhuma oferta neste mercado.',
  side: { all: 'Todos', BUY: 'Comprar', SELL: 'Vender', group: 'Lado da oferta' },
  filters: 'Filtros',
  filtersActive: (n: number) => `Filtros, ${n} ${n === 1 ? 'ativo' : 'ativos'}`,
  advancedFilters: 'Filtros avançados',
  moreFilters: 'Mais filtros',
  clear: 'Limpar',
  seeOffers: (n: number) => `Ver ${n} ${n === 1 ? 'oferta' : 'ofertas'}`,
  close: 'Fechar',
  fieldAsset: 'Ativo',
  fieldCurrency: 'Moeda',
  fieldPayment: 'Pagamento',
  fieldSort: 'Ordenar',
  fieldSeller: 'Vendedor',
  sortPrefix: 'Ordenar: ',
  sortLabel: 'Ordenar por',
  searchPlaceholder: 'Buscar por vendedor…',
  searchLabel: 'Buscar por vendedor',
  // Sails Agent: contextual action surface (§16.2), under the context control and above the manual filters.
  agentTitle: 'Sails Agent',
  agentSubtitle: 'Buscar e negociar neste mercado',
  agentOpen: 'Abrir Sails Agent',
  agentClose: 'Fechar Sails Agent',
  agentOffline: 'Indisponível sem conexão.',
  agentDemo: 'Demonstração',
  agentSteps: (name: string) => [
    'Você descreve o que quer negociar e os seus limites (preço, reputação mínima).',
    `O Sails Agent sugere ofertas de ${name} dentro desses limites.`,
    'Você aprova ou descarta. É sempre uma sugestão: nada acontece sem a sua aprovação.',
  ],
  agentNotInContext: 'Em comunidades e mercados restritos o Sails Agent ainda não busca ofertas: aqui só se demonstra o fluxo, sem resultados.',
  agentPublicNote: 'No Market real, aqui abre o painel atual do Sails Agent. Ele não é carregado no protótipo para não misturar dados fictícios com ações reais.',
}

const PUBLIC: MarketContextView = { id: 'public', name: 'Mercado público', kind: 'public', access: 'open', description: 'Explorar ofertas disponíveis' }
const COMMUNITY_SUL: MarketContextView = { id: 'c-sul', name: 'Comunidade Exemplo Sul', kind: 'community', access: 'open', memberStatus: 'member', description: 'Ofertas de um grupo fictício de negociantes' }
const COMMUNITY_NORTE: MarketContextView = { id: 'c-norte', name: 'Comunidade Exemplo Norte', kind: 'community', access: 'open', memberStatus: 'none', description: 'Ofertas de outro grupo fictício' }
const RESTRICTED_MEMBER: MarketContextView = { id: 'r-member', name: 'Mercado Exemplo Restrito', kind: 'restricted', access: 'restricted', memberStatus: 'member', description: 'Ofertas listadas só para participantes' }
const RESTRICTED_NOT_GRANTED: MarketContextView = { id: 'r-none', name: 'Mercado Exemplo Fechado', kind: 'restricted', access: 'restricted', memberStatus: 'none', unavailableReason: 'Você não participa deste mercado restrito.' }
const UNAVAILABLE: MarketContextView = { id: 'u-pausado', name: 'Comunidade Exemplo Pausada', kind: 'community', access: 'unavailable', unavailableReason: 'Esta comunidade existe, mas não pode ser listada agora.' }

const ALL = [PUBLIC, COMMUNITY_SUL, COMMUNITY_NORTE, RESTRICTED_MEMBER, RESTRICTED_NOT_GRANTED, UNAVAILABLE]

type ScenarioId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g-loading' | 'g-error' | 'h-offline'
const SCENARIOS: { id: ScenarioId; label: string; current: MarketContextView; options: MarketContextView[]; state: MarketContextListState; offline?: boolean }[] = [
  { id: 'a', label: 'a. Mercado público', current: PUBLIC, options: [PUBLIC], state: 'ready' },
  { id: 'b', label: 'b. Comunidades disponíveis', current: PUBLIC, options: [PUBLIC, COMMUNITY_SUL, COMMUNITY_NORTE], state: 'ready' },
  { id: 'c', label: 'c. Mercado restrito', current: RESTRICTED_MEMBER, options: ALL, state: 'ready' },
  { id: 'd', label: 'd. Troca de contexto', current: PUBLIC, options: ALL, state: 'ready' },
  { id: 'e', label: 'e. Só o público', current: PUBLIC, options: [PUBLIC], state: 'empty' },
  { id: 'f', label: 'f. Sem acesso / indisponível', current: PUBLIC, options: ALL, state: 'ready' },
  { id: 'g-loading', label: 'g. Carregando', current: PUBLIC, options: [PUBLIC], state: 'loading' },
  { id: 'g-error', label: 'g. Falha ao carregar', current: PUBLIC, options: [PUBLIC], state: 'unavailable' },
  { id: 'h-offline', label: 'h. Falha de conexão', current: PUBLIC, options: [PUBLIC], state: 'unavailable', offline: true },
]

function trader(id: string, displayName: string, reputationScore: number, totalTrades: number) {
  return { id, publicKey: `pk-${id}`, displayName, peerId: null, reputationScore, totalTrades, disputeCount: 0, totalVolumeBtc: 0, verified: false, createdAt: '2026-01-01T00:00:00Z' }
}
// Same shape as real rows (realOffers.ts): USD is the only price unit, no converted fiat.
function offer(id: string, user: ReturnType<typeof trader>, asset: AssetType, side: TradeSide, priceUsd: number, paymentMethod: PaymentMethod, minAmount: number, maxAmount: number): Offer {
  return { id, userId: user.id, user, asset, side, priceUsd, fiatCurrency: 'USD', priceFiat: priceUsd, minAmount, maxAmount, paymentMethod, status: 'ACTIVE', country: 'BR', tradedWithCurrentUser: false, blockedRelationship: false, createdAt: '2026-01-01T00:00:00Z' }
}
const T1 = trader('t1', 'Negociante Exemplo A', 96, 120)
const T2 = trader('t2', 'Negociante Exemplo B', 88, 41)
const T3 = trader('t3', 'Negociante Exemplo C', 92, 67)
const OFFERS: Record<string, Offer[]> = {
  public: [
    offer('o1', T1, 'BTC', 'SELL', 98500, 'PIX', 0.001, 0.05),
    offer('o2', T2, 'USDT_LIQUID', 'SELL', 1.0, 'PIX', 50, 2000),
    offer('o3', T3, 'BTC', 'BUY', 97800, 'TED', 0.002, 0.1),
  ],
  'c-sul': [offer('o4', T3, 'LIQUID_BTC', 'SELL', 98700, 'PIX', 0.001, 0.02), offer('o5', T1, 'BTC', 'BUY', 98000, 'CASH', 0.001, 0.01)],
  'c-norte': [offer('o6', T2, 'BTC', 'SELL', 98900, 'PIX', 0.001, 0.03)],
  'r-member': [offer('o7', T1, 'BTC', 'SELL', 98400, 'BANK_TRANSFER', 0.01, 0.2)],
}

export function MarketContextPreview() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('a')
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!
  const [currentId, setCurrentId] = useState(scenario.current.id)
  const [state, setState] = useState(scenario.state)
  const [asset, setAsset] = useState<AssetType | 'Todos'>('Todos')
  const [side, setSide] = useState<TradeSide | 'Todos'>('Todos')
  const [payments, setPayments] = useState<PaymentMethod[]>([])
  const [currency, setCurrency] = useState<FiatCurrency | 'Todas'>('Todas')
  const [sortBy, setSortBy] = useState<MarketplaceFilters['sortBy']>('price')
  const [search, setSearch] = useState('')
  const [agentOpen, setAgentOpen] = useState(false)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const mobileFiltersTriggerRef = useRef<HTMLButtonElement>(null)
  const [resetNotice, setResetNotice] = useState<string | null>(null)

  const current = ALL.find((o) => o.id === currentId) ?? PUBLIC
  // Offline: nothing was loaded, so nothing is shown (no cached data is invented).
  const offers = scenario.offline ? [] : (OFFERS[current.id] ?? []).filter((o) => (asset === 'Todos' || o.asset === asset) && (side === 'Todos' || o.side === side) && (payments.length === 0 || payments.includes(o.paymentMethod)) && (currency === 'Todas' || o.fiatCurrency === currency) && (!search || (o.user.displayName ?? '').toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (sortBy === 'reputation' ? b.user.reputationScore - a.user.reputationScore : sortBy === 'trades' ? b.user.totalTrades - a.user.totalTrades : a.priceUsd - b.priceUsd))
  const filterCount = (asset !== 'Todos' ? 1 : 0) + (currency !== 'Todas' ? 1 : 0) + (payments.length > 0 ? 1 : 0) + (search ? 1 : 0)

  // Filters belong to a context: never carried over.
  const resetFilters = () => {
    setAsset('Todos')
    setSide('Todos')
    setPayments([])
    setCurrency('Todas')
    setSortBy('price')
    setSearch('')
    setAgentOpen(false)
  }
  const pickScenario = (id: ScenarioId) => {
    const s = SCENARIOS.find((x) => x.id === id)!
    setScenarioId(id)
    setCurrentId(s.current.id)
    setState(s.state)
    resetFilters()
    setResetNotice(null)
  }
  const switchTo = (id: string) => {
    const next = ALL.find((o) => o.id === id)
    if (!next) return
    setCurrentId(id)
    resetFilters()
    setResetNotice(COPY.filtersReset(next.name))
  }

  const sideSegment = (wrapClass: string, buttonClass: string) => (
    <div role="group" aria-label={COPY.side.group} className={cn('flex gap-1 rounded-lg bg-brand-elevated p-1', wrapClass)}>
      {(['Todos', 'BUY', 'SELL'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={side === v}
          onClick={() => setSide(v)}
          className={cn(
            'rounded-md px-3 text-sm transition-colors',
            buttonClass,
            side === v ? 'bg-primary font-medium text-primary-foreground' : 'text-brand-text-secondary hover:text-brand-text'
          )}
        >
          {v === 'Todos' ? COPY.side.all : COPY.side[v]}
        </button>
      ))}
    </div>
  )
  const sortSelect = (triggerClass: string) => (
    <Select value={sortBy} onValueChange={(v) => setSortBy(v as MarketplaceFilters['sortBy'])}>
      <SelectTrigger aria-label={COPY.sortLabel} className={cn('border-brand-border bg-brand-elevated text-sm hover:border-brand-border-hover', triggerClass)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{COPY.sortPrefix}{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
  const searchInput = (className: string) => (
    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={COPY.searchPlaceholder} aria-label={COPY.searchLabel} className={cn('border-brand-border bg-brand-elevated', className)} />
  )

  return (
    <div className="mx-auto max-w-6xl">
      {/* Prototype banner + dev scenario switcher (collapsed, so it does not inflate the designed layout). */}
      <div role="note" className="rounded-lg border border-brand-warning/40 bg-brand-warning/10 px-3 py-1.5 text-xs text-brand-text">
        <details>
          <summary className="flex min-h-8 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 [&::-webkit-details-marker]:hidden">
            <span>{COPY.banner}</span>
            <span className="inline-flex items-center gap-1 font-mono text-brand-text-secondary">{COPY.scenario}: {scenario.label}<ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /></span>
          </summary>
          <div className="flex flex-wrap gap-1 border-t border-brand-warning/20 py-1.5">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={s.id === scenarioId}
                onClick={() => pickScenario(s.id)}
                className={cn(
                  'min-h-11 rounded-md px-2.5 font-mono text-xs',
                  s.id === scenarioId ? 'bg-brand-text text-brand-bg' : 'text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </details>
      </div>

      {/* Title row: count, global connection status and "Nova oferta" share one row. */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-page-title">{COPY.pageTitle}</h1>
          <p className="text-metadata mt-0.5 flex flex-wrap items-center gap-x-1.5">
            <span role="status">{scenario.offline ? COPY.offlineCount : COPY.offersCount(offers.length)} · {COPY.inContext(current.name)}</span>
            <span aria-hidden="true" className="max-sm:hidden">·</span>
            <span className="inline-flex items-center gap-1 max-sm:basis-full">
              {scenario.offline ? <WifiOff aria-hidden="true" className="h-3.5 w-3.5 text-brand-warning" /> : <CircleDot aria-hidden="true" className="h-3.5 w-3.5 text-brand-success" />}
              {scenario.offline ? COPY.connectionFailed : COPY.connected}
            </span>
            <span aria-hidden="true" className="max-sm:hidden">·</span>
            <span className="max-sm:hidden">{COPY.poweredBy}</span>
          </p>
        </div>
        {/* Functional HOLD: shows the intended destination, publishes nothing. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-3">
            {/* Same as the real Market: on desktop the side segment sits with the title, keeping the toolbar on one row. */}
            {sideSegment('hidden md:flex', 'py-1.5')}
            <Button aria-disabled="true" aria-describedby="publish-destination" className="min-h-11 cursor-not-allowed px-4 opacity-60 md:min-h-10">
              <Plus aria-hidden="true" />
              {COPY.newOffer}
            </Button>
          </div>
          <p id="publish-destination" className="max-w-[11rem] text-right text-caption leading-4 text-brand-text-muted sm:max-w-none">{COPY.publishTo(current.name)}</p>
        </div>
      </div>

      {/* Market Context Navigation: its own row, above the Sails Agent and outside the filter toolbar. */}
      <div className="mt-3">
        <MarketContextSelector
          key={scenarioId}
          current={current}
          options={scenario.options.includes(current) ? scenario.options : [current, ...scenario.options]}
          state={state}
          copy={COPY.selector}
          onSelect={switchTo}
          onRetry={() => setState('ready')}
        />
      </div>

      {resetNotice && (
        <p role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-brand-info/30 bg-brand-info/10 px-3 py-1.5 text-sm text-brand-text">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand-info" />
          {resetNotice}
        </p>
      )}

      {/* Sails Agent: a contextual action surface (§16.2) scoped to the selected context, before the manual filters. */}
      <section aria-label={COPY.agentTitle} className="mt-2 rounded-xl border border-brand-border-subtle bg-brand-surface">
        <button
          type="button"
          aria-expanded={scenario.offline ? undefined : agentOpen}
          aria-disabled={scenario.offline ? 'true' : undefined}
          aria-describedby="agent-subtitle"
          aria-label={scenario.offline ? COPY.agentTitle : agentOpen ? COPY.agentClose : COPY.agentOpen}
          onClick={() => !scenario.offline && setAgentOpen((o) => !o)}
          className={cn('flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-1 text-left', scenario.offline && 'cursor-not-allowed')}
        >
          <span aria-hidden="true" className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', scenario.offline ? 'bg-brand-elevated text-brand-text-muted' : 'bg-brand-orange-accent/10 text-brand-orange-accent')}>
            <Bot className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-brand-text">{COPY.agentTitle}</span>
            <span id="agent-subtitle" className="min-w-0 truncate text-metadata">{scenario.offline ? COPY.agentOffline : COPY.agentSubtitle}</span>
          </span>
          {!scenario.offline && (agentOpen ? <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" /> : <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" />)}
        </button>
        {agentOpen && !scenario.offline && (
          <div className="border-t border-brand-border-subtle px-3 py-3">
            <div className="rounded-lg border border-dashed border-brand-border px-3 py-2.5">
              <span className="rounded border border-brand-border px-1.5 text-caption font-medium uppercase tracking-wider text-brand-text-secondary">{COPY.agentDemo}</span>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-brand-text-secondary">
                {COPY.agentSteps(current.name).map((step) => <li key={step}>{step}</li>)}
              </ol>
              <p className="mt-2 text-xs text-brand-text-muted">{current.kind === 'public' ? COPY.agentPublicNote : COPY.agentNotInContext}</p>
            </div>
          </div>
        )}
      </section>

      {/* Desktop/tablet (md+): the real Market toolbar. */}
      <div className="mt-3 hidden flex-wrap items-center gap-2 rounded-xl border border-brand-border-subtle bg-brand-surface px-3 py-2 md:flex">
        <AssetPicker assets={ASSETS_FILTERABLE} value={asset} onChange={setAsset} />
        <CurrencyPicker value={currency} onChange={setCurrency} />
        <PaymentMethodPicker methods={PAYMENT_METHODS_FILTERABLE} value={payments} onChange={setPayments} />
        <button type="button" aria-disabled="true" aria-describedby="more-filters-note" className="toolbar-chip flex cursor-not-allowed items-center gap-1.5">
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          {COPY.moreFilters}
          <span id="more-filters-note" className="sr-only">({COPY.notInPrototype})</span>
        </button>
        {sortSelect('w-auto min-w-0')}
        {searchInput('ml-auto min-w-[10rem] flex-1 max-w-[220px]')}
      </div>

      {/* Mobile (<md): the real Market pattern, side segment + "Filtros" opening the shared bottom sheet. */}
      <div className="mt-3 flex gap-2 md:hidden">
        {sideSegment('min-w-0 flex-1', 'min-h-11 flex-1 px-2')}
        <Button
          ref={mobileFiltersTriggerRef}
          variant="outline"
          onClick={() => setMobileFiltersOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={mobileFiltersOpen}
          aria-label={filterCount > 0 ? COPY.filtersActive(filterCount) : COPY.filters}
          className="h-auto min-h-11 min-w-11 border-brand-border bg-brand-elevated px-3 text-sm hover:bg-brand-elevated"
        >
          <SlidersHorizontal aria-hidden="true" />
          <span className="hidden min-[360px]:inline">{COPY.filters}</span>
          {filterCount > 0 && <CountBadge n={filterCount} />}
        </Button>
      </div>
      <MobileFiltersSheet
        open={mobileFiltersOpen}
        onOpenChange={setMobileFiltersOpen}
        triggerRef={mobileFiltersTriggerRef}
        title={COPY.filters}
        closeLabel={COPY.close}
        footer={
          <>
            <Button variant="outline" onClick={resetFilters} disabled={filterCount === 0} className="min-h-11 flex-1 text-sm">{COPY.clear}</Button>
            <Button onClick={() => setMobileFiltersOpen(false)} className="min-h-11 flex-1 text-sm">{scenario.offline ? COPY.close : COPY.seeOffers(offers.length)}</Button>
          </>
        }
      >
        <MobileField label={COPY.fieldAsset}><AssetPicker assets={ASSETS_FILTERABLE} value={asset} onChange={setAsset} /></MobileField>
        <MobileField label={COPY.fieldCurrency}><CurrencyPicker value={currency} onChange={setCurrency} /></MobileField>
        <MobileField label={COPY.fieldPayment}><PaymentMethodPicker methods={PAYMENT_METHODS_FILTERABLE} value={payments} onChange={setPayments} /></MobileField>
        <MobileField label={COPY.fieldSort}>{sortSelect('min-h-11 w-full')}</MobileField>
        <MobileField label={COPY.fieldSeller}>{searchInput('min-h-11 w-full')}</MobileField>
        <Button variant="outline" aria-disabled="true" aria-describedby="advanced-filters-note" className="h-auto min-h-11 w-full cursor-not-allowed justify-between border-brand-border text-sm opacity-60">
          <span className="flex items-center gap-2"><SlidersHorizontal aria-hidden="true" /> {COPY.advancedFilters}</span>
          <span id="advanced-filters-note" className="text-xs">{COPY.notInPrototype}</span>
        </Button>
      </MobileFiltersSheet>

      {/* Fictional rows: capture clicks so the links never open a real offer route. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-brand-border-subtle" onClickCapture={(e) => e.preventDefault()}>
        {offers.length > 0 ? offers.map((o) => <OfferCard key={o.id} offer={o} />) : <p className="px-4 py-8 text-center text-sm text-brand-text-secondary">{scenario.offline ? COPY.offlineNotice : COPY.noOffers}</p>}
      </div>
    </div>
  )
}
