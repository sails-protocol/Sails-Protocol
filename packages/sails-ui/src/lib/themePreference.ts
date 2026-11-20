/**
 * Appearance preference (DESIGN_SYSTEM.md 5.4): follow the system, or a fixed dark/light theme.
 * Stored per viewer in localStorage under the key the old dark/light toggle used, so a value saved
 * by the old toggle ('dark' | 'light') is already a valid explicit choice and carries over as is.
 * Default stays dark (dark-first identity) until the Design System Architect decides otherwise.
 */
export type Theme = 'light' | 'dark'
export type ThemePreference = 'system' | Theme

export const THEME_STORAGE_KEY = 'sails_ui_theme'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'
const PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light']

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Stored preference, or null when nothing valid is stored or storage is unavailable. */
export function readThemePreference(store: Store | undefined): ThemePreference | null {
  try {
    const v = store?.getItem(THEME_STORAGE_KEY) ?? ''
    return (PREFERENCES as readonly string[]).includes(v) ? (v as ThemePreference) : null
  } catch {
    return null
  }
}

/** Persists the preference; false when storage refused it (the choice then lasts this page load only). */
export function saveThemePreference(store: Store | undefined, preference: ThemePreference): boolean {
  try {
    store?.setItem(THEME_STORAGE_KEY, preference)
    return !!store
  } catch {
    return false
  }
}

/** The theme to show for a preference, given whether the system currently asks for dark. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}
