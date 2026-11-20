import { resetDemoAndReload } from './demoBackend'

/** DEV-ONLY: always-visible notice that the app is running on fictional demo data. */
export function DemoBanner() {
  const link = 'underline font-semibold inline-flex items-center min-h-[44px] md:min-h-0 px-1'
  return (
    <div role="region" aria-label="Modo demonstração" className="bg-primary text-primary-foreground text-xs md:text-sm font-medium px-4 md:py-2 flex items-center justify-center gap-x-3 text-center whitespace-nowrap">
      {/* One line on mobile: the short notice; the full sentence from md. */}
      <span className="md:hidden">Demonstração · dados fictícios</span>
      <span className="hidden md:inline">Modo demonstração — dados fictícios. Nada é enviado a nenhum nó Sails.</span>
      <button type="button" onClick={resetDemoAndReload} className={link}>Reiniciar</button>
      {/* Full reload on purpose: turning the demo off must restore the real client. */}
      <a href="/?demo=0" className={link}>Sair</a>
    </div>
  )
}
