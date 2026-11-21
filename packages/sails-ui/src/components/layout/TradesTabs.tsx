import { useEffect, useState } from 'react'
import { TabLinks } from '../ui/tabs'
import { useAuth } from '../../context/AuthContext'
import { sailsClient } from '../../lib/sailsClient'
import { TONE_CLASS } from '../../lib/tone'
import { cn } from '../../lib/utils'
import { TRADES_ROUTES } from './navMatch'

/**
 * The viewer's own trades in dispute (getTrades(), first 50, status DISPUTED: the Disputas tab's own list).
 * null = unknown (signed out, loading or failed): no count is shown, never a guessed one.
 */
function useMyDisputedCount(enabled: boolean): number | null {
  const { user } = useAuth()
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled || !user) {
      setCount(null)
      return
    }
    let cancelled = false
    sailsClient.openp2p
      .getTrades({ limit: 50 })
      .then((page) => { if (!cancelled) setCount(page.trades.filter((t) => t.status === 'DISPUTED').length) })
      .catch(() => { if (!cancelled) setCount(null) })
    return () => { cancelled = true }
  }, [enabled, user])
  return count
}

/**
 * "Ativos | Histórico | Minhas ofertas | Disputas" under the one "Trades" page title (each Trades page
 * renders it inside its PageHeader). Route tabs (TabLinks): links with aria-current, not ARIA tabs,
 * because each tab is its own URL. At narrow widths the strip scrolls sideways on its own instead of
 * widening the page.
 *
 * `openDisputes`: the Disputas page passes the count it already loaded (null while it loads); the other
 * tabs omit it and the count is fetched here.
 */
export function TradesTabs({ openDisputes }: { openDisputes?: number | null }) {
  const fetched = useMyDisputedCount(openDisputes === undefined)
  const count = openDisputes === undefined ? fetched : openDisputes
  const items = [
    { to: TRADES_ROUTES.active, label: 'Ativos' },
    { to: TRADES_ROUTES.history, label: 'Histórico' },
    { to: TRADES_ROUTES.offers, label: 'Minhas ofertas' },
    {
      to: TRADES_ROUTES.disputes,
      label: (
        <>
          Disputas
          {count ? (
            <span className={cn('rounded-full border px-1.5 text-caption tabular-nums', TONE_CLASS.warning)}>
              {count}<span className="sr-only"> em disputa</span>
            </span>
          ) : null}
        </>
      ),
    },
  ]
  return <TabLinks label="Trades" items={items} className="overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none]" />
}
