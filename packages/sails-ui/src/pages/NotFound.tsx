import { Link } from 'react-router'
import { buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'
import { t } from '../i18n'

export function NotFound() {
  return (
    <div className="py-16 flex flex-col items-center gap-3 text-center">
      <h1 className="text-page-title">{t('shell.notFound.title')}</h1>
      <p className="text-metadata max-w-xs">{t('shell.notFound.body')}</p>
      <Link to="/" className={cn(buttonVariants({ className: 'mt-2 min-h-10 touch:min-h-11 px-4' }))}>{t('shell.notFound.back')}</Link>
    </div>
  )
}
