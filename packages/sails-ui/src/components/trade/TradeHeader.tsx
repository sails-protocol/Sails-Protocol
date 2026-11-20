/**
 * Layer A: trade title, id (copyable), creation time and ONE status chip.
 * The chip comes from deriveTradeState(); no routing here (the host adds
 * any back link).
 */
import type { ReactNode } from 'react'
import type { StatusTone } from '../../lib/tradeState'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'border-brand-border bg-brand-elevated text-brand-text-secondary',
  info: 'border-brand-info/70 bg-brand-info/10 text-brand-info',
  // Light: one shade darker than the token so tinted chips keep >= 4.5:1.
  warning: 'border-brand-warning bg-brand-warning/10 text-amber-800 dark:border-brand-warning/70 dark:text-brand-warning',
  success: 'border-brand-success/70 bg-brand-success/10 text-green-800 dark:text-brand-success',
  // --destructive is red-700 in both themes; on dark surfaces the text needs the lighter red.
  danger: 'border-red-700/70 bg-brand-danger/10 text-red-700 dark:border-red-400/70 dark:text-red-400',
}

interface Props {
  title: string
  tradeId: string
  createdAtLabel: string
  status: { label: string; tone: StatusTone }
  /** Host-provided element on the chip's row (e.g. a back link). */
  leading?: ReactNode
}

export function TradeHeader({ title, tradeId, createdAtLabel, status, leading }: Props) {
  return (
    <header>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">{leading}</div>
        <span
          role="status"
          className={cn('inline-flex w-fit shrink-0 items-center rounded-full border px-3 py-1 text-sm font-medium', STATUS_TONE_CLASS[status.tone])}
        >
          {status.label}
        </span>
      </div>
      <h1 className="mt-1 text-xl font-semibold text-brand-text [overflow-wrap:anywhere]">{title}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-brand-text-secondary">
        <span>Trade <span className="font-mono">#{tradeId.slice(0, 8)}</span></span>
        <CopyButton value={tradeId} label="Copiar" className="min-h-11 px-3 sm:min-h-0 sm:py-1" />
        <span>· Aberto em {createdAtLabel}</span>
      </p>
    </header>
  )
}
