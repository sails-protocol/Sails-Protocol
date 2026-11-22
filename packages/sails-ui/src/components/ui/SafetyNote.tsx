/**
 * Layer A: a calm, always-visible safety note (not a tooltip). The host
 * passes the copy. Since 2026-11-20 it is the Alert primitive (tint + icon, no
 * border, role=note) at caption size; the API stays.
 */
import type { ReactNode } from 'react'
import { Alert } from './alert'

export function SafetyNote({ tone = 'info', children, className }: { tone?: 'info' | 'warning'; children: ReactNode; className?: string }) {
  return <Alert tone={tone} size="sm" className={className}>{children}</Alert>
}
