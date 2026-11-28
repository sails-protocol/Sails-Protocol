import { SAFETY_CENTER_BASE_URL as B, SAFETY_CENTER_PAGES, safetyCenterInEnglish, safetyCenterUrl, type SafetyCenterPage } from '../src/lib/safetyCenter'

describe('safetyCenterUrl', () => {
  const pages = Object.keys(SAFETY_CENTER_PAGES) as SafetyCenterPage[]
  const prefix = { 'pt-BR': 'pt-BR/', es: 'es/', en: '', fr: '', de: '', xx: '' } as const

  it.each(Object.entries(prefix))('%s maps every page under its site prefix', (locale, p) => {
    for (const page of pages) expect(safetyCenterUrl(locale, page)).toBe(`${B}${p}${SAFETY_CENTER_PAGES[page]}`)
  })

  it('defaults to the home page', () => {
    expect(safetyCenterUrl('pt-BR')).toBe(`${B}pt-BR/`)
    expect(safetyCenterUrl('en')).toBe(B)
  })

  it('uses the given slugs', () => {
    expect(safetyCenterUrl('es', 'thirdPartyPayments')).toBe(`${B}es/guides/pagamentos/terceiros`)
    expect(safetyCenterUrl('fr', 'incident')).toBe(`${B}incident`)
  })

  it('accepts an override base with or without the trailing slash', () => {
    expect(safetyCenterUrl('es', 'incident', 'https://x.test/sc')).toBe('https://x.test/sc/es/incident')
    expect(safetyCenterUrl('es', 'incident', 'https://x.test/sc/')).toBe('https://x.test/sc/es/incident')
  })

  it('fr and de (and anything unknown) open the English site', () => {
    expect(['fr', 'de', 'xx'].every(safetyCenterInEnglish)).toBe(true)
    expect(['pt-BR', 'es', 'en'].some(safetyCenterInEnglish)).toBe(false)
  })
})
