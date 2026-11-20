/**
 * One derivation for the trade page: the header status chip, the timeline
 * steps, the current action card and the payment-instructions gating all
 * come from here, so they can never disagree with each other.
 *
 * Source of truth is the escrow status when an escrow exists (the page
 * patches the escrow after each action but does not refetch the trade, so
 * trade.status can lag behind), otherwise trade.status. Timestamps are only
 * the ones the records carry; no per-transition time is invented.
 *
 * Rail (trade workspace): every stage and its evidence come from a record
 * field (Escrow.type for the deposit stage, the pending round for the
 * signatures stage, Escrow.txReleaseId for the transaction stage). The actor
 * of the current stage (the "bastão") is who the protocol waits on, from the
 * same fields; when the records do not say, there is no actor.
 */
import type { DisputeStatus } from '@satsails/p2p-trading-sdk'
import type { EscrowStatus, TradeStatus } from '../types'
import { deriveCurrentAction, type CurrentAction } from './currentAction'

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'
export type StepState = 'done' | 'current' | 'upcoming'

/** Who the current stage waits on. 'parties': either party may act (contest an automatic suggestion). */
export type StepActor = 'buyer' | 'seller' | 'arbiter' | 'parties' | 'unknown'

/** A record field shown on a stage: label plus the value as the record carries it. */
export interface StepEvidence { label: string; value: string; mono?: boolean }

export interface TradeStep {
  id: 'opened' | 'escrow' | 'deposit' | 'locked' | 'paymentSent' | 'signatures' | 'completed' | 'outcome' | 'transaction'
  label: string
  state: StepState
  at?: string | null
  tone?: 'danger' | 'warning'
  /** Only on the current stage, and only when the records say who acts. */
  actors?: StepActor[]
  /** The current stage's action cannot be done in this interface (signing not offered, release unavailable for this escrow type). */
  blocked?: 'signing' | 'release'
  evidence?: StepEvidence[]
}

/** The pending signing round's signers, as getPendingTransaction() returns them. */
export interface RoundSigners {
  requiredSigners: string[]
  signedBy?: { participantId: string; submittedAt: string }[]
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
  // Rail inputs (all optional: without them the rail keeps the base stages and has no actor).
  buyerId?: string
  sellerId?: string
  escrowId?: string | null
  /** Escrow.type: the deposit stage exists only for MULTISIG (a real deposit address and rule). */
  escrowType?: string | null
  /** Escrow.txLockId (+ txLockVout): the funding outpoint the server recorded at lock. */
  txLockId?: string | null
  txLockVout?: number | null
  /** Escrow.txReleaseId: the payout transaction id the server recorded. */
  txReleaseId?: string | null
  round?: RoundSigners | null
  /** This interface cannot sign the pending round for anyone (not verified: MULTISIG_SIGNING_HOLD, mismatch, unsupported type; or disputed). */
  signingUnavailable?: boolean
  dispute?: { status: DisputeStatus; arbiterId: string | null; autoResolutionDeadline?: string | null } | null
  /** Clock for deadline checks (ms); defaults to Date.now(). */
  now?: number
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

/** Escrow.txReleaseId: the payout (release/refund/split) transaction the server recorded. Distinct from the deposit (txLockId). */
export const PAYOUT_TX_LABEL = 'Transação de pagamento registrada pelo servidor'

/**
 * Escrow.custodyModel, as the server's providers declare it (getCustodyModelForType():
 * multisig/lightning-hodl/safe-guard-evm/wdk-settlement providers), in plain words. Any
 * other value or null is shown as not declared: never guessed as custodial or not.
 */
export const CUSTODY_MODEL_LABEL: Record<string, string> = {
  'client-held-buyer-seller-keys-server-held-arbiter': 'Comprador e vendedor guardam as próprias chaves; a chave de árbitro fica com o servidor',
  'client-held-buyer-seller-keys-server-held-kms-arbiter': 'Comprador e vendedor guardam as próprias chaves; a chave de árbitro fica com o servidor, num serviço de gestão de chaves (KMS)',
  'server-custodial-reference-implementation': 'Custódia do servidor (implementação de referência)',
}
export function custodyModelLabel(model: string | null | undefined): string {
  return (model && Object.prototype.hasOwnProperty.call(CUSTODY_MODEL_LABEL, model) ? CUSTODY_MODEL_LABEL[model] : null) ?? 'Não declarado pelo provedor'
}
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

const ROUND_EVIDENCE: Record<SigningRoundKind, string> = {
  release: 'Rodada de liberação',
  refund: 'Rodada de reembolso',
  split: 'Rodada de divisão',
  unknown: 'Rodada de assinatura',
}

/** "1 de 2 assinaturas", counting only required signers that signed. */
function roundProgress(r: RoundSigners): string {
  const signed = r.requiredSigners.filter((id) => (r.signedBy ?? []).some((x) => x.participantId === id)).length
  return `${signed} de ${r.requiredSigners.length} assinaturas`
}

/** Required signers that have not signed, as roles; an id the trade does not identify stays 'unknown'. */
function pendingSigners(i: TradeStateInput, r: RoundSigners): StepActor[] {
  const roles = r.requiredSigners
    .filter((id) => !(r.signedBy ?? []).some((x) => x.participantId === id))
    .map((id): StepActor => id === i.buyerId ? 'buyer' : id === i.sellerId ? 'seller' : id === i.dispute?.arbiterId ? 'arbiter' : 'unknown')
  return [...new Set(roles)]
}

// Who the current stage waits on, and whether this interface can do that action.
// Gating mirrors currentAction.ts (seller creates/locks/releases, buyer marks payment).
function currentActors(i: TradeStateInput, cancelled: boolean, current: TradeStep['id']): { actors: StepActor[]; blocked?: TradeStep['blocked'] } {
  const s = i.escrowStatus
  if (cancelled) return { actors: [] }
  // A round waits on its missing signatures only where the rail shows it: the signatures stage or a disputed/expired outcome.
  if (i.signingRoundKind && i.round && (current === 'signatures' || current === 'outcome')) {
    return { actors: pendingSigners(i, i.round), ...(i.signingUnavailable ? { blocked: 'signing' as const } : {}) }
  }
  if (!s || s === 'CREATED') return { actors: ['seller'] }
  if (s === 'PAYMENT_PENDING') return { actors: ['seller'], ...(i.releaseUnavailable ? { blocked: 'release' as const } : {}) }
  if (s === 'FUNDS_LOCKED') return { actors: ['buyer'] }
  if (s === 'DISPUTED') {
    const d = i.dispute
    if (!d || d.status === 'RESOLVED') return { actors: [] } // a recorded ruling being executed: who acts next is not exposed
    if (d.status === 'AUTO_PROPOSED') {
      // Contesting is open only until the suggestion's deadline; after it (or without one) nobody is named.
      const deadline = d.autoResolutionDeadline ? Date.parse(d.autoResolutionDeadline) : NaN
      return { actors: Number.isFinite(deadline) && deadline > (i.now ?? Date.now()) ? ['parties'] : [] }
    }
    return { actors: d.arbiterId ? ['arbiter'] : [] }
  }
  return { actors: [] } // EXPIRED (no recovery action in this interface) and terminal statuses
}

function steps(i: TradeStateInput, cancelled: boolean, locked: boolean): TradeStep[] {
  const s = i.escrowStatus
  const L = ESCROW_STATE_LABEL
  const opened: TradeStep = { id: 'opened', label: 'Trade aberto', state: 'done', at: i.createdAt }
  const escrow: TradeStep = { id: 'escrow', label: L.CREATED, state: s ? 'done' : 'upcoming', at: s ? i.escrowCreatedAt : null, ...(s && i.escrowId ? { evidence: [{ label: 'ID do escrow', value: i.escrowId, mono: true }] } : {}) }
  // MULTISIG only: the seller deposits to the escrow address before the lock is recorded. Done = the lock recorded the outpoint.
  const outpoint = i.txLockId ? (i.txLockVout !== null && i.txLockVout !== undefined ? `${i.txLockId}:${i.txLockVout}` : i.txLockId) : null
  const deposit: TradeStep[] = s && i.escrowType === 'MULTISIG'
    ? [{ id: 'deposit', label: 'Depósito registrado no endereço do escrow', state: locked ? 'done' : 'upcoming', ...(outpoint ? { evidence: [{ label: 'Saída registrada', value: outpoint, mono: true }] } : {}) }]
    : []
  const lockedStep: TradeStep = { id: 'locked', label: L.FUNDS_LOCKED, state: locked ? 'done' : 'upcoming', at: i.lockedAt }
  // Recorded by the server, never "confirmed": no confirmation depth is exposed.
  const transaction: TradeStep[] = i.txReleaseId
    ? [{ id: 'transaction', label: PAYOUT_TX_LABEL, state: 'done', evidence: [{ label: 'ID da transação', value: i.txReleaseId, mono: true }] }]
    : []
  const withActors = (list: TradeStep[]) => {
    const cur = list.find((x) => x.state === 'current')
    if (!cur) return list
    const { actors, blocked } = currentActors(i, cancelled, cur.id)
    if (actors.length) Object.assign(cur, { actors }, blocked ? { blocked } : {})
    return list
  }

  // Side branches: keep only what the records prove happened, then the outcome.
  // Whether payment was marked as sent before a dispute is not recorded, so that step is omitted.
  const outcome: Omit<TradeStep, 'id'> | null = cancelled ? { label: CANCELLED_LABEL, state: 'done', at: i.cancelledAt }
    : s === 'DISPUTED' ? { label: L.DISPUTED, state: 'current', tone: 'danger' }
    : s === 'EXPIRED' ? { label: L.EXPIRED, state: 'current', tone: 'warning' }
    : s === 'REFUNDED' ? { label: L.REFUNDED, state: 'done', at: i.cancelledAt }
    : s === 'SPLIT' ? { label: L.SPLIT, state: 'done', at: i.completedAt }
    : null
  if (outcome) {
    // A round on a disputed/expired escrow (ruling or refund) is evidence on the outcome, not a stage of the happy path.
    const roundEvidence = i.round && i.signingRoundKind && (s === 'DISPUTED' || s === 'EXPIRED')
      ? [{ label: ROUND_EVIDENCE[i.signingRoundKind], value: roundProgress(i.round) }]
      : []
    const end: TradeStep = { id: 'outcome', ...outcome, ...(roundEvidence.length ? { evidence: roundEvidence } : {}) }
    const proven = [opened, ...(s ? [escrow] : []), ...(locked ? [...deposit, lockedStep] : []), end]
    return withActors([...proven, ...(s === 'REFUNDED' || s === 'SPLIT' ? transaction : [])])
  }

  const paid = s === 'PAYMENT_PENDING' || s === 'COMPLETED'
  const done = s === 'COMPLETED'
  // Only a round the server returned for this escrow; never assumed from the escrow type.
  const signatures: TradeStep[] = s === 'PAYMENT_PENDING' && i.signingRoundKind && i.round
    ? [{ id: 'signatures', label: i.signingRoundKind === 'release' ? 'Assinaturas da liberação' : ROUND_EVIDENCE[i.signingRoundKind], state: 'upcoming', evidence: [{ label: 'Assinaturas', value: roundProgress(i.round) }] }]
    : []
  const list: TradeStep[] = [
    opened, escrow, ...deposit, lockedStep,
    { id: 'paymentSent', label: L.PAYMENT_PENDING, state: paid ? 'done' : 'upcoming' },
    ...signatures,
    { id: 'completed', label: L.COMPLETED, state: done ? 'done' : 'upcoming', at: done ? i.completedAt : null },
    ...(done ? transaction : []),
  ]
  const next = list.find((x) => x.state === 'upcoming')
  if (next) next.state = 'current'
  return withActors(list)
}

export interface Baton {
  text: string
  /** 'brand' only when the named party can act in this interface; otherwise a neutral wait. */
  tone: 'brand' | 'neutral'
}

/**
 * The bastão for the current stage, from the viewer's side. null when the
 * records do not say who acts (no marker is shown then). When this interface
 * cannot do the stage's action (`step.blocked`), it never says "Sua vez" and
 * never implies the other party can act here: it states a wait, in neutral.
 */
export function batonLabel(step: Pick<TradeStep, 'actors' | 'blocked'> | undefined, viewer: 'buyer' | 'seller' | null, names: { buyer?: string | null; seller?: string | null } = {}): Baton | null {
  const actors = step?.actors
  if (!actors?.length) return null
  const blocked = step?.blocked
  if (viewer && actors.includes(viewer)) {
    if (!blocked) return { text: 'Sua vez', tone: 'brand' }
    return { text: blocked === 'signing' ? 'Aguardando sua assinatura — indisponível nesta interface' : 'Aguardando sua liberação — indisponível nesta interface', tone: 'neutral' }
  }
  const tone = blocked ? 'neutral' : 'brand'
  if (actors.length === 1) {
    const a = actors[0]
    if (a === 'arbiter') return { text: 'Com o árbitro', tone }
    if (a === 'parties') return { text: 'Partes podem contestar até o prazo', tone }
    if (a === 'unknown') return { text: blocked ? 'Aguardando participante não identificado' : 'Vez de participante não identificado', tone }
    const role = a === 'buyer' ? 'comprador' : 'vendedor'
    const name = names[a]
    if (blocked) return { text: name ? `Aguardando ${name} (${role})` : `Aguardando o ${role}`, tone }
    return { text: name ? `Vez de ${name} (${role})` : `Vez do ${role}`, tone }
  }
  const both = actors.every((a) => a === 'buyer' || a === 'seller')
  if (blocked) return { text: both ? 'Aguardando o comprador e o vendedor' : 'Aguardando mais de um participante', tone }
  return { text: both ? 'Vez do comprador e do vendedor' : 'Vez de mais de um participante', tone }
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
  const view = deriveCurrentAction({ status: i.escrowStatus, isBuyer: i.isBuyer, isSeller: i.isSeller, releaseUnavailable: i.releaseUnavailable, signingUnavailable: i.signingUnavailable })
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
