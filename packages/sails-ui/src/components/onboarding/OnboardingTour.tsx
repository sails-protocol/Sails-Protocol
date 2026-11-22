/**
 * First-time product tour (2026-08-04) — the last item on the SLC audit
 * list: a first-time user connecting for the first time had zero
 * in-app guidance past Login.tsx's own value-prop copy. Every claim
 * below is a real, already-shipped capability (not aspirational): the
 * escrow flow, the assigned-arbiter dispute path, and the chat's
 * opt-in end-to-end encryption were all verified live earlier this
 * pass — see docs/BACKLOG.md's OpenP2P/OpenSettlement rows.
 *
 * Shown automatically once per browser after a first successful login
 * (Layout.tsx owns that trigger + the localStorage flag, lib/onboarding.ts).
 * Replayable anytime via the "?" button in Topbar (desktop) and Layout's
 * own mobile header — this component itself is a plain controlled Dialog,
 * it doesn't know or care why it's open.
 */
import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { ShoppingCart, Lock, MessageCircle, KeyRound, type LucideIcon } from 'lucide-react'
import { t, type MessageKey } from '../../i18n'

interface Step {
  icon: LucideIcon
  title: MessageKey
  description: MessageKey
}

// Keys, not copy: translated at render time (shell.onboarding.*).
const STEPS: Step[] = [
  { icon: ShoppingCart, title: 'shell.onboarding.marketplace.title', description: 'shell.onboarding.marketplace.description' },
  { icon: Lock, title: 'shell.onboarding.escrow.title', description: 'shell.onboarding.escrow.description' },
  { icon: MessageCircle, title: 'shell.onboarding.chat.title', description: 'shell.onboarding.chat.description' },
  { icon: KeyRound, title: 'shell.onboarding.key.title', description: 'shell.onboarding.key.description' },
]

export function OnboardingTour({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [step, setStep] = useState(0)
  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  const close = () => {
    onOpenChange(false)
    // Reset for the next open (replayed via the "?" button) rather than
    // reopening mid-tour on whatever step it was last closed at.
    setTimeout(() => setStep(0), 200)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <div className="flex flex-col items-center text-center pt-2">
          <div aria-hidden="true" className="w-14 h-14 rounded-full bg-brand-orange-accent/10 flex items-center justify-center mb-4">
            <current.icon className="size-icon-lg text-brand-orange-accent" />
          </div>
          <DialogTitle className="font-display">{t(current.title)}</DialogTitle>
          <DialogDescription className="text-brand-text-muted mt-2">{t(current.description)}</DialogDescription>
        </div>

        {/* Step-dot progress — same visual language as PublishOffer.tsx's
            own 3-step wizard indicator, for consistency across the app's
            two multi-step flows. */}
        <div className="flex items-center justify-center gap-1.5 mt-2">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-[width,background-color] duration-medium ease-standard ${i === step ? 'w-6 bg-brand-orange-accent' : 'w-1.5 bg-brand-border'}`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 mt-4">
          <Button variant="outline" onClick={close} className="flex-1 py-2 text-sm">
            {t('shell.onboarding.skip')}
          </Button>
          <Button
            onClick={() => (isLast ? close() : setStep((s) => s + 1))}
            className="flex-1 py-2 text-sm"
          >
            {isLast ? t('shell.onboarding.start') : t('shell.onboarding.next')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
