/**
 * Layer A: the trade's key figures in one strip. The host passes only
 * fields the trade record carries; nothing is converted here. On phones
 * only the first two items show (the rest repeat in the host's details),
 * so the current action stays in the first viewport.
 */
import { cn } from '../../lib/utils'

export interface AmountItem {
  label: string
  value: string
  sub?: string
}

export function TradeAmountsStrip({ items }: { items: AmountItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-brand-border-subtle bg-brand-border-subtle lg:grid-cols-4">
      {items.map((it, i) => (
        <div key={it.label} className={cn('min-w-0 bg-brand-surface p-3 sm:p-4', i > 1 && 'hidden sm:block')}>
          <dt className="text-xs font-medium text-brand-text-secondary">{it.label}</dt>
          <dd className="mt-1 text-base font-semibold text-brand-text tabular-nums [overflow-wrap:anywhere] sm:text-lg">{it.value}</dd>
          {it.sub && <dd className="mt-0.5 text-xs text-brand-text-secondary [overflow-wrap:anywhere]">{it.sub}</dd>}
        </div>
      ))}
    </dl>
  )
}
