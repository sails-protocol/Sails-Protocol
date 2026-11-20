/**
 * Advanced filters drawer — Binance P2P-style, requested directly with
 * exact option wording and an "i" info icon per option explaining what
 * it does. `negotiableOnly`/`highReputationOnly`/`previouslyTradedOnly`
 * filter against UI-only demonstration fields (see MarketplaceFilters'
 * own comment in types.ts) — real versions need a real block-list and
 * trade-history join, neither built in the backend yet.
 *
 * NAVIGATION-FILTER-1 §4.1 — reorganized into six labeled sections
 * (Qualidade do anunciante / Valor / Tempo de pagamento [removed 2026-11-20] / País-Região /
 * Método de pagamento / Ordenação), was six blocks of equal visual
 * weight with no grouping signal beyond spacing. §4.6 — footer is now
 * sticky (outside the scrolling region) so mobile users don't have to
 * scroll to the end to apply/clear.
 */
import * as React from 'react'
import type { FiatCurrency, MarketplaceFilters, PaymentMethod } from '../../types'
import { AMOUNT_PRESETS, formatByCurrency } from '../../lib/currency'
import { COUNTRIES, PAYMENT_METHODS_FILTERABLE } from '../../data/mock'
import { PAYMENT_METHOD_LABELS } from '../../lib/labels'
import {
  PAYMENT_METHOD_CATEGORY,
  PAYMENT_METHOD_CATEGORY_LABELS,
  PAYMENT_METHOD_CATEGORY_ORDER,
  COUNTRY_PRIORITY_METHODS,
} from '../../lib/paymentMethodMeta'
import { countActiveFilters } from '../../lib/filters'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Button } from '../ui/button'
import { badgeVariants } from '../ui/badge'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Checkbox } from '../ui/checkbox'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { cn } from '../../lib/utils'
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet'
import { Search, ChevronDown, ChevronUp, X, ArrowLeft, SlidersHorizontal } from 'lucide-react'
import { DEFAULT_FILTERS } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
  filters: MarketplaceFilters
  onChange: (filters: MarketplaceFilters) => void
  currency: FiatCurrency
}

// NAVIGATION-FILTER-1 §4.4 — copy audit. `trades`/`reputation` are
// correctly "best first" regardless of context (higher totalTrades/
// reputationScore is unambiguously better) — safe to say "Maior"/"Mais".
// `price` is NOT: Marketplace.tsx's own sort is a flat
// `a.priceUsd - b.priceUsd` (always ascending) regardless of the
// BUY/SELL side filter. Ascending is genuinely "best" only when viewing
// SELL offers (the viewer is buying — lowest price wins); for BUY
// offers (the viewer would be selling to the offer's maker) ascending
// shows the WORST price first. Calling this "Melhor preço" would
// overclaim correctness the implementation doesn't have yet — "Menor
// preço" states exactly what happens today, honestly. Real gap
// registered, not fixed here (a side-aware sort is a logic change, out
// of this mission's copy-only scope for §4.4) — see
// docs/SAILS_DESIGN_LANGUAGE.md's Filter/Discovery UX Grammar section
// and docs/BACKLOG.md.
export const SORT_OPTIONS: { value: MarketplaceFilters['sortBy']; label: string }[] = [
  { value: 'price', label: 'Menor preço' },
  { value: 'reputation', label: 'Maior reputação' },
  { value: 'trades', label: 'Mais trades' },
]

// UI-POLISH-2 §2.2 — was a false "staged commit" UI: every control called
// `onChange` (the real committed Market filters) immediately, live, while
// an "Aplicar filtros" button implied edits were held until confirmed.
// That mismatch is fixed by actually staging: `draft` is a local copy,
// re-seeded from the real `filters` prop every time the sheet opens, and
// every control below edits `draft` only. `onChange(draft)` fires exactly
// once, from `applyAndClose`. No other path calls `onChange`.
export function FilterPanel({ open, onClose, filters, onChange, currency }: Props) {
  const [draft, setDraft] = React.useState<MarketplaceFilters>(filters)

  React.useEffect(() => {
    if (open) setDraft(filters)
  }, [open, filters])

  const set = <K extends keyof MarketplaceFilters>(key: K, value: MarketplaceFilters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const togglePaymentMethod = (method: PaymentMethod) => {
    setDraft((d) => {
      const has = d.paymentMethods.includes(method)
      return { ...d, paymentMethods: has ? d.paymentMethods.filter((m) => m !== method) : [...d.paymentMethods, method] }
    })
  }

  const activeCount = countActiveFilters(draft)

  // §2.2 — "Limpar" edits the draft only, same as every other control
  // here; it takes effect on the real Market filters only via Apply,
  // same as everything else in this panel. Preserves the draft's own
  // save-preference and current sort choice (not "filters" in the
  // countActiveFilters sense — sort is display ordering, saveForNext is
  // a meta-preference about persistence, not search criteria).
  const clearDraft = () => setDraft((d) => ({ ...DEFAULT_FILTERS, saveForNext: d.saveForNext, sortBy: d.sortBy }))

  // §2.3 — the one path every dismissal (mobile Back, desktop X,
  // Escape, overlay click — all route through Sheet's own
  // `onOpenChange`) shares: discard the draft, never silently apply it.
  const cancelAndClose = () => {
    setDraft(filters)
    onClose()
  }

  const applyAndClose = () => {
    onChange(draft)
    onClose()
  }

  return (
    // Real Radix Sheet (2026-08-01) — replaces a hand-rolled `fixed inset-0`
    // backdrop with a manually added (but never wired) `role="dialog"
    // aria-modal="true"`: no real focus trap, no Escape-to-close. Same fix
    // as Disputes.tsx's own drawer — see feedback_slc_ui_philosophy memory.
    <Sheet open={open} onOpenChange={(o) => !o && cancelAndClose()}>
      <SheetContent side="right" hideDefaultClose className="w-full max-w-sm p-0 flex flex-col gap-0">
        {/* UI-POLISH-2 §2.1 — full-width on mobile, this Sheet reads as a
            full-screen secondary surface, not a dismissive overlay: Back
            semantics (an arrow, same row as the title) fit that better
            than the built-in `X`. At `sm+` it's a narrower side drawer —
            genuinely dismissive overlay territory — where `X` stays
            correct. Both buttons call the same cancelAndClose. */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brand-border-subtle shrink-0">
          {/* UI-POLISH-2 §5.1 — h-11 w-11 (44px) meets
              `SAILS_MARKET_DESIGN_DIRECTION.md` §21's own minimum touch-
              target rule; the icon stays visually 20px, only the hit
              area grows. -ml-2.5 keeps the icon itself visually aligned
              with the content below despite the larger tap target. */}
          <button
            onClick={cancelAndClose}
            aria-label="Voltar"
            className="sm:hidden -ml-2.5 h-11 w-11 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <SheetTitle className="flex-1">Filtros avançados</SheetTitle>
          <button
            onClick={cancelAndClose}
            aria-label="Fechar"
            className="hidden sm:flex h-8 w-8 items-center justify-center rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* §4.5 — proportional active-filter summary: a count + a single
              clear-all action, not a second set of removable chips
              duplicating the per-section toggles already visible below. */}
          {activeCount > 0 && (
            <div className="mb-2 flex items-center justify-between text-xs">
              {/* UI-POLISH-2 §4.3 — same icon as the toolbar's own
                  "Filtros" button (Marketplace.tsx), so this summary
                  reads as "the same thing, staged" at a glance rather
                  than a disconnected line of text. */}
              <span className="flex items-center gap-1.5 text-brand-text-secondary">
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                {activeCount} {activeCount === 1 ? 'filtro ativo' : 'filtros ativos'}
              </span>
              <button onClick={clearDraft} className="text-brand-orange-accent hover:underline font-medium">
                Limpar tudo
              </button>
            </div>
          )}

          <ToggleRow
            label="Salvar filtro para o próximo"
            info="Mantém essas preferências de filtro salvas para a próxima vez que você visitar o Marketplace."
            checked={draft.saveForNext}
            onChange={(v) => set('saveForNext', v)}
          />

          <Section title="Qualidade do anunciante">
            <CheckRow
              label="Apenas anúncios negociáveis"
              info="Exclui usuários que você bloqueou ou que bloquearam você."
              checked={draft.negotiableOnly}
              onChange={(v) => set('negotiableOnly', v)}
            />
            <CheckRow
              label="Somente comerciantes com alta reputação"
              info="Mostra apenas comerciantes com excelentes pontuações e avaliações de alta reputação."
              checked={draft.highReputationOnly}
              onChange={(v) => set('highReputationOnly', v)}
            />
            <CheckRow
              label="Comerciantes com os quais você já negociou"
              info="Comerciantes frequentes com quem você negociou nos últimos meses."
              checked={draft.previouslyTradedOnly}
              onChange={(v) => set('previouslyTradedOnly', v)}
              last
            />
          </Section>

          <Section title="Valor (USD)" info="Mostra só ofertas cujos limites, convertidos pelo preço em USD da própria oferta, incluem este valor.">
            <Input
              value={draft.amount}
              onChange={(e) => set('amount', e.target.value)}
              type="number"
              aria-label="Valor em USD"
              placeholder="0.00"
              className="w-full mb-2"
            />
            <div className="flex gap-1.5 flex-wrap">
              {AMOUNT_PRESETS[currency].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={draft.amount === String(preset)}
                  onClick={() => set('amount', String(preset))}
                  className={cn(badgeVariants({ variant: draft.amount === String(preset) ? 'default' : 'secondary' }), 'rounded-full px-3 py-1')}
                >
                  {formatByCurrency(preset, currency)}
                </button>
              ))}
            </div>
          </Section>

          {/* "Tempo de pagamento" removed (CTO 437): it was never applied and described an order-expiry
              deadline offers do not have. LOOSE_WIRES: offer payment-time window needs a contract. */}

          <Section title="País/Região">
            <Select value={draft.country} onValueChange={(v) => set('country', v)}>
              <SelectTrigger aria-label="País/Região" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Todos">Todos</SelectItem>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>

          <Section title="Método de pagamento" info="Métodos populares indicados primeiro pelo país selecionado — os demais continuam disponíveis em 'Ver todos'.">
            <PaymentMethodSection
              country={draft.country}
              value={draft.paymentMethods}
              onToggle={togglePaymentMethod}
            />
          </Section>

          <Section title="Ordenação" last>
            <div className="flex gap-1.5 flex-wrap">
              {SORT_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={draft.sortBy === s.value}
                  onClick={() => set('sortBy', s.value)}
                  className={cn(badgeVariants({ variant: draft.sortBy === s.value ? 'default' : 'secondary' }), 'rounded-full px-3 py-1')}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Section>
        </div>

        {/* §4.6 — sticky footer: a flex sibling of the scrolling region
            above (not inside its own overflow-y-auto), so it stays
            pinned to the bottom of the sheet regardless of scroll
            position — no more scrolling to the end to apply/clear. */}
        <div className="shrink-0 border-t border-brand-border-subtle p-4 flex gap-2 bg-brand-surface">
          <Button variant="outline" onClick={clearDraft} className="flex-1 py-2.5 text-sm">
            Limpar
          </Button>
          <Button onClick={applyAndClose} className="flex-1 py-2.5 text-sm">
            Aplicar filtros
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// NAVIGATION-FILTER-1 §4.1 — small local wrapper, not a new design-
// system primitive: gives every section the same title + spacing +
// divider rhythm without retyping it six times.
function Section({ title, info, last, children }: { title: string; info?: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div className={`mt-5 pb-5 ${last ? '' : 'border-b border-brand-border-subtle'}`}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-label">{title}</span>
        {info && <InfoTooltip text={info} />}
      </div>
      {children}
    </div>
  )
}

// NAVIGATION-FILTER-1 §4.2 — replaces the flat "wall of chips" (all 43
// filterable methods rendered at once, no search/grouping/priority)
// with: selected methods pinned visible, country-prioritized
// suggestions (priority, never a hard restriction — every method stays
// reachable via "Ver todos"), and a collapsed-by-default grouped+
// searchable full list.
function PaymentMethodSection({
  country,
  value,
  onToggle,
}: {
  country: string
  value: PaymentMethod[]
  onToggle: (m: PaymentMethod) => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const priorityMethods = React.useMemo(() => COUNTRY_PRIORITY_METHODS[country] ?? [], [country])
  const selectedSet = React.useMemo(() => new Set(value), [value])

  // Suggested row: this country's priority methods, minus whatever is
  // already pinned in the "selected" row above it (no duplicate chips).
  const suggested = priorityMethods.filter((m) => !selectedSet.has(m))

  const q = search.trim().toLowerCase()
  const remaining = React.useMemo(() => {
    const shown = new Set<PaymentMethod>([...value, ...suggested])
    return PAYMENT_METHODS_FILTERABLE.filter((m) => !shown.has(m))
  }, [value, suggested])

  const filteredRemaining = q
    ? remaining.filter((m) => PAYMENT_METHOD_LABELS[m].toLowerCase().includes(q))
    : remaining

  const grouped = React.useMemo(() => {
    const map = new Map<string, PaymentMethod[]>()
    for (const m of filteredRemaining) {
      const cat = PAYMENT_METHOD_CATEGORY[m]
      map.set(cat, [...(map.get(cat) ?? []), m])
    }
    return map
  }, [filteredRemaining])

  const Chip = ({ m }: { m: PaymentMethod }) => (
    <button
      type="button"
      aria-pressed={selectedSet.has(m)}
      onClick={() => onToggle(m)}
      className={cn(badgeVariants({ variant: selectedSet.has(m) ? 'default' : 'secondary' }), 'rounded-full px-3 py-1')}
    >
      {PAYMENT_METHOD_LABELS[m]}
      {selectedSet.has(m) && <X className="h-3 w-3" />}
    </button>
  )

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2">
          <span className="text-xs text-brand-text-muted">Selecionados</span>
          <div className="flex gap-1.5 flex-wrap mt-1">
            {value.map((m) => <Chip key={m} m={m} />)}
          </div>
        </div>
      )}

      {suggested.length > 0 && (
        <div className="mb-2">
          <span className="text-xs text-brand-text-muted">
            Sugeridos para {COUNTRIES.find((c) => c.code === country)?.label ?? country}
          </span>
          <div className="flex gap-1.5 flex-wrap mt-1">
            {suggested.map((m) => <Chip key={m} m={m} />)}
          </div>
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-xs text-brand-text-secondary hover:text-brand-text mt-1"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {expanded ? 'Ocultar métodos' : 'Ver todos os métodos'}
      </button>

      {expanded && (
        <div className="mt-2">
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-text-muted pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar método de pagamento..."
              className="w-full pl-8"
            />
          </div>
          <div className="max-h-72 overflow-y-auto pr-1 space-y-3">
            {PAYMENT_METHOD_CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
              <div key={cat}>
                <span className="text-xs text-brand-text-muted">{PAYMENT_METHOD_CATEGORY_LABELS[cat]}</span>
                <div className="flex gap-1.5 flex-wrap mt-1">
                  {grouped.get(cat)!.map((m) => <Chip key={m} m={m} />)}
                </div>
              </div>
            ))}
            {filteredRemaining.length === 0 && (
              <p className="text-xs text-brand-text-muted">Nenhum método encontrado com esse nome.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// DESIGN-LANGUAGE-1 §2.3 — was a hand-rolled button+span pair reimplementing
// a switch from scratch; the real shadcn `Switch` (packages/sails-ui/src/
// components/ui/switch.tsx, already used by ChatWindow.tsx) exists and is
// already brand-token-mapped (checked = --primary = Sails orange) — no
// reason for a second, subtly-different-looking switch implementation.
function ToggleRow({ label, info, checked, onChange }: { label: string; info: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = React.useId()
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-brand-border-subtle">
      <label htmlFor={id} className="flex items-center gap-1.5 cursor-pointer">
        <span className="text-sm text-brand-text">{label}</span>
        <InfoTooltip text={info} />
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

// Same rationale as ToggleRow: replaces a bare `<input type="checkbox">`
// (unstyled native browser control, the most literal "looks like the
// browser, not Sails Market" case flagged this mission) with the real
// shadcn `Checkbox` primitive (new — packages/sails-ui/src/components/ui/checkbox.tsx,
// same Radix family as the existing Switch/Select/Popover/Dialog).
function CheckRow({ label, info, checked, onChange, last }: { label: string; info: string; checked: boolean; onChange: (v: boolean) => void; last?: boolean }) {
  const id = React.useId()
  return (
    <div className={`flex items-center gap-2.5 py-2.5 ${last ? '' : 'border-b border-brand-border-subtle'}`}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <label htmlFor={id} className="text-sm text-brand-text flex-1 cursor-pointer">{label}</label>
      <InfoTooltip text={info} />
    </div>
  )
}
