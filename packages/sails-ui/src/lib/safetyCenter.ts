/**
 * Sails P2P Safety Center: an external, live public site (DECISIONS.md, PO 2026-11-23). The app only links to it.
 * The site has en (root, also x-default), pt-BR and es; every page keeps the same slug under the locale prefix.
 * Any other locale (fr, de) opens the English site.
 */
export const SAFETY_CENTER_BASE_URL = 'https://sails-protocol.github.io/Sails-P2P-Safety-Center/'

export const SAFETY_CENTER_PAGES = {
  home: '',
  thirdPartyPayments: 'guides/pagamentos/terceiros',
  incident: 'incident',
  escrowLimits: 'guides/negociacoes/limites-do-escrow',
  evidence: 'guides/disputas/preservar-evidencias',
  arbitration: 'guides/seguranca-arbitragem',
} as const
export type SafetyCenterPage = keyof typeof SAFETY_CENTER_PAGES

const SITE_PREFIX: Record<string, string> = { 'pt-BR': 'pt-BR/', es: 'es/', en: '' }

/** True when the locale has no Safety Center version and the link opens the English site. */
export const safetyCenterInEnglish = (locale: string): boolean => !(locale in SITE_PREFIX)

export function safetyCenterUrl(locale: string, page: SafetyCenterPage = 'home', base: string = SAFETY_CENTER_BASE_URL): string {
  const root = base.endsWith('/') ? base : `${base}/`
  return root + (SITE_PREFIX[locale] ?? '') + SAFETY_CENTER_PAGES[page]
}
