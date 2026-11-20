/**
 * Dev-only (see App.tsx): Market Context Navigation prototype (D1, NAVIGATION-FILTER-1, docs/SAILS_DESIGN_LANGUAGE.md §16.6).
 * A mock of the Market header with the context selector ABOVE the filter toolbar. Every market, community and
 * offer here is fictional: the protocol has no market/community discovery or membership today.
 */
import { useState } from 'react'
import { Bot, ChevronDown, ChevronUp, CircleDot, CircleOff, Info, Plus, SlidersHorizontal } from 'lucide-react'
import { MarketContextSelector } from '../../components/market-context/MarketContextSelector'
import { AssetPicker } from '../../components/marketplace/AssetPicker'
import { CurrencyPicker } from '../../components/marketplace/CurrencyPicker'
import { PaymentMethodPicker } from '../../components/marketplace/PaymentMethodPicker'
import { SORT_OPTIONS } from '../../components/marketplace/FilterPanel'
import { Input } from '../../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { OfferCard } from '../../components/marketplace/OfferCard'
import { Button } from '../../components/ui/button'
import { ASSETS_FILTERABLE, PAYMENT_METHODS_FILTERABLE } from '../../data/mock'
import { canViewContextContent, type MarketContextCopy, type MarketContextListState, type MarketContextView } from '../../lib/marketContext'
import { cn } from '../../lib/utils'
import type { AssetType, FiatCurrency, MarketplaceFilters, Offer, PaymentMethod, TradeSide } from '../../types'

// All copy in one object so the pending naming decision (PROJECT_CONTEXT §2F.3) is a one-place rename.
const COPY = {
  selector: {
    label: 'Contexto de mercado',
    kind: { public: 'Público', community: 'Comunidade', private: 'Privado' },
    member: { member: 'Você participa', invited: 'Convite pendente', none: 'Você não participa' },
    current: 'Selecionado',
    listTitle: 'Escolher mercado',
    loading: 'Carregando mercados',
    loadError: 'Não foi possível carregar a lista de mercados. O Mercado público continua disponível.',
    retry: 'Tentar novamente',
    empty: 'Por enquanto, só o Mercado público está disponível.',
    close: 'Fechar',
  } satisfies MarketContextCopy,
  banner: 'Protótipo — dados fictícios; mercados e comunidades ainda não existem no protocolo',
  scenario: 'Cenário do protótipo',
  pageTitle: 'Market',
  offersCount: (n: number) => `${n} ${n === 1 ? 'oferta disponível' : 'ofertas disponíveis'}`,
  poweredBy: 'Powered by Satsails',
  newOffer: 'Nova oferta',
  sortPrefix: 'Ordenar: ',
  sortLabel: 'Ordenar por',
  searchPlaceholder: 'Buscar por vendedor...',
  searchLabel: 'Buscar por vendedor',
  // Sails Agent: contextual action surface (§16.2), placed under the context control and above manual filters.
  agentTitle: 'Sails Agent',
  agentSubtitle: (name: string) => `Buscar e negociar neste mercado · ${name}`,
  agentOpen: 'Abrir Sails Agent',
  agentClose: 'Fechar Sails Agent',
  agentBody: (name: string) => `Descreva o que você quer negociar. O Sails Agent sugere ofertas de ${name} dentro dos limites que você definir e prepara uma proposta. É sempre uma sugestão: nada acontece sem a sua aprovação.`,
  agentProtoNote: 'Protótipo: o painel real do Sails Agent (o mesmo do Market de hoje) não é carregado aqui, para não misturar dados fictícios com ações reais.',
  agentOffline: 'Sails Agent indisponível sem conexão.',
  inContext: (name: string) => `em ${name}`,
  filtersReset: (name: string) => `Você entrou em ${name}. Os filtros foram redefinidos, porque cada mercado tem os seus.`,
  gateTitle: 'Acesso indisponível',
  gateBack: 'Voltar ao Mercado público',
  noOffers: 'Nenhuma oferta neste mercado.',
  side: { all: 'Todos', BUY: 'Comprar', SELL: 'Vender', group: 'Lado da oferta' },
  moreFilters: 'Mais filtros',
  moreFiltersNote: 'Não disponível no protótipo',
  // Illustrative only: D2 defines real connection semantics. Never implies server choice, redundancy or multi-node sync.
  connected: 'Conectado',
  disconnected: 'Conexão indisponível',
  illustrative: 'ilustrativo',
  offlineNotice: 'Sem conexão no momento. Não há ofertas carregadas para mostrar; você pode continuar navegando e tentar mais tarde.',
}

const PUBLIC: MarketContextView = { id: 'public', name: 'Mercado público', kind: 'public', access: 'open', description: 'Explorar ofertas disponíveis' }
const COMMUNITY_SUL: MarketContextView = { id: 'c-sul', name: 'Comunidade Exemplo Sul', kind: 'community', access: 'open', memberStatus: 'member', description: 'Ofertas de um grupo fictício de negociantes' }
const COMMUNITY_NORTE: MarketContextView = { id: 'c-norte', name: 'Comunidade Exemplo Norte', kind: 'community', access: 'open', memberStatus: 'none', description: 'Ofertas de outro grupo fictício' }
const PRIVATE_MEMBER: MarketContextView = { id: 'p-member', name: 'Mercado Exemplo Restrito', kind: 'private', access: 'restricted', memberStatus: 'member', description: 'Ofertas visíveis só para participantes' }
const PRIVATE_NO_ACCESS: MarketContextView = { id: 'p-none', name: 'Mercado Exemplo Fechado', kind: 'private', access: 'restricted', memberStatus: 'none', description: 'Ofertas visíveis só para participantes', unavailableReason: 'Este mercado é restrito a participantes, e você não participa dele.' }
const UNAVAILABLE: MarketContextView = { id: 'u-pausado', name: 'Comunidade Exemplo Pausada', kind: 'community', access: 'unavailable', unavailableReason: 'Esta comunidade não está disponível no momento.' }

const ALL = [PUBLIC, COMMUNITY_SUL, COMMUNITY_NORTE, PRIVATE_MEMBER, PRIVATE_NO_ACCESS, UNAVAILABLE]

type ScenarioId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g-loading' | 'g-error' | 'h-offline'
const SCENARIOS: { id: ScenarioId; label: string; current: MarketContextView; options: MarketContextView[]; state: MarketContextListState; offline?: boolean }[] = [
  { id: 'a', label: 'a. Mercado público', current: PUBLIC, options: [PUBLIC], state: 'ready' },
  { id: 'b', label: 'b. Comunidades disponíveis', current: PUBLIC, options: [PUBLIC, COMMUNITY_SUL, COMMUNITY_NORTE], state: 'ready' },
  { id: 'c', label: 'c. Mercado privado', current: PRIVATE_MEMBER, options: ALL, state: 'ready' },
  { id: 'd', label: 'd. Troca de contexto', current: PUBLIC, options: ALL, state: 'ready' },
  { id: 'e', label: 'e. Só o público', current: PUBLIC, options: [PUBLIC], state: 'empty' },
  { id: 'f', label: 'f. Acesso indisponível', current: PRIVATE_NO_ACCESS, options: ALL, state: 'ready' },
  { id: 'g-loading', label: 'g. Carregando', current: PUBLIC, options: [PUBLIC], state: 'loading' },
  { id: 'g-error', label: 'g. Falha ao carregar', current: PUBLIC, options: [PUBLIC], state: 'unavailable' },
  { id: 'h-offline', label: 'h. Conexão indisponível', current: PUBLIC, options: [PUBLIC], state: 'unavailable', offline: true },
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
  'p-member': [offer('o7', T1, 'BTC', 'SELL', 98400, 'BANK_TRANSFER', 0.01, 0.2)],
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
  const [resetNotice, setResetNotice] = useState<string | null>(null)

  const current = ALL.find((o) => o.id === currentId) ?? PUBLIC
  const visible = canViewContextContent(current)
  // Offline: nothing was loaded, so nothing is shown (no cached data is invented).
  const offers = scenario.offline ? [] : (OFFERS[current.id] ?? []).filter((o) => (asset === 'Todos' || o.asset === asset) && (side === 'Todos' || o.side === side) && (payments.length === 0 || payments.includes(o.paymentMethod)) && (currency === 'Todas' || o.fiatCurrency === currency) && (!search || (o.user.displayName ?? '').toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (sortBy === 'reputation' ? b.user.reputationScore - a.user.reputationScore : sortBy === 'trades' ? b.user.totalTrades - a.user.totalTrades : a.priceUsd - b.priceUsd))
  const agentDisabledReason = scenario.offline ? COPY.agentOffline : visible ? null : current.unavailableReason ?? COPY.gateTitle

  const pickScenario = (id: ScenarioId) => {
    const s = SCENARIOS.find((x) => x.id === id)!
    setScenarioId(id)
    setCurrentId(s.current.id)
    setState(s.state)
    setAsset('Todos')
    setSide('Todos')
    setPayments([])
    setCurrency('Todas')
    setSearch('')
    setAgentOpen(false)
    setResetNotice(null)
  }

  // Filters belong to a context: switching context resets them and says so.
  const switchTo = (id: string) => {
    const next = ALL.find((o) => o.id === id)
    if (!next) return
    setCurrentId(id)
    setAsset('Todos')
    setSide('Todos')
    setPayments([])
    setCurrency('Todas')
    setSearch('')
    setAgentOpen(false)
    setResetNotice(COPY.filtersReset(next.name))
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div role="note" className="rounded-lg border border-brand-warning/25 bg-brand-warning/10 px-4 py-3 text-sm text-brand-warning">
        {COPY.banner}
      </div>

      {/* Dev-only control, not part of the designed screen. */}
      <fieldset className="mt-3 rounded-lg border border-dashed border-brand-border px-3 pb-3 pt-1">
        <legend className="px-1 text-xs font-mono text-brand-text-muted">{COPY.scenario}</legend>
        <select
          aria-label={COPY.scenario}
          value={scenarioId}
          onChange={(e) => pickScenario(e.target.value as ScenarioId)}
          className="mt-1 min-h-11 w-full rounded-md border border-brand-border bg-brand-elevated px-2 font-mono text-xs text-brand-text md:hidden"
        >
          {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="hidden flex-wrap gap-1.5 md:flex">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={s.id === scenarioId}
              onClick={() => pickScenario(s.id)}
              className={cn(
                'min-h-11 rounded-md px-2.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                s.id === scenarioId ? 'bg-brand-text text-brand-bg' : 'text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="text-page-title">{COPY.pageTitle}</h1>
          <p className="text-metadata mt-1" role="status">
            {visible ? `${COPY.offersCount(offers.length)} · ${COPY.inContext(current.name)}` : COPY.inContext(current.name)} · {COPY.poweredBy}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <p className="flex items-center gap-1.5 text-xs text-brand-text-secondary">
            {scenario.offline ? <CircleOff aria-hidden="true" className="h-3.5 w-3.5 text-brand-warning" /> : <CircleDot aria-hidden="true" className="h-3.5 w-3.5 text-brand-success" />}
            <span>{scenario.offline ? COPY.disconnected : COPY.connected}</span>
            <span className="text-brand-text-muted">({COPY.illustrative})</span>
          </p>
          {/* Kept from the real Market; inert here so a fictional context never publishes to the real one. */}
          <Button aria-disabled="true" title={COPY.moreFiltersNote} className="min-h-11 cursor-not-allowed px-4 opacity-60 md:min-h-10">
            <Plus aria-hidden="true" />
            {COPY.newOffer}
            <span className="sr-only">({COPY.moreFiltersNote})</span>
          </Button>
        </div>
      </div>

      {/* Market Context Navigation: its own row, above and outside the filter toolbar. */}
      <div className="mt-4">
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
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-brand-info/30 bg-brand-info/10 px-3 py-2 text-sm text-brand-text">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand-info" />
          {resetNotice}
        </p>
      )}

      {/* Sails Agent: a contextual action surface (§16.2) scoped to the selected context, before the manual filters. */}
      <section aria-label={COPY.agentTitle} className="mt-3 rounded-xl border border-brand-border-subtle bg-brand-surface">
        <button
          type="button"
          aria-expanded={agentDisabledReason ? undefined : agentOpen}
          aria-disabled={agentDisabledReason ? 'true' : undefined}
          aria-describedby={agentDisabledReason ? 'agent-disabled-reason' : undefined}
          aria-label={agentDisabledReason ? COPY.agentTitle : agentOpen ? COPY.agentClose : COPY.agentOpen}
          onClick={() => !agentDisabledReason && setAgentOpen((o) => !o)}
          className={cn(
            'flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            agentDisabledReason && 'cursor-not-allowed'
          )}
        >
          <span aria-hidden="true" className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', agentDisabledReason ? 'bg-brand-elevated text-brand-text-muted' : 'bg-brand-orange-accent/10 text-brand-orange-accent')}>
            <Bot className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-brand-text">{COPY.agentTitle}</span>
            {agentDisabledReason
              ? <span id="agent-disabled-reason" className="block text-metadata">{agentDisabledReason}</span>
              : <span className="block truncate text-metadata">{COPY.agentSubtitle(current.name)}</span>}
          </span>
          {!agentDisabledReason && (agentOpen ? <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" /> : <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" />)}
        </button>
        {agentOpen && !agentDisabledReason && (
          <div className="border-t border-brand-border-subtle px-4 py-3">
            <p className="max-w-prose text-sm text-brand-text-secondary">{COPY.agentBody(current.name)}</p>
            <p className="mt-2 rounded-md border border-dashed border-brand-border px-3 py-2 font-mono text-xs text-brand-text-muted">{COPY.agentProtoNote}</p>
          </div>
        )}
      </section>

      {visible ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand-border-subtle bg-brand-surface px-3 py-2.5">
            <div role="group" aria-label={COPY.side.group} className="flex gap-1 rounded-lg bg-brand-elevated p-1">
              {(['Todos', 'BUY', 'SELL'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={side === v}
                  onClick={() => setSide(v)}
                  className={cn(
                    'min-h-9 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11',
                    side === v ? 'bg-primary font-medium text-primary-foreground' : 'text-brand-text-secondary hover:text-brand-text'
                  )}
                >
                  {v === 'Todos' ? COPY.side.all : COPY.side[v]}
                </button>
              ))}
            </div>
            <AssetPicker assets={ASSETS_FILTERABLE} value={asset} onChange={setAsset} />
            <CurrencyPicker value={currency} onChange={setCurrency} />
            <PaymentMethodPicker methods={PAYMENT_METHODS_FILTERABLE} value={payments} onChange={setPayments} />
            <button type="button" aria-disabled="true" title={COPY.moreFiltersNote} className="toolbar-chip flex cursor-not-allowed items-center gap-1.5 max-md:min-h-11">
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              {COPY.moreFilters}
              <span className="sr-only">({COPY.moreFiltersNote})</span>
            </button>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as MarketplaceFilters['sortBy'])}>
              <SelectTrigger aria-label={COPY.sortLabel} className="w-auto min-w-0 border-brand-border bg-brand-elevated text-sm hover:border-brand-border-hover max-md:min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{COPY.sortPrefix}{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={COPY.searchPlaceholder}
              aria-label={COPY.searchLabel}
              className="min-w-[10rem] flex-1 border-brand-border bg-brand-elevated max-md:min-h-11 md:ml-auto md:max-w-[220px]"
            />
          </div>
          {scenario.offline && <p role="status" className="mt-3 rounded-lg border border-brand-border-subtle bg-brand-surface px-3 py-2 text-sm text-brand-text-secondary">{COPY.offlineNotice}</p>}
          {/* Fictional rows: capture clicks so the links never open a real offer route. */}
          <div className="mt-4 overflow-hidden rounded-xl border border-brand-border-subtle" onClickCapture={(e) => e.preventDefault()}>
            {offers.length > 0 ? offers.map((o) => <OfferCard key={o.id} offer={o} />) : <p className="px-4 py-8 text-center text-sm text-brand-text-secondary">{COPY.noOffers}</p>}
          </div>
        </>
      ) : (
        <section aria-labelledby="context-gate-title" className="mt-4 rounded-xl border border-brand-border bg-brand-surface px-5 py-6">
          <h2 id="context-gate-title" className="text-section-title">{COPY.gateTitle}</h2>
          <p className="mt-2 max-w-prose text-sm text-brand-text-secondary">{current.unavailableReason}</p>
          <Button onClick={() => switchTo(PUBLIC.id)} className="mt-4 min-h-11">{COPY.gateBack}</Button>
        </section>
      )}
    </div>
  )
}
