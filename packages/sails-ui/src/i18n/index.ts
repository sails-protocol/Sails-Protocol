import { getLocale, useLocale, type Locale } from '../lib/locale'
import { CATALOGS, type MessageKey } from './catalog'
import type { Message } from './define'

export type { MessageKey } from './catalog'
export { getLocale, useLocale } from '../lib/locale'

export type Vars = Record<string, string | number>

const pluralRules = new Map<Locale, Intl.PluralRules>()
const rulesFor = (l: Locale) => pluralRules.get(l) ?? pluralRules.set(l, new Intl.PluralRules(l)).get(l)!

/** Formats one message: `{name}` placeholders, numbers in the locale's style (pass ids and years as strings), plural form from `count`. */
export function formatMessage(locale: Locale, msg: Message, vars?: Vars): string {
  const n = Number(vars?.count ?? 0)
  // CLDR puts pt 0 in "one"; the pt-BR copy has always said "0 trades", so 0 takes the plural form there.
  const category = locale === 'pt-BR' && n === 0 ? 'other' : rulesFor(locale).select(n)
  const text = typeof msg === 'string' ? msg : msg[category] ?? msg.other
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k]
    return v === undefined ? m : typeof v === 'number' ? v.toLocaleString(locale) : v
  })
}

/** Translates a key in the current interface language (falls back to pt-BR, the source catalog). */
export function t(key: MessageKey, vars?: Vars): string {
  const locale = getLocale()
  return formatMessage(locale, CATALOGS[locale][key] ?? CATALOGS['pt-BR'][key] ?? key, vars)
}

/** Same as `t`, and re-renders the component when the language changes. */
export function useT(): typeof t {
  useLocale()
  return t
}
