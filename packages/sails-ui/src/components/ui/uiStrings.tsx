import { createContext, useContext, type ReactNode } from 'react'

/**
 * Copy the Layer A primitives render on their own (close buttons, copy feedback). Layer A never imports
 * the app dictionary: the host passes these strings (Sails Market fills them from src/i18n/uiStrings.ts,
 * a white-label partner from its own catalog). Defaults are the pt-BR source copy.
 */
export interface UiStrings {
  close: string
  cancel: string
  copy: string
  copied: string
  copyFailed: string
  notifications: string
  /** InfoTooltip's "i" button. */
  moreInfo: string
  /** FavoriteButton's name (the state is aria-pressed). */
  favoriteSeller: string
  /** UserAvatar presence dot titles. */
  presenceUnknown: string
  presenceOnline: string
  presenceOffline: string
}

export const DEFAULT_UI_STRINGS: UiStrings = {
  close: 'Fechar',
  cancel: 'Cancelar',
  copy: 'Copiar',
  copied: 'Copiado!',
  copyFailed: 'Não foi possível copiar',
  notifications: 'Notificações',
  moreInfo: 'Mais informações',
  favoriteSeller: 'Favoritar este vendedor',
  presenceUnknown: 'Presença ainda não observada nesta sessão',
  presenceOnline: 'Online agora — visto na sala de chat deste trade',
  presenceOffline: 'Offline — saiu da sala de chat deste trade',
}

const UiStringsContext = createContext<UiStrings>(DEFAULT_UI_STRINGS)

export function UiStringsProvider({ value, children }: { value: UiStrings; children: ReactNode }) {
  return <UiStringsContext.Provider value={value}>{children}</UiStringsContext.Provider>
}

export const useUiStrings = () => useContext(UiStringsContext)
