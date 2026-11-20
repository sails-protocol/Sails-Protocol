/**
 * E25 F1 / E26 - SDK implementation against the shared conformance vectors, the same file the
 * server test reads (tests/tradeCommitment.test.ts). This package never imports `src/`.
 */
import nacl from 'tweetnacl'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { canonicalizeTradeCommitment, evaluateTradeCommitment, feePolicyDigestV1, hashTradeCommitment, signTradeCommitment } from '../src/modules/trade-commitment'
import { evaluateCommitmentPair, validateArbitrationTerms } from '../src/modules/arbitration-commitment'

const V = require('../../../conformance/vectors/sails-trade-commitment-v1.vectors.json')
const derive = (rail: string) => V.railCapability[rail] ?? 'UNKNOWN'

describe('TradeCommitmentV1 / ArbitrationCommitmentV1 (SDK) - conformance vectors', () => {
  it('fixture: keys, FeePolicyDigestV1 and the canonical commitment reproduce', () => {
    for (const role of ['maker', 'taker', 'arbiter']) expect(bytesToHex(nacl.sign.keyPair.fromSeed(hexToBytes(V.keys[role].seed)).publicKey)).toBe(V.keys[role].publicKey)
    expect(feePolicyDigestV1(V.feePolicy.input)).toBe(V.feePolicy.digest)
    expect(canonicalizeTradeCommitment(V.tradeCommitment.fields)).toBe(V.tradeCommitment.canonicalUtf8)
    expect(hashTradeCommitment(V.tradeCommitment.fields)).toBe(V.tradeCommitment.digest)
  })

  it('signTradeCommitment produces the vector signature', () => {
    const secret = bytesToHex(nacl.sign.keyPair.fromSeed(hexToBytes(V.keys.taker.seed)).secretKey)
    expect(signTradeCommitment(V.tradeCommitment.fields, secret)).toBe(V.tradeCases[0].input.taker.signature)
  })

  it.each<[string, any]>(V.tradeCases.map((t: any) => [t.name, t]))('trade: %s', (_n, t: any) => {
    expect(evaluateTradeCommitment({ ...t.input, enabledRails: new Set(t.input.enabledRails) })).toMatchObject(t.expect)
  })

  it.each<[string, any]>(V.termsCases.map((t: any) => [t.name, t]))('terms (ordered R1->R7): %s', (_n, t: any) => {
    expect(validateArbitrationTerms(t.commitment, t.policy, derive(t.commitment.rail))).toEqual(t.expect)
  })

  it.each<[string, any]>(V.pairCases.map((t: any) => [t.name, t]))('pair: %s', (_n, t: any) => {
    expect(evaluateCommitmentPair({ trade: { ...t.input.trade, enabledRails: new Set(t.input.trade.enabledRails) }, arbitration: t.input.arbitration, deriveCapability: derive })).toMatchObject(t.expect)
  })
})
