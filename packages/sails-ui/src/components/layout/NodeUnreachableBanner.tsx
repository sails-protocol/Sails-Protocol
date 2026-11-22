/**
 * Shell banner while the configured nó Sails cannot be reached (lib/nodeConnection.ts: a request got no response
 * at all; an HTTP error never shows it). "Tentar de novo" repeats one light read the Market already makes
 * (liquidity.discover, one offer) and, once the node answers, asks the shell to reload the page's data.
 * It hides on its own as soon as any request gets a response. Never in demo mode (no network there).
 */
import { useState } from 'react'
import { WifiOff } from 'lucide-react'
import { Alert } from '../ui/alert'
import { Button } from '../ui/button'
import { useNodeConnection } from '../../hooks/useNodeConnection'
import { getNodeConnectionStatus } from '../../lib/nodeConnection'
import { sailsClient } from '../../lib/sailsClient'
import { isDemoMode } from '../../lib/demoMarkers'
import { t } from '../../i18n'

export function NodeUnreachableBanner({ onReconnected }: { onReconnected: () => void }) {
  const status = useNodeConnection()
  const [retrying, setRetrying] = useState(false)
  const shown = status === 'unreachable' && !isDemoMode()

  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await sailsClient.liquidity.discover({ asset: 'BTC', side: 'SELL', limit: 1 })
    } catch {
      // Outcome is read from the store below: an HTTP error still means the node answered.
    }
    setRetrying(false)
    if (getNodeConnectionStatus() === 'online') onReconnected()
  }

  return (
    // Polite and always mounted, so the message is announced when it appears without interrupting.
    <div role="status" aria-live="polite">
      {shown && (
        <div className="max-w-7xl mx-auto px-4 md:px-6 xl:px-8 pt-4">
          <Alert
            tone="danger"
            icon={WifiOff}
            action={
              <Button variant="secondary" size="sm" onClick={retry} aria-disabled={retrying || undefined}>
                {retrying ? t('shell.node.retrying') : t('shell.node.retry')}
              </Button>
            }
          >
            {t('shell.node.unreachable')}
          </Alert>
        </div>
      )}
    </div>
  )
}
