/**
 * Layer A: list of Sails nodes with what each one declares (operator, region, status, fee, limits, custody model).
 * Missing metadata is shown as the caller's "unavailable" label, never guessed. Illustrative entries carry a visible
 * marker. A grouped list (rows split by hairlines, no box per node), all copy from props, tokens only.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, type LucideIcon } from 'lucide-react'
import { Badge } from '../ui/badge'
import { TONE_CLASS, type Tone } from '../../lib/tone'
import { cn } from '../../lib/utils'
import type { NodeProfile, NodeStatus, NodeView } from '../../lib/sailsNode'

export interface NodeListCopy {
  label: string
  profile: Record<NodeProfile, string>
  sharedHosting: string
  status: Record<NodeStatus, string>
  fields: { operator: string; region: string; status: string; fee: string; limits: string; custody: string }
  /** Shown in place of a field the node does not (yet) declare. */
  unavailable: string
  current: string
  illustrative: string
}

const STATUS: Record<NodeStatus, { tone: Tone; Icon: LucideIcon }> = {
  online: { tone: 'success', Icon: CheckCircle2 },
  degraded: { tone: 'warning', Icon: AlertTriangle },
  offline: { tone: 'neutral', Icon: CircleSlash },
}

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text'

function Field({ label, value, unavailable }: { label: string; value?: ReactNode; unavailable: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-brand-text-muted">{label}</dt>
      <dd className={cn('text-body-sm break-words', value ? 'text-brand-text' : 'text-brand-text-secondary')}>{value ?? unavailable}</dd>
    </div>
  )
}

export function NodeList({ nodes, copy, className }: { nodes: readonly NodeView[]; copy: NodeListCopy; className?: string }) {
  return (
    <ul aria-label={copy.label} className={cn('divide-y divide-brand-border-subtle', className)}>
      {nodes.map((n) => {
        const status = n.status ? STATUS[n.status] : null
        return (
          <li key={n.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium text-brand-text">{n.name}</span>
              {n.profile && <Badge variant="outline" className={TAG} translate="no">{copy.profile[n.profile]}</Badge>}
              {n.sharedHosting && <Badge variant="outline" className={TAG}>{copy.sharedHosting}</Badge>}
              {n.current && <Badge variant="outline" className={TAG}>{copy.current}</Badge>}
              {n.illustrative && <Badge variant="outline" className={cn(TAG, 'text-brand-text-secondary')}>{copy.illustrative}</Badge>}
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 min-[420px]:grid-cols-2 lg:grid-cols-3">
              <Field label={copy.fields.operator} value={n.operator} unavailable={copy.unavailable} />
              <Field label={copy.fields.region} value={n.region} unavailable={copy.unavailable} />
              <Field
                label={copy.fields.status}
                unavailable={copy.unavailable}
                value={status && n.status ? (
                  <Badge variant="outline" className={cn('gap-1', TONE_CLASS[status.tone])}>
                    <status.Icon aria-hidden="true" className="size-icon-xs" />
                    {copy.status[n.status]}
                  </Badge>
                ) : undefined}
              />
              <Field label={copy.fields.fee} value={n.fee} unavailable={copy.unavailable} />
              <Field label={copy.fields.limits} value={n.limits} unavailable={copy.unavailable} />
              <Field label={copy.fields.custody} value={n.custodyModel} unavailable={copy.unavailable} />
            </dl>
          </li>
        )
      })}
    </ul>
  )
}
