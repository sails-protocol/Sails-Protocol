/**
 * Interface translation (UX-028, DESIGN_SYSTEM.md 7.3): catalog parity, messages, locale resolution,
 * formatting per language and the native-review list.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { AREAS, CATALOGS, NEEDS_NATIVE_REVIEW, type MessageKey } from '../src/i18n/catalog'
import { REVIEW_AREAS, TRANSLATED_LOCALES, type Message } from '../src/i18n/define'
import { formatMessage, t } from '../src/i18n'
import { getLocale, matchLanguages, resolveLocale, setLocalePreference, type Locale } from '../src/lib/locale'
import { formatAmount, formatDateTime, formatMonthYear, formatUsd, formatUsdExact } from '../src/lib/format'
import { currencyLabel, formatPrice } from '../src/lib/currency'
import { countryLabel } from '../src/data/mock'

const nb = (s: string) => s.replace(/[  ]/g, ' ')
const placeholders = (m: Message) => [...new Set((typeof m === 'string' ? [m] : Object.values(m)).join(' ').match(/\{\w+\}/g) ?? [])].sort()
const PT = CATALOGS['pt-BR']
const KEYS = Object.keys(PT) as MessageKey[]

function inLocale<T>(locale: Locale, fn: () => T): T {
  setLocalePreference(locale)
  try {
    return fn()
  } finally {
    setLocalePreference('system')
  }
}

describe('catalogs', () => {
  it('every language has exactly the pt-BR keys', () => {
    for (const l of TRANSLATED_LOCALES) expect(Object.keys(CATALOGS[l]).sort()).toEqual([...KEYS].sort())
  })

  it('every key starts with its area name and no key is defined in two areas', () => {
    const seen = new Map<string, string>()
    for (const [area, def] of Object.entries(AREAS)) {
      for (const key of Object.keys(def.messages['pt-BR'])) {
        expect(`${area}:${key.split('.')[0]}`).toBe(`${area}:${area}`)
        expect(seen.get(key)).toBeUndefined()
        seen.set(key, area)
      }
    }
  })

  it('translations keep the same placeholders and never ship empty', () => {
    const bad: string[] = []
    for (const key of KEYS) {
      for (const l of TRANSLATED_LOCALES) {
        const m = CATALOGS[l][key]
        if (placeholders(m).join() !== placeholders(PT[key]).join()) bad.push(`${l} ${key}: ${placeholders(m)} vs ${placeholders(PT[key])}`)
        if ((typeof m === 'string' ? [m] : Object.values(m)).some((v) => !v?.trim())) bad.push(`${l} ${key}: empty`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('messages', () => {
  it('interpolates and formats numbers in the language', () => {
    expect(formatMessage('en', 'Hello {name}, {n} left', { name: 'Alice', n: 1234.5 })).toBe('Hello Alice, 1,234.5 left')
    expect(formatMessage('de', '{n}', { n: 1234.5 })).toBe('1.234,5')
    expect(formatMessage('pt-BR', 'Olá {name} {missing}', { name: 'Bob' })).toBe('Olá Bob {missing}')
  })

  it('picks the plural form with Intl.PluralRules', () => {
    const msg = { one: '{count} trade', other: '{count} trades' }
    expect(formatMessage('en', msg, { count: 1 })).toBe('1 trade')
    expect(formatMessage('en', msg, { count: 0 })).toBe('0 trades')
    expect(formatMessage('fr', msg, { count: 0 })).toBe('0 trade')
    expect(formatMessage('fr', msg, { count: 2 })).toBe('2 trades')
    // pt-BR copy has always used the plural for zero.
    expect(formatMessage('pt-BR', msg, { count: 0 })).toBe('0 trades')
    expect(formatMessage('pt-BR', msg, { count: 1 })).toBe('1 trade')
  })

  it('t() follows the chosen language and falls back to pt-BR by default', () => {
    expect(t('common.close')).toBe('Fechar')
    expect(inLocale('de', () => t('common.close'))).toBe('Schließen')
    expect(inLocale('fr', () => t('common.soon'))).toBe('Bientôt')
    expect(getLocale()).toBe('pt-BR')
  })
})

describe('locale resolution', () => {
  it('matches browser languages to the five catalogs by language, pt-BR otherwise', () => {
    expect(matchLanguages(['de-AT', 'en'])).toBe('de')
    expect(matchLanguages(['pt-PT'])).toBe('pt-BR')
    expect(matchLanguages(['ja-JP', 'fr-CA'])).toBe('fr')
    expect(matchLanguages(['ja-JP'])).toBe('pt-BR')
    expect(matchLanguages(undefined)).toBe('pt-BR')
  })

  it('an explicit choice wins over the system language', () => {
    expect(resolveLocale('es', ['de-DE'])).toBe('es')
    expect(resolveLocale('system', ['en-US'])).toBe('en')
  })
})

describe('formatting per language (USD stays the price unit)', () => {
  const rows: [Locale, string, string, string][] = [
    ['pt-BR', 'US$ 97.800,00', '0,0015', 'nov. de 2026'],
    ['en', '$97,800.00', '0.0015', 'Nov 2026'],
    ['es', '97.800,00 US$', '0,0015', 'nov 2026'],
    ['fr', '97 800,00 $US', '0,0015', 'nov. 2026'],
    ['de', '97.800,00 $', '0,0015', 'Nov. 2026'],
  ]
  it.each(rows)('%s', (locale, usd, btc, monthYear) => {
    inLocale(locale, () => {
      expect(nb(formatUsd(97800))).toBe(usd)
      expect(nb(formatPrice(97800, 'USD'))).toBe(usd)
      expect(nb(formatUsdExact('97800'))).toBe(usd)
      expect(formatAmount(0.0015)).toBe(btc)
      expect(formatMonthYear('2026-11-05T12:00:00Z')).toBe(monthYear)
    })
  })

  it('dates follow the language', () => {
    const now = new Date('2026-11-21T12:00:00')
    expect(inLocale('pt-BR', () => formatDateTime('2026-11-20T14:32:00', now))).toBe('20/11, 14:32')
    expect(inLocale('de', () => formatDateTime('2026-11-20T14:32:00', now))).toBe('20.11., 14:32')
    expect(nb(inLocale('en', () => formatDateTime('2026-11-20T14:32:00', now)))).toBe('11/20, 02:32 PM')
  })

  it('currency and country names: pt-BR labels as written, Intl elsewhere', () => {
    expect(currencyLabel('BRL')).toBe('Real Brasileiro')
    expect(inLocale('en', () => currencyLabel('BRL'))).toBe('Brazilian Real')
    expect(countryLabel('DE')).toBe('Alemanha')
    expect(inLocale('fr', () => countryLabel('DE'))).toBe('Allemagne')
  })
})

describe('native review gate', () => {
  it('lists only real keys, in known review areas, and covers every sensitive area', () => {
    for (const area of REVIEW_AREAS) {
      expect(NEEDS_NATIVE_REVIEW[area].length).toBeGreaterThan(0)
      for (const key of NEEDS_NATIVE_REVIEW[area]) expect(PT[key]).toBeDefined()
    }
    const sizes = Object.fromEntries(REVIEW_AREAS.map((a) => [a, new Set(NEEDS_NATIVE_REVIEW[a]).size]))
    const unique = new Set(REVIEW_AREAS.flatMap((a) => NEEDS_NATIVE_REVIEW[a])).size
    // Printed so the release checklist can read the list size (DESIGN_SYSTEM.md 7.3).
    console.info(`needsNativeReview: ${JSON.stringify(sizes)}; ${unique} unique of ${KEYS.length} keys`)
  })

  it('every dispute, escrow-deadline and reputation-explanation key is in the review list', () => {
    const listed = new Set(REVIEW_AREAS.flatMap((a) => NEEDS_NATIVE_REVIEW[a]))
    const must = KEYS.filter((k) => /^(disputes\.|reputation\.|escrow\.deadline\.)/.test(k))
    expect(must.filter((k) => !listed.has(k))).toEqual([])
  })
})

describe('Layer A boundary', () => {
  it('components/ui primitives never import the app dictionary (copy comes by props or UiStrings)', () => {
    const dir = join(__dirname, '..', 'src', 'components', 'ui')
    const APP_COMPONENTS = new Set(['StatusBadges.tsx', 'VouchButton.tsx', 'AssetIcon.tsx'])
    const hits = readdirSync(dir).filter((f) => !APP_COMPONENTS.has(f) && /from ['"][./]+i18n/.test(readFileSync(join(dir, f), 'utf8')))
    expect(hits).toEqual([])
  })
})
