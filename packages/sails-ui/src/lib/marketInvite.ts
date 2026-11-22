/**
 * Sails Market Invite: the states the UI shows while a pasted invite is checked (DECISIONS.md "Nós e mercados
 * privados", issue #147). No contract exists yet (LOOSE_WIRES.marketInvite): the real screen never leaves 'idle',
 * and only demo mode feeds the 'validated' events. Pure, no I/O, no parsing: the UI never inspects the invite's
 * format (formats are pending the Principal) and never treats a public identifier as access.
 */

export type InviteState = 'idle' | 'validating' | 'pending' | 'granted' | 'failed'
/**
 * What validating can answer. 'granted' straight away is possible when the inviter pre-authorized the holder.
 * 'failed' is ONE generic answer for invalid, expired or revoked alike (GK, 2026-11-22): the screen never tells which,
 * so it never confirms that a market or an invite exists.
 */
export type InviteOutcome = 'pending' | 'granted' | 'failed'

export type InviteEvent =
  | { type: 'submit' }
  | { type: 'validated'; outcome: InviteOutcome }
  | { type: 'authorized' }
  /** The admin refused (pending) or removed the access (granted): same generic failure. */
  | { type: 'failed' }
  | { type: 'reset' }

/** Every state, in the order the flow reaches them (dev gallery, tests). */
export const INVITE_STATES: readonly InviteState[] = ['idle', 'validating', 'pending', 'granted', 'failed']

/** One transition. Events that do not apply to the current state leave it unchanged. */
export function nextInviteState(state: InviteState, event: InviteEvent): InviteState {
  if (event.type === 'reset') return 'idle'
  switch (state) {
    case 'idle':
      return event.type === 'submit' ? 'validating' : state
    case 'validating':
      return event.type === 'validated' ? event.outcome : state
    case 'pending':
      return event.type === 'authorized' ? 'granted' : event.type === 'failed' ? 'failed' : state
    case 'granted':
      return event.type === 'failed' ? 'failed' : state
    default:
      // failed is final for this invite: only reset (a new invite) leaves it.
      return state
  }
}

/** Submitting needs a contract (or demo mode) and a non-empty pasted value; never while a check is running. */
export function canSubmitInvite(state: InviteState, value: string, contractAvailable: boolean): boolean {
  return contractAvailable && state === 'idle' && value.trim().length > 0
}

/** Only 'granted' means access. Everything else, including a known public identifier, is no access. */
export function inviteGrantsAccess(state: InviteState): boolean {
  return state === 'granted'
}
