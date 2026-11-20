/**
 * Small badge/pill primitives. Semantic colors (green/red/yellow/blue)
 * are universal conventions, not brand decisions — the brand accent
 * (`--color-orange-accent`, primary actions/active nav) is a separate
 * role from `EXPIRED` below's plain `orange-500`, a narrow semantic use
 * for an expiry-shaped meaning (docs/SAILS_DESIGN_LANGUAGE.md §1/§2,
 * corrected `UI-GATE-CLOSE-1-R1` — an earlier version of this comment
 * claimed orange was never reused for a status meaning here, which this
 * file's own EXPIRED case already contradicted).
 */
import type { AssetType, TradeSide, PaymentMethod, TradeStatus, EscrowStatus, OfferStatus } from '../../types'
import { ASSET_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { badgeVariants } from './badge'
import { cn } from '../../lib/utils'
import {
  Zap, Clock, CheckCircle2, AlertTriangle, XCircle, Circle, Lock, RotateCcw, PauseCircle, Scissors, type LucideIcon,
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
    <span title={title} className={cn(badgeVariants({ variant: 'outline' }), 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1', className)}>
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
    <Pill className="border-green-500/25 bg-green-500/10 text-green-800 dark:text-green-300">COMPRAR</Pill>
  ) : (
    <Pill className="border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300">VENDER</Pill>
  )
}

export function PaymentBadge({ method }: { method: PaymentMethod }) {
  return <Pill className="border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300">{PAYMENT_METHOD_LABELS[method]}</Pill>
}

const TRADE_STATUS_LABEL: Record<TradeStatus, string> = {
  PENDING: 'Pendente', ACTIVE: 'Ativo', COMPLETED: 'Concluído', DISPUTED: 'Em disputa', CANCELLED: 'Cancelado',
}
const TRADE_STATUS_COLOR: Record<TradeStatus, string> = {
  PENDING: 'border-yellow-500/25 bg-yellow-500/10 text-yellow-800 dark:text-yellow-300',
  ACTIVE: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  COMPLETED: 'border-green-500/25 bg-green-500/10 text-green-800 dark:text-green-300',
  DISPUTED: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
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
export const ESCROW_STATUS_LABEL: Record<EscrowStatus, string> = {
  CREATED: 'Criado', FUNDS_LOCKED: 'Fundos travados', PAYMENT_PENDING: 'Pagamento marcado como enviado',
  COMPLETED: 'Concluído', DISPUTED: 'Em disputa', REFUNDED: 'Reembolsado', EXPIRED: 'Expirado',
  SPLIT: 'Dividido entre as partes',
}
const ESCROW_STATUS_COLOR: Record<EscrowStatus, string> = {
  CREATED: 'border-brand-border bg-brand-elevated text-brand-text-secondary',
  FUNDS_LOCKED: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  PAYMENT_PENDING: 'border-yellow-500/25 bg-yellow-500/10 text-yellow-800 dark:text-yellow-300',
  COMPLETED: 'border-green-500/25 bg-green-500/10 text-green-800 dark:text-green-300',
  DISPUTED: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
  REFUNDED: 'border-brand-border bg-brand-elevated text-brand-text-muted',
  EXPIRED: 'border-orange-500/25 bg-orange-500/10 text-orange-800 dark:text-orange-300',
  SPLIT: 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300',
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
  const color = status === 'ACTIVE' ? 'border-green-500/25 bg-green-500/10 text-green-800 dark:text-green-300' : 'border-brand-border bg-brand-elevated text-brand-text-muted'
  return <Pill className={color} icon={OFFER_STATUS_ICON[status]}>{OFFER_STATUS_LABEL[status]}</Pill>
}

// Noones-inspired tenure/volume badge (lib/reputation.ts's own comment
// has the full threshold sourcing) — an achievement/brand highlight, not
// a semantic status, so it uses the orange accent like other brand-
// highlight marks in this UI (e.g. the "Verificado" checkmark), not a
// universal-convention color the way Trade/Escrow/Offer status do above.
export function PowerTraderBadge() {
  return (
    <Pill
      className="border-brand-orange-accent/30 bg-brand-orange-accent/10 text-brand-orange-hover flex items-center gap-1"
      title="Power Trader: alto volume de trades com alta taxa de trades sem disputa"
    >
      <Zap className="h-3 w-3" fill="currentColor" strokeWidth={0} /> Power Trader
    </Pill>
  )
}
