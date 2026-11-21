import type { EscrowStatus } from '../types'
import { deriveCurrentAction, type CurrentActionKind } from './currentAction'
import { t } from '../i18n'

// One message per action: lower-casing a translated title breaks German nouns and word order.
const YOUR_TURN = {
  createEscrow: 'escrow.nextStep.createEscrow',
  lock: 'escrow.nextStep.lock',
  markPaymentSent: 'escrow.nextStep.markPaymentSent',
  release: 'escrow.nextStep.release',
} as const satisfies Record<CurrentActionKind, string>

export interface TradeNextStep {
  yourTurn: boolean
  text: string
}

/**
 * The viewer's next step for a trade row in a list. `escrowStatus` is
 * `undefined` when the trade has no escrow yet (Trade.tsx's own rule:
 * the seller creates it) and `null` when an escrow exists but its status
 * could not be loaded, in which case there is no honest next step to show.
 */
export function tradeNextStep(escrowStatus: EscrowStatus | null | undefined, role: { isBuyer: boolean; isSeller: boolean }): TradeNextStep | null {
  if (escrowStatus === null) return null
  if (escrowStatus === undefined) {
    return role.isSeller ? { yourTurn: true, text: t(YOUR_TURN.createEscrow) } : { yourTurn: false, text: t('escrow.action.waitCreate.title') }
  }
  const action = deriveCurrentAction({ status: escrowStatus, ...role })
  if (action.tone === 'action' && action.primary) return { yourTurn: true, text: t(YOUR_TURN[action.primary.action]) }
  return { yourTurn: false, text: action.title }
}
