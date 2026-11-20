import type { ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Card } from '../ui/card'
import { cn } from '../../lib/utils'
import { tabPanelProps } from '../ui/tabs'

/**
 * One settings group: heading + list of rows. All copy comes from the caller
 * (no hardcoded language); styled only through brand tokens.
 */
export function SettingsGroup({ id, title, icon: Icon, children, className, panelOf }: {
  id: string
  title: string
  icon: LucideIcon
  children: ReactNode
  className?: string
  /** idBase of the Tabs that switch this group: renders it as that tab's panel. */
  panelOf?: string
}) {
  const panel = panelOf ? tabPanelProps(panelOf, id) : null
  return (
    <section
      id={panel?.id ?? id}
      role={panel?.role}
      aria-labelledby={`${id}-title`}
      className={className}
    >
      {/* Below md the page header already names the open section, so the heading stays for screen readers only. */}
      <h2 id={`${id}-title`} className="text-section-title sr-only md:not-sr-only md:flex items-center gap-2 md:mb-3">
        <Icon className="h-4 w-4 text-brand-text-muted" aria-hidden="true" />
        {title}
      </h2>
      <Card className="overflow-hidden border-brand-border-subtle bg-brand-surface">
        <ul className="divide-y divide-brand-border-subtle">{children}</ul>
      </Card>
    </section>
  )
}

interface SettingsRowProps {
  icon: LucideIcon
  label: string
  description?: ReactNode
  /** Current value, right-aligned. Never set on a planned row. */
  value?: ReactNode
  /** Trailing control (switch, button) instead of a chevron. */
  control?: ReactNode
  onClick?: () => void
  /** Marks the row as planned: disabled, no value, no action, shows this badge text. */
  plannedLabel?: string
}

/** Icon + label + value right-aligned + chevron/control (mobile P2P app pattern). */
export function SettingsRow({ icon: Icon, label, description, value, control, onClick, plannedLabel }: SettingsRowProps) {
  const planned = !!plannedLabel
  const body = (
    <>
      <span className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', planned ? 'bg-brand-elevated/50' : 'bg-brand-elevated')}>
        <Icon className={cn('h-4 w-4', planned ? 'text-brand-text-muted' : 'text-brand-text-secondary')} aria-hidden="true" />
      </span>
      <span className="flex-1 min-w-0">
        <span className={cn('block text-sm font-medium', planned ? 'text-brand-text-secondary' : 'text-brand-text')}>{label}</span>
        {description && <span className="block text-xs text-brand-text-muted mt-0.5">{description}</span>}
      </span>
      {planned ? (
        <Badge variant="outline" className="shrink-0 border-brand-border font-medium text-brand-text-secondary">{plannedLabel}</Badge>
      ) : (
        <>
          {value !== undefined && <span className="text-sm text-brand-text-secondary text-right shrink-0 max-w-[50%] truncate">{value}</span>}
          {control}
          {onClick && !control && <ChevronRight className="h-4 w-4 text-brand-text-muted shrink-0" aria-hidden="true" />}
        </>
      )}
    </>
  )
  const rowClass = 'w-full min-h-14 flex items-center gap-3 px-4 py-3 text-left'
  const interactive = 'transition-colors state-layer focus-visible:-outline-offset-2'

  if (planned) {
    return (
      <li aria-disabled="true" className={cn(rowClass, 'cursor-not-allowed')}>
        {body}
      </li>
    )
  }
  if (onClick) {
    return (
      <li>
        <button type="button" onClick={onClick} className={cn(rowClass, interactive)}>{body}</button>
      </li>
    )
  }
  return <li className={rowClass}>{body}</li>
}
