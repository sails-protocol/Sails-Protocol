import type { EscrowStatus } from '../types'
import { deriveCurrentAction } from './currentAction'

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
    return role.isSeller ? { yourTurn: true, text: 'Sua vez: criar o escrow' } : { yourTurn: false, text: 'Aguardando o vendedor criar o escrow' }
  }
  const action = deriveCurrentAction({ status: escrowStatus, ...role })
  if (action.tone === 'action') return { yourTurn: true, text: `Sua vez: ${action.title.charAt(0).toLowerCase()}${action.title.slice(1)}` }
  return { yourTurn: false, text: action.title }
}
