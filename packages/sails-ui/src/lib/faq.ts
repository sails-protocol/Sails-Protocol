/**
 * Perguntas frequentes (DECISIONS.md, CTO/PO 2026-11-23): a sub-page of Configurações › Ajuda e Sobre.
 * Every question has a stable anchor (`#faq-<slug>`), used by the contextual "?" links in the trade and the Market.
 * Copy lives in i18n/areas/faq.ts; this module only holds the structure and the addresses.
 */
import type { SafetyCenterPage } from './safetyCenter'

export const FAQ_ROUTE = '/settings/help/faq'

export const FAQ_GROUPS = ['start', 'safety', 'fees', 'disputes', 'account', 'markets', 'merchant'] as const
export type FaqGroup = (typeof FAQ_GROUPS)[number]

/** Extra content under an answer: a table (T1, T2, T4) or a step diagram (D1, D2). */
export type FaqExtra = 't1' | 't2' | 't4' | 'd1' | 'd2'

export interface FaqItem {
  /** Anchor slug: the item's id is `faq-<slug>`. Never rename one (links point to it). */
  slug: string
  /** i18n key stem: `faq.<key>.q` and `faq.<key>.a`. */
  key: string
  group: FaqGroup
  extras?: readonly FaqExtra[]
  /** Safety Center pages offered as "Saiba mais". */
  more?: readonly SafetyCenterPage[]
  /** In-app pages the answer points to (label `faq.link.<id>`). */
  links?: readonly FaqLink[]
}

/** In-app destinations an answer can link to. */
export const FAQ_LINKS = { merchant: '/profile#merchant', myMarkets: '/markets/mine' } as const
export type FaqLink = keyof typeof FAQ_LINKS

// Order on screen = the approved proposal (13 questions, plus "corrigir-pagamento", CTO D6), then the Merchant group (PO 2026-11-23).
export const FAQ_ITEMS: readonly FaqItem[] = [
  { slug: 'como-funciona', key: 'howItWorks', group: 'start', extras: ['d1'], more: ['safeDecision'] },
  { slug: 'estados', key: 'states', group: 'start', extras: ['t1'] },
  { slug: 'escrow', key: 'escrow', group: 'safety', extras: ['t2'], more: ['escrowLimits'] },
  { slug: 'prazo', key: 'deadline', group: 'safety' },
  { slug: 'marquei-pago', key: 'markedPaid', group: 'safety' },
  { slug: 'terceiros', key: 'thirdParty', group: 'safety', more: ['thirdPartyPayments'] },
  { slug: 'corrigir-pagamento', key: 'fixPayment', group: 'safety' },
  { slug: 'taxas', key: 'fees', group: 'fees', extras: ['t4'] },
  { slug: 'disputa', key: 'dispute', group: 'disputes', extras: ['d2'], more: ['evidence', 'incident'] },
  { slug: 'contestar', key: 'appeal', group: 'disputes' },
  { slug: 'reputacao', key: 'reputation', group: 'account' },
  { slug: 'senha', key: 'password', group: 'account' },
  // CTO 29 (2026-11-23): the honest "lose everything" answer for the portable identity, which is in preparation.
  { slug: 'perder-tudo', key: 'loseAll', group: 'account' },
  { slug: 'mercados', key: 'markets', group: 'markets' },
  { slug: 'kyc', key: 'kyc', group: 'markets' },
  { slug: 'merchant-how', key: 'merchantHow', group: 'merchant', links: ['merchant'] },
  { slug: 'merchant-criteria', key: 'merchantCriteria', group: 'merchant', links: ['merchant'] },
  { slug: 'merchant-perks', key: 'merchantPerks', group: 'merchant', links: ['merchant'] },
  { slug: 'merchant-space', key: 'merchantSpace', group: 'merchant', links: ['merchant', 'myMarkets'] },
]

export type FaqSlug = 'como-funciona' | 'estados' | 'escrow' | 'prazo' | 'marquei-pago' | 'terceiros' | 'corrigir-pagamento' | 'taxas' | 'disputa' | 'contestar' | 'reputacao' | 'senha' | 'perder-tudo' | 'mercados' | 'kyc' | 'merchant-how' | 'merchant-criteria' | 'merchant-perks' | 'merchant-space'

export const faqAnchor = (slug: FaqSlug | string) => `faq-${slug}`
export const faqPath = (slug: FaqSlug) => `${FAQ_ROUTE}#${faqAnchor(slug)}`

/** The item a URL hash points to (`#faq-escrow` → 'escrow'), or null. */
export function faqSlugFromHash(hash: string): string | null {
  const id = decodeURIComponent(hash.replace(/^#/, ''))
  const item = FAQ_ITEMS.find((i) => faqAnchor(i.slug) === id)
  return item ? item.slug : null
}

/**
 * "Taxa do Sails nesta negociação" from the escrow's frozen fee snapshot (Escrow.snapshotProtocolFeeRate, a decimal
 * fraction string, RFC-009). A fee exists only when the node published a fee policy; null, 0 or unreadable → null,
 * so nothing is shown. Never a hardcoded rate.
 */
export function protocolFeeRateLabel(rate: string | null | undefined, locale: string): string | null {
  if (rate === null || rate === undefined || rate.trim() === '') return null
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n)
}
