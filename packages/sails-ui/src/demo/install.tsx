/** DEV-ONLY entry point: main.tsx imports this behind `import.meta.env.DEV`. */
import ReactDOM from 'react-dom/client'
import { demoRequested, installDemoBackend } from './demoBackend'
import { DemoBanner } from './DemoBanner'
import { DemoControls } from './DemoControls'
import { SkipLink } from '../components/layout/SkipLink'

export function installDemoIfRequested() {
  if (!demoRequested()) return
  installDemoBackend()
  // Own React root outside #root, so no product page or layout changes.
  const host = document.createElement('div')
  document.body.prepend(host)
  ReactDOM.createRoot(host).render(<><SkipLink /><DemoBanner /><DemoControls /></>)
}
