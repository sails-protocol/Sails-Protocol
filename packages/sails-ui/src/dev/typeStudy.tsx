/**
 * DEV-ONLY typography study switcher (main.tsx imports it behind
 * import.meta.env.DEV). Opt in with ?type=current|inter|geist|plex
 * (optional &mono=system|geist-mono|plex-mono, &scale=0|1); the choice
 * persists in sessionStorage so in-app navigation keeps it.
 */
import ReactDOM from 'react-dom/client'
import { useState } from 'react'
import './typeStudy.css'

const KEY = 'sails.typeStudy'
const FONTS = ['current', 'inter', 'geist', 'plex'] as const
const MONOS = ['system', 'geist-mono', 'plex-mono'] as const
type State = { type: string; mono: string; scale: boolean }

// Study only: production must self-host (no third-party font requests).
const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist:wght@400;500;600;700' +
  '&family=IBM+Plex+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap'

function apply(s: State) {
  const el = document.documentElement
  const set = (k: string, v: string | null) => (v ? el.setAttribute(k, v) : el.removeAttribute(k))
  set('data-type-candidate', s.type === 'current' ? null : s.type)
  set('data-type-mono', s.mono === 'system' ? null : s.mono)
  set('data-type-scale', s.scale ? 'proposed' : null)
  try { sessionStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode: no persistence */ }
}

function initialState(): State | null {
  const q = new URLSearchParams(window.location.search)
  const type = q.get('type')
  if (type && (FONTS as readonly string[]).includes(type)) {
    const mono = q.get('mono') ?? 'system'
    return {
      type,
      mono: (MONOS as readonly string[]).includes(mono) ? mono : 'system',
      scale: q.has('scale') ? q.get('scale') === '1' : type !== 'current',
    }
  }
  try {
    const saved = sessionStorage.getItem(KEY)
    return saved ? (JSON.parse(saved) as State) : null
  } catch { return null }
}

function Switcher({ start }: { start: State }) {
  const [s, setS] = useState(start)
  const update = (next: State) => { setS(next); apply(next) }
  const box = 'bg-brand-elevated text-brand-text border border-brand-border rounded px-1 py-0.5'
  return (
    <div
      data-type-study
      style={{ position: 'fixed', left: 8, bottom: 8, zIndex: 2147483000, fontFamily: 'system-ui, sans-serif', fontSize: 12 }}
      className="flex flex-wrap items-center gap-2 rounded-md border border-brand-border bg-brand-surface/95 p-2 text-brand-text shadow-lg"
    >
      <label className="flex items-center gap-1">Font
        <select className={box} value={s.type} aria-label="Typography candidate"
          onChange={(e) => update({ ...s, type: e.target.value, scale: e.target.value !== 'current' })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">Mono
        <select className={box} value={s.mono} aria-label="Monospace candidate"
          onChange={(e) => update({ ...s, mono: e.target.value })}>
          {MONOS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={s.scale} onChange={(e) => update({ ...s, scale: e.target.checked })} />
        Proposed scale
      </label>
    </div>
  )
}

export function installTypeStudyIfRequested() {
  const start = initialState()
  if (!start) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = GOOGLE_FONTS
  document.head.appendChild(link)
  apply(start)
  const host = document.createElement('div')
  document.body.appendChild(host)
  ReactDOM.createRoot(host).render(<Switcher start={start} />)
}
