import { useEffect, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { IdentityAvatarStyle } from '../../lib/identityAvatar'
import { AVATAR_STYLES } from '../../lib/avatarStyle'
import { AVATAR_VARIANTS, seedFor, type AvatarChoice } from '../../lib/avatarChoice'
import { cn } from '../../lib/utils'
import { IdentityAvatar } from './IdentityAvatar'
import { SegmentedControl } from './SegmentedControl'
import { Radio, RadioGroup } from './radio-group'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'

export interface AvatarDeckCopy {
  title: string
  description: string
  styleLabel: string
  styles: Record<IdentityAvatarStyle, string>
  variantsLabel: string
  /** Accessible name of variant `n` (1-based). */
  variantLabel: (n: number) => string
  confirm: string
  cancel: string
}

/**
 * Layer A: the avatar deck. Pick a style (segmented) and one of AVATAR_VARIANTS variants drawn from
 * `publicKey` (radio cards: native radios, arrow keys from the browser; checked = brand blue ring + check).
 * The draft only applies on `confirm`; Cancel, Esc or the close button discard it. Dialog at md+, bottom
 * sheet below (`sheet`). All copy, and the honesty `note`, come from the host.
 */
export function AvatarDeck({ open, onOpenChange, publicKey, value, onConfirm, copy, note, sheet }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  publicKey: string
  value: AvatarChoice
  onConfirm: (choice: AvatarChoice) => void
  copy: AvatarDeckCopy
  note?: ReactNode
  sheet: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { if (open) setDraft(value) }, [open, value])

  const body = (
    <>
      <div className="flex justify-center">
        <IdentityAvatar seed={seedFor(publicKey, draft.variant)} style={draft.style} size={64} label={`${copy.styles[draft.style]}, ${copy.variantLabel(draft.variant + 1)}`} />
      </div>
      <SegmentedControl
        label={copy.styleLabel}
        options={AVATAR_STYLES.map((s) => ({ value: s, label: copy.styles[s] }))}
        value={draft.style}
        onChange={(style) => setDraft((d) => ({ ...d, style }))}
        className="self-center justify-self-center"
      />
      <RadioGroup legend={copy.variantsLabel} legendHidden listClassName="grid grid-cols-4 gap-2">
        {Array.from({ length: AVATAR_VARIANTS }, (_, n) => {
          const checked = draft.variant === n
          return (
            <label
              key={n}
              className={cn(
                'relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-transparent p-2 transition-colors duration-short state-layer field-focus-within',
                checked ? 'bg-brand-selected' : 'bg-brand-tonal'
              )}
            >
              {/* Native radio over the whole card: invisible, but it carries focus, arrows and "n of 8". */}
              <Radio
                name="avatar-variant"
                value={n}
                checked={checked}
                onChange={() => setDraft((d) => ({ ...d, variant: n }))}
                aria-label={copy.variantLabel(n + 1)}
                className="absolute inset-0 m-0 size-full cursor-pointer rounded-lg opacity-0"
              />
              <IdentityAvatar seed={seedFor(publicKey, n)} style={draft.style} size={48} className={cn(checked && 'ring-2 ring-brand-checked')} />
              {checked && (
                <span aria-hidden="true" className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-brand-checked text-brand-on-checked">
                  <Check className="size-icon-sm" />
                </span>
              )}
            </label>
          )
        })}
      </RadioGroup>
      {note}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" className="touch:min-h-11" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
        <Button className="touch:min-h-11" onClick={() => onConfirm(draft)}>{copy.confirm}</Button>
      </div>
    </>
  )

  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-xl border-brand-border-subtle px-4 pt-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="pr-10">
            <SheetTitle>{copy.title}</SheetTitle>
            <SheetDescription className="mt-1 text-body-sm text-brand-text-secondary">{copy.description}</SheetDescription>
          </div>
          {body}
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="pr-8">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="mt-1 text-body-sm text-brand-text-secondary">{copy.description}</DialogDescription>
        </div>
        {body}
      </DialogContent>
    </Dialog>
  )
}
