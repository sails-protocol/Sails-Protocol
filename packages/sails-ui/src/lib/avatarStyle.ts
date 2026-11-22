import { useSyncExternalStore } from 'react'
import type { IdentityAvatarStyle } from './identityAvatar'

/**
 * Viewer display preference: which identity-avatar style THIS viewer sees for every avatar (their own and
 * counterparties'). Stored per viewer in localStorage, best effort. Nobody else sees this choice.
 */
export const AVATAR_STYLES: readonly IdentityAvatarStyle[] = ['vela', 'mare', 'grade']
export const DEFAULT_AVATAR_STYLE: IdentityAvatarStyle = 'vela'
export const AVATAR_STYLE_STORAGE_KEY = 'sails_ui_avatar_style'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Stored style, or the default when nothing valid is stored or storage is unavailable. */
export function readAvatarStyle(store: Store | undefined): IdentityAvatarStyle {
  try {
    const v = store?.getItem(AVATAR_STYLE_STORAGE_KEY)
    return (AVATAR_STYLES as readonly string[]).includes(v ?? '') ? (v as IdentityAvatarStyle) : DEFAULT_AVATAR_STYLE
  } catch {
    return DEFAULT_AVATAR_STYLE
  }
}

/** Persists the style; returns false when storage refused it (the choice then lasts this session only). */
export function saveAvatarStyle(store: Store | undefined, style: IdentityAvatarStyle): boolean {
  try {
    store?.setItem(AVATAR_STYLE_STORAGE_KEY, style)
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

let current: IdentityAvatarStyle | null = null
const listeners = new Set<() => void>()

function getStyle(): IdentityAvatarStyle {
  if (current === null) current = readAvatarStyle(browserStore())
  return current
}

export function setAvatarStyle(style: IdentityAvatarStyle) {
  current = style
  saveAvatarStyle(browserStore(), style)
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current style plus a setter; every avatar using it re-renders immediately on change. */
export function useAvatarStyle(): [IdentityAvatarStyle, (style: IdentityAvatarStyle) => void] {
  return [useSyncExternalStore(subscribe, getStyle, getStyle), setAvatarStyle]
}
