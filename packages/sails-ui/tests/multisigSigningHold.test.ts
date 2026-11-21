import { checkMultisigPending, multisigSigningHoldMessage } from '../src/lib/multisigSigningIntent'

describe('MULTISIG signing HOLD (CTO 28 Despacho 033)', () => {
  it('refuses to verify any release while fundedAmount is unresolved, even with complete data', () => {
    const escrow = { id: 'e1', type: 'MULTISIG', multisigAddr: 'bc1qexample', txLockId: 'a'.repeat(64), txLockVout: 0, fundedAmount: '0.01' }
    const pending = { kind: 'release', minerFeeSats: '500', unsignedPsbtBase64: 'x', requiredSigners: [] }
    expect(checkMultisigPending(escrow as never, pending as never)).toEqual({ status: 'cannotVerify', reason: multisigSigningHoldMessage() })
  })
})
