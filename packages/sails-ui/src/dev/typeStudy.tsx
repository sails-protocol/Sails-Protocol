/**
 * DEV-ONLY typography study switcher (main.tsx imports it behind
 * import.meta.env.DEV). Opt in with ?type=current|inter|geist|plex|legacy
 * (optional &mono=plex-mono|system|geist-mono); the choice persists in
 * sessionStorage so in-app navigation keeps it. "current" = the app
 * default (Inter + IBM Plex Mono); the responsive scale is now the
 * default for every candidate, so there is no scale toggle any more.
 */
import ReactDOM from 'react-dom/client'
import { useState } from 'react'
import './typeStudy.css'

const KEY = 'sails.typeStudy'
const FONTS = ['current', 'inter', 'geist', 'plex', 'legacy'] as const
const MONOS = ['plex-mono', 'system', 'geist-mono'] as const
type State = { type: string; mono: string }

// Study only: production must self-host (no third-party font requests).
const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Space+Grotesk:wght@500;700' +
  '&family=IBM+Plex+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap'

function apply(s: State) {
  const el = document.documentElement
  const set = (k: string, v: string | null) => (v ? el.setAttribute(k, v) : el.removeAttribute(k))
  set('data-type-candidate', s.type === 'current' ? null : s.type)
  set('data-type-mono', s.mono === 'plex-mono' ? null : s.mono)
  try { sessionStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode: no persistence */ }
}

function initialState(): State | null {
  const q = new URLSearchParams(window.location.search)
  const type = q.get('type')
  if (type && (FONTS as readonly string[]).includes(type)) {
    const mono = q.get('mono') ?? 'plex-mono'
    return { type, mono: (MONOS as readonly string[]).includes(mono) ? mono : 'plex-mono' }
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
          onChange={(e) => update({ ...s, type: e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">Mono
        <select className={box} value={s.mono} aria-label="Monospace candidate"
          onChange={(e) => update({ ...s, mono: e.target.value })}>
          {MONOS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
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
