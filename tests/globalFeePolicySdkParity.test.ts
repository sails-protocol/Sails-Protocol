// G3 + G4: the SDK and the node compute the same V2 digest and reach the same verdict on the same signed document.
import nacl from 'tweetnacl'
import * as node from '../src/modules/open-settlement/global-fee-policy'
import * as sdk from '../packages/sails-sdk/src/modules/fee-policy'

const keys = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(i)))
const authority = { keys: keys.map((k) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 }
const now = new Date('2026-12-01T00:00:00.000Z')
const policy: node.FeePolicyV2 = {
  version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: { breakEven: { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] } },
  rail: 'MULTISIG', network: 'bitcoin', destination: { kind: 'address', value: 'bc1qfixturecollectionaddress' },
  validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
}

describe('signed V2 fee policy: node and SDK parity', () => {
  it('same digest for the same policy', () => {
    expect(sdk.feePolicyDigestV2(policy)).toBe(node.feePolicyDigestV2(policy))
  })

  it('a document signed on the node verifies in the SDK, and the verdicts agree on refusals', () => {
    const good = node.signFeePolicy(policy, [keys[0].secretKey, keys[1].secretKey])
    expect(sdk.verifySignedFeePolicy(good, authority, now)).toEqual(node.verifySignedFeePolicy(good, authority, now))
    const one = node.signFeePolicy(policy, [keys[2].secretKey])
    expect(sdk.verifySignedFeePolicy(one, authority, now).ok).toBe(false)
    expect(node.verifySignedFeePolicy(one, authority, now).ok).toBe(false)
    const tampered = { ...good, policy: { ...policy, destination: { kind: 'address' as const, value: 'bc1qattacker' } } }
    expect(sdk.verifySignedFeePolicy(tampered, authority, now).ok).toBe(false)
    expect(node.verifySignedFeePolicy(tampered, authority, now).ok).toBe(false)
  })
})
