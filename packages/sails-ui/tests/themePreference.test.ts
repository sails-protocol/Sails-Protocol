import { readThemePreference, resolveTheme, saveThemePreference, THEME_STORAGE_KEY } from '../src/lib/themePreference'
import { LOCALE_STORAGE_KEY, readLocale, saveLocale, translationPending } from '../src/lib/locale'

const memoryStore = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => { data[k] = v } }
}
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('theme preference', () => {
  it('resolves system against the OS setting and keeps fixed choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
  it('carries over the value saved by the old dark/light toggle', () => {
    expect(readThemePreference(memoryStore({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
    expect(readThemePreference(memoryStore({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
  })
  it('returns null (the caller then uses the dark default) for nothing, junk or blocked storage', () => {
    expect(readThemePreference(memoryStore())).toBeNull()
    expect(readThemePreference(memoryStore({ [THEME_STORAGE_KEY]: 'sepia' }))).toBeNull()
    expect(readThemePreference(throwing)).toBeNull()
    expect(readThemePreference(undefined)).toBeNull()
  })
  it('persists system and reports a refused write', () => {
    const store = memoryStore()
    expect(saveThemePreference(store, 'system')).toBe(true)
    expect(readThemePreference(store)).toBe('system')
    expect(saveThemePreference(throwing, 'light')).toBe(false)
  })
})

describe('locale preference (stored only; translations are lot B)', () => {
  it('defaults to system and reads a stored language under sails_ui_locale', () => {
    expect(LOCALE_STORAGE_KEY).toBe('sails_ui_locale')
    expect(readLocale(memoryStore())).toBe('system')
    const store = memoryStore()
    saveLocale(store, 'es')
    expect(readLocale(store)).toBe('es')
    expect(readLocale(memoryStore({ [LOCALE_STORAGE_KEY]: 'klingon' }))).toBe('system')
    expect(readLocale(throwing)).toBe('system')
  })
  it('flags a pending translation for anything but Portuguese', () => {
    expect(translationPending('pt-BR')).toBe(false)
    expect(translationPending('en')).toBe(true)
    expect(translationPending('system', 'pt-BR')).toBe(false)
    expect(translationPending('system', 'de-DE')).toBe(true)
    expect(translationPending('system', undefined)).toBe(false)
  })
})
