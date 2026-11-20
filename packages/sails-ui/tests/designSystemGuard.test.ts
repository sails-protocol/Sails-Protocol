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

describe('design system guard', () => {
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
    ]
    for (const line of bad) expect(violations('x.tsx', line).out).toHaveLength(1)
    const ok = [
      'className="text-brand-buy-fg bg-brand-sell/10"', 'className="text-body-sm"', "style={{ color: 'rgb(var(--color-text))' }}",
      '// Issue #303 - see PR #651', 'className="w-[13px]"', 'className="text-[length:var(--t-control)]"',
      'className="focus-visible:-outline-offset-2 outline-brand-focus"',
    ]
    for (const line of ok) expect(violations('x.tsx', line).out).toHaveLength(0)
    expect(violations('x.tsx', 'className="text-red-500" // ds-allow: third-party mark').allowed).toHaveLength(1)
    expect(violations('lib/identityAvatar.ts', "const FG = ['#F97316']").out).toHaveLength(0)
  })
})
