/**
 * Layer C: entry points to the external Sails P2P Safety Center (DECISIONS.md, PO 2026-11-23). Real and live, so
 * no demo marker. The base URL can be overridden at build time with VITE_SAFETY_CENTER_URL (like VITE_API_BASE_URL).
 */
import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { getLocale, t } from '../../i18n'
import { safetyCenterInEnglish, safetyCenterUrl, type SafetyCenterPage } from '../../lib/safetyCenter'
import { cn } from '../../lib/utils'

export function safetyCenterHref(page: SafetyCenterPage = 'home'): string {
  return safetyCenterUrl(getLocale(), page, import.meta.env.VITE_SAFETY_CENTER_URL || undefined)
}

/** " (em inglês)" for locales the site does not have yet (fr, de), empty otherwise. */
export const safetyCenterLanguageNote = (): string => (safetyCenterInEnglish(getLocale()) ? ` ${t('shell.safetyCenter.inEnglish')}` : '')

/** Screen-reader suffix for every Safety Center link: language note (fr/de) + "(abre em nova aba)". */
export function SafetyCenterNewTab() {
  return <span className="sr-only">{`${safetyCenterLanguageNote()} ${t('shell.safetyCenter.newTab')}`}</span>
}

export const SAFETY_CENTER_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const

/** Inline text link, appended to an existing safety note. */
export function SafetyCenterLink({ page, children, className }: { page: SafetyCenterPage; children: ReactNode; className?: string }) {
  return (
    <a
      href={safetyCenterHref(page)}
      {...SAFETY_CENTER_LINK_PROPS}
      className={cn('inline-flex min-h-8 touch:min-h-11 items-center gap-1 font-medium text-brand-link underline underline-offset-2 hover:decoration-2', className)}
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-icon-xs shrink-0" />
      <SafetyCenterNewTab />
    </a>
  )
}
