import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2, Wallet, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export type StateKind = 'loading' | 'empty' | 'error' | 'signedOut'

const DEFAULT_ICON: Record<StateKind, LucideIcon> = { loading: Loader2, empty: Inbox, error: AlertTriangle, signedOut: Wallet }

/** Loading is announced politely, an error assertively; empty and signed-out are static content. */
export function stateRole(kind: StateKind): 'status' | 'alert' | undefined {
  return kind === 'loading' ? 'status' : kind === 'error' ? 'alert' : undefined
}

export interface StateBlockProps {
  kind: StateKind
  title: string
  description?: ReactNode
  /** Primary action (retry, connect, explore). The caller supplies the element and its copy. */
  action?: ReactNode
  secondaryAction?: ReactNode
  icon?: LucideIcon
  /** Render without its own surface, when it already sits inside a card or table. */
  bare?: boolean
  className?: string
}

/**
 * Layer A: the one loading / empty / error / signed-out block used inside every content surface.
 * No copy of its own (everything through props), tokens only.
 */
export function StateBlock({ kind, title, description, action, secondaryAction, icon, bare, className }: StateBlockProps) {
  const Icon = icon ?? DEFAULT_ICON[kind]
  return (
    <div
      role={stateRole(kind)}
      className={cn(
        'flex flex-col items-center gap-2 px-6 py-12 text-center',
        !bare && 'rounded-lg border border-brand-border-subtle bg-brand-surface',
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('h-5 w-5', kind === 'loading' && 'motion-safe:animate-spin', kind === 'error' ? 'text-brand-danger' : 'text-brand-text-muted')}
      />
      <p className="text-section-title">{title}</p>
      {description && <p className="text-body-sm text-brand-text-secondary max-w-sm">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}
