/**
 * G4 / W2: verifyFeeAwarePsbt() is the client's pre-sign check. The fee terms come only from a signed policy that
 * verifies (2-of-3 authority), never from the node's response; the PSBT must pay exactly those outputs.
 */
export {}

const nacl = require('tweetnacl')
const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const { verifyFeeAwarePsbt, feeAwareEscrowFromPolicy, buildExpectedFeeAwareOutputs } = require('../packages/sails-sdk/src/modules/fee-outputs')
const { signFeePolicy } = require('../src/modules/open-settlement/global-fee-policy')

const seed = (s: string) => crypto.createHash('sha256').update(s).digest()
const p2wpkh = (s: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.fromPrivateKey(seed(s), { network }).publicKey), network }).address
const authority = [1, 2, 3].map((i) => nacl.sign.keyPair.fromSeed(seed(`authority-${i}`)))
const ctx = (purpose: 'new-use' | 'existing', now = new Date('2026-11-28T12:00:00.000Z')) => ({
  authority: { keys: authority.map((k: any) => Buffer.from(k.publicKey).toString('hex')), threshold: 2 },
  network: { name: 'testnet', bitcoin: network }, now, purpose,
})
const collection = p2wpkh('verify-collection')
const buyer = p2wpkh('verify-buyer')
const policy = {
  version: 2, protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: {}, rail: 'MULTISIG', network: 'testnet', destination: { kind: 'address', value: collection },
  validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2026-12-01T00:00:00.000Z',
}
const signed = signFeePolicy(policy, [authority[0].secretKey, authority[1].secretKey])
const T = 2_000_000n
const RELEASE = { kind: 'RELEASE', buyer }

/** A RELEASE PSBT paying the given outputs from one escrow input of T + Fmax (as the provider builds it). */
function psbtWith(outputs: Array<{ address: string; value: bigint }>): string {
  const e = feeAwareEscrowFromPolicy(policy, T, network)
  const input = T + (e.waivedPreFunding ? 0n : (T * 400_000n) / 100_000_000n)
  const p = new bitcoin.Psbt({ network })
  p.addInput({ hash: seed('escrow-funding').toString('hex'), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(p2wpkh('escrow'), network), value: input } })
  for (const o of outputs) p.addOutput({ address: o.address, value: o.value })
  return p.toBase64()
}
const expected = () => buildExpectedFeeAwareOutputs(feeAwareEscrowFromPolicy(policy, T, network), RELEASE, 5, network)
const check = (over: Record<string, unknown> = {}) =>
  verifyFeeAwarePsbt({ signedPolicy: signed, ctx: ctx('new-use'), lockedSats: T, outcome: RELEASE, psbtBase64: psbtWith(expected()), maxFeeRateSatPerVb: 50, ...over })

it("a PSBT paying exactly the signed policy's outputs passes", () => {
  expect(expected()).toHaveLength(2) // the fee output is really there
  expect(check()).toMatchObject({ ok: true })
})

it("a fee output redirected to another address is refused", () => {
  const outs = expected().map((o: any) => (o.address === collection ? { ...o, address: p2wpkh('attacker') } : o))
  expect(check({ psbtBase64: psbtWith(outs) })).toMatchObject({ ok: false, reason: 'the outputs do not match the committed fee terms' })
})

it("a policy with only one authority signature is refused before the PSBT is read", () => {
  const one = signFeePolicy(policy, [authority[0].secretKey])
  expect(check({ signedPolicy: one })).toMatchObject({ ok: false, reason: expect.stringMatching(/^fee policy: needs 2 authority signatures/) })
})

it("a V1 policy never yields a fee destination: refused", () => {
  const { version, ...v1 } = policy
  expect(check({ signedPolicy: { policy: v1, signatures: signed.signatures } })).toMatchObject({ ok: false, reason: 'fee policy: not a V2 fee policy' })
})

it("after the policy expires, an open escrow still settles ('existing'); a new use is refused", () => {
  const later = new Date('2026-12-15T00:00:00.000Z')
  expect(check({ ctx: ctx('existing', later) })).toMatchObject({ ok: true })
  expect(check({ ctx: ctx('new-use', later) })).toMatchObject({ ok: false, reason: 'fee policy: outside its validity window' })
})
