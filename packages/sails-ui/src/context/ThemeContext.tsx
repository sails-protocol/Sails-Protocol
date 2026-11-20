import React, { createContext, useContext, useEffect, useState } from 'react'
import { DEFAULT_THEME_PREFERENCE, readThemePreference, resolveTheme, saveThemePreference, type Theme, type ThemePreference } from '../lib/themePreference'

interface ThemeContextType {
  /** The theme actually shown (the preference resolved against the system setting). */
  theme: Theme
  /** What the viewer chose: follow the system, or a fixed theme. */
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)
const DARK_QUERY = '(prefers-color-scheme: dark)'

function browserStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return true // no matchMedia: keep the dark-first identity
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark)
  // Lazy initializer applies the class synchronously on first render (no flash, no effect-ordering
  // race: the same lesson AuthContext's own doc comment records).
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const initial = readThemePreference(browserStore()) ?? DEFAULT_THEME_PREFERENCE
    applyTheme(resolveTheme(initial, systemPrefersDark()))
    return initial
  })
  const theme = resolveTheme(preference, systemDark)

  useEffect(() => { applyTheme(theme) }, [theme])

  // Follow the OS setting live while the preference is "system".
  useEffect(() => {
    if (preference !== 'system') return
    let mql: MediaQueryList
    try { mql = window.matchMedia(DARK_QUERY) } catch { return }
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    setSystemDark(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next)
    saveThemePreference(browserStore(), next)
  }

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
