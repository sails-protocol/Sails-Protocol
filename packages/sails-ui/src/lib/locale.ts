import { useSyncExternalStore } from 'react'

/**
 * Interface language preference (DESIGN_SYSTEM.md 5.4). Lot A stores the choice only: the copy is
 * pt-BR everywhere until the i18n layer of lot B reads `sails_ui_locale` (LOOSE_WIRES.language).
 * 'system' = follow the browser language once translations exist.
 */
export const LOCALES = ['system', 'pt-BR', 'en', 'es', 'fr', 'de'] as const
export type LocalePreference = (typeof LOCALES)[number]
export const LOCALE_STORAGE_KEY = 'sails_ui_locale'
export const DEFAULT_LOCALE: LocalePreference = 'system'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function readLocale(store: Store | undefined): LocalePreference {
  try {
    const v = store?.getItem(LOCALE_STORAGE_KEY) ?? ''
    return (LOCALES as readonly string[]).includes(v) ? (v as LocalePreference) : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function saveLocale(store: Store | undefined, locale: LocalePreference): boolean {
  try {
    store?.setItem(LOCALE_STORAGE_KEY, locale)
    return !!store
  } catch {
    return false
  }
}

/** True when the choice needs a translation that does not exist yet (only pt-BR copy ships today). */
export function translationPending(locale: LocalePreference, browserLanguage?: string): boolean {
  const effective = locale === 'system' ? browserLanguage ?? 'pt-BR' : locale
  return !/^pt(-BR)?$/i.test(effective)
}

const browserStore = (): Store | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

let current: LocalePreference | null = null
const listeners = new Set<() => void>()
const get = () => (current ??= readLocale(browserStore()))
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function useLocalePreference(): [LocalePreference, (locale: LocalePreference) => void] {
  const set = (locale: LocalePreference) => {
    current = locale
    saveLocale(browserStore(), locale)
    listeners.forEach((l) => l())
  }
  return [useSyncExternalStore(subscribe, get, get), set]
}
