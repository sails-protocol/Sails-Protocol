/**
 * Desktop width of the trade's right column (counterparty + chat), set by dragging its divider
 * (DECISIONS.md "Chat do trade", 2026-11-21). Desktop only (lg, 1024 px+); the stage column on the
 * left never gets narrower than MIN_STAGE (at 1024 px that still leaves the aside about 370 px, above the old fixed 360). Stored per viewer in localStorage, best effort.
 */
export const ASIDE_MIN = 320
export const ASIDE_MAX = 640
export const ASIDE_DEFAULT = 400
export const MIN_STAGE = 520
export const ASIDE_STEP = 16
export const ASIDE_WIDTH_STORAGE_KEY = 'sails_ui_trade_aside_width'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Largest width the aside may take in a grid this wide (gap included), never below ASIDE_MIN. */
export function asideMax(gridWidth: number, gap = 16): number {
  return Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, Math.floor(gridWidth - gap - MIN_STAGE)))
}

export function clampAside(width: number, gridWidth: number, gap = 16): number {
  if (!Number.isFinite(width)) return Math.min(ASIDE_DEFAULT, asideMax(gridWidth, gap))
  return Math.round(Math.min(asideMax(gridWidth, gap), Math.max(ASIDE_MIN, width)))
}

export function readAsideWidth(store: Store | undefined): number {
  try {
    const v = Number(store?.getItem(ASIDE_WIDTH_STORAGE_KEY))
    return v >= ASIDE_MIN && v <= ASIDE_MAX ? v : ASIDE_DEFAULT
  } catch {
    return ASIDE_DEFAULT
  }
}

export function saveAsideWidth(store: Store | undefined, width: number): boolean {
  try {
    store?.setItem(ASIDE_WIDTH_STORAGE_KEY, String(Math.round(width)))
    return !!store
  } catch {
    return false
  }
}
