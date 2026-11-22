/**
 * Toast policy (DESIGN_SYSTEM.md 5.3): how long a toast stays. Short for a
 * local confirmation, longer for warnings/errors, longest when it carries an
 * action (WCAG 2.2.1: time to reach it). Pure, so it is unit-tested.
 */
export type ToastKind = 'default' | 'success' | 'info' | 'warning' | 'error'

export const TOAST_MS = { short: 4000, long: 6000, action: 8000 } as const

export function toastDuration(kind: ToastKind, hasAction: boolean): number {
  if (hasAction) return TOAST_MS.action
  return kind === 'warning' || kind === 'error' ? TOAST_MS.long : TOAST_MS.short
}
