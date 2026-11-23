// G3 + G4: the signed V2 fee policy (destination inside the digest; k-of-n authority pinned in the release).
import nacl from 'tweetnacl'
import { feePolicyDigestV2, signFeePolicy, verifySignedFeePolicy, type FeePolicyV2 } from '../src/modules/open-settlement/global-fee-policy'

const keys = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(i)))
const authority = { keys: keys.map((k) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 }
const outsider = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
const now = new Date('2026-12-01T00:00:00.000Z')

const policy: FeePolicyV2 = {
  version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: {}, rail: 'MULTISIG', network: 'bitcoin',
  destination: { kind: 'address', value: 'bc1qfixturecollectionaddress' }, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
}

describe('signed V2 fee policy', () => {
  it('2 of 3 authority signatures verify; the digest is the global identity', () => {
    const doc = signFeePolicy(policy, [keys[0].secretKey, keys[2].secretKey])
    expect(verifySignedFeePolicy(doc, authority, now)).toEqual({ ok: true, digest: feePolicyDigestV2(policy) })
  })

  it('one authority signature is not enough; an outsider signature is never counted', () => {
    expect(verifySignedFeePolicy(signFeePolicy(policy, [keys[0].secretKey]), authority, now)).toMatchObject({ ok: false })
    expect(verifySignedFeePolicy(signFeePolicy(policy, [keys[0].secretKey, outsider.secretKey]), authority, now)).toMatchObject({ ok: false })
  })

  it('the same key signing twice counts once', () => {
    const doc = signFeePolicy(policy, [keys[1].secretKey])
    expect(verifySignedFeePolicy({ ...doc, signatures: { ...doc.signatures } }, { ...authority, threshold: 2 }, now)).toMatchObject({ ok: false })
  })

  it.each([
    ['the rate', { protocolFeeRate: '0.005' }],
    ['the destination', { destination: { kind: 'address', value: 'bc1qattacker' } }],
    ['the rail', { rail: 'LIGHTNING_HODL' }],
  ])('a signed policy with %s changed afterwards is refused', (_name, change) => {
    const doc = signFeePolicy(policy, [keys[0].secretKey, keys[1].secretKey])
    expect(verifySignedFeePolicy({ ...doc, policy: { ...policy, ...change } as FeePolicyV2 }, authority, now)).toMatchObject({ ok: false })
  })

  it('the destination is inside the digest; the V2 domain differs from V1', () => {
    expect(feePolicyDigestV2({ ...policy, destination: { kind: 'address', value: 'bc1qother' } })).not.toBe(feePolicyDigestV2(policy))
  })

  it('outside the validity window, or without a destination, it is refused', () => {
    const doc = signFeePolicy(policy, [keys[0].secretKey, keys[1].secretKey])
    expect(verifySignedFeePolicy(doc, authority, new Date('2026-10-01T00:00:00.000Z'))).toMatchObject({ ok: false, reason: 'outside its validity window' })
    const noDest = signFeePolicy({ ...policy, destination: { kind: 'address', value: '' } }, [keys[0].secretKey, keys[1].secretKey])
    expect(verifySignedFeePolicy(noDest, authority, now)).toMatchObject({ ok: false, reason: 'missing fee destination' })
  })
})

describe('the signed document must be the document of this row', () => {
  const { signedDocumentMatchesRow } = require('../src/modules/open-settlement/global-fee-policy')
  const row = { railScope: 'MULTISIG', protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, smallTradeRule: {} }
  const doc = signFeePolicy(policy, [keys[0].secretKey, keys[1].secretKey])

  it('matching fields pass', () => {
    expect(signedDocumentMatchesRow(doc, row)).toEqual({ ok: true })
  })

  it.each([
    ['railScope', { railScope: 'LIGHTNING_HODL' }, 'rail'],
    ['protocolFeeRate', { protocolFeeRate: '0.003' }, 'protocolFeeRate'],
    ['requiredConfirmations', { requiredConfirmations: 1 }, 'requiredConfirmations'],
    ['smallTradeRule', { smallTradeRule: { fixtureOnlyMinimum: '0.001' } }, 'smallTradeRule'],
  ])('a valid document of another policy pasted next to a row with a different %s is refused', (_n, change, field) => {
    expect(verifySignedFeePolicy(doc, authority, now).ok).toBe(true) // the signature alone would pass
    expect(signedDocumentMatchesRow(doc, { ...row, ...change })).toEqual({ ok: false, field })
  })
})
