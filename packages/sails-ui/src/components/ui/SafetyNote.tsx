/**
 * Layer A: a calm, always-visible safety note (not a tooltip). The host
 * passes the copy; themes restyle it through the info/warning tokens.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SafetyNote({ tone = 'info', children, className }: { tone?: 'info' | 'warning'; children: ReactNode; className?: string }) {
  const Icon = tone === 'warning' ? AlertTriangle : Info
  return (
    <p
      role="note"
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-xs text-brand-text',
        tone === 'warning' ? 'border-brand-warning/25 bg-brand-warning/10' : 'border-brand-info/25 bg-brand-info/10',
        className,
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', tone === 'warning' ? 'text-brand-warning' : 'text-brand-info')} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
