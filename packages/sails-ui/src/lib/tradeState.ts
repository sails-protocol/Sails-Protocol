/**
 * One derivation for the trade page: the header status chip, the timeline
 * steps, the current action card and the payment-instructions gating all
 * come from here, so they can never disagree with each other.
 *
 * Source of truth is the escrow status when an escrow exists (the page
 * patches the escrow after each action but does not refetch the trade, so
 * trade.status can lag behind), otherwise trade.status. Timestamps are only
 * the ones the records carry; no per-transition time is invented.
 */
import type { EscrowStatus, TradeStatus } from '../types'
import { deriveCurrentAction, type CurrentAction } from './currentAction'

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'
export type StepState = 'done' | 'current' | 'upcoming'

export interface TradeStep {
  id: 'opened' | 'escrow' | 'locked' | 'paymentSent' | 'completed' | 'outcome'
  label: string
  state: StepState
  at?: string | null
  tone?: 'danger' | 'warning'
}

/** hidden: buyer, funds not yet recorded as locked. inactive: no longer an instruction to act on. */
export type InstructionsVisibility = 'hidden' | 'active' | 'inactive'

/** Kind of the pending signing round as the server reported it; 'unknown' for any other value, null when none. */
export type SigningRoundKind = 'release' | 'refund' | 'split' | 'unknown'

export interface TradeStateInput {
  tradeStatus: TradeStatus
  escrowStatus: EscrowStatus | null
  signingRoundKind: SigningRoundKind | null
  isBuyer: boolean
  isSeller: boolean
  releaseUnavailable?: boolean
  /** A resolved dispute this viewer may still appeal: a terminal card must not say nothing is left to do. */
  appealAvailable?: boolean
  /** true only once checked and none is registered (not while still checking). */
  payoutAddressMissing?: boolean
  /** The check itself failed (not a 404): the address is unknown, so never prompt to register. */
  payoutAddressCheckFailed?: boolean
  createdAt: string
  escrowCreatedAt?: string | null
  lockedAt?: string | null
  completedAt?: string | null
  cancelledAt?: string | null
}

export interface TradeState {
  status: { label: string; tone: StatusTone }
  steps: TradeStep[]
  action: CurrentAction
  /** Buyer-only step in the action card while release can still happen. */
  payoutStep: 'missing' | 'checkFailed' | null
  instructions: InstructionsVisibility
  /** Open for the normal trade steps: not cancelled, disputed, expired or terminal. */
  open: boolean
}

/**
 * The one name of each recorded escrow state: header chip, timeline, specs,
 * confirmation dialogs and chat system rows all use it. Recorded by the
 * server, not verified by it: "Pagamento marcado como enviado" is not a
 * payment confirmation and "concluído" is not settlement finality.
 */
export const ESCROW_STATE_LABEL: Record<EscrowStatus, string> = {
  CREATED: 'Escrow criado',
  FUNDS_LOCKED: 'Fundos registrados como bloqueados',
  PAYMENT_PENDING: 'Pagamento marcado como enviado',
  COMPLETED: 'Escrow marcado como concluído',
  DISPUTED: 'Em disputa',
  REFUNDED: 'Escrow marcado como reembolsado',
  SPLIT: 'Escrow marcado como dividido entre as partes',
  EXPIRED: 'Prazo do escrow encerrado',
}
const NO_ESCROW_LABEL = 'Escrow ainda não criado'
const CANCELLED_LABEL = 'Trade cancelado'

const ACTIVE_ESCROW = new Set<EscrowStatus>(['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'])
const ACTIVE_OR_EXPIRED = new Set<EscrowStatus>([...ACTIVE_ESCROW, 'EXPIRED'])

// Only from the real round kind: never assume a round is a release.
const ROUND_CHIP: Record<SigningRoundKind, string> = {
  release: 'Liberação em andamento',
  refund: 'Reembolso em andamento',
  split: 'Divisão em andamento',
  unknown: 'Rodada de assinatura em andamento',
}

// The chip names the recorded state (ESCROW_STATE_LABEL); who acts next is the action card's job.
const CHIP_TONE: Record<EscrowStatus, StatusTone> = {
  CREATED: 'neutral', FUNDS_LOCKED: 'info', PAYMENT_PENDING: 'warning',
  // A recorded escrow status, not a settlement or payment confirmation: neutral.
  COMPLETED: 'neutral', DISPUTED: 'danger', REFUNDED: 'neutral', SPLIT: 'neutral', EXPIRED: 'warning',
}

function statusChip(i: TradeStateInput, cancelled: boolean): TradeState['status'] {
  if (cancelled) return { label: CANCELLED_LABEL, tone: 'neutral' }
  // A dispute stays the headline state while any round exists; terminal statuses have no open round to show.
  if (i.signingRoundKind && i.escrowStatus && ACTIVE_OR_EXPIRED.has(i.escrowStatus)) {
    return { label: ROUND_CHIP[i.signingRoundKind], tone: i.signingRoundKind === 'unknown' ? 'neutral' : 'warning' }
  }
  if (!i.escrowStatus) return { label: NO_ESCROW_LABEL, tone: 'neutral' }
  return { label: ESCROW_STATE_LABEL[i.escrowStatus], tone: CHIP_TONE[i.escrowStatus] }
}

function steps(i: TradeStateInput, cancelled: boolean, locked: boolean): TradeStep[] {
  const s = i.escrowStatus
  const L = ESCROW_STATE_LABEL
  const opened: TradeStep = { id: 'opened', label: 'Trade aberto', state: 'done', at: i.createdAt }
  const escrow: TradeStep = { id: 'escrow', label: L.CREATED, state: s ? 'done' : 'upcoming', at: s ? i.escrowCreatedAt : null }
  const lockedStep: TradeStep = { id: 'locked', label: L.FUNDS_LOCKED, state: locked ? 'done' : 'upcoming', at: i.lockedAt }

  // Side branches: keep only what the records prove happened, then the outcome.
  // Whether payment was marked as sent before a dispute is not recorded, so that step is omitted.
  const outcome: Omit<TradeStep, 'id'> | null = cancelled ? { label: CANCELLED_LABEL, state: 'done', at: i.cancelledAt }
    : s === 'DISPUTED' ? { label: L.DISPUTED, state: 'current', tone: 'danger' }
    : s === 'EXPIRED' ? { label: L.EXPIRED, state: 'current', tone: 'warning' }
    : s === 'REFUNDED' ? { label: L.REFUNDED, state: 'done', at: i.cancelledAt }
    : s === 'SPLIT' ? { label: L.SPLIT, state: 'done', at: i.completedAt }
    : null
  if (outcome) {
    return [opened, ...(s ? [escrow] : []), ...(locked ? [lockedStep] : []), { id: 'outcome', ...outcome }]
  }

  const paid = s === 'PAYMENT_PENDING' || s === 'COMPLETED'
  const done = s === 'COMPLETED'
  const list: TradeStep[] = [
    opened, escrow, lockedStep,
    { id: 'paymentSent', label: L.PAYMENT_PENDING, state: paid ? 'done' : 'upcoming' },
    { id: 'completed', label: L.COMPLETED, state: done ? 'done' : 'upcoming', at: done ? i.completedAt : null },
  ]
  const next = list.find((x) => x.state === 'upcoming')
  if (next) next.state = 'current'
  return list
}

function action(i: TradeStateInput, cancelled: boolean): CurrentAction {
  if (cancelled) {
    return { tone: 'terminal', actorLabel: 'Encerrado', title: CANCELLED_LABEL, description: 'Não há mais ações disponíveis neste trade.', canDispute: false }
  }
  if (!i.escrowStatus) {
    return i.isSeller
      ? { tone: 'action', actorLabel: 'Ação necessária — vendedor', title: 'Criar o escrow deste trade', description: 'Registra o escrow do trade no servidor. Não move fundos: depois você deposita e registra o bloqueio dos fundos.', primary: { action: 'createEscrow', label: 'Criar escrow' }, canDispute: false }
      : { tone: 'waiting', actorLabel: i.isBuyer ? 'Aguardando a contraparte' : 'Acompanhamento', title: 'Aguardando o vendedor criar o escrow', description: 'Não envie nenhum pagamento antes de os fundos estarem bloqueados no escrow.', canDispute: false }
  }
  const view = deriveCurrentAction({ status: i.escrowStatus, isBuyer: i.isBuyer, isSeller: i.isSeller, releaseUnavailable: i.releaseUnavailable })
  // A resolved dispute can still be appealed (TradeDisputePanel): never say nothing is left to do next to that button.
  if (view.tone === 'terminal' && i.appealAvailable) {
    return { ...view, actorLabel: 'Disputa resolvida', description: 'A única ação ainda disponível neste trade é apelar da decisão da disputa, na seção da disputa.' }
  }
  // While a signing round exists, its card is the next step; never offer a second release.
  return i.signingRoundKind ? { ...view, primary: undefined } : view
}

export function deriveTradeState(i: TradeStateInput): TradeState {
  // A refunded escrow also projects the trade to CANCELLED; the escrow outcome is the more specific one.
  const cancelled = i.tradeStatus === 'CANCELLED' && (!i.escrowStatus || ACTIVE_ESCROW.has(i.escrowStatus))
  const s = i.escrowStatus
  const locked = !!i.lockedAt || s === 'FUNDS_LOCKED' || s === 'PAYMENT_PENDING' || s === 'COMPLETED'
  const open = !cancelled && (s === null || ACTIVE_ESCROW.has(s))
  const instructions: InstructionsVisibility = !open
    ? (locked || i.isSeller ? 'inactive' : 'hidden')
    : i.isSeller || s === 'FUNDS_LOCKED' || s === 'PAYMENT_PENDING' ? 'active' : 'hidden'
  return {
    status: statusChip(i, cancelled),
    steps: steps(i, cancelled, locked),
    action: action(i, cancelled),
    payoutStep: !i.isBuyer || !open ? null : i.payoutAddressCheckFailed ? 'checkFailed' : i.payoutAddressMissing ? 'missing' : null,
    instructions,
    open,
  }
}
