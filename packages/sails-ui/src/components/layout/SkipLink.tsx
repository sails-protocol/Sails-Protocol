import { useT } from '../../i18n'

/** "Pular para o conteúdo": the first tab stop of the page (the demo root renders it before its banner). */
export function SkipLink() {
  const t = useT()
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-brand-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-text focus:shadow-elevation-2"
    >
      {t('shell.nav.skipToContent')}
    </a>
  )
}
