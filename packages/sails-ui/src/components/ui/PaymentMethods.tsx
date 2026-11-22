import { cn } from '../../lib/utils'
import { splitOverflow } from '../../lib/paymentMethods'

/**
 * Layer A: the payment methods an offer accepts. Two layouts, one look (thin neutral tick + quiet text):
 * - `stack` (Market table, offer detail): one method per line, the P2P-market pattern, so long names
 *   ("Transferência bancária") never mix lines with short ones; "+N" sits on the last line.
 * - `inline` (Market card / phone): one line, a single tick, names joined by commas, then "+N".
 * `max` items, then "+N"; `maxNarrow` (optional) is the limit below `sm`. Screen readers get the full
 * list once (`listLabel`); the visual part is hidden from them. `max` omitted = the full list.
 */
export function PaymentMethods({ labels, max, maxNarrow, listLabel, layout = 'stack', className }: {
  labels: readonly string[]
  max?: number
  maxNarrow?: number
  /** Accessible text for the whole list, e.g. "Pagamento: PIX, TED". Defaults to the labels joined. */
  listLabel?: string
  layout?: 'stack' | 'inline'
  className?: string
}) {
  const wide = splitOverflow(labels, max ?? labels.length)
  const narrow = splitOverflow(labels, Math.min(maxNarrow ?? wide.shown.length, wide.shown.length))
  const narrowOnly = narrow.more !== wide.more
  const hiddenNarrow = (i: number) => i >= narrow.shown.length
  const tick = <span aria-hidden="true" className="h-3 w-0.5 shrink-0 self-center rounded-full bg-brand-border" />
  const moreWide = wide.more > 0 && <span className={cn('ml-1.5 whitespace-nowrap tabular-nums text-brand-text-muted', narrowOnly && 'hidden sm:inline')}>+{wide.more}</span>
  const moreNarrow = narrowOnly && <span className="ml-1.5 whitespace-nowrap tabular-nums text-brand-text-muted sm:hidden">+{narrow.more}</span>

  if (layout === 'inline') {
    return (
      <span className={cn('inline-flex max-w-full min-w-0 items-baseline gap-1.5 text-body-sm text-brand-text-secondary', className)}>
        <span className="sr-only">{listLabel ?? labels.join(', ')}</span>
        {tick}
        <span aria-hidden="true" className="min-w-0 break-words">
          {wide.shown.map((label, i) => (
            <span key={label} className={cn(hiddenNarrow(i) && 'hidden sm:inline')}>{i > 0 && ', '}{label}</span>
          ))}
          {moreNarrow}
          {moreWide}
        </span>
      </span>
    )
  }

  return (
    <span className={cn('inline-flex max-w-full min-w-0 flex-col gap-0.5 text-body-sm text-brand-text-secondary', className)}>
      <span className="sr-only">{listLabel ?? labels.join(', ')}</span>
      {wide.shown.map((label, i) => (
        <span key={label} aria-hidden="true" className={cn('min-w-0 items-baseline gap-1.5', hiddenNarrow(i) ? 'hidden sm:flex' : 'flex')}>
          {tick}
          <span className="min-w-0 break-words">
            {label}
            {i === narrow.shown.length - 1 && moreNarrow}
            {i === wide.shown.length - 1 && moreWide}
          </span>
        </span>
      ))}
    </span>
  )
}
