import { useSyncExternalStore } from 'react'

/**
 * Interface language (DESIGN_SYSTEM.md 5.4 and 7.3). The preference is stored under `sails_ui_locale`;
 * 'system' follows `navigator.languages`, matched to the five shipped catalogs, falling back to pt-BR.
 */
export const LOCALES = ['system', 'pt-BR', 'en', 'es', 'fr', 'de'] as const
export type LocalePreference = (typeof LOCALES)[number]
/** A language with a catalog (src/i18n). */
export type Locale = Exclude<LocalePreference, 'system'>
export const LOCALE_STORAGE_KEY = 'sails_ui_locale'
export const DEFAULT_LOCALE: LocalePreference = 'system'
export const FALLBACK_LOCALE: Locale = 'pt-BR'

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

/** First browser language that matches a catalog by primary subtag (pt-PT -> pt-BR, de-AT -> de); pt-BR otherwise. */
export function matchLanguages(languages: readonly string[] | undefined): Locale {
  for (const tag of languages ?? []) {
    const primary = tag.toLowerCase().split('-')[0]
    if (primary === 'pt') return 'pt-BR'
    if (primary === 'en' || primary === 'es' || primary === 'fr' || primary === 'de') return primary
  }
  return FALLBACK_LOCALE
}

export function resolveLocale(preference: LocalePreference, languages?: readonly string[]): Locale {
  return preference === 'system' ? matchLanguages(languages) : preference
}

const hasWindow = () => typeof window !== 'undefined'

const browserStore = (): Store | undefined => {
  try {
    return hasWindow() ? window.localStorage : undefined
  } catch {
    return undefined
  }
}

// No window (tests, SSR): 'system' resolves to pt-BR, so the source catalog is the default everywhere.
const browserLanguages = (): readonly string[] | undefined =>
  hasWindow() && typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : undefined

let current: LocalePreference | null = null
let resolved: Locale | null = null
const listeners = new Set<() => void>()
const getPreference = () => (current ??= readLocale(browserStore()))
const notify = () => { resolved = null; listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
if (hasWindow()) window.addEventListener('languagechange', notify)

/** The language the interface renders in right now. */
export function getLocale(): Locale {
  return (resolved ??= resolveLocale(getPreference(), browserLanguages()))
}

export function setLocalePreference(locale: LocalePreference): void {
  current = locale
  saveLocale(browserStore(), locale)
  notify()
}

export function useLocalePreference(): [LocalePreference, (locale: LocalePreference) => void] {
  return [useSyncExternalStore(subscribe, getPreference, getPreference), setLocalePreference]
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}
