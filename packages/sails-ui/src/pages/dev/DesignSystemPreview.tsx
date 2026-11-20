/**
 * Dev-only (see App.tsx): living reference of the Sails Design System
 * (DESIGN_SYSTEM.md). Contrast numbers are measured here from the real CSS
 * variables of BOTH themes (read from the loaded stylesheet), swatches render
 * in the current theme. Example data only; no SDK calls.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { StateBlock } from '../../components/ui/StateBlock'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { SideBadge, TradeStatusBadge, EscrowStatusBadge, OfferStatusBadge } from '../../components/ui/StatusBadges'
import { TONE_CLASS, type Tone } from '../../lib/tone'
import { blend, contrastRatio, parseTriplet, type Rgb } from '../../lib/contrast'
import type { EscrowStatus, TradeStatus, OfferStatus } from '../../types'

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
  { name: 'Marca: laranja', use: 'Ação primária (um botão sólido por página), navegação ativa. Não é foco (foco = --color-focus). Não é status nem lado.', fg: '--color-orange-accent', base: '--color-orange', solid: ['--color-orange', '--primary-foreground'], text: 'text-brand-orange-accent', chip: 'border-brand-orange/25 bg-brand-orange/10 text-brand-text', solidClass: 'bg-primary text-primary-foreground' },
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
  const get = (k: string): Rgb | null => parseTriplet(v[k] ?? '')
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
    const track = blend(text, c, a('--tonal-a'))
    const thumb = blend(raised, track, a('--raised-a'))
    return {
      name: k.replace('--color-', ''),
      focus: contrastRatio(focus, c),
      tonalLabel: contrastRatio(text, track),
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
  ['text-heading', 'heading (seção)', '16 / 16', '1.35', '600', '0', 'Título de seção'],
  ['text-subheading', 'subheading', '15 / 14', '1.4', '500', '0', 'Subtítulo, rótulo de grupo'],
  ['text-body', 'body (= text-sm)', '15 / 14', '1.5', '400', '0', 'Texto corrido e controles'],
  ['text-body-sm', 'body-sm', '13 / 13', '1.5', '400', '0', 'Texto secundário, células de tabela'],
  ['text-caption', 'caption (= text-xs, piso)', '12 / 12', '1.4', '400', '0', 'Metadados, legendas'],
] as const

const TRADE: TradeStatus[] = ['PENDING', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'CANCELLED']
const ESCROW: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
const OFFER: OfferStatus[] = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']
const VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const
const TONES: Tone[] = ['neutral', 'info', 'success', 'warning', 'danger', 'buy', 'sell']
const SURFACE_SAMPLES = [['bg-brand-bg', 'Fundo da página'], ['bg-brand-surface', 'Superfície (card, diálogo)'], ['bg-brand-elevated', 'Elevado']] as const
/** Static specimens of the two keyboard-focus treatments (screenshots without a keyboard). */
const FOCUS_STATIC = 'outline-2 outline-offset-2 outline-brand-focus'
const FIELD_FOCUS_STATIC = 'border-brand-focus shadow-[inset_0_0_0_1px_rgb(var(--color-focus))]'
const SEG_OPTIONS = [{ value: 'all', label: 'Todos' }, { value: 'buy', label: 'Comprar' }, { value: 'sell', label: 'Vender' }] as const

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
  useEffect(() => setVars(readThemeVars()), [])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div role="note" className="rounded-lg border border-brand-warning-border bg-brand-warning-bg px-4 py-3 text-sm text-brand-warning-fg">
        Pré-visualização de desenvolvimento: proposta do Design System, aguardando homologação.
      </div>
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
                <td className="px-3 py-2 tabular-nums">15 (hero 26 / 28)</td>
                <td className="px-3 py-2 tabular-nums">1.3</td>
                <td className="px-3 py-2 tabular-nums">600</td>
                <td className="px-3 py-2 tabular-nums">0</td>
                <td className="px-3 py-2 money text-brand-text">R$ 1.234,56</td>
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
            <p className="text-caption text-brand-text-muted">Primeiro tonal (fundo → superfície → elevado); sombra só para camadas flutuantes.</p>
            <div className="mt-3 flex flex-wrap gap-4 text-caption text-brand-text-secondary">
              <div className="h-16 w-32 rounded-lg bg-brand-bg p-2">bg</div>
              <div className="h-16 w-32 rounded-lg bg-brand-surface p-2 border border-brand-border-subtle">surface</div>
              <div className="h-16 w-32 rounded-lg bg-brand-elevated p-2">elevated</div>
              {['shadow-elevation-1', 'shadow-elevation-2', 'shadow-elevation-3'].map((c) => <div key={c} className={`h-16 w-32 rounded-lg bg-brand-surface p-2 ${c}`}>{c}</div>)}
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
        <p className="mt-2 text-caption text-brand-text-muted">default = a única ação primária (sólido laranja, um por tela). secondary (tonal; outline é alias) = ações de apoio: Voltar, Tentar de novo, Comprar/Vender na linha do Market. ghost = baixa ênfase, sem preenchimento até o hover. destructive = ação destrutiva. link = navegação no texto. Carregando = desativado + aria-busy + spinner (respeita movimento reduzido).</p>
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
            <Input className="mt-1 border-brand-danger" defaultValue="99999" aria-invalid="true" aria-describedby="ds-input-error" />
            <span id="ds-input-error" className="mt-1 block text-xs text-brand-danger-fg">Fora do limite: 10 – 500</span>
          </label>
          <label className="text-sm text-brand-text">Desativado
            <Input className="mt-1" disabled defaultValue="Bloqueado" />
          </label>
        </div>
      </Section>

      <Section id="ds-badges" title="Badges e tons">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Lado</span><SideBadge side="BUY" /><SideBadge side="SELL" /></div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Trade</span>{TRADE.map((s) => <TradeStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Escrow</span>{ESCROW.map((s) => <EscrowStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">Oferta</span>{OFFER.map((s) => <OfferStatusBadge key={s} status={s} />)}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-24 text-caption text-brand-text-muted">TONE_CLASS</span>{TONES.map((t) => <span key={t} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[t]}`}>{t}</span>)}</div>
        </div>
      </Section>

      <Section id="ds-states" title="Estados (StateBlock)">
        <div className="grid gap-4 md:grid-cols-2">
          <StateBlock kind="loading" title="Carregando ofertas" description="Buscando no servidor configurado." />
          <StateBlock kind="empty" title="Nenhuma oferta" description="Ajuste os filtros ou publique uma oferta." action={<Button size="sm">Publicar oferta</Button>} />
          <StateBlock kind="error" title="Não foi possível carregar" description="O servidor não respondeu." action={<Button size="sm" variant="outline">Tentar de novo</Button>} />
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
    </div>
  )
}
