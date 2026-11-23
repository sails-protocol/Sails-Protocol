import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { cn } from '../../lib/utils'

/** Fixed categorical slots (index.css --color-chart-N): colour follows the entity, never its rank. */
export type SeriesSlot = 1 | 2 | 3
export const seriesColor = (slot: SeriesSlot) => `rgb(var(--color-chart-${slot}))`

export interface ChartSeries {
  key: string
  name: string
  slot: SeriesSlot
  /** One value per bucket, same length as `labels`. */
  values: readonly number[]
}

export interface LineAreaChartCopy {
  /** Accessible name of the focusable plot ("Explore com as setas"). */
  explore: string
  showTable: string
  hideTable: string
  /** Header of the bucket column in the table ("Período"). */
  bucketHeader: string
  /** Name of the legend list. */
  legend: string
}

const M = { top: 12, right: 64, bottom: 26, left: 56 }
const H = 220

/** A round step for about four gridlines (1, 2, 2.5 or 5 x 10^n). */
function niceStep(max: number): number {
  if (max <= 0) return 1
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p
}

/**
 * Layer A: volume over time, one line (2 px) with a 10 % wash per series, on one value axis (never two). Legend
 * above for two or more series, direct labels at the line ends (leader lines when they would collide), a crosshair
 * tooltip on hover and on keyboard focus (arrows, Home, End) that lists every series at that bucket, `role="img"` with
 * a summary, and "Ver tabela" with the same numbers. Hand-built SVG, colours from tokens only.
 */
export function LineAreaChart({ labels, series, formatValue, formatTick, summary, copy, className }: {
  labels: readonly string[]
  series: readonly ChartSeries[]
  formatValue: (n: number) => string
  formatTick: (n: number) => string
  /** One-sentence description for screen readers (caller copy, with the key numbers). */
  summary: string
  copy: LineAreaChartCopy
  className?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [active, setActive] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const id = useId()

  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = labels.length
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = H - M.top - M.bottom
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  const step = niceStep(max)
  const yMax = Math.max(step, Math.ceil(max / step) * step)
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step)
  const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1))
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH
  // Bucket labels: as many as fit (about one per 96 px), the last one always; a tick too close to it gives way.
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 96))))
  const xTicks = labels.map((_, i) => i).filter((i) => i % every === 0 && n - 1 - i >= every)
  if (n > 0) xTicks.push(n - 1)

  // End labels: sorted by height, pushed apart to 16 px; a leader line joins a moved label to its line end.
  const ends = useMemo(() => {
    const list = series.map((s) => ({ s, y0: y(s.values[n - 1] ?? 0), y: y(s.values[n - 1] ?? 0) })).sort((a, b) => a.y0 - b.y0)
    for (let i = 1; i < list.length; i++) if (list[i].y - list[i - 1].y < 16) list[i].y = list[i - 1].y + 16
    const over = list.length ? list[list.length - 1].y - (M.top + plotH) : 0
    if (over > 0) for (const e of list) e.y -= over
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, n, yMax, plotH])

  const pick = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect || n === 0) return
    const px = clientX - rect.left
    setActive(n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((px - M.left) / plotW) * (n - 1)))))
  }
  const onKey = (e: KeyboardEvent) => {
    const cur = active ?? n - 1
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'Escape' ? null : undefined
    if (next === undefined) return
    e.preventDefault()
    setActive(next === null ? null : Math.min(n - 1, Math.max(0, next)))
  }
  const tipLeft = active === null ? 0 : Math.min(Math.max(x(active) - 96, 0), Math.max(0, width - 200))
  const readout = active === null ? '' : `${labels[active]}: ${series.map((s) => `${s.name} ${formatValue(s.values[active] ?? 0)}`).join(', ')}`

  return (
    <figure className={cn('min-w-0', className)}>
      {series.length >= 2 && (
        <ul aria-label={copy.legend} className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-caption text-brand-text-secondary">
              <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: seriesColor(s.slot) }} />{s.name}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={wrap}
        role="group"
        aria-label={copy.explore}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
        onPointerMove={(e: PointerEvent) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        className="relative rounded-sm touch-pan-y"
      >
        <svg role="img" aria-label={summary} width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="block max-w-full overflow-visible">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} stroke="rgb(var(--color-border-subtle))" strokeWidth={1} />
              <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-brand-text-muted text-caption tabular-nums">{formatTick(v)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor={n > 1 && i === n - 1 ? 'end' : n > 1 && i === 0 ? 'start' : 'middle'} className="fill-brand-text-muted text-caption">{labels[i]}</text>
          ))}
          {series.map((s) => {
            const pts = s.values.map((v, i) => `${x(i)},${y(v)}`)
            return (
              <g key={s.key}>
                {n > 1 && <path d={`M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`} fill={seriesColor(s.slot)} fillOpacity={0.1} />}
                {n > 1 && <path d={`M${pts.join(' L')}`} fill="none" stroke={seriesColor(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                <circle cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r={4} fill={seriesColor(s.slot)} stroke="rgb(var(--color-surface))" strokeWidth={2} />
              </g>
            )
          })}
          {ends.map((e) => (
            <g key={e.s.key}>
              {Math.abs(e.y - e.y0) > 2 && <line x1={x(n - 1) + 5} y1={e.y0} x2={x(n - 1) + 10} y2={e.y} stroke="rgb(var(--color-border))" strokeWidth={1} />}
              <text x={x(n - 1) + 12} y={e.y} dy="0.32em" className="fill-brand-text-secondary text-caption">{e.s.name}</text>
            </g>
          ))}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={M.top} y2={M.top + plotH} stroke="rgb(var(--color-border))" strokeWidth={1} />
              {series.map((s) => <circle key={s.key} cx={x(active)} cy={y(s.values[active] ?? 0)} r={4} fill={seriesColor(s.slot)} stroke="rgb(var(--color-surface))" strokeWidth={2} />)}
            </g>
          )}
        </svg>
        {active !== null && (
          <div aria-hidden="true" className="pointer-events-none absolute top-0 z-10 w-48 rounded-md bg-popover p-2 shadow-elevation-2" style={{ left: tipLeft }}>
            <p className="text-caption text-brand-text-muted">{labels[active]}</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(s.slot) }} />
                  <span className="text-body-sm font-semibold tabular-nums text-brand-text">{formatValue(s.values[active] ?? 0)}</span>
                  <span className="min-w-0 break-words text-caption text-brand-text-secondary">{s.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="sr-only" aria-live="polite">{readout}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" aria-expanded={tableOpen} aria-controls={`${id}-table`} onClick={() => setTableOpen((o) => !o)} className="mt-2 -ml-2 touch:min-h-11">
        {tableOpen ? copy.hideTable : copy.showTable}
        <ChevronDown aria-hidden="true" className={cn('size-icon-sm transition-transform duration-short', tableOpen && 'rotate-180')} />
      </Button>
      <div id={`${id}-table`} hidden={!tableOpen} className="mt-1">
        <Table>
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead>{copy.bucketHeader}</TableHead>
              {series.map((s) => <TableHead key={s.key} numeric>{s.name}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {labels.map((l, i) => (
              <TableRow key={`${l}-${i}`}>
                <TableCell className="text-body-sm text-brand-text-secondary">{l}</TableCell>
                {series.map((s) => <TableCell key={s.key} numeric className="text-body-sm text-brand-text">{formatValue(s.values[i] ?? 0)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </figure>
  )
}
