/**
 * Layer A: a confirmation step in front of an irreversible action.
 * Presentational only — the host page passes the copy and the handler;
 * nothing runs until the user presses the confirm button. Focus starts on
 * Cancel so Enter never confirms by accident; Esc and the close control
 * cancel unless the action is already running.
 */
import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog'

export interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  summary?: { label: string; value: string }[]
  warnings?: string[]
  consequence: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  busy?: boolean
  tone?: 'default' | 'danger'
}

export function ConfirmActionDialog({
  open, onOpenChange, title, summary, warnings, consequence, confirmLabel, cancelLabel = 'Cancelar', onConfirm, busy = false, tone = 'default',
}: ConfirmActionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Controlled dialog without a Radix Trigger: remember the opener so focus can go back to it.
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) openerRef.current = document.activeElement as HTMLElement | null
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-w-md max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-lg"
        onOpenAutoFocus={(e: Event) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={(e: Event) => {
          e.preventDefault()
          openerRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug">{title}</DialogTitle>
          <DialogDescription className="text-brand-text-secondary">{consequence}</DialogDescription>
        </DialogHeader>

        {summary && summary.length > 0 && (
          <dl className="rounded-lg border border-brand-border divide-y divide-brand-border text-sm">
            {summary.map((item) => (
              <div key={item.label} className="flex justify-between gap-3 px-3 py-2">
                <dt className="text-brand-text-muted">{item.label}</dt>
                <dd className="font-medium text-brand-text text-right break-words min-w-0">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {warnings && warnings.length > 0 && (
          <ul className="space-y-2 rounded-lg border border-brand-warning/25 bg-brand-warning/10 p-3 text-sm text-brand-text">
            {warnings.map((w) => (
              <li key={w} className="flex gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-brand-warning" aria-hidden="true" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="min-h-11">
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy} aria-busy={busy} className="min-h-11">
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
