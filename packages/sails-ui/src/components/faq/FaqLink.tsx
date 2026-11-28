/**
 * Layer C: the contextual "?" that opens one FAQ answer (`/settings/help/faq#faq-<slug>`). Same look and 44px hit
 * area as the "i" of ExplanationPopover; a real link, named after the question it opens.
 */
import { Link } from 'react-router'
import { t, type MessageKey } from '../../i18n'
import { FAQ_ITEMS, faqPath, type FaqSlug } from '../../lib/faq'
import { cn } from '../../lib/utils'

export const faqQuestion = (slug: FaqSlug) => t(`faq.${FAQ_ITEMS.find((i) => i.slug === slug)!.key}.q` as MessageKey)

/** Text link to one FAQ answer, for the inside of an explanation popover. */
export function FaqTextLink({ slug, children }: { slug: FaqSlug; children: string }) {
  return (
    <Link to={faqPath(slug)} className="inline-flex min-h-8 touch:min-h-11 items-center text-xs font-medium text-brand-link underline underline-offset-2 hover:decoration-2">
      {children}
    </Link>
  )
}

export function FaqLink({ slug, className }: { slug: FaqSlug; className?: string }) {
  return (
    <Link
      to={faqPath(slug)}
      aria-label={t('faq.contextLabel', { question: faqQuestion(slug) })}
      className={cn('group p-[14px] -m-[14px] inline-flex items-center justify-center rounded-full', className)}
    >
      <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center rounded-full border border-brand-border text-xs font-normal leading-none text-brand-text-muted transition-colors group-hover:border-brand-link group-hover:text-brand-link">
        ?
      </span>
    </Link>
  )
}
