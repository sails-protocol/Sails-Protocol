/**
 * Layer A: inline alert (DESIGN_SYSTEM.md 5.3). Tint of its tone + leading icon
 * in the tone's base color, no border (no box inside a box); text in the main
 * text color (15.36+:1 light, 10.80+:1 dark on every tint), so the tone is
 * carried by the icon and tint, never the text alone. Optional title and action.
 * `live`: polite status for info/success, assertive alert only for a new danger;
 * static notes (always-visible guidance) use the default role=note.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

const TONE: Record<AlertTone, { bg: string; icon: string; Icon: LucideIcon }> = {
  info: { bg: 'bg-brand-info-bg', icon: 'text-brand-info', Icon: Info },
  success: { bg: 'bg-brand-success-bg', icon: 'text-brand-success', Icon: CheckCircle2 },
  warning: { bg: 'bg-brand-warning-bg', icon: 'text-brand-warning', Icon: AlertTriangle },
  danger: { bg: 'bg-brand-danger-bg', icon: 'text-brand-danger', Icon: XCircle },
}

export function Alert({ tone = 'info', title, children, action, live = false, icon, size = 'md', className }: {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  /** Announce when it appears (status, or alert for danger) instead of a static note. */
  live?: boolean
  icon?: LucideIcon
  /** `sm`: caption text, for notes inside forms and cards. */
  size?: 'sm' | 'md'
  className?: string
}) {
  const t = TONE[tone]
  const Icon = icon ?? t.Icon
  return (
    <div
      role={live ? (tone === 'danger' ? 'alert' : 'status') : 'note'}
      className={cn('flex gap-2 rounded-md px-3 py-2 text-brand-text', size === 'sm' ? 'text-caption' : 'text-body-sm', t.bg, className)}
    >
      <Icon aria-hidden="true" className={cn('size-icon-sm shrink-0', size === 'sm' ? 'mt-px' : 'mt-0.5', t.icon)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}
