/**
 * Dev-only (see App.tsx): living reference of the Sails Design System
 * (DESIGN_SYSTEM.md). Contrast numbers are measured here from the real CSS
 * variables of BOTH themes (read from the loaded stylesheet), swatches render
 * in the current theme. Example data only; no SDK calls.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle2, Copy, Heart, Info, Loader2, LogOut, RefreshCw, Settings, Star, Trash2, User as UserIcon, XCircle } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Checkbox } from '../../components/ui/checkbox'
import { Switch } from '../../components/ui/switch'
import { StateBlock } from '../../components/ui/StateBlock'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { SideBadge, TradeStatusBadge, EscrowStatusBadge, OfferStatusBadge } from '../../components/ui/StatusBadges'
import { TONE_CLASS, type Tone } from '../../lib/tone'
import { blend, contrastRatio, parseTriplet, type Rgb } from '../../lib/contrast'
import type { EscrowStatus, TradeStatus, OfferStatus } from '../../types'
import { toast, TOAST_CLASS } from '../../components/ui/toast'
import { Tabs, tabClass, tabPanelProps } from '../../components/ui/tabs'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../components/ui/menu'
import { Radio, RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { SortableTableHead, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Alert, type AlertTone } from '../../components/ui/alert'
import { Progress } from '../../components/ui/progress'
import { Divider } from '../../components/ui/divider'
import { IconButton } from '../../components/ui/icon-button'
import { FilterChip } from '../../components/ui/filter-chip'
import { Combobox } from '../../components/ui/combobox'
import { AssetPicker } from '../../components/marketplace/AssetPicker'
import { AssetPairIcon } from '../../components/ui/AssetIcon'
import { cn } from '../../lib/utils'
import { badgeVariants } from '../../components/ui/badge'
import { SOON_NOTE, pickerPairs } from '../../lib/assetCatalog'
import type { AssetType } from '../../types'
import { nextSort, sortRows, type SortState } from '../../lib/sort'
import { PaymentMethods } from '../../components/ui/PaymentMethods'
import { TradeRail } from '../../components/trade/TradeRail'
import { batonLabel, deriveTradeState, type TradeStateInput } from '../../lib/tradeState'
import { OfferTable } from '../../components/marketplace/OfferTable'
import { OfferCard } from '../../components/marketplace/OfferCard'
import type { Offer } from '../../types'
import { PlannedItem } from '../../components/ui/PlannedItem'
import { StarRating } from '../../components/ui/star-rating'
import { RateCounterpartyCard, type RateCounterpartyCopy } from '../../components/trade/RateCounterpartyCard'
import { RATINGS_EXPLANATION } from '../../lib/reputation'
import { NavPositionThumb } from '../../components/layout/NavPositionThumb'
import { NAV_ITEMS, NavIcon, navItemTone } from '../../components/layout/Sidebar'

type Theme = 'light' | 'dark'
type Vars = Record<Theme, Record<string, string>>

/** Custom properties declared on `:root` and `:root.dark` in the loaded CSS. */
function readThemeVars(): Vars {
  const out: Vars = { light: {}, dark: {} }
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && (r.selectorText === ':root' || r.selectorText === ':root.dark')) {
        const target = r.selectorText === ':root' ? out.light : out.dark
        for (const prop of Array.from(r.style)) if (prop.startsWith('--')) target[prop] = r.style.getPropertyValue(prop).trim()
      } else if ('cssRules' in r && !(r instanceof CSSMediaRule)) walk((r as CSSGroupingRule).cssRules)
    }
  }
  for (const s of Array.from(document.styleSheets)) {
    try { walk(s.cssRules) } catch { /* cross-origin sheet (Google Fonts) */ }
  }
  return out
}

interface Role {
  name: string
  use: string
  fg: string
  base: string
  solid?: [string, string]
  /** Tint is base/10 except neutral, whose tint is the elevated surface. */
  neutral?: boolean
  text: string
  chip: string
  solidClass?: string
}

// Static class strings so Tailwind generates them.
const ROLES: Role[] = [
  { name: 'Marca: laranja', use: 'Ação primária (um botão sólido por página), navegação ativa. Não é foco (foco = --color-focus). Não é status nem lado.', fg: '--color-orange-accent', base: '--color-orange', solid: ['--primary', '--primary-foreground'], text: 'text-brand-orange-accent', chip: 'border-brand-orange/25 bg-brand-orange/10 text-brand-text', solidClass: 'bg-primary text-primary-foreground' },
  { name: 'Marca: azul', use: 'Acento secundário da marca: links, seleção, gráficos, destaques. Não é info.', fg: '--color-brand-blue-fg', base: '--color-brand-blue', solid: ['--color-brand-blue-solid', '--color-on-brand-blue'], text: 'text-brand-blue-fg', chip: 'border-brand-blue-border bg-brand-blue-bg text-brand-blue-fg', solidClass: 'bg-brand-blue-solid text-brand-on-blue' },
  { name: 'Lado: compra', use: 'Somente lado do trade (Comprar). Nunca sucesso.', fg: '--color-buy-fg', base: '--color-buy', solid: ['--color-buy-solid', '--color-on-buy'], text: 'text-brand-buy-fg', chip: TONE_CLASS.buy, solidClass: 'bg-brand-buy-solid text-brand-on-buy' },
  { name: 'Lado: venda', use: 'Somente lado do trade (Vender). Nunca erro, nunca disputa.', fg: '--color-sell-fg', base: '--color-sell', solid: ['--color-sell-solid', '--color-on-sell'], text: 'text-brand-sell-fg', chip: TONE_CLASS.sell, solidClass: 'bg-brand-sell-solid text-brand-on-sell' },
  { name: 'Status: sucesso', use: 'Etapa concluída, trade concluído, presença online.', fg: '--color-success-fg', base: '--color-success', solid: ['--color-success-solid', '--color-on-success'], text: 'text-brand-success-fg', chip: TONE_CLASS.success, solidClass: 'bg-brand-success-solid text-brand-on-success' },
  { name: 'Status: atenção', use: 'Pendente, aguardando, avisos de risco moderado.', fg: '--color-warning-fg', base: '--color-warning', solid: ['--color-warning-solid', '--color-on-warning'], text: 'text-brand-warning-fg', chip: TONE_CLASS.warning, solidClass: 'bg-brand-warning-solid text-brand-on-warning' },
  { name: 'Status: perigo', use: 'Erro, disputa, bloqueio, ação destrutiva.', fg: '--color-danger-fg', base: '--color-danger', solid: ['--color-danger-solid', '--color-on-danger'], text: 'text-brand-danger-fg', chip: TONE_CLASS.danger, solidClass: 'bg-brand-danger-solid text-brand-on-danger' },
  { name: 'Status: info', use: 'Em andamento, fundos travados, informação neutra relevante.', fg: '--color-info-fg', base: '--color-info', solid: ['--color-info-solid', '--color-on-info'], text: 'text-brand-info-fg', chip: TONE_CLASS.info, solidClass: 'bg-brand-info-solid text-brand-on-info' },
  { name: 'Status: neutro', use: 'Criado, cancelado, reembolsado, sem gravidade.', fg: '--color-text-secondary', base: '--color-border', neutral: true, text: 'text-brand-text-secondary', chip: TONE_CLASS.neutral },
]

const SURFACES = ['--color-bg', '--color-surface', '--color-elevated']

function measure(v: Record<string, string>, role: Role) {
  // Follows one var() alias (dark --primary = var(--color-orange)).
  const get = (k: string): Rgb | null => parseTriplet(v[v[k]?.match(/^var\((--[\w-]+)\)$/)?.[1] ?? k] ?? '')
  const fg = get(role.fg), base = get(role.base)
  const surf = SURFACES.map(get).filter((x): x is Rgb => !!x)
  if (!fg || !base || surf.length !== 3) return null
  const min = (xs: number[]) => Math.min(...xs)
  const elevated = surf[2]
  return {
    text: min(surf.map((s) => contrastRatio(fg, s))),
    tint: role.neutral ? contrastRatio(fg, elevated) : min(surf.map((s) => contrastRatio(fg, blend(base, s, 0.1)))),
    ui: min(surf.map((s) => contrastRatio(base, s))),
    solid: role.solid && get(role.solid[0]) && get(role.solid[1]) ? contrastRatio(get(role.solid[0])!, get(role.solid[1])!) : null,
  }
}

/** Surfaces lot: focus outline and tonal/segmented fills, measured per container (bg, surface, elevated). */
function measureSurfaces(v: Record<string, string>) {
  const get = (k: string) => parseTriplet(v[k] ?? '')
  const a = (k: string) => Number(v[k])
  const text = get('--color-text'), sec = get('--color-text-secondary'), focus = get('--color-focus'), raised = get('--raised-base')
  if (!text || !sec || !focus || !raised) return null
  return SURFACES.map((k) => {
    const c = get(k)!
    const track = blend(text, c, a('--segment-track-a'))
    const thumb = blend(raised, track, a('--raised-a'))
    return {
      name: k.replace('--color-', ''),
      focus: contrastRatio(focus, c),
      tonalLabel: contrastRatio(text, blend(text, c, a('--tonal-a'))),
      thumbVsTrack: contrastRatio(thumb, track),
      selected: contrastRatio(text, thumb),
      unselected: contrastRatio(sec, track),
    }
  })
}

function Ratio({ value, min }: { value: number | null; min: number }) {
  if (value === null) return <span className="text-brand-text-muted">—</span>
  const ok = value >= min
  return (
    <span className={ok ? 'text-brand-text' : 'font-medium text-brand-danger-fg'}>
      {value.toFixed(2)}:1 <span className="text-caption text-brand-text-muted">{ok ? 'AA' : `abaixo de ${min}`}</span>
    </span>
  )
}

const TYPE = [
  ['text-display', 'display', '28 / 32', '1.15', '600', '-0.02em', 'Valor de destaque (raro)'],
  ['text-title', 'title (h1 da página)', '22 / 24', '1.25', '600', '-0.01em', 'Título da página'],
  ['text-headline', 'headline (provisório)', '18 / 18', '1.3', '600', '-0.01em', 'Título de diálogo, sheet e card'],
  ['text-heading', 'heading (seção)', '16 / 16', '1.35', '600', '0', 'Título de seção'],
  ['text-subheading', 'subheading', '15 / 14', '1.4', '500', '0', 'Subtítulo, rótulo de grupo'],
  ['text-body', 'body (= text-sm)', '15 / 14', '1.5', '400', '0', 'Texto corrido e controles'],
  ['text-body-sm', 'body-sm', '13 / 13', '1.5', '400', '0', 'Texto secundário, células de tabela'],
  ['text-caption', 'caption (= text-xs, piso)', '12 / 12', '1.4', '400', '0', 'Metadados, legendas'],
  ['text-control', 'control', '14 / 14', '1.25', '500', '0', 'Rótulo de botão e campo'],
  ['text-field', 'field (provisório)', '16 / 14', '1.4', '400', '0', 'Texto digitado (16 no toque)'],
] as const

const TRADE: TradeStatus[] = ['PENDING', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'CANCELLED']
const ESCROW: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
const OFFER: OfferStatus[] = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']
const VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const
const TONES: Tone[] = ['neutral', 'info', 'success', 'warning', 'danger', 'buy', 'sell']
const SURFACE_SAMPLES = [['bg-brand-bg', 'Fundo da página'], ['bg-brand-surface', 'Superfície (card, diálogo)'], ['bg-brand-elevated', 'Elevado']] as const
/** Static specimens of the two keyboard-focus treatments (screenshots without a keyboard). */
const FOCUS_STATIC = 'outline-2 outline-offset-2 outline-brand-focus'
/** Static hover/pressed specimen: the same layer color rule as the `state-layer` utility. */
function layerStyle(v: 'default' | 'secondary' | 'ghost' | 'destructive', alpha: '--state-hover-a' | '--state-pressed-a') {
  const layer = v === 'default' ? '255 255 255' : v === 'destructive' ? '0 0 0' : 'var(--color-text)'
  const c = `rgb(var(--state-layer) / var(${alpha}))`
  return { '--state-layer': layer, backgroundImage: `linear-gradient(${c}, ${c})` } as CSSProperties
}
const FIELD_FOCUS_STATIC = 'border-brand-focus shadow-[inset_0_0_0_1px_rgb(var(--color-focus))]'
/** Side buttons (phase 4A): every state, per surface (min over bg/surface/elevated). Tonal layer = --state-layer-{side}; solid layer = black (light) / white (dark). */
function measureSide(v: Record<string, string>, theme: 'light' | 'dark') {
  const res = (k: string): string => { const x = v[k] ?? ''; const m = x.match(/^var\((--[\w-]+)\)$/); return m ? res(m[1]) : x }
  const get = (k: string) => parseTriplet(res(k))
  const hover = Number(v['--state-hover-a'] ?? 0.08), pressed = Number(v['--state-pressed-a'] ?? 0.12)
  const focus = get('--color-focus')
  const solidLayer: Rgb = theme === 'dark' ? [255, 255, 255] : [0, 0, 0]
  const surf = SURFACES.map((k) => get(k)).filter((x): x is Rgb => !!x)
  const min = (xs: number[]) => Math.min(...xs)
  return (['buy', 'sell'] as const).flatMap((side) => {
    const base = get(`--color-${side}`), fg = get(`--color-${side}-fg`), layer = get(`--state-layer-${side}`)
    const solid = get(`--color-${side}-solid`), on = get(`--color-on-${side}`)
    if (!base || !fg || !layer || !solid || !on || !focus || surf.length !== 3) return []
    const fill = surf.map((c) => blend(base, c, 0.1))
    return [{
      side,
      rest: min(fill.map((f) => contrastRatio(fg, f))),
      hover: min(fill.map((f) => contrastRatio(fg, blend(layer, f, hover)))),
      pressed: min(fill.map((f) => contrastRatio(fg, blend(layer, f, pressed)))),
      solid: contrastRatio(on, solid),
      solidHover: contrastRatio(on, blend(solidLayer, solid, hover)),
      solidPressed: contrastRatio(on, blend(solidLayer, solid, pressed)),
      solidFill: min(surf.map((c) => contrastRatio(solid, c))),
      focus: min(surf.map((c) => contrastRatio(focus, c))),
    }]
  })
}
/** Static state specimens (screenshots have no mouse or keyboard): the same layer the `state-layer` utility paints. */
const layerBg = (alpha: '--state-hover-a' | '--state-pressed-a'): CSSProperties => {
  const c = `rgb(var(--state-layer, var(--color-text)) / var(${alpha}))`
  return { backgroundImage: `linear-gradient(${c}, ${c})` }
}
const SIDE_STATE_VARIANTS = [
  ['buy-tonal', 'Comprar', 'sm'], ['sell-tonal', 'Vender', 'sm'], ['buy', 'Comprar BTC', 'default'], ['sell', 'Vender BTC', 'default'],
] as const
const OWN_OFFER_LINK = 'inline-flex min-h-9 items-center text-xs font-medium text-brand-text-secondary hover:text-brand-text rounded-md'
const DEMO_TRADER = (id: string, displayName: string, reputationScore: number, totalTrades: number) => ({ id, publicKey: `pk-${id}`, displayName, peerId: null, reputationScore, totalTrades, disputeCount: 0, totalVolumeBtc: 0, verified: false, createdAt: '2026-01-01T00:00:00Z' })
const DEMO_ROW = (id: string, name: string, side: Offer['side'], price: number): Offer => ({
  id, userId: id, user: DEMO_TRADER(id, name, 96, 48), asset: 'BTC', side, priceUsd: price, fiatCurrency: 'USD', priceFiat: price,
  minAmount: 0.001, maxAmount: 0.05, paymentMethod: 'PIX', status: 'ACTIVE', country: 'BR', tradedWithCurrentUser: false, blockedRelationship: false, createdAt: '2026-01-01T00:00:00Z',
})
const DEMO_ROWS: Offer[] = [DEMO_ROW('ds-row-sell', 'Exemplo (vende)', 'SELL', 97450), DEMO_ROW('ds-row-buy', 'Exemplo (compra)', 'BUY', 96900), DEMO_ROW('ds-row-own', 'Você (exemplo)', 'SELL', 97600)]
const RATE_COPY: RateCounterpartyCopy = {
  title: 'Avaliar Alice',
  description: 'De 1 a 5 estrelas, com um comentário se quiser. A avaliação é só informativa: não muda a reputação de ninguém. Uma por trade.',
  legend: 'Nota',
  starLabel: (n) => `${n} ${n === 1 ? 'estrela' : 'estrelas'}`,
  valueText: (n) => (n ? `${n} de 5` : 'Escolha de 1 a 5'),
  scoreError: 'Escolha uma nota de 1 a 5 estrelas.',
  commentLabel: 'Comentário (opcional)',
  submitLabel: 'Enviar avaliação',
}
const SEG_OPTIONS = [{ value: 'all', label: 'Todos' }, { value: 'buy', label: 'Comprar' }, { value: 'sell', label: 'Vender' }] as const


/** Phase 3 tokens (selected, link): measured per surface in both themes. */
function measurePrimitives(v: Record<string, string>) {
  const res = (k: string): string => { const x = v[k] ?? ''; const m = x.match(/^var\((--[\w-]+)\)$/); return m ? res(m[1]) : x }
  const get = (k: string) => parseTriplet(res(k))
  const text = get('--color-text'), sec = get('--color-text-secondary'), blue = get('--color-selected'), link = get('--color-link')
  if (!text || !sec || !blue || !link) return null
  return SURFACES.map((k) => {
    const c = get(k)!
    const sel = blend(blue, c, Number(v['--selected-a'] ?? 0.12))
    return { name: k.replace('--color-', ''), selText: contrastRatio(text, sel), selSec: contrastRatio(sec, sel), link: contrastRatio(link, c) }
  })
}

const TABLE_ROWS = [
  { id: 'a', seller: 'Kestrel Câmbio', price: 97800, trades: 312 },
  { id: 'b', seller: 'Álvaro', price: 96900, trades: 158 },
  { id: 'c', seller: 'Bob', price: 97450, trades: 21 },
  { id: 'd', seller: 'Erin', price: 97600, trades: 3 },
] as const
type TableKey = 'seller' | 'price' | 'trades'
// Neutral sample data for the primitive; asset options live only in lib/assetCatalog.ts (section "Catálogo de ativos").
const COMBO_OPTIONS = [
  { value: 'USD', label: 'Dólar americano', keywords: ['USD'] },
  { value: 'BRL', label: 'Real', keywords: ['BRL'] },
  { value: 'EUR', label: 'Euro', keywords: ['EUR'] },
  { value: 'ARS', label: 'Peso argentino', keywords: ['ARS'] },
  { value: 'PYG', label: 'Guarani', keywords: ['PYG'] },
] as const
type ComboValue = (typeof COMBO_OPTIONS)[number]['value']
// Option states for the catalog section: [state, pair id].
const CATALOG_STATES = [
  ['Repouso', 'btc-bitcoin'], ['Hover', 'btc-bitcoin'], ['Foco (teclado)', 'btc-bitcoin'], ['Selecionado', 'btc-bitcoin'], ['Desativado', 'btc-liquid'],
] as const
const CATALOG_ICON_SAMPLES: readonly string[] = ['btc-bitcoin', 'btc-liquid', 'usdt-tron', 'usdt-arbitrum', 'usdc-base', 'usdc-solana']
const CATALOG_SOON_BADGE = cn(badgeVariants({ variant: 'outline' }), 'border-transparent bg-brand-tonal font-medium text-brand-text')
const ALERT_TONES: AlertTone[] = ['info', 'success', 'warning', 'danger']
const TONAL_TRIGGER = 'inline-flex h-10 touch:min-h-11 items-center rounded-md bg-brand-tonal px-4 text-control font-medium text-brand-text state-layer'
const STATIC_TOASTS = [
  ['success', 'Chave pública copiada', 'text-brand-inverse-success', CheckCircle2],
  ['info', 'Oferta publicada', 'text-brand-inverse-info', Info],
  ['warning', 'Algumas ofertas podem não ter carregado', 'text-brand-inverse-warning', AlertTriangle],
  ['danger', 'Não foi possível copiar', 'text-brand-inverse-danger', XCircle],
] as const

// Trilho do trade (DESIGN_SYSTEM.md 5.5): one real derivation per stage tone, example data only.
const RAIL_BASE: TradeStateInput = {
  tradeStatus: 'ACTIVE', escrowStatus: 'FUNDS_LOCKED', signingRoundKind: null, isBuyer: true, isSeller: false,
  buyerId: 'buyer-demo', sellerId: 'seller-demo', escrowId: 'esc-demo-0001', escrowType: 'MOCK',
  createdAt: '2026-11-20T09:00:00.000Z', escrowCreatedAt: '2026-11-20T09:05:00.000Z', lockedAt: '2026-11-20T09:20:00.000Z', completedAt: null, cancelledAt: null,
}
const RAIL_CASES: { name: string; viewer: 'buyer' | 'seller' | null; input: Partial<TradeStateInput> }[] = [
  { name: 'Sua vez (laranja, pulso)', viewer: 'buyer', input: {} },
  { name: 'Esperando a outra parte (azul)', viewer: 'seller', input: { isBuyer: false, isSeller: true } },
  { name: 'Bloqueada nesta interface (âmbar)', viewer: 'seller', input: { escrowStatus: 'PAYMENT_PENDING', isBuyer: false, isSeller: true, releaseUnavailable: true } },
  { name: 'Em disputa (âmbar, o trilho para)', viewer: 'buyer', input: { tradeStatus: 'DISPUTED', escrowStatus: 'DISPUTED', dispute: { status: 'OPENED', arbiterId: 'arbiter-demo' } } },
  { name: 'Prazo encerrado (âmbar, o trilho para)', viewer: 'buyer', input: { escrowStatus: 'EXPIRED' } },
  { name: 'Escrow marcado como concluído (todo azul)', viewer: 'buyer', input: { tradeStatus: 'COMPLETED', escrowStatus: 'COMPLETED', completedAt: '2026-11-20T10:00:00.000Z' } },
]
function RailSpecimen({ theme, vars }: { theme: Theme; vars: Vars | null }) {
  // The theme's own variables on the wrapper, so both themes render side by side.
  const style = (vars ? { ...vars.light, ...vars[theme] } : {}) as CSSProperties
  return (
    <div style={style} className="flex min-w-0 flex-col gap-3 rounded-lg bg-brand-bg p-3 text-brand-text">
      <p className="text-caption font-medium text-brand-text-secondary">{theme === 'light' ? 'Claro' : 'Escuro'}</p>
      {RAIL_CASES.map((c) => {
        const st = deriveTradeState({ ...RAIL_BASE, ...c.input })
        const baton = batonLabel(st.steps.find((x) => x.state === 'current'), c.viewer, { buyer: 'Alice', seller: 'Bob' })
        return <TradeRail key={c.name} title={c.name} steps={st.steps} status={st.status} baton={baton} viewer={c.viewer} />
      })}
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-heading text-brand-text">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function DesignSystemPreview() {
  const [vars, setVars] = useState<Vars | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [seg, setSeg] = useState<(typeof SEG_OPTIONS)[number]['value']>('all')
  const [tab, setTab] = useState<'resumo' | 'evidencias' | 'decisao'>('resumo')
  const [radio, setRadio] = useState('release')
  const [sort, setSort] = useState<SortState<TableKey> | null>({ key: 'price', direction: 'ascending' })
  const sortedRows = useMemo(() => sortRows(TABLE_ROWS, sort, (r, k) => r[k as TableKey]), [sort])
  const [chips, setChips] = useState<string[]>(['PIX'])
  const [combo, setCombo] = useState<ComboValue>('USD')
  const [comboMulti, setComboMulti] = useState<ComboValue[]>(['BRL'])
  const [catalogAsset, setCatalogAsset] = useState<AssetType | 'Todos'>('Todos')
  const [fav, setFav] = useState(false)
  const [stars, setStars] = useState<number | null>(4)
  const onSort = (c: TableKey) => setSort((x) => nextSort(x, c))
  useEffect(() => setVars(readThemeVars()), [])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Alert tone="warning">Pré-visualização de desenvolvimento: proposta do Design System, aguardando homologação.</Alert>
      <h1 className="mt-4 text-title text-brand-text">Sails Design System</h1>
      <p className="mt-1 text-body-sm text-brand-text-secondary">Tokens em src/index.css e tailwind.config.js; regras em packages/sails-ui/DESIGN_SYSTEM.md; guarda em tests/designSystemGuard.test.ts.</p>

      <Section id="ds-colors" title="Cores por papel">
        <p className="text-body-sm text-brand-text-secondary">Contraste medido das variáveis reais, mínimo entre fundo, superfície e elevado. Texto 4.5:1; UI e texto grande 3:1. Amostras no tema atual.</p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[56rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Papel</th>
                <th className="px-3 py-2 font-medium">Amostras</th>
                {(['light', 'dark'] as const).map((t) => <th key={t} className="px-3 py-2 font-medium">{t === 'light' ? 'Claro' : 'Escuro'}: texto · tint · UI · sólido</th>)}
              </tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.name} className="border-t border-brand-border-subtle align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium text-brand-text">{r.name}</p>
                    <p className="text-caption text-brand-text-muted max-w-[16rem]">{r.use}</p>
                    <p className="mt-1 mono-id text-caption text-brand-text-muted">{r.fg}</p>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={r.text}>Texto</span>
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${r.chip}`}>Chip</span>
                      {r.solidClass && <span className={`rounded-md px-3 py-1.5 text-sm font-medium ${r.solidClass}`}>Sólido</span>}
                    </div>
                  </td>
                  {(['light', 'dark'] as const).map((t) => {
                    const m = vars ? measure(vars[t], r) : null
                    return (
                      <td key={t} className="px-3 py-2 tabular-nums">
                        {m ? (
                          <ul className="space-y-0.5">
                            <li>texto <Ratio value={m.text} min={4.5} /></li>
                            <li>no tint <Ratio value={m.tint} min={4.5} /></li>
                            <li>UI <Ratio value={m.ui} min={3} /></li>
                            <li>sólido <Ratio value={m.solid} min={4.5} /></li>
                          </ul>
                        ) : <span className="text-brand-text-muted">medindo…</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Bordas de chip (base/25) são decorativas: o rótulo carrega o significado. Bordas funcionais (inputs, foco, erro) usam a base cheia, medida na coluna UI. Laranja sobre tint laranja não é uma combinação aprovada.</p>
      </Section>

      <Section id="ds-type" title="Escala tipográfica">
        <div className="overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[48rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>{['Utilitário', 'Papel', 'Tamanho móvel / desktop (px)', 'Altura de linha', 'Peso', 'Tracking', 'Amostra'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {TYPE.map(([cls, role, size, lh, w, ls, sample]) => (
                <tr key={cls} className="border-t border-brand-border-subtle">
                  <td className="px-3 py-2 mono-id text-body-sm text-brand-text-secondary">{cls}</td>
                  <td className="px-3 py-2 text-brand-text">{role}</td>
                  <td className="px-3 py-2 tabular-nums">{size}</td>
                  <td className="px-3 py-2 tabular-nums">{lh}</td>
                  <td className="px-3 py-2 tabular-nums">{w}</td>
                  <td className="px-3 py-2 tabular-nums">{ls}</td>
                  <td className={`px-3 py-2 text-brand-text ${cls}`}>{sample}</td>
                </tr>
              ))}
              <tr className="border-t border-brand-border-subtle">
                <td className="px-3 py-2 mono-id text-body-sm text-brand-text-secondary">money / tabular-nums</td>
                <td className="px-3 py-2 text-brand-text">numérico</td>
                <td className="px-3 py-2 tabular-nums">15 (lg 18, hero 26 / 28)</td>
                <td className="px-3 py-2 tabular-nums">1.3</td>
                <td className="px-3 py-2 tabular-nums">600</td>
                <td className="px-3 py-2 tabular-nums">0</td>
                <td className="px-3 py-2 text-brand-text"><span className="money">R$ 1.234,56</span> · <span className="money-lg">US$ 97.450,00</span></td>
              </tr>
              <tr className="border-t border-brand-border-subtle">
                <td className="px-3 py-2 mono-id text-body-sm text-brand-text-secondary">mono-id</td>
                <td className="px-3 py-2 text-brand-text">mono (IBM Plex Mono, só IDs)</td>
                <td className="px-3 py-2 tabular-nums">14</td>
                <td className="px-3 py-2 tabular-nums">1.5</td>
                <td className="px-3 py-2 tabular-nums">400</td>
                <td className="px-3 py-2 tabular-nums">0</td>
                <td className="px-3 py-2 mono-id text-brand-text">#c41d9e73</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="ds-sizes" title="Espaçamento, raios, controles, ícones, avatares, elevação">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
            <h3 className="text-subheading text-brand-text">Espaçamento (passo de 4px)</h3>
            <ul className="mt-2 space-y-1 text-body-sm text-brand-text-secondary">
              {[['1', 'w-1', 4], ['2', 'w-2', 8], ['3', 'w-3', 12], ['4', 'w-4', 16], ['6', 'w-6', 24], ['8', 'w-8', 32]].map(([k, w, px]) => (
                <li key={k} className="flex items-center gap-3"><span className={`h-3 rounded-sm bg-brand-blue-solid ${w}`} /><span className="tabular-nums">{k} = {px}px</span></li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
            <h3 className="text-subheading text-brand-text">Raios</h3>
            <div className="mt-2 flex flex-wrap gap-3 text-caption text-brand-text-secondary">
              {[['rounded-sm', '4px'], ['rounded-md', '6px (controles)'], ['rounded-lg', '8px (cards, diálogos)'], ['rounded-full', 'chips, avatares']].map(([c, l]) => (
                <div key={c} className="text-center"><div className={`h-12 w-16 border border-brand-border bg-brand-elevated ${c}`} /><p className="mt-1">{c}<br />{l}</p></div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
            <h3 className="text-subheading text-brand-text">Altura de controles</h3>
            <div className="mt-2 flex flex-wrap items-end gap-3 text-caption text-brand-text-secondary">
              {[['h-control-sm', '36 compacto (desktop)'], ['h-control', '40 padrão (desktop)'], ['h-control-touch', '44 toque (móvel)']].map(([c, l]) => (
                <div key={c} className="text-center"><div className={`w-24 rounded-md border border-brand-border bg-brand-elevated ${c}`} /><p className="mt-1">{c}<br />{l}</p></div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
            <h3 className="text-subheading text-brand-text">Ícones e avatares</h3>
            <div className="mt-2 flex flex-wrap items-end gap-4 text-caption text-brand-text-secondary">
              {[['size-icon-sm', '16'], ['size-icon', '20'], ['size-icon-lg', '24']].map(([c, l]) => (
                <div key={c} className="text-center"><Loader2 aria-hidden="true" className={`mx-auto text-brand-text ${c}`} /><p className="mt-1">{c} {l}</p></div>
              ))}
              {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
                <div key={s} className="text-center"><UserAvatar user={{ id: 'ds-preview', displayName: 'Exemplo', publicKey: '02ds-preview-seed' }} size={s} /><p className="mt-1">{s}</p></div>
              ))}
            </div>
            <p className="mt-2 text-caption text-brand-text-muted">Avatares: 28 / 36 / 48 / 64 (UserAvatar SIZES).</p>
          </div>
          <div className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4 md:col-span-2">
            <h3 className="text-subheading text-brand-text">Elevação</h3>
            <p className="text-caption text-brand-text-muted">Primeiro tonal (fundo → superfície → elevado); sombra só para camadas flutuantes. Mapa por componente na seção 4.3 do DESIGN_SYSTEM.md.</p>
            <div className="mt-3 flex flex-wrap gap-4 text-caption text-brand-text-secondary">
              <div className="h-16 w-32 rounded-lg bg-brand-bg p-2">0 · bg (página)</div>
              <div className="h-16 w-32 rounded-lg bg-brand-surface p-2 border border-brand-border-subtle">1 · surface (card)</div>
              <div className="h-16 w-32 rounded-lg bg-brand-elevated p-2">elevated (grupo)</div>
              <div className="h-16 w-32 rounded-lg bg-brand-floating p-2 shadow-elevation-2 border border-brand-border-subtle">2 · floating (popover, menu, select)</div>
              <div className="h-16 w-32 rounded-sm bg-brand-inverse p-2 text-brand-on-inverse shadow-elevation-2">2 · inverse (tooltip)</div>
              <div className="h-16 w-32 rounded-lg bg-brand-surface p-2 shadow-elevation-3 border border-brand-border-subtle">3 · surface (diálogo, sheet)</div>
              <div className="relative h-16 w-32 overflow-hidden rounded-lg bg-brand-surface p-2"><span className="absolute inset-0 bg-scrim" aria-hidden="true" /><span className="relative text-brand-text">scrim</span></div>
            </div>
          </div>
        </div>
      </Section>

      <Section id="ds-buttons" title="Botões">
        <div className="space-y-3">
          {VARIANTS.map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <span className="w-24 mono-id text-caption text-brand-text-muted">{v}</span>
              <Button variant={v}>Ação</Button>
              <Button variant={v} disabled>Desativado</Button>
              <Button variant={v} disabled aria-busy="true"><Loader2 className="motion-safe:animate-spin" aria-hidden="true" />Enviando</Button>
              <Button variant={v} size="sm">Pequeno</Button>
            </div>
          ))}
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">default = a única ação primária (sólido laranja, um por tela). secondary (tonal; outline é alias) = ações de apoio: Voltar, Tentar de novo, Limpar. buy/sell e buy-tonal/sell-tonal = só o lado do trade (seção abaixo). ghost = baixa ênfase, sem preenchimento até o hover. destructive = ação destrutiva. link = navegação no texto. Carregando = desativado + aria-busy + spinner (respeita movimento reduzido).</p>
        <h3 className="mt-4 text-subheading text-brand-text">Tonal em cada superfície</h3>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          {SURFACE_SAMPLES.map(([cls, name]) => (
            <div key={cls} className={`flex flex-wrap items-center gap-3 rounded-lg p-4 ${cls}`}>
              <span className="w-full text-caption text-brand-text-muted">{name}</span>
              <Button variant="secondary">Voltar</Button>
              <Button variant="ghost">Detalhes</Button>
              <Button variant="secondary" disabled>Desativado</Button>
            </div>
          ))}
        </div>
      </Section>

      <Section id="ds-side-buttons" title="Botões de lado: Comprar e Vender">
        <div className="grid gap-3 md:grid-cols-3">
          {SURFACE_SAMPLES.map(([cls, name]) => (
            <div key={cls} className={`flex flex-wrap items-center gap-3 rounded-lg p-4 ${cls}`}>
              <span className="w-full text-caption text-brand-text-muted">{name}</span>
              <Button variant="buy-tonal" size="sm">Comprar</Button>
              <Button variant="sell-tonal" size="sm">Vender</Button>
              <Button variant="buy">Comprar BTC</Button>
              <Button variant="sell">Vender BTC</Button>
              <Button variant="buy-tonal" size="sm" disabled>Comprar</Button>
              <Button variant="sell" loading>Vender BTC</Button>
            </div>
          ))}
        </div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[36rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>{['Tema', 'Lado', 'Tonal: rótulo', 'hover', 'pressionado', 'Sólido: rótulo', 'hover', 'pressionado', 'Sólido vs superfície', 'Foco vs superfície'].map((h, i) => <th key={h + i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(['light', 'dark'] as const).flatMap((t) => (vars ? measureSide({ ...vars.light, ...vars[t] }, t) : []).map((m) => (
                <tr key={t + m.side} className="border-t border-brand-border-subtle tabular-nums">
                  <td className="px-3 py-2">{t === 'light' ? 'Claro' : 'Escuro'}</td>
                  <td className="px-3 py-2">{m.side === 'buy' ? 'Compra' : 'Venda'}</td>
                  <td className="px-3 py-2"><Ratio value={m.rest} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.hover} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.pressed} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.solid} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.solidHover} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.solidPressed} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.solidFill} min={3} /></td>
                  <td className="px-3 py-2"><Ratio value={m.focus} min={3} /></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <h3 id="ds-botoes-estados" className="mt-4 text-subheading text-brand-text">Estados lado a lado</h3>
        <div className="mt-2 overflow-x-auto rounded-lg bg-brand-surface p-4">
          <table className="text-body-sm">
            <thead className="text-left text-brand-text-secondary">
              <tr>{['Variante', 'Repouso', 'Hover', 'Pressionado', 'Foco (teclado)', 'Desativado', 'Carregando'].map((h) => <th key={h} className="px-2 pb-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {SIDE_STATE_VARIANTS.map(([v, label, size]) => (
                <tr key={v}>
                  <td className="px-2 py-2 mono-id text-caption text-brand-text-muted">{v}</td>
                  <td className="px-2 py-2"><Button variant={v} size={size}>{label}</Button></td>
                  <td className="px-2 py-2"><Button variant={v} size={size} style={layerBg('--state-hover-a')}>{label}</Button></td>
                  <td className="px-2 py-2"><Button variant={v} size={size} style={layerBg('--state-pressed-a')}>{label}</Button></td>
                  <td className="px-2 py-2"><Button variant={v} size={size} className={FOCUS_STATIC + ' outline'}>{label}</Button></td>
                  <td className="px-2 py-2"><Button variant={v} size={size} disabled>{label}</Button></td>
                  <td className="px-2 py-2"><Button variant={v} size={size} loading>{label}</Button></td>
                </tr>
              ))}
              <tr>
                <td className="px-2 py-2 mono-id text-caption text-brand-text-muted">Sua oferta</td>
                <td className="px-2 py-2"><span className={OWN_OFFER_LINK}>Sua oferta</span></td>
                <td className="px-2 py-2"><span className={OWN_OFFER_LINK + ' text-brand-text'}>Sua oferta</span></td>
                <td className="px-2 py-2 text-caption text-brand-text-muted">igual ao hover</td>
                <td className="px-2 py-2"><span className={OWN_OFFER_LINK + ' outline ' + FOCUS_STATIC}>Sua oferta</span></td>
                <td className="px-2 py-2 text-caption text-brand-text-muted">não se aplica</td>
                <td className="px-2 py-2 text-caption text-brand-text-muted">não se aplica</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 className="mt-4 text-subheading text-brand-text">Na linha do Market (OfferTable; OfferCard abaixo de lg)</h3>
        {/* Same split as the Market: the table from lg, the compact rows below it. */}
        <div id="ds-botoes-linha" className="mt-2 overflow-hidden rounded-lg bg-brand-surface">
          <div className="hidden lg:block"><OfferTable offers={DEMO_ROWS} isOwn={(o) => o.id === 'ds-row-own'} /></div>
          <div className="lg:hidden">{DEMO_ROWS.map((o) => <OfferCard key={o.id} offer={o} own={o.id === 'ds-row-own'} />)}</div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Na tabela a ação é o único link da linha e seu ::after cobre a linha: passar o mouse em qualquer ponto da linha acende a camada da linha e a do botão; o foco pelo teclado desenha o contorno no botão. "Sua oferta" é texto secundário que vira principal no hover, sem preenchimento.</p>
        <p className="mt-2 text-caption text-brand-text-muted">Só para a ação que é o lado do trade. Tonal (linha do Market): tint do lado a 10 % + texto do lado; a camada de estado é a cor do lado no claro e preta no escuro, para o rótulo nunca perder contraste (mínimo entre fundo, superfície e elevado). Sólido: a ação primária do ticket da oferta, no lugar do laranja. "Sua oferta" fica neutra. O guard só aceita essas variantes escolhidas a partir do lado do trade.</p>
      </Section>

      <Section id="ds-phase4a" title="Métodos de pagamento, item planejado e avaliação">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 text-body-sm">
            <p className="text-caption text-brand-text-muted">PaymentMethods: até 2 na linha (1 abaixo de sm), depois +N; lista completa na oferta.</p>
            <div><PaymentMethods labels={['PIX']} max={2} maxNarrow={1} /></div>
            <div><PaymentMethods labels={['PIX', 'TED', 'Dinheiro', 'Wise']} max={2} maxNarrow={1} /></div>
            <div><PaymentMethods labels={['PIX', 'TED', 'Dinheiro', 'Wise']} className="text-sm text-brand-text" /></div>
          </div>
          <div className="space-y-4">
            <PlannedItem label="Avaliações" soonLabel="Em breve" description="Notas de 1 a 5 estrelas dadas pelas contrapartes. Só informativas: não mudam a reputação." explanation={RATINGS_EXPLANATION} />
            <StarRating legend="Estrelas (StarRating)" name="ds-stars" value={stars} onChange={setStars} starLabel={RATE_COPY.starLabel} valueText={RATE_COPY.valueText(stars)} />
          </div>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <RateCounterpartyCard copy={RATE_COPY} submitting={false} onSubmit={() => toast.success('Avaliação enviada')} />
          <div className="space-y-4">
            <RateCounterpartyCard copy={RATE_COPY} submitting={false} error="Não foi possível enviar a avaliação. Tente novamente." onSubmit={() => undefined} />
            <RateCounterpartyCard copy={RATE_COPY} submitting={false} doneText="Você avaliou este trade" onSubmit={() => undefined} />
            <RateCounterpartyCard copy={RATE_COPY} submitting={false} doneText="Você já avaliou este trade" onSubmit={() => undefined} />
          </div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Estrelas = rádios nativos com rótulo por estrela (setas mudam a nota); escolhidas em azul de marcado, nunca laranja. A avaliação é informativa (RFC-007) e nunca aparece como número de reputação. Concluído = uma linha no lugar do formulário.</p>
      </Section>

      <Section id="ds-state-layers" title="Camadas de estado, desativado e carregando">
        <div className="overflow-x-auto">
          <table className="text-body-sm">
            <thead className="text-left text-brand-text-secondary">
              <tr>{['Variante', 'Repouso', 'Hover (8 %)', 'Pressionado (12 %)', 'Foco pelo teclado', 'Desativado', 'Carregando'].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(['default', 'secondary', 'ghost', 'destructive'] as const).map((v) => (
                <tr key={v}>
                  <td className="px-2 py-2 mono-id text-caption text-brand-text-muted">{v}</td>
                  <td className="px-2 py-2"><Button tabIndex={-1} variant={v}>Enviar</Button></td>
                  <td className="px-2 py-2"><Button tabIndex={-1} variant={v} style={layerStyle(v, '--state-hover-a')}>Enviar</Button></td>
                  <td className="px-2 py-2"><Button tabIndex={-1} variant={v} style={layerStyle(v, '--state-pressed-a')}>Enviar</Button></td>
                  <td className="px-2 py-2"><Button tabIndex={-1} variant={v} className={FOCUS_STATIC}>Enviar</Button></td>
                  <td className="px-2 py-2"><Button variant={v} disabled>Enviar</Button></td>
                  <td className="px-2 py-2"><Button tabIndex={-1} variant={v} loading>Enviar</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Uma camada para tudo: cor do texto sobre fundos neutros; branca sobre sólidos de rótulo escuro (primário); preta sobre sólidos de rótulo branco (destrutivo), então o rótulo só ganha contraste. Hover só com ponteiro que tem hover; pressionado em todo lugar. Desativado = recipiente 12 % e conteúdo 38 % da cor do texto, sem laranja (isento de 1.4.3), com o atributo disabled. Carregando = mantém o visual e a largura, spinner no lugar do rótulo (que segue no nome acessível), aria-busy, cliques ignorados.</p>
        <div className="mt-4 flex flex-wrap items-center gap-6 text-body-sm text-brand-text">
          <label className="flex items-center gap-2"><Checkbox defaultChecked /> Marcado (azul da marca)</label>
          <label className="flex items-center gap-2"><Checkbox /> Desmarcado</label>
          <label className="flex items-center gap-2"><Switch defaultChecked aria-label="Ligado" /> Ligado</label>
          <label className="flex items-center gap-2"><Switch aria-label="Desligado" /> Desligado</label>
          <span className="rounded-sm bg-brand-inverse px-2 py-1 text-caption text-brand-on-inverse shadow-elevation-2">Tooltip (superfície inversa)</span>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Marcado é azul da marca, nunca laranja: laranja = agir, azul = escolhido.</p>
      </Section>

      <Section id="ds-motion" title="Movimento">
        <ul className="space-y-1 text-body-sm text-brand-text-secondary">
          <li><span className="mono-id text-caption">--duration-short</span> 100 ms: cor, hover, pressionado, tooltip; saída de popover.</li>
          <li><span className="mono-id text-caption">--duration-medium</span> 200 ms: entrada de popover, menu e select; largura da barra lateral; saída de diálogo e sheet.</li>
          <li><span className="mono-id text-caption">--duration-long</span> 300 ms: entrada de diálogo e sheet.</li>
          <li>Entrada desacelera (<span className="mono-id text-caption">--easing-decelerate</span>), saída acelera e é mais curta; com movimento reduzido tudo fica instantâneo.</li>
        </ul>
        <Button variant="secondary" className="mt-3" onClick={() => setConfirmOpen(true)}>Ver a entrada do diálogo</Button>
      </Section>

      <Section id="ds-segmented" title="Controle segmentado">
        <div className="flex flex-wrap gap-3">
          {SURFACE_SAMPLES.map(([cls, name]) => (
            <div key={cls} className={`rounded-lg p-4 ${cls}`}>
              <p className="mb-2 text-caption text-brand-text-muted">{name}</p>
              <SegmentedControl label={`Exemplo de filtro, ${name}`} options={SEG_OPTIONS} value={seg} onChange={setSeg} />
            </div>
          ))}
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Trilho tonal sem contorno; item selecionado = superfície elevada + shadow-elevation-1 + texto principal em peso 500; não selecionado = texto secundário. A seleção nunca depende só da cor (preenchimento, elevação, cor e peso juntos, mais aria-pressed). Medidas na tabela de Foco e superfícies.</p>
      </Section>

      <Section id="ds-forms" title="Campos">
        <div className="grid max-w-3xl gap-4 md:grid-cols-3">
          <label className="text-sm text-brand-text">Valor
            <Input className="mt-1" placeholder="0,00" inputMode="decimal" />
          </label>
          <label className="text-sm text-brand-text">Valor com erro
            <Input className="mt-1" defaultValue="99999" aria-invalid="true" aria-describedby="ds-input-error" />
            <span id="ds-input-error" className="mt-1 block text-xs text-brand-danger-fg">Fora do limite: 10 – 500</span>
          </label>
          <label className="text-sm text-brand-text">Desativado
            <Input className="mt-1" disabled defaultValue="Bloqueado" />
          </label>
        </div>
      </Section>

      <Section id="ds-badges" title="Badges e tons">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3"><span className="w-24 text-caption text-brand-text-muted">Lado (texto + seta)</span><SideBadge side="BUY" /><SideBadge side="SELL" /><span className="text-caption text-brand-text-muted">Status (pílula + ícone):</span><TradeStatusBadge status="DISPUTED" /></div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Trade</span>{TRADE.map((s) => <TradeStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Escrow</span>{ESCROW.map((s) => <EscrowStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Oferta</span>{OFFER.map((s) => <OfferStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">TONE_CLASS</span>{TONES.map((t) => <span key={t} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[t]}`}>{t}</span>)}</div>
        </div>
      </Section>

      <Section id="ds-primitives-tokens" title="Tokens novos: seleção, link, trilho do segmentado">
        <div className="flex flex-wrap items-center gap-3 text-body-sm">
          <span className="rounded-sm bg-brand-selected px-3 py-2 text-brand-text">Linha selecionada (bg-brand-selected)</span>
          <a href="#ds-primitives-tokens" className="text-brand-link underline underline-offset-4">Link (text-brand-link)</a>
          <SegmentedControl label="Exemplo de trilho" options={SEG_OPTIONS} value={seg} onChange={setSeg} />
        </div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[36rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>{['Tema', 'Superfície', 'Texto na seleção', 'Secundário na seleção', 'Link'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(['light', 'dark'] as const).flatMap((t) => (vars ? measurePrimitives({ ...vars.light, ...vars[t] }) ?? [] : []).map((m) => (
                <tr key={t + m.name} className="border-t border-brand-border-subtle tabular-nums">
                  <td className="px-3 py-2">{t === 'light' ? 'Claro' : 'Escuro'}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2"><Ratio value={m.selText} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.selSec} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.link} min={4.5} /></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Seleção = azul da marca a 12 % + um sinal que não é cor (check, rádio marcado, texto "selecionada"). Link = azul da marca; laranja não é link. O trilho do segmentado tem tom próprio, mais fundo no claro: o thumb branco se separa pelo preenchimento (coluna "Thumb vs trilho" em Foco e superfícies), além da sombra.</p>
      </Section>

      <Section id="ds-toast" title="Toast">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => toast.success('Chave pública copiada')}>Sucesso</Button>
          <Button variant="secondary" onClick={() => toast.info('Oferta publicada')}>Info</Button>
          <Button variant="secondary" onClick={() => toast.warning('Algumas ofertas podem não ter carregado')}>Atenção</Button>
          <Button variant="secondary" onClick={() => toast.error('Não foi possível copiar')}>Erro</Button>
          <Button variant="secondary" onClick={() => toast('Filtros limpos', { action: { label: 'Desfazer', onClick: () => undefined } })}>Com ação</Button>
        </div>
        <div className="mt-3 grid max-w-md gap-2" aria-hidden="true">
          {STATIC_TOASTS.map(([k, msg, c, Icon]) => (
            <div key={k} className={TOAST_CLASS}>
              <Icon className={`size-icon shrink-0 ${c}`} />
              <span className="flex-1 py-1 font-medium">{msg}</span>
            </div>
          ))}
          <div className={TOAST_CLASS}><span className="flex-1 py-1 font-medium">Filtros limpos</span><span className="px-2 text-control font-medium text-brand-inverse-link">Desfazer</span></div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Superfície inversa, sem borda, ícone por tom em cor própria para o inverso (4.12+:1), ação em link inverso (5.51+:1). Duração: 4 s confirmação, 6 s atenção/erro, 8 s com ação; erro e ação têm botão Fechar. Região aria-live polida; nunca rouba o foco. Entra e sai com os tokens de movimento. Confirma uma ação local; nunca é o único registro de uma mudança de estado do protocolo (CTO 437). Espécimes estáticos acima; os botões disparam o toast real.</p>
      </Section>

      <Section id="ds-tabs" title="Abas">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-2 text-caption text-brand-text-muted">Abas na página (role=tablist, setas, Home/End)</p>
            <Tabs label="Exemplo de abas" idBase="ds-tabs" items={[{ value: 'resumo', label: 'Resumo' }, { value: 'evidencias', label: 'Evidências' }, { value: 'decisao', label: 'Decisão' }]} value={tab} onChange={setTab} />
            <div {...tabPanelProps('ds-tabs', tab)} className="py-3 text-body-sm text-brand-text-secondary">Painel: {tab}</div>
          </div>
          <div>
            <p className="mb-2 text-caption text-brand-text-muted">Estados (estático): ativa, inativa, foco</p>
            <div className="flex gap-1 border-b border-brand-border-subtle" aria-hidden="true">
              <span className={tabClass(true)}>Ativa</span>
              <span className={tabClass(false)}>Inativa</span>
              <span className={`${tabClass(false)} ${FOCUS_STATIC}`}>Foco</span>
            </div>
            <p className="mt-3 mb-2 text-caption text-brand-text-muted">Vertical (Configurações, md+)</p>
            <div className="w-52" aria-hidden="true"><span className={tabClass(true, 'vertical')}>Aplicativo</span><span className={tabClass(false, 'vertical')}>Segurança</span></div>
          </div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Duas espécies, um visual. Tabs trocam o painel na mesma página (Configurações md+). TabLinks navegam entre rotas (Trades: Ativos | Histórico): links com aria-current, Tab passa por eles como links. Ativa = texto principal + indicador laranja de 2 px ("você está aqui"); 40 px fino, 44 no toque. Para filtros use o segmentado.</p>
      </Section>

      <Section id="ds-menu" title="Menu">
        <Menu>
          <MenuTrigger className={TONAL_TRIGGER}>Abrir menu de exemplo</MenuTrigger>
          <MenuContent label="Menu de exemplo" align="start">
            <MenuLabel><span className="text-body-sm font-medium text-brand-text">Satoshi</span></MenuLabel>
            <MenuSeparator />
            <MenuItem><Copy aria-hidden="true" /> Copiar chave pública</MenuItem>
            <MenuItem><UserIcon aria-hidden="true" /> Meu perfil</MenuItem>
            <MenuItem><Settings aria-hidden="true" /> Configurações</MenuItem>
            <MenuSeparator />
            <MenuItem><LogOut aria-hidden="true" /> Desconectar</MenuItem>
            <MenuItem destructive><Trash2 aria-hidden="true" /> Excluir rascunho</MenuItem>
          </MenuContent>
        </Menu>
        <p className="mt-2 text-caption text-brand-text-muted">role=menu sobre o Popover do Radix: Enter, Espaço ou seta abrem e focam o primeiro item (seta para cima: o último); setas, Home/End e letras (typeahead) navegam; Tab e Esc fecham, o foco volta ao gatilho. Itens 32 px fino / 44 toque, ícone 16, foco = camada de 12 % (sem caixa dentro do menu). Destrutivo em danger-fg. Sair fica separado da navegação.</p>
      </Section>

      <Section id="ds-radio" title="Rádio e cartões de rádio">
        <div className="grid gap-6 md:grid-cols-2">
          <RadioGroup legend="Decisão (cartões)" listClassName="space-y-2">
            {([['release', 'Liberar ao comprador', false], ['refund', 'Devolver ao vendedor', false], ['split', 'Dividir 50/50', true]] as const).map(([v, l, off]) => (
              <RadioCard key={v} name="ds-radio" value={v} checked={!off && radio === v} disabled={off} onChange={() => setRadio(v)}>
                <span>{l}{off && <span className="block font-normal text-brand-text-secondary">Indisponível neste escrow</span>}</span>
              </RadioCard>
            ))}
          </RadioGroup>
          <RadioGroup legend="Rádio simples">
            <div className="space-y-2 text-body-sm text-brand-text">
              <label className="flex min-h-11 items-center gap-2"><Radio name="ds-radio-plain" defaultChecked /> Marcado</label>
              <label className="flex min-h-11 items-center gap-2"><Radio name="ds-radio-plain" /> Desmarcado</label>
              <label className="flex min-h-11 items-center gap-2 text-brand-text-secondary"><Radio name="ds-radio-off" disabled /> Desativado</label>
            </div>
          </RadioGroup>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Rádio nativo (setas, foco no marcado, "1 de 3" vêm do navegador), anel na cor secundária, marcado = azul da marca (escolhido, nunca laranja). Cartão: o cartão inteiro é o rótulo (44 px+), tonal sem contorno; selecionado = preenchimento de seleção + rádio marcado; foco pelo teclado = a própria borda do cartão (2 px). Uma escolha obrigatória num formulário; para filtros use o segmentado.</p>
      </Section>

      <Section id="ds-table" title="Tabela">
        <div className="max-h-56 overflow-y-auto rounded-lg border border-brand-border-subtle bg-brand-surface">
          <Table sticky className="min-w-[32rem]">
            <caption className="sr-only">Ofertas de exemplo, ordenáveis</caption>
            <TableHeader>
              <tr>
                <SortableTableHead column="seller" sort={sort} onSort={onSort}>Anunciante</SortableTableHead>
                <SortableTableHead column="price" sort={sort} onSort={onSort} numeric>Preço (US$)</SortableTableHead>
                <SortableTableHead column="trades" sort={sort} onSort={onSort} numeric>Trades</SortableTableHead>
                <TableHead>Status</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {[...sortedRows, ...sortedRows].map((r, i) => (
                <TableRow key={r.id + i} interactive className={i === 1 ? 'bg-brand-selected' : undefined}>
                  <TableCell className="text-body-sm text-brand-text">{r.seller}{i === 1 && <span className="sr-only"> (selecionada)</span>}</TableCell>
                  <TableCell numeric className="text-body-sm text-brand-text">{r.price.toLocaleString('pt-BR')}</TableCell>
                  <TableCell numeric className="text-body-sm text-brand-text-secondary">{r.trades}</TableCell>
                  <TableCell><TradeStatusBadge status={i % 2 ? 'COMPLETED' : 'ACTIVE'} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-brand-border-subtle bg-brand-surface">
          <Table>
            <TableHeader><tr><TableHead>Anunciante</TableHead><TableHead numeric>Preço</TableHead></tr></TableHeader>
            <TableBody><TableEmpty colSpan={2} kind="empty" title="Nenhuma oferta com estes filtros" /></TableBody>
          </Table>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Cabeçalho caption 500 em muted, frase normal; fixo opcional (superfície a 95 % + desfoque). Coluna ordenável = botão dentro do th, aria-sort no th, ícone de setas; um clique ordena crescente, outro inverte (pt-BR, vazios no fim, estável). Números à direita e tabulares. Linha: uma linha fina, camada de estado no hover; selecionada = bg-brand-selected + texto "selecionada". Vazio/erro = StateBlock sem borda numa linha cheia. Abaixo de lg a tabela do Market vira linhas; Trades, Perfil e Disputas são listas-tabela (mesmo cabeçalho e linha: TABLE_HEAD_ROW, TABLE_ROW).</p>
      </Section>

      <Section id="ds-alert" title="Aviso (Alert)">
        <div className="grid gap-3 md:grid-cols-2">
          {ALERT_TONES.map((t) => <Alert key={t} tone={t} title={`Aviso ${t}`}>Texto do aviso no tom {t}: tint e ícone carregam o tom, o texto fica na cor principal.</Alert>)}
          <Alert tone="warning" size="sm">Nota compacta (SafetyNote): guarde a senha; se perdê-la, não há como recuperar a chave.</Alert>
          <Alert tone="info" title="Com ação" action={<Button size="sm" variant="secondary">Tentar de novo</Button>}>Algumas ofertas podem não ter carregado.</Alert>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Tint do tom (base a 10 %) + ícone na base do tom, sem borda (nada de caixa dentro de caixa). Texto principal: 15.36+:1 claro, 10.80+:1 escuro em todo tint. Papel: note (estático), status (aparece: info, sucesso, atenção) ou alert (só perigo novo). Substitui os avisos soltos e o visual do SafetyNote (texto mantido).</p>
      </Section>

      <Section id="ds-progress" title="Progresso">
        <div className="grid max-w-xl gap-4 text-caption text-brand-text-secondary">
          {[0, 40, 100].map((v) => <div key={v}><p className="mb-1">Determinado {v} %</p><Progress value={v} label={`Exemplo ${v} %`} /></div>)}
          <div><p className="mb-1">Indeterminado</p><Progress label="Enviando comprovante" /></div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Trilho de 4 px em border-subtle, indicador azul da marca (3.95+:1 contra o trilho, 4.74+:1 contra as superfícies). Determinado só para progresso medido de verdade (envio de arquivo); nunca uma porcentagem inventada para uma espera do protocolo. Indeterminado: a barra corre; com movimento reduzido fica parada e o rótulo diz que está trabalhando. Animação só por transform.</p>
      </Section>

      <Section id="ds-divider" title="Divisória">
        <div className="max-w-md rounded-lg bg-brand-surface py-2 text-body-sm text-brand-text">
          <p className="px-4 py-2">Linha de lista</p>
          <Divider inset />
          <p className="px-4 py-2">Divisória recuada (inset)</p>
          <Divider />
          <div className="flex items-center gap-3 px-4 py-2">Esquerda <Divider orientation="vertical" className="h-5" /> Direita</div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">1 px em border-subtle dentro de uma superfície (grupos de menu, seções de lista); decorativa por padrão, role=separator quando é uma quebra de verdade. Nunca a borda de uma caixa.</p>
      </Section>

      <Section id="ds-icon-button" title="Botão de ícone">
        <div className="flex flex-wrap items-center gap-3">
          <IconButton label="Atualizar"><RefreshCw aria-hidden="true" /></IconButton>
          <IconButton label="Atualizar (tonal)" variant="tonal"><RefreshCw aria-hidden="true" /></IconButton>
          <IconButton label="Favoritar este vendedor" pressed={fav} onClick={() => setFav((f) => !f)}><Star aria-hidden="true" fill={fav ? 'currentColor' : 'none'} /></IconButton>
          <IconButton label="Favorito (ligado)" pressed><Heart aria-hidden="true" fill="currentColor" /></IconButton>
          <IconButton label="Indisponível: requer 3 trades" aria-disabled><Heart aria-hidden="true" /></IconButton>
          <IconButton label="Enviando" loading><RefreshCw aria-hidden="true" /></IconButton>
          <IconButton label="Pequeno" size="sm"><Copy aria-hidden="true" /></IconButton>
          <span className={`inline-flex size-9 items-center justify-center rounded-md text-brand-text-secondary ${FOCUS_STATIC}`} aria-hidden="true"><RefreshCw className="size-icon" /></span>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Rótulo obrigatório: vira o nome acessível e a dica (tooltip no hover e no foco; title= é proibido pelo guard). 36 px fino (sm 32), 44 no toque. Ghost ou tonal; alternância com aria-pressed, ligado = ícone azul (escolhido). Indisponível usa aria-disabled para manter a dica e o foco; carregando = spinner, aria-busy. O último é o foco estático.</p>
      </Section>

      <Section id="ds-chips" title="Chips de filtro">
        <div className="flex flex-wrap items-center gap-2">
          {['PIX', 'TED', 'Wise'].map((m) => (
            <FilterChip key={m} label={m} selected={chips.includes(m)} onToggle={() => setChips((c) => (c.includes(m) ? c.filter((x) => x !== m) : [...c, m]))} />
          ))}
          <Divider orientation="vertical" className="h-6" />
          {chips.map((m) => <FilterChip key={m} label={m} onClear={() => setChips((c) => c.filter((x) => x !== m))} clearLabel={`Remover filtro ${m}`} />)}
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Tonal, sem borda (é um gatilho, não um campo). Alternância (aria-pressed): selecionado = checked a 12 % + check + texto azul (5.21+:1 claro, 4.60+:1 escuro). Filtro aplicado: rótulo + botão próprio de remover ("Remover filtro PIX"). 32 px fino / 44 toque.</p>
      </Section>

      <Section id="ds-combobox" title="Combobox (seleção com busca)">
        <div className="flex flex-wrap items-center gap-3">
          <Combobox
            label="Moeda de exemplo"
            valueText={COMBO_OPTIONS.find((o) => o.value === combo)!.label}
            options={COMBO_OPTIONS}
            selected={[combo]}
            onSelect={setCombo}
            trigger={<span className="font-medium">{COMBO_OPTIONS.find((o) => o.value === combo)!.label}</span>}
            triggerClassName="min-w-[12rem]"
            searchPlaceholder="Buscar moeda…"
            emptyText={(q) => `Nada encontrado para “${q}”`}
          />
          <Combobox
            multiple
            label="Vários de exemplo"
            valueText={`${comboMulti.length} ${comboMulti.length === 1 ? 'selecionado' : 'selecionados'}`}
            options={COMBO_OPTIONS}
            selected={comboMulti}
            onSelect={(v) => setComboMulti((c) => (c.includes(v) ? c.filter((x) => x !== v) : [...c, v]))}
            trigger={<span className={comboMulti.length ? 'font-medium text-brand-blue-fg' : ''}>{comboMulti.length} {comboMulti.length === 1 ? 'selecionado' : 'selecionados'}</span>}
            triggerClassName="min-w-[10rem]"
            searchPlaceholder="Buscar…"
            emptyText={(q) => `Nada encontrado para “${q}”`}
          />
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Gatilho = chip de campo + seta; o nome diz o valor ("Ativo: Bitcoin"). Lista no floating: busca com role=combobox que mantém o foco, setas movem a opção ativa (aria-activedescendant, camada de 12 %), Enter escolhe, Esc fecha. Busca ignora maiúsculas e acentos e acha pelo código. Escolha única fecha; múltipla fica aberta. Selecionado = preenchimento de seleção + check azul. Substitui os seletores de Ativo, Moeda e Pagamento.</p>
      </Section>

      <Section id="ds-asset-catalog" title="Catálogo de ativos">
        <p className="text-body-sm text-brand-text-secondary">Os 14 pares oficiais (lib/assetCatalog.ts), uma opção por rede, agrupados pelo ativo. Só fica disponível o par com rail de liquidação apto a produção; os outros aparecem desativados, com “Em breve”. Logos oficiais sem alteração (public/brand/THIRD_PARTY_LOGOS.md); a rede fica numa pastilha clara no canto.</p>
        <div className="mt-3 flex flex-wrap items-start gap-6">
          <div>
            <span className="mb-1.5 block text-caption text-brand-text-muted">Seletor real (filtro do Market)</span>
            <AssetPicker value={catalogAsset} onChange={setCatalogAsset} />
          </div>
          {/* Static option specimens (screenshots have no mouse or keyboard): the classes the Combobox option uses. */}
          <div className="w-80 max-w-full rounded-md border border-brand-border-subtle bg-popover p-1 shadow-elevation-2">
            <div className="px-2 pb-1 pt-2 text-xs font-medium text-brand-text-muted">Bitcoin</div>
            {CATALOG_STATES.map(([state, pairId]) => {
              const p = pickerPairs(false).find((x) => x.id === pairId)!
              const soon = p.availability === 'soon'
              return (
                <div key={state}>
                  <span className="block px-2 pt-1 text-caption text-brand-text-muted">{state}</span>
                  <div
                    data-active={state === 'Foco (teclado)' || undefined}
                    style={state === 'Hover' ? layerBg('--state-hover-a') : undefined}
                    className={cn('flex min-h-8 touch:min-h-11 items-center gap-2 rounded-sm px-2 text-sm', p.note && !soon && 'py-1.5',
                      soon ? 'cursor-not-allowed text-brand-text-secondary' : 'text-brand-text state-focus',
                      state === 'Selecionado' && 'bg-brand-selected font-medium')}
                  >
                    <AssetPairIcon pair={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.label}</span>
                      {p.note && p.note !== SOON_NOTE && <span className="block text-xs font-normal text-brand-text-muted">{p.note}</span>}
                    </span>
                    {soon && <span className="shrink-0 text-xs"><span className={CATALOG_SOON_BADGE}>{SOON_NOTE}</span></span>}
                    <Check aria-hidden="true" className={cn('size-icon-sm shrink-0 text-brand-blue-fg', state !== 'Selecionado' && 'invisible')} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Repouso = texto principal. Hover = camada de 8 %. Foco pelo teclado = a busca mantém o foco e a opção ativa ganha a camada de 12 % (aria-activedescendant), sem contorno dentro da lista. Selecionado = seleção azul a 12 % + check. Desativado = texto secundário, aria-disabled, sem camada, ignorado pelas setas e pelo clique, com “Em breve” (badge tonal, sem borda) e o motivo quando há um.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {SURFACE_SAMPLES.map(([cls, name]) => (
            <div key={cls} className={`rounded-lg p-4 ${cls}`}>
              <span className="block text-caption text-brand-text-muted">{name}: 16 / 20 / 24 px</span>
              <div className="mt-2 grid gap-2">
                {pickerPairs(false).filter((x) => CATALOG_ICON_SAMPLES.includes(x.id)).map((x) => (
                  <div key={x.id} className="flex items-center gap-3 text-body-sm text-brand-text">
                    {(['sm', 'md', 'lg'] as const).map((sz) => <AssetPairIcon key={sz} pair={x} size={sz} />)}
                    <span>{x.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[36rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>{['Par', 'Enum (AssetType)', 'Estado', 'Motivo / aviso'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {pickerPairs(true).map((x) => (
                <tr key={x.id} className="border-t border-brand-border-subtle">
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><AssetPairIcon pair={x} size="sm" />{x.label}</span></td>
                  <td className="px-3 py-2">{x.assetType ? <span className="mono-id">{x.assetType}</span> : <span className="text-brand-text-muted">não existe</span>}</td>
                  <td className="px-3 py-2">{x.testOnly ? 'Só em desenvolvimento' : x.availability === 'available' ? 'Disponível' : SOON_NOTE}</td>
                  <td className="px-3 py-2 text-brand-text-secondary">{x.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="ds-states" title="Estados (StateBlock)">
        <div className="grid gap-4 md:grid-cols-2">
          <StateBlock kind="loading" title="Carregando ofertas" description="Buscando no nó Sails configurado." />
          <StateBlock kind="empty" title="Nenhuma oferta" description="Ajuste os filtros ou publique uma oferta." action={<Button size="sm">Publicar oferta</Button>} />
          <StateBlock kind="error" title="Não foi possível carregar" description="O nó Sails não respondeu." action={<Button size="sm" variant="outline">Tentar de novo</Button>} />
          <StateBlock kind="signedOut" title="Conecte sua carteira" description="Para ver seus trades." action={<Button size="sm">Conectar</Button>} />
        </div>
      </Section>

      <Section id="ds-confirm" title="Confirmação de ação irreversível">
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>Abrir exemplo</Button>
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Cancelar esta oferta?"
          consequence="A oferta sai do Market. Trades já abertos não mudam."
          summary={[{ label: 'Oferta', value: 'Vender BTC · PIX' }, { label: 'Limites', value: '10 – 500' }]}
          warnings={['Esta ação não pode ser desfeita nesta interface.']}
          confirmLabel="Cancelar oferta"
          cancelLabel="Voltar"
          tone="danger"
          onConfirm={() => setConfirmOpen(false)}
        />
        <p className="mt-2 text-caption text-brand-text-muted">O foco começa em Voltar; Enter nunca confirma por acidente; Esc cancela.</p>
      </Section>

      <Section id="ds-focus" title="Foco e superfícies">
        <div className="grid gap-3 md:grid-cols-3">
          {SURFACE_SAMPLES.map(([cls, name]) => (
            <div key={cls} className={`flex flex-wrap items-center gap-3 rounded-lg p-4 ${cls}`}>
              <span className="w-full text-caption text-brand-text-muted">{name}</span>
              {([['Normal', '', ''], ['Foco pelo teclado', FOCUS_STATIC, FIELD_FOCUS_STATIC]] as const).map(([state, btn, field]) => (
                <div key={state} className="flex flex-wrap items-center gap-3">
                  <span className="w-28 text-caption text-brand-text-secondary">{state}</span>
                  <Button tabIndex={-1} className={btn}>Primário</Button>
                  <Button tabIndex={-1} variant="secondary" className={btn}>Voltar</Button>
                  <Input tabIndex={-1} readOnly className={`w-28 ${field}`} placeholder="Campo" aria-label={`Campo de exemplo, ${state}, ${name}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">"Foco pelo teclado" é um espécime estático (os controles reais só mostram foco com teclado, :focus-visible). Botões, links, abas, itens segmentados e linhas: outline 2px em --color-focus (cor do texto, nunca azul em volta do laranja) + vão transparente de 2px que mostra a superfície onde o controle está. Campos (input, textarea, select, seletores): sem outline; a própria borda vira a cor de foco e 2px por dentro (field-focus), erro igual em danger; cartões de rádio usam field-focus-within. Linhas em listas recortadas usam focus-visible:-outline-offset-2. Uma borda visível por elemento. Use Tab para ver o foco real.</p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-border-subtle">
          <table className="w-full min-w-[40rem] text-body-sm">
            <thead className="bg-brand-elevated text-left text-brand-text-secondary">
              <tr>{['Tema', 'Superfície', 'Foco', 'Rótulo no tonal', 'Thumb vs trilho', 'Selecionado', 'Não selecionado'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(['light', 'dark'] as const).flatMap((t) => (vars ? measureSurfaces(vars[t]) ?? [] : []).map((m) => (
                <tr key={t + m.name} className="border-t border-brand-border-subtle tabular-nums">
                  <td className="px-3 py-2">{t === 'light' ? 'Claro' : 'Escuro'}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2"><Ratio value={m.focus} min={3} /></td>
                  <td className="px-3 py-2"><Ratio value={m.tonalLabel} min={4.5} /></td>
                  <td className="px-3 py-2">{m.thumbVsTrack.toFixed(2)}:1 <span className="text-caption text-brand-text-muted">+ sombra, cor e peso</span></td>
                  <td className="px-3 py-2"><Ratio value={m.selected} min={4.5} /></td>
                  <td className="px-3 py-2"><Ratio value={m.unselected} min={4.5} /></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="ds-trade-rail" title="Trilho do trade">
        <p className="mb-3 text-body-sm text-brand-text-secondary">Concluída = azul com check (nunca verde: concluído não é finalidade de liquidação). Sua vez = anel laranja com pulso (parado com movimento reduzido). Esperando = anel azul. Atenção = âmbar. Futura = contorno neutro. Abaixo de 1024 px: pontos com o mesmo código.</p>
        <div className="grid gap-4 xl:grid-cols-2">
          {(['light', 'dark'] as const).map((t) => <RailSpecimen key={t} theme={t} vars={vars} />)}
        </div>
      </Section>

      <Section id="ds-nav-position" title="Posição do menu no desktop">
        <div className="flex flex-wrap gap-6 rounded-lg bg-brand-surface p-3">
          {([['side', 'Lateral (padrão)'], ['top', 'Superior']] as const).map(([p, l]) => (
            <div key={p} className="flex items-center gap-3 text-body-sm text-brand-text"><NavPositionThumb position={p} className="h-14 w-24" />{l}</div>
          ))}
        </div>
        {/* Static copy of the top bar's items (spans, not links: one navigation landmark per page). */}
        <div className="mt-4 flex flex-wrap items-center gap-1 rounded-lg bg-brand-surface p-2">
          {NAV_ITEMS.map((item, i) => (
            <span key={item.to} className={cn('flex h-9 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap', navItemTone(i === 0))}>
              <span className="flex w-6 shrink-0 justify-center"><NavIcon item={item} active={i === 0} /></span>
              {item.label}
            </span>
          ))}
        </div>
        <p className="mt-2 text-caption text-brand-text-muted">Configurações → Aparência. Superior vale a partir de 1024 px: logo à esquerda, os 5 itens no centro, conta à direita; abaixo disso, o layout de hoje, e no celular a barra inferior. Item ativo = o mesmo tom laranja da barra lateral, com aria-current="page"; repouso = texto secundário com camada de estado no mouse. 36 px com ponteiro fino, 44 no toque.</p>
      </Section>
    </div>
  )
}
