// G3 + G4: the signed V2 fee policy (destination inside the digest; k-of-n authority pinned in the release).
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import {
  feePolicyDigestV2, signFeePolicy, verifySignedFeePolicy, signedDocumentMatchesRow, type FeePolicyV2, type VerificationContext,
} from '../src/modules/open-settlement/global-fee-policy'
import { feePolicyDigest, feePolicyDigestV1 } from '../src/modules/open-p2p/trade-commitment'

const keys = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(i)))
const outsider = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
const addr = (seed: number, network: bitcoin.Network) =>
  bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, seed), network }).address as string
const mainnetDest = addr(7, bitcoin.networks.bitcoin)
const testnetDest = addr(7, bitcoin.networks.testnet)

const ctx: VerificationContext = {
  authority: { keys: keys.map((k) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 },
  network: { name: 'bitcoin', bitcoin: bitcoin.networks.bitcoin },
  maxRate: '0.005',
  now: new Date('2026-12-01T00:00:00.000Z'),
  purpose: 'new-use',
}

const policy: FeePolicyV2 = {
  version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: {}, rail: 'MULTISIG', network: 'bitcoin',
  destination: { kind: 'address', value: mainnetDest }, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
}
const two = (p: FeePolicyV2) => signFeePolicy(p, [keys[0].secretKey, keys[1].secretKey])

describe("signed V2 fee policy", () => {
  it("2 of 3 authority signatures verify; the digest is the global identity", () => {
    expect(verifySignedFeePolicy(two(policy), ctx)).toEqual({ ok: true, digest: feePolicyDigestV2(policy) })
  })

  it("one authority signature is not enough; an outsider signature is never counted", () => {
    expect(verifySignedFeePolicy(signFeePolicy(policy, [keys[0].secretKey]), ctx)).toMatchObject({ ok: false })
    expect(verifySignedFeePolicy(signFeePolicy(policy, [keys[0].secretKey, outsider.secretKey]), ctx)).toMatchObject({ ok: false })
  })

  it.each([
    ["the rate", { protocolFeeRate: '0.003' }],
    ["the destination", { destination: { kind: 'address', value: addr(8, bitcoin.networks.bitcoin) } }],
    ["the rail", { rail: 'LIGHTNING_HODL' }],
  ])("a signed policy with %s changed afterwards is refused", (_name, change) => {
    const doc = two(policy)
    expect(verifySignedFeePolicy({ ...doc, policy: { ...policy, ...change } as FeePolicyV2 }, ctx)).toMatchObject({ ok: false })
  })

  it("a single-key or threshold-1 authority is refused, as are duplicated keys", () => {
    const k = ctx.authority.keys
    expect(verifySignedFeePolicy(two(policy), { ...ctx, authority: { keys: [k[0]], threshold: 1 } })).toMatchObject({ ok: false })
    expect(verifySignedFeePolicy(two(policy), { ...ctx, authority: { keys: k, threshold: 1 } })).toMatchObject({ ok: false, reason: 'invalid authority threshold' })
    expect(verifySignedFeePolicy(two(policy), { ...ctx, authority: { keys: [k[0], k[0], k[1]], threshold: 2 } })).toMatchObject({ ok: false, reason: 'invalid authority keys' })
  })
})

describe("network, ceiling and validity (GK G3+G4 gaps 1-3)", () => {
  it("a policy for another network is refused, even when validly signed", () => {
    const testnet = two({ ...policy, network: 'testnet', destination: { kind: 'address', value: testnetDest } })
    expect(verifySignedFeePolicy(testnet, ctx)).toMatchObject({ ok: false })
  })

  it("a destination that is not an address of this network is refused", () => {
    const wrong = two({ ...policy, destination: { kind: 'address', value: testnetDest } })
    expect(verifySignedFeePolicy(wrong, ctx)).toMatchObject({ ok: false, reason: 'fee destination is not an address of this network' })
  })

  it("a signature never waives the fee ceiling", () => {
    expect(verifySignedFeePolicy(two({ ...policy, protocolFeeRate: '0.006' }), ctx)).toMatchObject({ ok: false, reason: 'fee rate above the ceiling 0.005' })
    expect(verifySignedFeePolicy(two({ ...policy, protocolFeeRate: '0.004' }), { ...ctx, maxRate: '0.003' })).toMatchObject({ ok: false })
  })

  it("the validity window applies to new use only; an open escrow settles after the policy expires", () => {
    const expiring = two({ ...policy, validUntil: '2026-11-15T00:00:00.000Z' })
    expect(verifySignedFeePolicy(expiring, ctx)).toMatchObject({ ok: false, reason: 'outside its validity window' })
    expect(verifySignedFeePolicy(expiring, { ...ctx, purpose: 'existing' })).toMatchObject({ ok: true })
  })

  it("a non-canonical timestamp is refused even when signed", () => {
    expect(verifySignedFeePolicy(two({ ...policy, validFrom: '2026-11-01T00:00:00Z' }), ctx)).toMatchObject({ ok: false, reason: 'invalid validity window' })
  })

  it.each([["network", { network: 'testnet' }], ["rail", { rail: 'SAFE_GUARD_EVM' }], ["confirmations", { requiredConfirmations: 6 }]])("%s is inside the digest", (_n, change) => {
    expect(feePolicyDigestV2({ ...policy, ...change } as FeePolicyV2)).not.toBe(feePolicyDigestV2(policy))
  })
})

describe("version-explicit digest at commitment admission (gap 6)", () => {
  const v1 = { protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, smallTradeRule: {} }
  it("no version = V1, version 2 = V2, any other version is refused", () => {
    expect(feePolicyDigest(v1)).toBe(feePolicyDigestV1(v1))
    expect(feePolicyDigest(policy)).toBe(feePolicyDigestV2(policy))
    expect(feePolicyDigest({ ...policy, version: 3 } as never)).toBeNull()
  })
  it("a V2 policy is never digested as V1", () => {
    expect(feePolicyDigest(policy)).not.toBe(feePolicyDigestV1(policy))
  })
})

describe("the signed document must be the document of this row (gap 7: rate spelling)", () => {
  const row = { railScope: 'MULTISIG', protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, smallTradeRule: {} }
  const doc = two(policy)

  it("matching fields pass, and a row rate stored as 0.0040 equals 0.004", () => {
    expect(signedDocumentMatchesRow(doc, row)).toEqual({ ok: true })
    expect(signedDocumentMatchesRow(doc, { ...row, protocolFeeRate: '0.0040' })).toEqual({ ok: true })
  })

  it("a document whose own rate is not canonical is refused", () => {
    expect(signedDocumentMatchesRow(two({ ...policy, protocolFeeRate: '0.0040' }), row)).toEqual({ ok: false, field: 'protocolFeeRate' })
  })

  it.each([
    ["railScope", { railScope: 'LIGHTNING_HODL' }, 'rail'],
    ["protocolFeeRate", { protocolFeeRate: '0.003' }, 'protocolFeeRate'],
    ["requiredConfirmations", { requiredConfirmations: 1 }, 'requiredConfirmations'],
    ["smallTradeRule", { smallTradeRule: { fixtureOnlyMinimum: '0.001' } }, 'smallTradeRule'],
  ])("a valid document of another policy pasted next to a row with a different %s is refused", (_n, change, field) => {
    expect(verifySignedFeePolicy(doc, ctx).ok).toBe(true) // the signature alone would pass
    expect(signedDocumentMatchesRow(doc, { ...row, ...change })).toEqual({ ok: false, field })
  })
})
