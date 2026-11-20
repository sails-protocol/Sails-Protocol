import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

async function start() {
  // Dev-only demo mode (?demo=1): import.meta.env.DEV is statically false in production builds, so Rollup drops this chunk.
  if (import.meta.env.DEV) (await import('./demo/install')).installDemoIfRequested()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void start()
