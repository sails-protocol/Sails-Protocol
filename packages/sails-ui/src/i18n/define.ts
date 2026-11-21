import type { Locale } from '../lib/locale'

/**
 * Catalog building blocks (DESIGN_SYSTEM.md 7.3). pt-BR is the source; every other catalog must have
 * exactly the same keys (a missing or extra key is a TypeScript error).
 */
export type TranslatedLocale = Exclude<Locale, 'pt-BR'>
export const TRANSLATED_LOCALES: readonly TranslatedLocale[] = ['en', 'es', 'fr', 'de']

/** Plural message: picked with Intl.PluralRules from `count`; `other` is required. */
export type PluralMessage = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>
export type Message = string | PluralMessage

/**
 * Areas whose en/es/fr/de strings must not ship to production before a native speaker reviews them
 * (DECISIONS.md: "textos de dinheiro e de disputa sem revisão nativa ficam fora da publicação").
 */
export const REVIEW_AREAS = ['money', 'dispute', 'deadline', 'reputation', 'custody', 'confirmation'] as const
export type ReviewArea = (typeof REVIEW_AREAS)[number]

export interface Area<K extends string> {
  messages: Record<Locale, Record<K, Message>>
  /** Keys whose translations need native review, by area. */
  review: Partial<Record<ReviewArea, readonly K[]>>
}

export function defineArea<K extends string>(
  pt: Record<K, Message>,
  translations: Record<TranslatedLocale, Record<NoInfer<K>, Message>>,
  review: Partial<Record<ReviewArea, readonly NoInfer<K>[]>> = {},
): Area<K> {
  return { messages: { 'pt-BR': pt, ...translations }, review }
}
