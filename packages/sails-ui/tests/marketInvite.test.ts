import { INVITE_STATES, canSubmitInvite, inviteGrantsAccess, nextInviteState, type InviteEvent, type InviteState } from '../src/lib/marketInvite'

const run = (events: InviteEvent[], from: InviteState = 'idle') => events.reduce(nextInviteState, from)

describe('Sails Market Invite state machine', () => {
  it('walks every outcome from a submitted invite', () => {
    expect(run([{ type: 'submit' }])).toBe('validating')
    for (const outcome of ['pending', 'granted', 'expired', 'revoked'] as const) {
      expect(run([{ type: 'submit' }, { type: 'validated', outcome }])).toBe(outcome)
    }
  })

  it('pending becomes granted only when authorized, and can be revoked', () => {
    expect(run([{ type: 'authorized' }], 'pending')).toBe('granted')
    expect(run([{ type: 'revoked' }], 'pending')).toBe('revoked')
    expect(run([{ type: 'revoked' }], 'granted')).toBe('revoked')
  })

  it('ignores events that do not apply (no skipping validation, no reviving a final state)', () => {
    expect(run([{ type: 'authorized' }])).toBe('idle')
    expect(run([{ type: 'validated', outcome: 'granted' }])).toBe('idle')
    expect(run([{ type: 'submit' }], 'validating')).toBe('validating')
    expect(run([{ type: 'authorized' }], 'expired')).toBe('expired')
    expect(run([{ type: 'authorized' }], 'revoked')).toBe('revoked')
    expect(run([{ type: 'submit' }], 'granted')).toBe('granted')
  })

  it('reset always returns to idle', () => {
    for (const s of INVITE_STATES) expect(nextInviteState(s, { type: 'reset' })).toBe('idle')
  })

  it('submit needs a contract, an idle state and a non-empty value', () => {
    expect(canSubmitInvite('idle', 'x', false)).toBe(false)
    expect(canSubmitInvite('idle', '   ', true)).toBe(false)
    expect(canSubmitInvite('validating', 'x', true)).toBe(false)
    expect(canSubmitInvite('idle', 'x', true)).toBe(true)
  })

  it('only granted means access', () => {
    expect(INVITE_STATES.filter(inviteGrantsAccess)).toEqual(['granted'])
  })
})
