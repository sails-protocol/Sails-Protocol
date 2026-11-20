/**
 * Small badge/pill primitives. Colors come from the Design System tones
 * (lib/tone.ts): trade side uses buy/sell, lifecycle status uses
 * success/warning/danger/info/neutral, and brand orange is never a status
 * (DESIGN_SYSTEM.md). EXPIRED was orange-500 and SPLIT violet-500 before
 * the 2026-11-20 token migration; both are listed there for the Architect.
 */
import type { AssetType, TradeSide, PaymentMethod, TradeStatus, EscrowStatus, OfferStatus } from '../../types'
import { ASSET_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { ESCROW_STATE_LABEL } from '../../lib/tradeState'
import { badgeVariants } from './badge'
import { cn } from '../../lib/utils'
import { TONE_CLASS } from '../../lib/tone'
import {
  Clock, CheckCircle2, AlertTriangle, XCircle, Circle, Lock, RotateCcw, PauseCircle, Scissors, type LucideIcon,
} from 'lucide-react'

// Routes through badgeVariants' own base shape (shared with the generic
// shadcn Badge) rather than a hardcoded string — but each call site below
// still passes its own full color className (green=compra, red=venda,
// blue=pagamento, etc.), since these are real domain-semantic colors
// with no equivalent in Badge's own fixed default/secondary/destructive/
// outline palette.
// UI-POLISH-2 §4.3 — `icon` is optional and additive, never a
// replacement for the text label (icon-only status would fail the
// "icons reinforce meaning, they don't manufacture hierarchy" rule and
// "important actions prefer icon+label"). Text alone already satisfies
// "color is never the only cue"; the icon is a real scanning aid for
// dense trade/escrow lists, not a requirement this component lacked.
function Pill({ children, className = '', title, icon: Icon }: { children: React.ReactNode; className?: string; title?: string; icon?: LucideIcon }) {
  return (
    <span title={title} className={cn(badgeVariants({ variant: 'outline' }), 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5', className)}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  )
}

export function AssetBadge({ asset }: { asset: AssetType }) {
  return <Pill className="border-brand-border bg-brand-elevated text-brand-text-secondary" title={asset}>{ASSET_LABELS[asset]}</Pill>
}

export function SideBadge({ side }: { side: TradeSide }) {
  return side === 'BUY' ? (
    <Pill className={TONE_CLASS.buy}>Comprar</Pill>
  ) : (
    <Pill className={TONE_CLASS.sell}>Vender</Pill>
  )
}

/** Quiet payment method: secondary text after a thin brand tick (the Market table style), not a filled pill. */
export function PaymentBadge({ method, className }: { method: PaymentMethod; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-body-sm text-brand-text-secondary whitespace-nowrap', className)}>
      <span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-brand-orange-accent" />
      {PAYMENT_METHOD_LABELS[method]}
    </span>
  )
}

const TRADE_STATUS_LABEL: Record<TradeStatus, string> = {
  PENDING: 'Pendente', ACTIVE: 'Ativo', COMPLETED: 'Concluído', DISPUTED: 'Em disputa', CANCELLED: 'Cancelado',
}
const TRADE_STATUS_COLOR: Record<TradeStatus, string> = {
  PENDING: TONE_CLASS.warning,
  ACTIVE: TONE_CLASS.info,
  COMPLETED: TONE_CLASS.success,
  DISPUTED: TONE_CLASS.danger,
  CANCELLED: 'border-brand-border bg-brand-elevated text-brand-text-muted',
}
const TRADE_STATUS_ICON: Record<TradeStatus, LucideIcon> = {
  PENDING: Clock, ACTIVE: Circle, COMPLETED: CheckCircle2, DISPUTED: AlertTriangle, CANCELLED: XCircle,
}
export function TradeStatusBadge({ status }: { status: TradeStatus }) {
  return <Pill className={TRADE_STATUS_COLOR[status]} icon={TRADE_STATUS_ICON[status]}>{TRADE_STATUS_LABEL[status]}</Pill>
}

// Missão 11 Fase 7.3 (cumulative audit) — EXPIRED added: a real
// EscrowStatus value (../../types.ts, mirroring prisma/schema.prisma)
// this Record was missing — TypeScript's own Record<EscrowStatus, ...>
// exhaustiveness check would otherwise fail this package's build the
// moment the type gained the value. SPLIT (RFC-021 D9) closed 2026-09-13
// (F-01, System Coherence & Integration Audit) — a real, terminal,
// partial-payout outcome, reachable only via a dispute ruling; distinct
// from DISPUTED (still open) and from COMPLETED/REFUNDED (either party
// received the full amount, not a share). violet is used for no other
// status here, so this color is never ambiguous with an existing
// meaning; the Scissors icon mirrors Disputes.tsx's own SPLIT action
// button.
// Trade Workspace L1: one name per escrow state everywhere, so this is an alias of tradeState's labels.
export const ESCROW_STATUS_LABEL: Record<EscrowStatus, string> = ESCROW_STATE_LABEL
const ESCROW_STATUS_COLOR: Record<EscrowStatus, string> = {
  CREATED: 'border-brand-border bg-brand-elevated text-brand-text-secondary',
  FUNDS_LOCKED: TONE_CLASS.info,
  PAYMENT_PENDING: TONE_CLASS.warning,
  COMPLETED: TONE_CLASS.success,
  DISPUTED: TONE_CLASS.danger,
  REFUNDED: 'border-brand-border bg-brand-elevated text-brand-text-muted',
  // Role ambiguous, pending the Architect: ended without completion -> warning (was orange, the brand hue).
  EXPIRED: TONE_CLASS.warning,
  // Terminal ruling outcome with no severity of its own -> neutral (was violet, no token); label + icon carry it.
  SPLIT: TONE_CLASS.neutral,
}
const ESCROW_STATUS_ICON: Record<EscrowStatus, LucideIcon> = {
  CREATED: Circle, FUNDS_LOCKED: Lock, PAYMENT_PENDING: Clock, COMPLETED: CheckCircle2,
  DISPUTED: AlertTriangle, REFUNDED: RotateCcw, EXPIRED: XCircle, SPLIT: Scissors,
}
export function EscrowStatusBadge({ status }: { status: EscrowStatus }) {
  return <Pill className={ESCROW_STATUS_COLOR[status]} icon={ESCROW_STATUS_ICON[status]}>{ESCROW_STATUS_LABEL[status]}</Pill>
}

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  ACTIVE: 'Ativa', PAUSED: 'Pausada', COMPLETED: 'Concluída', CANCELLED: 'Cancelada',
}
const OFFER_STATUS_ICON: Record<OfferStatus, LucideIcon> = {
  ACTIVE: Circle, PAUSED: PauseCircle, COMPLETED: CheckCircle2, CANCELLED: XCircle,
}
export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  const color = status === 'ACTIVE' ? TONE_CLASS.success : 'border-brand-border bg-brand-elevated text-brand-text-muted'
  return <Pill className={color} icon={OFFER_STATUS_ICON[status]}>{OFFER_STATUS_LABEL[status]}</Pill>
}
