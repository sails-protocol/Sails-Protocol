/**
 * The Market's mobile filter bottom sheet, extracted from pages/Marketplace.tsx (same markup and behavior) so the
 * D1 prototype reuses it instead of building a competing pattern. Marketplace.tsx still has its own inline copy:
 * switching it to this component is a pure refactor deferred while the real Market page must stay untouched.
 * Copy comes from the caller; the trigger is the caller's plain button, so focus is returned to it explicitly.
 */
import type { ReactNode, RefObject } from 'react'
import { X } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet'

export interface MobileFiltersSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef: RefObject<HTMLButtonElement | null>
  title: string
  closeLabel: string
  /** Filter fields; every control applies immediately (no staged "Aplicar"). */
  children: ReactNode
  /** Footer actions (e.g. clear + "Ver N ofertas"), which only close or clear. */
  footer: ReactNode
}

export function MobileFiltersSheet({ open, onOpenChange, triggerRef, title, closeLabel, children, footer }: MobileFiltersSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        hideDefaultClose
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          triggerRef.current?.focus()
        }}
        className="max-h-[85vh] p-0 gap-0 flex flex-col rounded-t-2xl border-brand-border-subtle bg-brand-surface">
        <div className="flex items-center justify-between gap-3 px-4 py-1 border-b border-brand-border-subtle shrink-0">
          <SheetTitle className="text-heading">{title}</SheetTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={closeLabel}
            className="-mr-2 h-11 w-11 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text state-layer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 [&_.toolbar-chip]:w-full [&_.toolbar-chip]:min-h-11">{children}</div>
        <div className="shrink-0 border-t border-brand-border-subtle p-4 flex gap-2">{footer}</div>
      </SheetContent>
    </Sheet>
  )
}

export function MobileField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-label mb-1.5">{label}</div>
      {children}
    </div>
  )
}

export function CountBadge({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="min-w-5 h-5 px-1 flex items-center justify-center bg-primary text-primary-foreground text-xs font-semibold tabular-nums rounded-full">
      {n}
    </span>
  )
}
