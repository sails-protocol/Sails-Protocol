/**
 * Design System guard (DESIGN_SYSTEM.md): colors and type sizes come from
 * tokens only. Fails on raw Tailwind palette classes, raw hex/rgb/hsl colors
 * in class names or string literals (style props, inline constants) and
 * arbitrary font sizes. A line may opt out with `ds-allow: <reason>`
 * (e.g. `// ds-allow: ...` or `{/* ds-allow: ... *\/}`), kept to a minimum.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..', 'src')

const PALETTE = 'red|green|emerald|amber|yellow|blue|sky|orange|rose|lime|teal|violet|purple|slate|gray|zinc|neutral|stone|indigo|cyan|pink|fuchsia'
const RULES: { name: string; re: RegExp }[] = [
  // `text-green-500`, `dark:hover:bg-amber-400/10`, `border-red-700/70` ...
  { name: 'raw palette class', re: new RegExp(`-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d{1,3})?(?![\\w-])`) },
  // `bg-[#fff]`, `text-[rgb(1,2,3)]`, `'#f97316'`, `"rgba(0,0,0,.5)"` (token-based `rgb(var(--x))` is fine).
  { name: 'raw color value', re: /(?:\[|['"`]\s*)(?:#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\((?!\s*var\())/ },
  // `text-[13px]`, `text-[0.8rem]`, `text-[length:12px]`.
  { name: 'arbitrary font size', re: /text-\[(?:length:)?\d*\.?\d+(?:px|rem|em)\]/ },
  // Old focus pattern: the offset band is painted with the page background, so a dark gap
  // shows on cards/dialogs. Focus is the global :focus-visible outline (DESIGN_SYSTEM.md 5.1).
  { name: 'ring-offset focus', re: /ring-offset-(?:background|\d)/ },
  // Foundations (DESIGN_SYSTEM.md 3-5): named type steps, elevation tokens, the scrim token,
  // the shape scale and motion tokens instead of raw Tailwind defaults.
  { name: 'off-scale type size', re: /(?<![\w-])text-(?:base|lg|xl|[2-9]xl)(?![\w-])/ },
  { name: 'raw shadow', re: /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl|inner)(?![\w-])/ },
  { name: 'raw scrim', re: /(?<![\w-])bg-(?:black|white)\/\d/ },
  { name: 'off-scale radius', re: /(?<![\w-])rounded-(?:2xl|3xl)(?![\w-])/ },
  { name: 'raw motion value', re: /(?<![\w-])(?:duration-\d+|ease-(?:in|out|in-out|linear))(?![\w-])/ },
]
// Fixed artwork, not UI chrome: the identity-avatar SVG palette and the Sails
// brand mark. Their hex values are art, never class names or themeable colors.
const HEX_EXEMPT = new Set(['lib/identityAvatar.ts', 'components/brand/SailsLogo.tsx'])
const ALLOW = /ds-allow:\s*\S{3,}/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

function violations(rel: string, text: string) {
  const out: string[] = []
  const allowed: string[] = []
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) {
      if (r.name === 'raw color value' && HEX_EXEMPT.has(rel)) continue
      if (!r.re.test(line)) continue
      const where = `${rel}:${i + 1} ${r.name}: ${line.trim().slice(0, 140)}`
      if (ALLOW.test(line)) allowed.push(where)
      else out.push(where)
    }
  })
  return { out, allowed }
}

/** Opening JSX tags of `names` (e.g. button, Button), whole tag text, braces and strings respected. */
function jsxTags(text: string, names: string[]): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = []
  const re = new RegExp(`<(?:${names.join('|')})(?=[\\s>/])`, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0, quote = '', i = m.index + 1
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue }
      // Comments between attributes may hold apostrophes ("page's").
      if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue }
      if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; if (i <= 0) break; continue }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push({ tag: text.slice(m.index, i + 1), line: text.slice(0, m.index).split('\n').length })
  }
  return out
}

// Phase 3 primitives (DESIGN_SYSTEM.md 5.3-5.13): these roles/patterns live only in their primitive,
// so a hand-rolled menu, tab list, radio, listbox, progress bar or raw toast cannot come back.
const PRIMITIVE_ONLY: { name: string; re: RegExp; home: string }[] = [
  { name: 'role="menu" outside the Menu primitive', re: /role=["'{]+menu(?:item)?["'}]/, home: 'components/ui/menu.tsx' },
  { name: 'role="tablist"/"tab" outside the Tabs primitive', re: /role=["'{]+tab(?:list|panel)?["'}]/, home: 'components/ui/tabs.tsx' },
  { name: 'native radio outside the RadioGroup primitive', re: /type=["']radio["']|role=["']radio(?:group)?["']/, home: 'components/ui/radio-group.tsx' },
  { name: 'role="listbox"/"combobox" outside the Combobox primitive', re: /role=["'](?:listbox|combobox|option)["']/, home: 'components/ui/combobox.tsx' },
  { name: 'role="progressbar" outside the Progress primitive', re: /role=["']progressbar["']/, home: 'components/ui/progress.tsx' },
  { name: "toast imported from 'sonner' instead of ui/toast", re: /from ['"]sonner['"]/, home: 'components/ui/toast.tsx' },
]

function primitiveViolations(rel: string, text: string): string[] {
  const out: string[] = []
  text.split('\n').forEach((line, i) => {
    for (const r of PRIMITIVE_ONLY) if (rel !== r.home && r.re.test(line)) out.push(`${rel}:${i + 1} ${r.name}`)
  })
  // Icon buttons get their name from aria-label and a Tooltip (IconButton), never title= (mouse-only, unreliable).
  for (const t of jsxTags(text, ['button', 'Button'])) if (/\stitle=/.test(t.tag)) out.push(`${rel}:${t.line} title= on a button (use IconButton)`)
  return out
}

describe('design system guard', () => {
  it('menus, tabs, radios, listboxes, progress bars and toasts come from their primitives; no title= on buttons', () => {
    const all = files(SRC).flatMap((p) => primitiveViolations(relative(SRC, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')))
    expect(all).toEqual([])
    // The guard itself catches what it should.
    expect(primitiveViolations('x.tsx', '<div role="menu">')).toHaveLength(1)
    expect(primitiveViolations('x.tsx', '<input type="radio" />')).toHaveLength(1)
    expect(primitiveViolations('x.tsx', "import { toast } from 'sonner'")).toHaveLength(1)
    expect(primitiveViolations('x.tsx', '<button\n  onClick={() => f(a > b)}\n  title="Favoritar"\n>')).toHaveLength(1)
    expect(primitiveViolations('x.tsx', '<span title="Presença">')).toHaveLength(0)
    expect(primitiveViolations('x.tsx', '<button\n  // the page\'s one\n  className="a"\n>x</button><b title="y">')).toHaveLength(0)
    expect(primitiveViolations('components/ui/menu.tsx', 'role="menu"')).toHaveLength(0)
  })

  it('src uses tokens only (no raw palette classes, raw colors or arbitrary font sizes)', () => {
    const all = files(SRC).map((p) => violations(relative(SRC, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')))
    expect(all.flatMap((v) => v.out)).toEqual([])
    // Exceptions are reported in DESIGN_SYSTEM.md; growing this list needs review.
    expect(all.flatMap((v) => v.allowed).length).toBeLessThanOrEqual(2)
  })

  it('the stylesheet does not bring back the ring-offset focus pattern either', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    expect(css.split('\n').filter((l) => /ring-offset-(?:background|\d)/.test(l))).toEqual([])
  })

  it('fields show focus with their own border (field-focus), never an outer outline', () => {
    // One boundary per element: an outline around a bordered field reads as a double border.
    for (const f of ['components/ui/input.tsx', 'components/ui/textarea.tsx', 'components/ui/select.tsx']) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect([f, text.includes('field-focus')]).toEqual([f, true])
      expect([f, /focus(?:-visible)?:(?:outline|ring)-/.test(text)]).toEqual([f, false])
    }
  })

  it('catches the patterns it is meant to catch', () => {
    const bad = [
      'className="text-green-500"', 'className="dark:hover:bg-amber-400/10"', "'border-red-700/70'",
      'className="bg-[#fff]"', "style={{ color: '#f97316' }}", "style={{ background: 'rgba(0,0,0,.5)' }}",
      'className="text-[13px]"', 'className="text-[0.8rem]"', 'className="md:text-[length:12px]"',
      'className="ring-offset-background"', 'className="focus-visible:ring-offset-2"',
      'className="text-lg"', 'className="md:text-base"', 'className="shadow-md"', 'className="bg-black/80"',
      'className="rounded-2xl"', 'className="duration-200"', 'className="ease-out"',
    ]
    for (const line of bad) expect(violations('x.tsx', line).out).toHaveLength(1)
    const ok = [
      'className="text-brand-buy-fg bg-brand-sell/10"', 'className="text-body-sm"', "style={{ color: 'rgb(var(--color-text))' }}",
      '// Issue #303 - see PR #651', 'className="w-[13px]"', 'className="text-[length:var(--t-control)]"',
      'className="focus-visible:-outline-offset-2 outline-brand-focus"',
      'className="text-headline money-lg shadow-elevation-2 bg-scrim rounded-xl duration-medium ease-standard"',
      'className="text-brand-text-secondary text-field"',
    ]
    for (const line of ok) expect(violations('x.tsx', line).out).toHaveLength(0)
    expect(violations('x.tsx', 'className="text-red-500" // ds-allow: third-party mark').allowed).toHaveLength(1)
    expect(violations('lib/identityAvatar.ts', "const FG = ['#F97316']").out).toHaveLength(0)
  })
})
