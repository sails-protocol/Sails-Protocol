/**
 * E25 F1 / E26 - server implementation against the shared conformance vectors
 * (conformance/vectors/sails-trade-commitment-v1.vectors.json). The SDK runs the same vectors
 * against its own implementation (packages/sails-sdk/tests/trade-commitment.test.ts).
 */
import nacl from 'tweetnacl'
import { hashOfferEnvelope, verifyOfferEnvelope } from '../src/modules/open-liquidity/offer-envelope'
import { canonicalizeTradeCommitment, evaluateTradeCommitment, feePolicyDigestV1, hashTradeCommitment, signTradeCommitment } from '../src/modules/open-p2p/trade-commitment'
import { evaluateCommitmentPair, validateArbitrationTerms } from '../src/modules/open-p2p/arbitration-commitment'

const V = require('../conformance/vectors/sails-trade-commitment-v1.vectors.json')
const derive = (rail: string) => V.railCapability[rail] ?? 'UNKNOWN'
const subset = (got: object, exp: object) => expect(got).toMatchObject(exp)

describe('TradeCommitmentV1 / ArbitrationCommitmentV1 (server) - conformance vectors', () => {
  it('fixture: the offer envelope verifies and hashes to the digest the commitment binds', () => {
    expect(verifyOfferEnvelope({ ...V.offerEnvelope.content, signature: V.offerEnvelope.signature })).toEqual({ valid: true })
    expect(hashOfferEnvelope(V.offerEnvelope.content).toString('hex')).toBe(V.offerEnvelope.digest)
    expect(V.tradeCommitment.fields.offerEnvelopeDigest).toBe(V.offerEnvelope.digest)
  })

  it('fixture: keys derive from the published seeds; FeePolicyDigestV1 and the canonical bytes reproduce', () => {
    for (const role of ['maker', 'taker', 'arbiter']) {
      expect(Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(V.keys[role].seed, 'hex')).publicKey).toString('hex')).toBe(V.keys[role].publicKey)
    }
    expect(feePolicyDigestV1(V.feePolicy.input)).toBe(V.feePolicy.digest)
    expect(canonicalizeTradeCommitment(V.tradeCommitment.fields).toString('utf8')).toBe(V.tradeCommitment.canonicalUtf8)
    expect(hashTradeCommitment(V.tradeCommitment.fields)).toBe(V.tradeCommitment.digest)
  })

  it('signTradeCommitment produces the vector signature (deterministic Ed25519)', () => {
    const secret = Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(V.keys.maker.seed, 'hex')).secretKey).toString('hex')
    expect(signTradeCommitment(V.tradeCommitment.fields, secret)).toBe(V.tradeCases[0].input.maker.signature)
  })

  it.each<[string, any]>(V.tradeCases.map((t: any) => [t.name, t]))('trade: %s', (_n, t: any) => {
    subset(evaluateTradeCommitment({ ...t.input, enabledRails: new Set(t.input.enabledRails) }), t.expect)
  })

  it.each<[string, any]>(V.termsCases.map((t: any) => [t.name, t]))('terms (ordered R1->R7): %s', (_n, t: any) => {
    expect(validateArbitrationTerms(t.commitment, t.policy, derive(t.commitment.rail))).toEqual(t.expect)
  })

  it.each<[string, any]>(V.pairCases.map((t: any) => [t.name, t]))('pair: %s', (_n, t: any) => {
    subset(evaluateCommitmentPair({ trade: { ...t.input.trade, enabledRails: new Set(t.input.trade.enabledRails) }, arbitration: t.input.arbitration, deriveCapability: derive }), t.expect)
  })
})
