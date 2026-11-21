/**
 * Escrow deadline timer (UX-029, DECISIONS.md "Temporizador no fluxo do trade"). Only `escrow.expiresAt`
 * (set by the nó Sails at lock: lockedAt + timelockHours) and `timelockHours`: no payment window,
 * auto-cancel or release/appeal deadline exists in the contract yet (UX-012, issue #740), so none is shown.
 *
 * What the deadline does, from the backend (escrow.service.ts sweepExpiredEscrows, escrow-lifecycle.ts):
 * the sweeper only looks at FUNDS_LOCKED escrows past expiresAt and either refunds the seller (rails that
 * can) or moves them to EXPIRED (MULTISIG / LIGHTNING_HODL / SAFE_GUARD_EVM, recovery by dispute).
 * PAYMENT_PENDING and DISPUTED never expire by this deadline. The copy below says only that.
 */
import type { EscrowStatus } from '../types'
import type { Explanation } from '../components/ui/trustTypes'
import { formatDateTime } from './format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Statuses where the timer renders. Terminal ones and EXPIRED (its own stage card says it) never do. */
export const DEADLINE_STATUSES: ReadonlySet<EscrowStatus> = new Set<EscrowStatus>(['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'DISPUTED'])

export type DeadlineTone = 'neutral' | 'attention' | 'expired'

/** Attention when under 1 h or under 10 % of the total remains (both strict: exactly 1 h / 10 % is still neutral). */
export function deadlineTone(remainingMs: number, totalMs: number | null): DeadlineTone {
  if (remainingMs <= 0) return 'expired'
  if (remainingMs < HOUR) return 'attention'
  if (totalMs !== null && totalMs > 0 && remainingMs < totalMs * 0.1) return 'attention'
  return 'neutral'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Non-breaking space between number and unit. "39 h 05 min" from 1 h up (minutes floored); "12 min 05 s" / "42 s" under 1 h (seconds rounded up, so a live deadline never reads 0). */
export function formatRemaining(ms: number): string {
  if (ms >= HOUR) {
    const totalMin = Math.floor(ms / MINUTE)
    return `${Math.floor(totalMin / 60)}\u00a0h ${pad(totalMin % 60)}\u00a0min`
  }
  const totalSec = Math.min(3599, Math.max(0, Math.ceil(ms / 1000)))
  const m = Math.floor(totalSec / 60)
  return m > 0 ? `${m}\u00a0min ${pad(totalSec % 60)}\u00a0s` : `${totalSec}\u00a0s`
}

/** Key moments for the screen-reader status, in order: 0 none, 1 attention, 2 ≤ 10 min, 3 ≤ 1 min, 4 expired. */
export function deadlineMilestone(remainingMs: number, tone: DeadlineTone): 0 | 1 | 2 | 3 | 4 {
  if (remainingMs <= 0) return 4
  if (remainingMs <= MINUTE) return 3
  if (remainingMs <= 10 * MINUTE) return 2
  return tone === 'attention' ? 1 : 0
}

export const MILESTONE_ANNOUNCEMENT: Record<1 | 2 | 3 | 4, string> = {
  1: 'Prazo do escrow: falta pouco.',
  2: 'Faltam 10 minutos ou menos para o fim do prazo do escrow.',
  3: 'Falta 1 minuto ou menos para o fim do prazo do escrow.',
  4: 'Prazo do escrow encerrado.',
}

export type EscrowDeadlineView =
  | { kind: 'pending'; text: string; explanation: Explanation }
  | { kind: 'unavailable'; text: string; explanation: Explanation }
  | {
      kind: 'active'
      remainingMs: number
      tone: DeadlineTone
      remainingText: string
      deadlineText: string
      /** Elapsed share 0-100, only when the total is known. */
      progress: number | null
      explanation: Explanation
    }

const FOOTER = 'Esta interface não age sozinha quando o prazo acaba.'

function explanation(status: EscrowStatus, timelockHours: number | null): Explanation {
  const lines: string[] = []
  if (timelockHours) lines.push(`Contado pelo nó Sails a partir do bloqueio dos fundos: ${timelockHours}\u00a0h.`)
  if (status === 'CREATED') lines.push('Só começa a contar quando os fundos forem bloqueados.')
  if (status === 'CREATED' || status === 'FUNDS_LOCKED') {
    lines.push('Se o prazo passar com os fundos bloqueados e o pagamento ainda não marcado como enviado, o escrow deixa de aceitar as etapas normais do trade.')
  } else if (status === 'PAYMENT_PENDING') {
    lines.push('Com o pagamento já marcado como enviado, o nó Sails não encerra o escrow por este prazo: o trade segue pela liberação ou por disputa.')
  } else if (status === 'DISPUTED') {
    lines.push('Em disputa, o nó Sails não encerra o escrow por este prazo: a resolução segue pela disputa.')
  }
  return { title: 'Prazo do escrow', lines, footer: FOOTER }
}

export function escrowDeadlineView(
  i: { expiresAt: string | null; timelockHours: number | null | undefined; status: EscrowStatus },
  now: number,
): EscrowDeadlineView | null {
  if (!DEADLINE_STATUSES.has(i.status)) return null
  const hours = typeof i.timelockHours === 'number' && i.timelockHours > 0 ? i.timelockHours : null
  const exp = i.expiresAt ? Date.parse(i.expiresAt) : NaN
  const why = explanation(i.status, hours)
  if (Number.isNaN(exp)) {
    // expiresAt is only set at lock: before it, the total is the whole story.
    if (i.status === 'CREATED' && !i.expiresAt && hours) return { kind: 'pending', text: `${hours}\u00a0h a partir do bloqueio dos fundos`, explanation: why }
    return { kind: 'unavailable', text: 'Prazo do escrow indisponível', explanation: why }
  }
  const remainingMs = exp - now
  const totalMs = hours ? hours * HOUR : null
  const tone = deadlineTone(remainingMs, totalMs)
  const progress = totalMs ? Math.min(100, Math.max(0, Math.round(((totalMs - remainingMs) / totalMs) * 100))) : null
  return {
    kind: 'active',
    remainingMs,
    tone,
    remainingText: tone === 'expired' ? 'Encerrado' : formatRemaining(remainingMs),
    deadlineText: `${tone === 'expired' ? 'em' : 'até'} ${formatDateTime(i.expiresAt!, new Date(now))}`,
    progress,
    explanation: why,
  }
}
