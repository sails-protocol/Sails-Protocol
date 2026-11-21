import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { ASIDE_DEFAULT, ASIDE_MIN, ASIDE_STEP, asideMax, clampAside, readAsideWidth, saveAsideWidth } from '../../lib/tradeAsideWidth'
import { t } from '../../i18n'

const store = () => { try { return window.localStorage } catch { return undefined } }

/**
 * Width of the trade's right column, owned by the grid that holds it. Returns the CSS variable for the
 * grid and the props of the divider. The width is re-clamped when the grid itself resizes.
 */
export function useTradeAsideWidth() {
  // Callback ref: the grid mounts only after the trade loads, so a plain ref would miss it.
  const [grid, gridRef] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(() => readAsideWidth(store()))
  const [gridWidth, setGridWidth] = useState(0)

  useEffect(() => {
    if (!grid || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setGridWidth(e.contentRect.width))
    ro.observe(grid)
    return () => ro.disconnect()
  }, [grid])

  const shown = gridWidth ? clampAside(width, gridWidth) : width
  const set = (w: number) => { const c = clampAside(w, gridWidth || 1e4); setWidth(c); saveAsideWidth(store(), c) }
  return { gridRef, style: { '--trade-aside-w': `${shown}px` } as CSSProperties, width: shown, max: gridWidth ? asideMax(gridWidth) : shown, set }
}

/**
 * Vertical divider in the gap left of the aside (desktop only). Drag, arrow keys (16 px), Home/End,
 * double-click or Enter to reset. A WAI-ARIA window splitter: focusable separator with its value.
 */
export function AsideResizer({ width, max, onChange, controls }: { width: number; max: number; onChange: (w: number) => void; controls: string }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width }
    setDragging(true)
  }
  // The aside grows as the divider moves left.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (drag.current) onChange(drag.current.w + drag.current.x - e.clientX) }
  const onPointerUp = () => { drag.current = null; setDragging(false) }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: width + ASIDE_STEP, ArrowRight: width - ASIDE_STEP, Home: max, End: ASIDE_MIN, Enter: ASIDE_DEFAULT }[e.key]
    if (next === undefined) return
    e.preventDefault()
    onChange(next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('trade.chat.resize')}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={ASIDE_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(ASIDE_DEFAULT)}
      onKeyDown={onKeyDown}
      data-dragging={dragging || undefined}
      className="group/resizer absolute -left-4 inset-y-0 hidden w-4 cursor-col-resize touch-none select-none justify-center rounded-sm lg:flex"
    >
      {/* Line appears on hover, focus and drag; the grip stays visible so the affordance is discoverable. */}
      <span aria-hidden="true" className="h-full w-0.5 rounded-full bg-transparent transition-colors duration-short ease-standard group-hover/resizer:bg-brand-border group-focus-visible/resizer:bg-primary group-data-[dragging]/resizer:bg-primary" />
      <span aria-hidden="true" className="absolute top-24 h-10 w-1 rounded-full bg-brand-text-muted/60 transition-colors duration-short ease-standard group-hover/resizer:bg-brand-text-muted group-focus-visible/resizer:bg-primary group-data-[dragging]/resizer:bg-primary" />
    </div>
  )
}
