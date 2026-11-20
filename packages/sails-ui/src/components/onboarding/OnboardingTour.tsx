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
import { Dialog, DialogContent } from '../ui/dialog'
import { Button } from '../ui/button'
import { ShoppingCart, Lock, MessageCircle, KeyRound, type LucideIcon } from 'lucide-react'

interface Step {
  icon: LucideIcon
  title: string
  description: string
}

const STEPS: Step[] = [
  {
    icon: ShoppingCart,
    title: 'Marketplace P2P com escrow',
    description: 'Compre e venda cripto direto com outra pessoa. Cada trade mostra o tipo de escrow e quem pode assinar a liberação; em uma disputa, um árbitro designado também pode assinar.',
  },
  {
    icon: Lock,
    title: 'Escrow protege os dois lados',
    description: 'Ao negociar, os fundos ficam bloqueados num escrow até o vendedor liberar, depois que o comprador marca o pagamento como enviado. Em caso de problema, um árbitro real pode intervir na disputa.',
  },
  {
    icon: MessageCircle,
    title: 'Chat direto, com criptografia opcional',
    description: 'Combine os detalhes do pagamento pelo chat da negociação. Dá pra ativar criptografia de ponta a ponta a qualquer momento, direto no cabeçalho do chat.',
  },
  {
    icon: KeyRound,
    title: 'Sua chave é sua identidade',
    description: 'A mesma chave que você usou pra conectar assina suas ações e é sua identidade na rede P2P — igual ao Keet. Ela fica criptografada neste navegador e não é enviada ao Sails Protocol.',
  },
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
          <div className="w-14 h-14 rounded-full bg-brand-orange-accent/10 border border-brand-orange-accent/25 flex items-center justify-center mb-4">
            <current.icon className="h-6 w-6 text-brand-orange-accent" />
          </div>
          <h2 className="text-lg font-display font-semibold text-brand-text">{current.title}</h2>
          <p className="text-sm text-brand-text-muted mt-2">{current.description}</p>
        </div>

        {/* Step-dot progress — same visual language as PublishOffer.tsx's
            own 3-step wizard indicator, for consistency across the app's
            two multi-step flows. */}
        <div className="flex items-center justify-center gap-1.5 mt-2">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-brand-orange-accent' : 'w-1.5 bg-brand-border'}`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 mt-4">
          <Button variant="outline" onClick={close} className="flex-1 py-2 text-sm">
            Pular
          </Button>
          <Button
            onClick={() => (isLast ? close() : setStep((s) => s + 1))}
            className="flex-1 py-2 text-sm"
          >
            {isLast ? 'Começar' : 'Próximo'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
