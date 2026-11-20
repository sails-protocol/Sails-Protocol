/**
 * E25/E26 F2 (P33) - admission against the verified offer envelope (F2.1), execution readiness (F2.2)
 * and the real capability classification (F2.3), on the shared conformance vectors.
 */
import nacl from 'tweetnacl'
import { signOfferEnvelope } from '../src/modules/open-liquidity/offer-envelope'
import { evaluateCommitmentPair, hashArbitrationCommitment } from '../src/modules/open-p2p/arbitration-commitment'
import { admitCommitmentPair, executionReadiness } from '../src/modules/open-p2p/commitment-admission'

const V = require('../conformance/vectors/sails-trade-commitment-v1.vectors.json')
const NOW = new Date('2026-11-19T11:10:00.000Z')
const envelope = { ...V.offerEnvelope.content, signature: V.offerEnvelope.signature }
const pairCase = (name: string) => V.pairCases.find((t: any) => t.name.startsWith(name)).input
const admit = (input: any, over: { envelope?: any; now?: Date } = {}) => {
  const { offer: _offer, ...trade } = input.trade
  return admitCommitmentPair({ envelope: over.envelope ?? envelope, now: over.now ?? NOW, trade: { ...trade, enabledRails: new Set(trade.enabledRails) }, arbitration: input.arbitration })
}
const secretHex = (seed: string) => Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(seed, 'hex')).secretKey).toString('hex')

describe('E25/E26 F2 - commitment admission and execution readiness (pure)', () => {
  const fixed = pairCase('valid FIXED pair')
  const MULTISIG = fixed.arbitration.commitment
  /** A COMMITTED verdict whose digest is these terms' own: readiness reads only the verdict and the terms. */
  const committedFor = (terms: any) => ({ ok: true as const, state: 'COMMITTED' as const, commitmentDigest: terms.commitmentDigest, arbitrationCommitmentDigest: hashArbitrationCommitment(terms) })

  it('F2.1+F2.2: a valid MULTISIG pair admitted against its verified envelope passes the commitment gate', () => {
    const v = admit(fixed)
    expect(v).toMatchObject({ ok: true, state: 'COMMITTED', executable: true, commitmentDigest: V.tradeCommitment.digest })
    expect(executionReadiness(v, MULTISIG)).toMatchObject({ ok: true, gate: 'COMMITMENT_PAIR_COMMITTED' })
  })

  it('F2.1: an envelope whose signature does not verify is refused BEFORE the pair is evaluated', () => {
    const wrongSigner = { ...envelope, signature: signOfferEnvelope(V.offerEnvelope.content, secretHex(V.keys.taker.seed)) }
    expect(admit(fixed, { envelope: wrongSigner })).toEqual({ ok: false, code: 'E25_OFFER_ENVELOPE_INVALID', field: 'envelope' })
  })

  it('F2.1: a correctly signed but CANCELLED envelope is refused (activity, not only signature)', () => {
    const cancelled = { ...V.offerEnvelope.content, status: 'CANCELLED' }
    const signed = { ...cancelled, signature: signOfferEnvelope(cancelled, secretHex(V.keys.maker.seed)) }
    expect(admit(fixed, { envelope: signed })).toEqual({ ok: false, code: 'E25_OFFER_ENVELOPE_INVALID', field: 'envelope.active' })
  })

  it('F2.1: an envelope already expired at the server clock is refused', () => {
    expect(admit(fixed, { now: new Date(V.offerEnvelope.content.expiresAt) })).toEqual({ ok: false, code: 'E25_OFFER_ENVELOPE_INVALID', field: 'envelope.active' })
  })

  it('F2.1: the accepted offer comes from the envelope, not from the caller (a forged offer in the input is ignored)', () => {
    // Were the forged offer used, its minAmount above the committed amount would refuse with E25_OFFER_LIMITS_VIOLATED.
    const trade = { ...fixed.trade, enabledRails: new Set(fixed.trade.enabledRails), offer: { ...fixed.trade.offer, minAmount: '0.01000000' } }
    expect(admitCommitmentPair({ envelope, now: NOW, trade, arbitration: fixed.arbitration } as any)).toMatchObject({ ok: true, state: 'COMMITTED' })
  })

  it('F2.3: an unclassified rail is UNKNOWN for the real classification -> non-executable proposal (P22)', () => {
    const v = admit(pairCase('P22: valid UNKNOWN pair with all four signatures'))
    expect(v).toMatchObject({ ok: true, state: 'PROPOSED', executable: false, reason: 'E26_CAPABILITY_UNPROVEN' })
    expect(executionReadiness(v, pairCase('P22: valid UNKNOWN pair with all four signatures').arbitration.commitment)).toEqual({ ok: false, code: 'E26_CAPABILITY_UNPROVEN' })
  })

  it('F2.3: UNAVAILABLE cannot be reached through the real classification (no rail declares it): the pair is refused', () => {
    expect(admit(pairCase('P32: valid UNAVAILABLE pair with all four signatures'))).toEqual({ ok: false, code: 'E26_TERMS_REFUSED', terms: ['E26_CAPABILITY_RAIL_MISMATCH'] })
  })

  const pure = (input: any) => evaluateCommitmentPair({ trade: { ...input.trade, enabledRails: new Set(input.trade.enabledRails) }, arbitration: input.arbitration, deriveCapability: (r) => V.railCapability[r] })

  it('F2.2 (P32): a COMMITTED pair declaring UNAVAILABLE records the consent but is never executable: E26_ARBITRATION_UNAVAILABLE, not UNPROVEN', () => {
    const input = pairCase('P32: valid UNAVAILABLE pair with all four signatures')
    // Since #704 HEAD-U the pure verdict itself is a non-executable proposal; readiness refuses it by its reason.
    const v = pure(input)
    expect(v).toMatchObject({ ok: true, state: 'PROPOSED', executable: false, reason: 'E26_ARBITRATION_UNAVAILABLE' })
    expect(executionReadiness(v, input.arbitration.commitment)).toEqual({ ok: false, code: 'E26_ARBITRATION_UNAVAILABLE' })
    // GK R-B, defence in depth: even a COMMITTED verdict whose terms declare UNAVAILABLE is never ready.
    expect(executionReadiness(committedFor(input.arbitration.commitment), input.arbitration.commitment)).toEqual({ ok: false, code: 'E26_ARBITRATION_UNAVAILABLE' })
  })

  it('F2.2: a COMMITTED verdict is not ready on a rail the real classification does not prove', () => {
    const onWdk = { ...MULTISIG, rail: 'WDK_USDT_EVM' }
    expect(executionReadiness(committedFor(onWdk), onWdk)).toEqual({ ok: false, code: 'E26_CAPABILITY_UNPROVEN' })
    // A fixture-DYNAMIC rail is unknown to the real classification.
    const onPool = { ...MULTISIG, rail: 'EXAMPLE_POOL_RAIL', arbitrationCapability: 'DYNAMIC_REASSIGNABLE' }
    expect(executionReadiness(committedFor(onPool), onPool)).toEqual({ ok: false, code: 'E26_CAPABILITY_UNPROVEN' })
  })

  it('GK R-A: terms of another pair never pass, even with a COMMITTED verdict', () => {
    const other = pairCase('P22: valid UNKNOWN pair with all four signatures').arbitration.commitment
    expect(executionReadiness(admit(fixed), other)).toEqual({ ok: false, code: 'E26_DIGEST_MISMATCH', field: 'terms' })
    expect(executionReadiness(admit(fixed), { ...MULTISIG, arbiterRef: 'f'.repeat(64) })).toEqual({ ok: false, code: 'E26_DIGEST_MISMATCH', field: 'terms' })
  })

  it('GK F2: every ok verdict from admission carries a boolean executable, true only for a ready COMMITTED pair', () => {
    let seen = 0
    for (const t of V.pairCases) {
      const v: any = admit(t.input)
      if (!v.ok) continue
      seen++
      expect(typeof v.executable).toBe('boolean')
      expect(v.executable).toBe(v.state === 'COMMITTED' && t.input.arbitration.commitment.rail === 'MULTISIG')
      if (!v.executable) expect(typeof v.reason).toBe('string')
    }
    expect(seen).toBeGreaterThanOrEqual(3)
    expect(admit(pairCase('nobody signed either object'))).toMatchObject({ ok: true, state: 'PROPOSED', executable: false, reason: 'E25_NOT_COMMITTED' })
  })

  it('F2.2: only COMMITTED passes; a partial pair and a refusal never do', () => {
    expect(executionReadiness({ ok: true, state: 'PARTIALLY_SIGNED', commitmentDigest: 'x', arbitrationCommitmentDigest: 'y' }, MULTISIG)).toEqual({ ok: false, code: 'E25_NOT_COMMITTED' })
    expect(executionReadiness({ ok: true, state: 'PROPOSED', commitmentDigest: 'x', arbitrationCommitmentDigest: 'y' }, MULTISIG)).toEqual({ ok: false, code: 'E25_NOT_COMMITTED' })
    expect(executionReadiness({ ok: false, code: 'E26_SIGNATURE_INVALID', field: 'maker' }, MULTISIG)).toEqual({ ok: false, code: 'E26_SIGNATURE_INVALID', field: 'maker' })
  })
})
