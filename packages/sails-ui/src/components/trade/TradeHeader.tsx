/**
 * Layer A: trade title, id (copyable), creation time and, optionally, ONE
 * status chip from deriveTradeState(). The trade page passes none: its
 * status line lives in TradeRail. No routing here (the host adds any back link).
 */
import type { ReactNode } from 'react'
import type { StatusTone } from '../../lib/tradeState'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'
import { TONE_CLASS } from '../../lib/tone'

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  // The one status chip of the page: Design System tone with a stronger border.
  neutral: TONE_CLASS.neutral,
  info: cn(TONE_CLASS.info, 'border-brand-info/70'),
  warning: cn(TONE_CLASS.warning, 'border-brand-warning/70'),
  success: cn(TONE_CLASS.success, 'border-brand-success/70'),
  danger: cn(TONE_CLASS.danger, 'border-brand-danger/70'),
}

interface Props {
  title: string
  tradeId: string
  createdAtLabel: string
  status?: { label: string; tone: StatusTone }
  /** Host-provided element on the chip's row (e.g. a back link). */
  leading?: ReactNode
  /** Host-rendered asset and network ("BTC · On-chain"), after the opening date. */
  asset?: ReactNode
}

export function TradeHeader({ title, tradeId, createdAtLabel, status, leading, asset }: Props) {
  return (
    <header>
      {/* Wraps instead of overlapping: a long status drops under the back link on narrow screens. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="shrink-0">{leading}</div>
        {status && (
          <span
            role="status"
            className={cn('inline-flex w-fit shrink-0 items-center rounded-full border px-3 py-1 text-sm font-medium', STATUS_TONE_CLASS[status.tone])}
          >
            {status.label}
          </span>
        )}
      </div>
      <h1 className="mt-1 text-page-title [overflow-wrap:anywhere]">{title}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-brand-text-secondary">
        <span>Trade <span className="font-mono">#{tradeId.slice(0, 8)}</span></span>
        <CopyButton value={tradeId} label="Copiar" className="px-3 py-1 touch:min-h-11" />
        <span>· Aberto em {createdAtLabel}</span>
        {asset && <span className="inline-flex items-center gap-1">· {asset}</span>}
      </p>
    </header>
  )
}
