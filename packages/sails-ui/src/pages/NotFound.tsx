import { Link } from 'react-router'
import { buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'

export function NotFound() {
  return (
    <div className="py-16 flex flex-col items-center gap-3 text-center">
      <h1 className="text-page-title">Página não encontrada</h1>
      <p className="text-metadata max-w-xs">Este endereço não existe ou foi movido.</p>
      <Link to="/" className={cn(buttonVariants({ className: 'mt-2 min-h-11 md:min-h-10 px-4' }))}>Voltar ao Market</Link>
    </div>
  )
}
