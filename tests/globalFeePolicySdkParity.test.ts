// G3 + G4: the SDK and the node compute the same V2 digest and reach the same verdict on the same signed document.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import * as node from '../src/modules/open-settlement/global-fee-policy'
import * as sdk from '../packages/sails-sdk/src/modules/fee-policy'
import * as nodeTc from '../src/modules/open-p2p/trade-commitment'
import * as sdkTc from '../packages/sails-sdk/src/modules/trade-commitment'

const keys = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(i)))
const ctx = {
  authority: { keys: keys.map((k) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 },
  network: { name: 'bitcoin', bitcoin: bitcoin.networks.bitcoin },
  maxRate: '0.005',
  now: new Date('2026-12-01T00:00:00.000Z'),
  purpose: 'new-use' as const,
}
const dest = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: bitcoin.networks.bitcoin }).address as string
const policy: node.FeePolicyV2 = {
  version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: { breakEven: { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] } },
  rail: 'MULTISIG', network: 'bitcoin', destination: { kind: 'address', value: dest },
  validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
}

describe("signed V2 fee policy: node and SDK parity", () => {
  it("same digest for the same policy, and the same version-explicit choice", () => {
    expect(sdk.feePolicyDigestV2(policy)).toBe(node.feePolicyDigestV2(policy))
    expect(sdkTc.feePolicyDigest(policy)).toBe(nodeTc.feePolicyDigest(policy))
    expect(sdkTc.feePolicyDigest({ ...policy, version: 3 } as never)).toBeNull()
  })

  it("a document signed on the node verifies in the SDK, and the verdicts agree on refusals", () => {
    const good = node.signFeePolicy(policy, [keys[0].secretKey, keys[1].secretKey])
    expect(sdk.verifySignedFeePolicy(good, ctx)).toEqual(node.verifySignedFeePolicy(good, ctx))
    const cases = [
      node.signFeePolicy(policy, [keys[2].secretKey]),
      { ...good, policy: { ...policy, destination: { kind: 'address' as const, value: bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 9), network: bitcoin.networks.bitcoin }).address as string } } },
      node.signFeePolicy({ ...policy, network: 'testnet' }, [keys[0].secretKey, keys[1].secretKey]),
      node.signFeePolicy({ ...policy, protocolFeeRate: '0.006' }, [keys[0].secretKey, keys[1].secretKey]),
    ]
    for (const doc of cases) {
      expect(sdk.verifySignedFeePolicy(doc, ctx).ok).toBe(false)
      expect(node.verifySignedFeePolicy(doc, ctx).ok).toBe(false)
    }
  })
})
