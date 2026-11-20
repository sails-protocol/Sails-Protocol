import { cn } from '../../lib/utils'
import { splitOverflow } from '../../lib/paymentMethods'

/**
 * Layer A: the payment methods an offer accepts, as quiet secondary text after a thin brand tick
 * (same look as the old single PaymentBadge). `max` items, then "+N"; `maxNarrow` (optional) is the
 * limit below `sm`. Screen readers get the full list once (`listLabel`); the visual part is hidden
 * from them. `max` omitted = the full list (offer detail). All copy comes from props.
 */
export function PaymentMethods({ labels, max, maxNarrow, listLabel, className }: {
  labels: readonly string[]
  max?: number
  maxNarrow?: number
  /** Accessible text for the whole list, e.g. "Pagamento: PIX, TED". Defaults to the labels joined. */
  listLabel?: string
  className?: string
}) {
  const wide = splitOverflow(labels, max ?? labels.length)
  const narrow = splitOverflow(labels, Math.min(maxNarrow ?? wide.shown.length, wide.shown.length))
  const narrowOnly = narrow.more !== wide.more
  return (
    <span className={cn('inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-body-sm text-brand-text-secondary', className)}>
      <span className="sr-only">{listLabel ?? labels.join(', ')}</span>
      {wide.shown.map((label, i) => (
        <span key={label} aria-hidden="true" className={cn('min-w-0 items-center gap-1.5', i >= narrow.shown.length ? 'hidden sm:inline-flex' : 'inline-flex')}>
          <span className="h-3 w-0.5 shrink-0 rounded-full bg-brand-orange-accent" />
          {label}
        </span>
      ))}
      {narrowOnly && <span aria-hidden="true" className="tabular-nums sm:hidden">+{narrow.more}</span>}
      {wide.more > 0 && <span aria-hidden="true" className={cn('tabular-nums', narrowOnly && 'hidden sm:inline')}>+{wide.more}</span>}
    </span>
  )
}
