/**
 * Layer A: where and how to fund a MULTISIG escrow, from the view-model of
 * deriveFundingInstruction(). Presentational only: every string comes from
 * the view; it never claims a deposit was seen or confirmed.
 */
import { useId } from 'react'
import type { FundingInstructionView } from '../../lib/fundingInstruction'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'

export function FundingInstructionCard({ view }: { view: FundingInstructionView }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="mt-4 rounded-md border border-brand-border-subtle bg-brand-surface p-3">
      <h3 id={titleId} className="text-sm font-semibold text-brand-text">{view.title}</h3>
      <dl className="mt-2 flex flex-col gap-2">
        {view.facts.map((f) => (
          <div key={f.label} className="flex flex-col gap-1">
            <dt className="text-xs text-brand-text-secondary">{f.label}</dt>
            <dd className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <span className={cn('min-w-0 text-sm text-brand-text [overflow-wrap:anywhere]', f.mono && 'font-mono')}>{f.value}</span>
              {f.copy && <CopyButton value={f.copy} label={view.copyLabel} className="min-h-11 shrink-0 self-start px-3 sm:min-h-0 sm:py-1" />}
            </dd>
          </div>
        ))}
      </dl>
      {view.requirements.length > 0 && (
        // Plain bullets, not check marks: these are conditions to meet, not facts already met.
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm text-brand-text-secondary marker:text-brand-text-muted">
          {view.requirements.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <p className="mt-3 text-sm text-brand-text">{view.note}</p>
    </section>
  )
}
