/**
 * Layer A: a short titled list of facts (guarantees, use cases, presets, planned steps). Icon or step number,
 * a label and an optional description. No box per item: it sits inside the caller's surface. Copy from props.
 */
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface Fact {
  title: string
  description?: string
  icon?: LucideIcon
}

export function FactList({ title, facts, ordered = false, level = 3, className }: { title: string; facts: readonly Fact[]; ordered?: boolean; /** Heading level of the title in the page outline. */ level?: 2 | 3; className?: string }) {
  const List = ordered ? 'ol' : 'ul'
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className={className}>
      <Heading className="text-sm font-medium text-brand-text">{title}</Heading>
      <List className="mt-2 space-y-2">
        {facts.map((f, i) => (
          <li key={f.title} className="flex items-start gap-2">
            {ordered ? (
              <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-tonal text-caption font-medium text-brand-text-secondary">{i + 1}</span>
            ) : f.icon ? (
              <f.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand-text-muted" />
            ) : null}
            <span className={cn('min-w-0 text-body-sm', ordered && 'pt-px')}>
              <span className="text-brand-text">{f.title}</span>
              {f.description && <span className="block text-caption text-brand-text-secondary">{f.description}</span>}
            </span>
          </li>
        ))}
      </List>
    </div>
  )
}
