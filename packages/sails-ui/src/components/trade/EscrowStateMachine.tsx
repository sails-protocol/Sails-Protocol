/**
 * Visualizes escrow.service.ts's real VALID_TRANSITIONS happy path
 * (CREATED -> FUNDS_LOCKED -> PAYMENT_PENDING -> COMPLETED). DISPUTED/
 * REFUNDED are real side-branches from that same state machine, not
 * additional steps on this track — shown as a separate banner instead
 * of forced into a 4-step line that doesn't represent them well.
 */
import type { EscrowStatus } from '../../types'
import { AlertTriangle, Undo2, Check } from 'lucide-react'

const HAPPY_PATH: { status: EscrowStatus; label: string }[] = [
  { status: 'CREATED', label: 'Criado' },
  { status: 'FUNDS_LOCKED', label: 'Bloqueado' },
  { status: 'PAYMENT_PENDING', label: 'Pagamento' },
  { status: 'COMPLETED', label: 'Concluído' },
]

export function EscrowStateMachine({ status }: { status: EscrowStatus }) {
  if (status === 'DISPUTED' || status === 'REFUNDED' || status === 'EXPIRED') {
    // Missão 11 Fase 7.3 (cumulative audit) — EXPIRED added: without an
    // explicit branch, HAPPY_PATH.findIndex() below returns -1 for this
    // status, silently rendering every step as "pending" — misleading
    // for an escrow that genuinely has real locked funds and needs
    // seller action, not one that simply hasn't started yet.
    const styles = status === 'DISPUTED'
      ? 'bg-red-500/10 text-red-500 border-red-500/25'
      : status === 'EXPIRED'
        ? 'bg-orange-500/10 text-orange-500 border-orange-500/25'
        : 'bg-brand-elevated text-brand-text-secondary border-brand-border'
    const message = status === 'DISPUTED'
      ? 'Este trade está em disputa — aguardando resolução do árbitro.'
      : status === 'EXPIRED'
        ? 'O prazo deste escrow expirou sem resolução cooperativa — o vendedor pode iniciar a recuperação abrindo uma disputa.'
        : 'Fundos reembolsados ao vendedor.'
    return (
      <div className={`rounded-lg p-4 text-sm border flex items-start gap-2 ${styles}`}>
        {status === 'REFUNDED' ? <Undo2 className="h-4 w-4 shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
        {message}
      </div>
    )
  }

  const activeIndex = HAPPY_PATH.findIndex((s) => s.status === status)

  return (
    <div>
      <h4 className="text-xs font-semibold text-brand-text-muted uppercase tracking-wider mb-3">Progresso do Escrow</h4>
      <div className="flex items-center">
        {HAPPY_PATH.map((step, i) => {
          const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending'
          return (
            <div key={step.status} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold relative ${
                    state === 'done'
                      ? 'bg-brand-orange text-primary-foreground'
                      : state === 'active'
                        ? 'border-2 border-brand-orange-accent text-brand-orange-accent'
                        : 'border-2 border-brand-border text-brand-text-muted'
                  }`}
                >
                  {state === 'active' && (
                    <span className="absolute inset-0 rounded-full border-2 border-brand-orange-accent animate-ping opacity-40" />
                  )}
                  {state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <span className={`text-[10px] ${state === 'pending' ? 'text-brand-text-muted' : 'text-brand-text-secondary'}`}>{step.label}</span>
              </div>
              {i < HAPPY_PATH.length - 1 && (
                <div className={`flex-1 h-px mx-1 mb-4 ${i < activeIndex ? 'bg-brand-orange-accent' : 'bg-brand-border'}`} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
