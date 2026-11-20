// Trade comes from @satsails/p2p-trading-sdk — types.ts's own local Trade
// interface (which used to shadow this name) was confirmed dead and
// removed 2026-08-11. Real Trade.amount is a `string` (matches the
// SDK's own decimal-safe wire format), so it's Number()'d below same as
// Trade.tsx does with its own copy.
import type { Trade } from '@satsails/p2p-trading-sdk'
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card'
import { Button } from '../ui/button'
// Reuses the existing translated, color-coded status pill (StatusBadges.tsx)
// instead of the generic shadcn `Badge` with the raw `trade.status` enum —
// this app is entirely PT-BR (see TradeParties.tsx's own labels), and
// showing "COMPLETED"/"ACTIVE" verbatim would reintroduce the exact
// raw-enum-as-copy bug labels.ts's header comment already describes fixing.
import { TradeStatusBadge } from '../ui/StatusBadges'
import { ASSET_SHORT_LABELS } from '../../lib/labels'
import { formatAmount } from '../../lib/format'

export interface TradeCardProps {
  trade: Trade
  onRelease?: () => void
}

export function TradeCard({ trade, onRelease }: TradeCardProps) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-brand-text-muted">
          Trade #{trade.id.slice(0, 8)}
        </CardTitle>
        <TradeStatusBadge status={trade.status} />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold text-brand-text">
          {formatAmount(Number(trade.amount))} {ASSET_SHORT_LABELS[trade.asset]}
        </p>
        {/* Only offered mid-flow — releasing funds on a COMPLETED/DISPUTED/
            CANCELLED trade isn't a valid action. */}
        {onRelease && trade.status === 'ACTIVE' && (
          <Button type="button" className="w-full mt-4" onClick={onRelease}>
            Liberar fundos
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
