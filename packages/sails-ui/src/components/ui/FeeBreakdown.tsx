/**
 * Layer A: base fee · benefit · effective fee for one trade (CTO 38, complement 1). Prepared but gated: the caller
 * renders it only when backend data proves the benefit (none does yet), or on the marked demo trade. Copy and
 * amounts come from props; never a hardcoded rate.
 */
import type { ReactNode } from 'react'

export function FeeBreakdown({ items, badge, note }: { items: readonly { label: string; value: string }[]; badge?: ReactNode; note?: string }) {
  return (
    <div className="text-right">
      <dl className="space-y-0.5">
        {items.map((i) => (
          <div key={i.label} className="flex justify-end gap-3">
            <dt className="text-brand-text-secondary">{i.label}</dt>
            <dd className="tabular-nums text-brand-text">{i.value}</dd>
          </div>
        ))}
      </dl>
      {(badge || note) && <p className="mt-1 flex flex-wrap items-center justify-end gap-1.5 text-caption text-brand-text-muted">{badge}{note}</p>}
    </div>
  )
}
