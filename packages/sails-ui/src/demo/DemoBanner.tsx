import { resetDemoAndReload } from './demoBackend'
import { useT } from '../i18n'

/** DEV-ONLY: always-visible notice that the app is running on fictional demo data. */
export function DemoBanner() {
  // Own React root (demo/install.tsx), outside the remounted routed tree: useT re-renders it on a language change.
  const t = useT()
  const link = 'underline font-semibold inline-flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 px-1'
  return (
    <div role="region" aria-label={t('shell.demo.region')} className="bg-primary text-primary-foreground text-xs md:text-sm font-medium px-4 md:py-2 flex items-center justify-center gap-x-3 text-center whitespace-nowrap">
      {/* One line on mobile: the short notice; the full sentence from md. */}
      <span className="md:hidden">{t('shell.demo.bannerShort')}</span>
      <span className="hidden md:inline">{t('shell.demo.bannerLong')}</span>
      {/* From md only: the mobile banner stays one line. */}
      <a href="/dev/wiring" className="hidden md:inline-flex items-center px-1 font-semibold underline">{t('shell.demo.wiring')}</a>
      <button type="button" onClick={resetDemoAndReload} className={link}>{t('shell.demo.reset')}</button>
      {/* Full reload on purpose: turning the demo off must restore the real client. */}
      <a href="/?demo=0" className={link}>{t('shell.demo.exit')}</a>
    </div>
  )
}
