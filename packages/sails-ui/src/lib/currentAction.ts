/**
 * Who must act now, and what the next permitted action is, from the
 * viewer's point of view. Gating is identical to the former
 * EscrowActions.tsx (which mirrored escrow.service.ts's ownership rules):
 * seller + CREATED -> lock, buyer + FUNDS_LOCKED -> mark payment sent,
 * seller + PAYMENT_PENDING -> release; either party may open a dispute
 * unless the status is COMPLETED, DISPUTED or REFUNDED.
 */
import type { EscrowStatus } from '../types'
import { t } from '../i18n'

export type CurrentActionKind = 'createEscrow' | 'lock' | 'markPaymentSent' | 'release'

export interface CurrentAction {
  tone: 'action' | 'waiting' | 'terminal' | 'attention'
  actorLabel: string
  title: string
  description: string
  primary?: { action: CurrentActionKind; label: string }
  canDispute: boolean
}

// `releaseUnavailable`: the escrow type needs a signing round this interface cannot sign
// (LIGHTNING_HODL / SAFE_GUARD_EVM), so no release is offered — it would dead-end.
// `signingUnavailable`: a release signing round exists but this interface cannot offer the signature
// (MULTISIG_SIGNING_HOLD, unverified terms): never ask the seller to "Liberar" next to a blocked round.
// `deadlinePassed`: FUNDS_LOCKED past escrow.expiresAt but the node has not recorded the expiry yet; never urge a payment then.
export function deriveCurrentAction({ status, isBuyer, isSeller, releaseUnavailable = false, signingUnavailable = false, deadlinePassed = false }: { status: EscrowStatus; isBuyer: boolean; isSeller: boolean; releaseUnavailable?: boolean; signingUnavailable?: boolean; deadlinePassed?: boolean }): CurrentAction {
  const canDispute = (isBuyer || isSeller) && status !== 'COMPLETED' && status !== 'DISPUTED' && status !== 'REFUNDED' && status !== 'SPLIT'
  const party = isBuyer || isSeller

  const watching = () => t(party ? 'escrow.actor.waiting' : 'escrow.actor.following')

  switch (status) {
    case 'CREATED':
      return isSeller
        ? { tone: 'action', actorLabel: t('escrow.actor.sellerNeeded'), title: t('escrow.action.lock.title'), description: t('escrow.action.lock.description'), primary: { action: 'lock', label: t('escrow.action.lock.label') }, canDispute }
        : { tone: 'waiting', actorLabel: watching(), title: t('escrow.action.waitLock.title'), description: t('escrow.action.noPaymentBeforeLock'), canDispute }
    case 'FUNDS_LOCKED':
      if (party && deadlinePassed) {
        return isBuyer
          ? { tone: 'attention', actorLabel: t('escrow.actor.buyer'), title: t('escrow.state.expired'), description: t('escrow.action.deadline.buyer'), canDispute }
          : { tone: 'attention', actorLabel: t('escrow.actor.seller'), title: t('escrow.state.expired'), description: t('escrow.action.deadline.seller'), canDispute }
      }
      return isBuyer
        ? { tone: 'action', actorLabel: t('escrow.actor.buyerNeeded'), title: t('escrow.action.markPaid.title'), description: t('escrow.action.markPaid.description'), primary: { action: 'markPaymentSent', label: t('escrow.action.markPaid.label') }, canDispute }
        : { tone: 'waiting', actorLabel: watching(), title: t('escrow.action.waitMarkPaid.title'), description: t('escrow.action.waitMarkPaid.description'), canDispute }
    case 'PAYMENT_PENDING':
      if (party && signingUnavailable) {
        return { tone: 'attention', actorLabel: t(isSeller ? 'escrow.actor.seller' : 'escrow.actor.buyer'), title: t('escrow.action.signingUnavailable.title'), description: t('escrow.action.signingUnavailable.description'), canDispute }
      }
      if (isSeller && releaseUnavailable) {
        return { tone: 'attention', actorLabel: t('escrow.actor.seller'), title: t('escrow.action.releaseUnavailable.title'), description: t('escrow.action.releaseUnavailable.description'), canDispute }
      }
      return isSeller
        ? { tone: 'action', actorLabel: t('escrow.actor.sellerNeeded'), title: t('escrow.action.release.title'), description: t('escrow.action.release.description'), primary: { action: 'release', label: t('escrow.action.release.label') }, canDispute }
        : { tone: 'waiting', actorLabel: watching(), title: t('escrow.action.waitRelease.title'), description: t('escrow.action.waitRelease.description'), canDispute }
    case 'COMPLETED':
      return { tone: 'terminal', actorLabel: t('escrow.actor.closed'), title: t('escrow.state.completed'), description: t('escrow.action.noMoreActions'), canDispute }
    case 'REFUNDED':
      return { tone: 'terminal', actorLabel: t('escrow.actor.closed'), title: t('escrow.state.refunded'), description: t('escrow.action.noMoreActions'), canDispute }
    case 'SPLIT':
      return { tone: 'terminal', actorLabel: t('escrow.actor.outcome'), title: t('escrow.state.split'), description: t('escrow.action.split.description'), canDispute }
    case 'DISPUTED':
      return { tone: 'attention', actorLabel: t('escrow.state.disputed'), title: t('escrow.action.disputed.title'), description: t('escrow.action.disputed.description'), canDispute }
    case 'EXPIRED':
      return { tone: 'attention', actorLabel: t('escrow.actor.deadlinePassed'), title: t('escrow.state.expired'), description: t('escrow.action.expired.description'), canDispute }
  }
}
