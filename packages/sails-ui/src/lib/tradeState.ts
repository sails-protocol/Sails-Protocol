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
}

const ACTIVE_ESCROW = new Set<EscrowStatus>(['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'])
const ACTIVE_OR_EXPIRED = new Set<EscrowStatus>([...ACTIVE_ESCROW, 'EXPIRED'])

// Only from the real round kind: never assume a round is a release.
const ROUND_CHIP: Record<SigningRoundKind, string> = {
  release: 'Liberação em andamento',
  refund: 'Reembolso em andamento',
  split: 'Divisão em andamento',
  unknown: 'Rodada de assinatura em andamento',
}

// Each label describes the state now (what is awaited), matching the timeline's current step.
function statusChip(i: TradeStateInput, cancelled: boolean): TradeState['status'] {
  if (cancelled) return { label: 'Cancelado', tone: 'neutral' }
  // A dispute stays the headline state while any round exists; terminal statuses have no open round to show.
  if (i.signingRoundKind && i.escrowStatus && ACTIVE_OR_EXPIRED.has(i.escrowStatus)) {
    return { label: ROUND_CHIP[i.signingRoundKind], tone: i.signingRoundKind === 'unknown' ? 'neutral' : 'warning' }
  }
  switch (i.escrowStatus) {
    case null: return { label: 'Aguardando escrow', tone: 'neutral' }
    case 'CREATED': return { label: 'Aguardando bloqueio dos fundos', tone: 'neutral' }
    case 'FUNDS_LOCKED': return { label: 'Aguardando pagamento', tone: 'info' }
    case 'PAYMENT_PENDING': return { label: 'Aguardando liberação', tone: 'warning' }
    // A recorded escrow status, not a settlement or payment confirmation: neutral, same words as the timeline.
    case 'COMPLETED': return { label: 'Escrow marcado como concluído', tone: 'neutral' }
    case 'DISPUTED': return { label: 'Em disputa', tone: 'danger' }
    case 'REFUNDED': return { label: 'Reembolsado', tone: 'neutral' }
    case 'SPLIT': return { label: 'Dividido entre as partes', tone: 'neutral' }
    case 'EXPIRED': return { label: 'Prazo encerrado', tone: 'warning' }
  }
}

function steps(i: TradeStateInput, cancelled: boolean, locked: boolean): TradeStep[] {
  const s = i.escrowStatus
  const opened: TradeStep = { id: 'opened', label: 'Trade aberto', state: 'done', at: i.createdAt }
  const escrow: TradeStep = { id: 'escrow', label: 'Escrow criado', state: s ? 'done' : 'upcoming', at: s ? i.escrowCreatedAt : null }
  const lockedStep: TradeStep = { id: 'locked', label: 'Fundos registrados como bloqueados', state: locked ? 'done' : 'upcoming', at: i.lockedAt }

  // Side branches: keep only what the records prove happened, then the outcome.
  // Whether payment was marked as sent before a dispute is not recorded, so that step is omitted.
  const outcome: Omit<TradeStep, 'id'> | null = cancelled ? { label: 'Trade cancelado', state: 'done', at: i.cancelledAt }
    : s === 'DISPUTED' ? { label: 'Em disputa', state: 'current', tone: 'danger' }
    : s === 'EXPIRED' ? { label: 'Prazo do escrow encerrado', state: 'current', tone: 'warning' }
    : s === 'REFUNDED' ? { label: 'Escrow marcado como reembolsado', state: 'done', at: i.cancelledAt }
    : s === 'SPLIT' ? { label: 'Escrow dividido entre as partes', state: 'done', at: i.completedAt }
    : null
  if (outcome) {
    return [opened, ...(s ? [escrow] : []), ...(locked ? [lockedStep] : []), { id: 'outcome', ...outcome }]
  }

  const paid = s === 'PAYMENT_PENDING' || s === 'COMPLETED'
  const done = s === 'COMPLETED'
  const list: TradeStep[] = [
    opened, escrow, lockedStep,
    { id: 'paymentSent', label: 'Pagamento marcado como enviado', state: paid ? 'done' : 'upcoming' },
    { id: 'completed', label: 'Escrow marcado como concluído', state: done ? 'done' : 'upcoming', at: done ? i.completedAt : null },
  ]
  const next = list.find((x) => x.state === 'upcoming')
  if (next) next.state = 'current'
  return list
}

function action(i: TradeStateInput, cancelled: boolean): CurrentAction {
  if (cancelled) {
    return { tone: 'terminal', actorLabel: 'Encerrado', title: 'Trade cancelado', description: 'Não há mais ações disponíveis neste trade.', canDispute: false }
  }
  if (!i.escrowStatus) {
    return i.isSeller
      ? { tone: 'action', actorLabel: 'Ação necessária — vendedor', title: 'Criar o escrow deste trade', description: 'Registra o escrow do trade no servidor. Não move fundos: depois você deposita e registra o bloqueio dos fundos.', primary: { action: 'createEscrow', label: 'Criar Escrow' }, canDispute: false }
      : { tone: 'waiting', actorLabel: i.isBuyer ? 'Aguardando a contraparte' : 'Acompanhamento', title: 'Aguardando o vendedor criar o escrow', description: 'Não envie nenhum pagamento antes de os fundos estarem bloqueados no escrow.', canDispute: false }
  }
  const view = deriveCurrentAction({ status: i.escrowStatus, isBuyer: i.isBuyer, isSeller: i.isSeller, releaseUnavailable: i.releaseUnavailable })
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
  }
}
