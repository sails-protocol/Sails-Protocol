import { resetDemoAndReload } from './demoBackend'

/** DEV-ONLY: always-visible notice that the app is running on fictional demo data. */
export function DemoBanner() {
  const link = 'underline font-semibold inline-flex items-center min-h-[44px] md:min-h-0 px-1'
  return (
    <div role="region" aria-label="Modo demonstração" className="bg-primary text-primary-foreground text-sm font-medium px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
      <span>Modo demonstração — dados fictícios. Nada é enviado a nenhum servidor.</span>
      <button type="button" onClick={resetDemoAndReload} className={link}>Reiniciar</button>
      {/* Full reload on purpose: turning the demo off must restore the real client. */}
      <a href="/?demo=0" className={link}>Sair</a>
    </div>
  )
}
