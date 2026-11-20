/**
 * Layer A: label/value tables for the trade's recorded details, grouped by
 * stage (the Registro ledger). `mono` is for identifiers; `copy` adds a copy
 * button with the full value. Groups are sections of one card: a heading and
 * divided rows, never a box inside the box.
 */
import { useId, type ReactNode } from 'react'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'

export interface SpecRow {
  label: string
  value: ReactNode
  mono?: boolean
  copy?: string
}

export interface SpecGroup {
  title: string
  rows: SpecRow[]
}

export function TradeSpecs({ title, groups, children }: { title: string; groups: SpecGroup[]; children?: ReactNode }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <h2 id={titleId} className="text-sm font-semibold text-brand-text">{title}</h2>
      {groups.filter((g) => g.rows.length > 0).map((g) => (
        <div key={g.title} className="mt-4">
          <h3 className="text-xs font-medium text-brand-text-secondary">{g.title}</h3>
          <dl className="mt-1 divide-y divide-brand-border-subtle">
            {g.rows.map((r, i) => (
              <div key={`${r.label}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <dt className="max-w-[45%] shrink-0 text-brand-text-secondary">{r.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-right text-brand-text">
                  <span translate={r.mono ? 'no' : undefined} className={cn('min-w-0 [overflow-wrap:anywhere]', r.mono && 'font-mono text-xs')}>{r.value}</span>
                  {r.copy && <CopyButton value={r.copy} label="Copiar" className="shrink-0 px-3 py-1 touch:min-h-11" />}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {children}
    </section>
  )
}
