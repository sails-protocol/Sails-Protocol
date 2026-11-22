import { useSyncExternalStore } from 'react'

/**
 * Desktop menu position (DECISIONS.md "Posição do menu no desktop"): the side menu (default, with
 * today's collapse/expand) or a top bar. Applies from 1024 px only; below that the layout is the same
 * for both, and the phone bottom nav never changes. Stored per viewer in localStorage, best effort.
 */
export type NavPosition = 'side' | 'top'
export const NAV_POSITIONS: readonly NavPosition[] = ['side', 'top']
export const DEFAULT_NAV_POSITION: NavPosition = 'side'
export const NAV_POSITION_STORAGE_KEY = 'sails_ui_nav_position'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Stored position, or the default when nothing valid is stored or storage is unavailable. */
export function readNavPosition(store: Store | undefined): NavPosition {
  try {
    const v = store?.getItem(NAV_POSITION_STORAGE_KEY)
    return (NAV_POSITIONS as readonly string[]).includes(v ?? '') ? (v as NavPosition) : DEFAULT_NAV_POSITION
  } catch {
    return DEFAULT_NAV_POSITION
  }
}

/** Persists the position; false when storage refused it (the choice then lasts this page load only). */
export function saveNavPosition(store: Store | undefined, position: NavPosition): boolean {
  try {
    store?.setItem(NAV_POSITION_STORAGE_KEY, position)
    return !!store
  } catch {
    return false
  }
}

const browserStore = (): Store | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

let current: NavPosition | null = null
const listeners = new Set<() => void>()

function getPosition(): NavPosition {
  if (current === null) current = readNavPosition(browserStore())
  return current
}

function setNavPosition(position: NavPosition) {
  current = position
  saveNavPosition(browserStore(), position)
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current position plus a setter; the layout re-renders immediately on change. */
export function useNavPosition(): [NavPosition, (position: NavPosition) => void] {
  return [useSyncExternalStore(subscribe, getPosition, getPosition), setNavPosition]
}
