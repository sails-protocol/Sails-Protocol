/**
 * G3 guard (Despacho 069): the fee policy authority is the constant pinned in the release. The module exports no way to
 * change it, the constant cannot be mutated at runtime, and the empty list of the pre-D-E1 release never verifies a
 * policy (fail closed, never a bypass).
 */
export {}

const nacl = require('tweetnacl')
const bitcoin = require('bitcoinjs-lib')
const crypto = require('crypto')
const authorityModule = require('../src/modules/open-settlement/fee-policy-authority')
const { FEE_POLICY_AUTHORITY } = authorityModule
const { signFeePolicy, verifySignedFeePolicy } = require('../src/modules/open-settlement/global-fee-policy')

it("the module exports only the pinned constant: no setter, no factory", () => {
  expect(Object.keys(authorityModule)).toEqual(['FEE_POLICY_AUTHORITY'])
  expect(Object.values(authorityModule).some((v) => typeof v === 'function')).toBe(false)
})

it("the pinned constant cannot be changed at runtime", () => {
  expect(Object.isFrozen(FEE_POLICY_AUTHORITY)).toBe(true)
  expect(Object.isFrozen(FEE_POLICY_AUTHORITY.keys)).toBe(true)
  expect(() => { 'use strict'; (FEE_POLICY_AUTHORITY.keys as string[]).push('00'.repeat(32)) }).toThrow()
  expect(() => { 'use strict'; (FEE_POLICY_AUTHORITY as any).threshold = 1 }).toThrow()
  expect(FEE_POLICY_AUTHORITY).toEqual({ keys: [], threshold: 2 })
})

it("with the pre-D-E1 empty authority, even a fully signed policy never verifies", () => {
  const kp = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(crypto.createHash('sha256').update(`any-${i}`).digest()))
  const network = bitcoin.networks.testnet
  const destination = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network }).address
  const policy = {
    version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
    smallTradeRule: {}, rail: 'MULTISIG', network: 'testnet', destination: { kind: 'address', value: destination },
    validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
  }
  const doc = signFeePolicy(policy, kp.map((k: any) => k.secretKey))
  const ctx = (authority: unknown) => ({ authority, network: { name: 'testnet', bitcoin: network }, maxRate: '0.005', now: new Date('2026-11-28T00:00:00.000Z'), purpose: 'new-use' })
  expect(verifySignedFeePolicy(doc, ctx({ keys: [...FEE_POLICY_AUTHORITY.keys], threshold: FEE_POLICY_AUTHORITY.threshold }))).toMatchObject({ ok: false })
  // The same document verifies against keys that are really in the authority: the refusal above is the empty list.
  expect(verifySignedFeePolicy(doc, ctx({ keys: kp.map((k: any) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 }))).toMatchObject({ ok: true })
})
