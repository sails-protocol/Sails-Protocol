import { useSyncExternalStore } from 'react'
import type { IdentityAvatarStyle } from './identityAvatar'
import { AVATAR_STYLES } from './avatarStyle'

/**
 * The signed-in person's own avatar pick from the deck (Perfil): one of AVATAR_VARIANTS variants per style,
 * all drawn from their own public key. Variant 0 is exactly the default avatar (seed = the key). Stored per
 * public key in this browser only (best effort): counterparties keep seeing the avatar generated from the key
 * until the node stores a public avatar (LOOSE_WIRES.publicAvatar). Applies only to the owner's own avatar;
 * everyone else's avatars keep the viewer's style preference (avatarStyle.ts).
 */
export interface AvatarChoice {
  style: IdentityAvatarStyle
  variant: number
}

export const AVATAR_VARIANTS = 8
export const AVATAR_CHOICE_STORAGE_PREFIX = 'sails_ui_avatar_choice:'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Seed of a deck variant: variant 0 is the key itself (today's avatar), the others `${key}:${n}`. */
export function seedFor(publicKey: string, variant: number): string {
  return variant === 0 ? publicKey : `${publicKey}:${variant}`
}

function isChoice(v: unknown): v is AvatarChoice {
  const c = v as AvatarChoice
  return !!c && (AVATAR_STYLES as readonly unknown[]).includes(c.style) && Number.isInteger(c.variant) && c.variant >= 0 && c.variant < AVATAR_VARIANTS
}

/** Stored pick for this key, or null when nothing valid is stored or storage is unavailable. */
export function readAvatarChoice(store: Store | undefined, publicKey: string): AvatarChoice | null {
  try {
    const raw = store?.getItem(AVATAR_CHOICE_STORAGE_PREFIX + publicKey)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isChoice(parsed) ? { style: parsed.style, variant: parsed.variant } : null
  } catch {
    return null
  }
}

/** Persists the pick; returns false when storage refused it (the pick then lasts this session only). */
export function saveAvatarChoice(store: Store | undefined, publicKey: string, choice: AvatarChoice): boolean {
  try {
    store?.setItem(AVATAR_CHOICE_STORAGE_PREFIX + publicKey, JSON.stringify(choice))
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

export interface OwnAvatar {
  publicKey: string
  choice: AvatarChoice | null
}

let own: OwnAvatar | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Called by AuthContext whenever the signed-in key changes (null on sign-out). */
export function setAvatarChoiceOwner(publicKey: string | null) {
  if ((own?.publicKey ?? null) === publicKey) return
  own = publicKey ? { publicKey, choice: readAvatarChoice(browserStore(), publicKey) } : null
  emit()
}

/** Saves the owner's pick and re-renders every avatar showing their key. */
export function setOwnAvatarChoice(choice: AvatarChoice) {
  if (!own) return
  own = { publicKey: own.publicKey, choice }
  saveAvatarChoice(browserStore(), own.publicKey, choice)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const getOwn = () => own

/** The signed-in key and its pick (null signed out). */
export function useOwnAvatar(): OwnAvatar | null {
  return useSyncExternalStore(subscribe, getOwn, getOwn)
}
