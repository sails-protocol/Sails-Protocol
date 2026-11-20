/**
 * Layer A: label/value table for the trade's recorded details. `mono`
 * is for identifiers; `copy` adds a copy button with the full value.
 */
import type { ReactNode } from 'react'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'

export interface SpecRow {
  label: string
  value: ReactNode
  mono?: boolean
  copy?: string
}

export function TradeSpecs({ title, rows, children }: { title: string; rows: SpecRow[]; children?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <h2 className="text-sm font-semibold text-brand-text">{title}</h2>
      <dl className="mt-2 divide-y divide-brand-border-subtle">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 py-2 text-sm">
            <dt className="max-w-[45%] shrink-0 text-brand-text-secondary">{r.label}</dt>
            <dd className="flex min-w-0 items-center gap-2 text-right text-brand-text">
              <span className={cn('min-w-0 [overflow-wrap:anywhere]', r.mono && 'font-mono text-xs')}>{r.value}</span>
              {r.copy && <CopyButton value={r.copy} label="Copiar" className="shrink-0 min-h-11 px-3 sm:min-h-0 sm:py-1" />}
            </dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  )
}
