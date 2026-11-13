/**
 * Sails Core Implementation Program M8-R (Live Dispatch Retry) — pure,
 * side-effect-free unit tests for dispatch-translation-guard.ts.
 * Constructs REAL PSBTs via bitcoinjs-lib directly (no mocking, no
 * database) — this is exactly the "deterministically inspectable"
 * property mission §18 asks for, proven by literally inspecting one.
 */
import * as bitcoin from 'bitcoinjs-lib'
import {
  validateTranslatedOutputsAgainstOutcome,
  assertTranslationMatchesOutcome,
  TranslationGuardError,
} from '../src/modules/open-settlement/dispatch-translation-guard'
import { buildArbitrationOutcome, buildOutcomeDestinationBinding } from '../src/modules/open-settlement/economic-outcome'
import { buildRulingOutcomeContent } from '../src/modules/open-settlement/dispute-outcome'

const NETWORK = bitcoin.networks.regtest

const FAKE_TXID = 'a'.repeat(64)
const BUYER_ADDRESS = bitcoin.payments.p2wpkh({ pubkey: Buffer.from('021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299', 'hex'), network: NETWORK }).address!
const SELLER_ADDRESS = bitcoin.payments.p2wpkh({ pubkey: Buffer.from('038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4', 'hex'), network: NETWORK }).address!
const ATTACKER_ADDRESS = bitcoin.payments.p2wpkh({ pubkey: Buffer.from('03a8f0fdc9911d8e33f58b1fced67b769189f2188431515e5171462522cb1be87b', 'hex'), network: NETWORK }).address!

function buildPsbt(inputValue: number, outputs: Array<{ address: string; value: number }>): string {
  const psbt = new bitcoin.Psbt({ network: NETWORK })
  psbt.addInput({
    hash: FAKE_TXID,
    index: 0,
    witnessUtxo: { script: bitcoin.address.toOutputScript(BUYER_ADDRESS, NETWORK), value: BigInt(inputValue) },
  })
  for (const o of outputs) {
    psbt.addOutput({ address: o.address, value: BigInt(o.value) })
  }
  return psbt.toBase64()
}

function releaseOutcome(totalUnits: string) {
  const content = buildRulingOutcomeContent('RELEASE', totalUnits, 'BTC', 'buyer-1', 'seller-1', null)
  const binding = buildOutcomeDestinationBinding([{ beneficiary: 'buyer-1', destination: BUYER_ADDRESS }])
  return buildArbitrationOutcome(content, binding)
}

function splitOutcome(totalUnits: string, buyerBps: number) {
  const content = buildRulingOutcomeContent('SPLIT', totalUnits, 'BTC', 'buyer-1', 'seller-1', buyerBps)
  const binding = buildOutcomeDestinationBinding([
    { beneficiary: 'buyer-1', destination: BUYER_ADDRESS },
    { beneficiary: 'seller-1', destination: SELLER_ADDRESS },
  ])
  return buildArbitrationOutcome(content, binding)
}

describe('buildRulingOutcomeContent — matches multisig.provider.ts buildUnsignedSplit() convention exactly', () => {
  it('RELEASE: buyer gets 10000bps, remainderBeneficiary is the buyer', () => {
    const content = buildRulingOutcomeContent('RELEASE', '100000', 'BTC', 'buyer-1', 'seller-1', null)
    expect(content.allocations).toEqual([{ beneficiary: 'buyer-1', basisPoints: 10000 }])
    expect(content.remainderBeneficiary).toBe('buyer-1')
  })

  it('REFUND: seller gets 10000bps, remainderBeneficiary is the seller', () => {
    const content = buildRulingOutcomeContent('REFUND', '100000', 'BTC', 'buyer-1', 'seller-1', null)
    expect(content.allocations).toEqual([{ beneficiary: 'seller-1', basisPoints: 10000 }])
    expect(content.remainderBeneficiary).toBe('seller-1')
  })

  it('SPLIT: buyer gets exactly buyerBps, seller gets the remainder — seller is remainderBeneficiary (matches buildUnsignedSplit\'s own buyerValue/sellerBase convention)', () => {
    const content = buildRulingOutcomeContent('SPLIT', '100000', 'BTC', 'buyer-1', 'seller-1', 7000)
    expect(content.allocations).toEqual([
      { beneficiary: 'buyer-1', basisPoints: 7000 },
      { beneficiary: 'seller-1', basisPoints: 3000 },
    ])
    expect(content.remainderBeneficiary).toBe('seller-1')
  })

  it('SPLIT rejects a missing/invalid buyerBps', () => {
    expect(() => buildRulingOutcomeContent('SPLIT', '100000', 'BTC', 'buyer-1', 'seller-1', null)).toThrow(/buyerBps/)
    expect(() => buildRulingOutcomeContent('SPLIT', '100000', 'BTC', 'buyer-1', 'seller-1', 0)).toThrow(/buyerBps/)
    expect(() => buildRulingOutcomeContent('SPLIT', '100000', 'BTC', 'buyer-1', 'seller-1', 10000)).toThrow(/buyerBps/)
  })
})

describe('P30/P31 — a faithful translation passes', () => {
  it('RELEASE: single correct output passes', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 100_000 }]) // 500 sat miner fee
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result).toEqual({ ok: true, mismatches: [] })
  })

  it('SPLIT: correct bps-exact outputs pass, remainder absorbed by seller', () => {
    const outcome = splitOutcome('100000', 7000)
    // spendable (post-fee) = 99500; buyer = floor(99500*7000/10000) = 69650; seller = 99500-69650 = 29850
    const psbt = buildPsbt(100_000, [
      { address: BUYER_ADDRESS, value: 69_650 },
      { address: SELLER_ADDRESS, value: 29_850 },
    ])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result).toEqual({ ok: true, mismatches: [] })
  })

  it('assertTranslationMatchesOutcome does not throw for a faithful translation', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 100_000 }])
    expect(() => assertTranslationMatchesOutcome(psbt, outcome, NETWORK)).not.toThrow()
  })
})

describe('§19/§46 — translator attacks are caught pre-dispatch', () => {
  it('wrong destination (correct amount, D3 instead of D1) is DIVERGENT and blocked', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [{ address: ATTACKER_ADDRESS, value: 100_000 }])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/no such output exists/)
    expect(() => assertTranslationMatchesOutcome(psbt, outcome, NETWORK)).toThrow(TranslationGuardError)
  })

  describe('M8.6 — execution-cost-bounded single-beneficiary skim detection (closes the M8-R disclosed gap)', () => {
    it('a legitimate, small fee (well under both ceilings) still passes — never a false positive', () => {
      const outcome = releaseOutcome('100000')
      const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 100_000 }]) // 500 sat fee, ~3 sat/vB, 0.5% of gross
      const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
      expect(result).toEqual({ ok: true, mismatches: [] })
    })

    it('DISCLOSED RESIDUAL (execution-cost-policy.ts\'s own header): a moderate (~10%) skim on a small escrow is NOT caught — the proportional ceiling (20%, deliberately loose so a real fee-spike settlement is never falsely rejected) does not reach this far without an external fee-market oracle, which mission M8.6 §15 explicitly forbids introducing', () => {
      const outcome = releaseOutcome('100000')
      const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 90_000 }]) // 10,000 sat implied fee, 10% of gross
      const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
      expect(result.ok).toBe(true) // accepted — see disclosed residual above
    })

    it('a LARGER skim (25% of gross) still exceeds the looser proportional ceiling and is caught — proving it remains load-bearing at its own new threshold, not merely decorative', () => {
      const outcome = releaseOutcome('100000')
      const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 75_000 }]) // 25,000 sat implied fee, ~152 sat/vB (under rate ceiling), 25% of gross (over the 20% proportional ceiling)
      const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
      expect(result.ok).toBe(false)
      expect(result.mismatches[0]).toMatch(/exceeds the deterministic ceiling/)
    })

    it('an extreme skim (a translator claiming half the escrow as "fee") is caught — the exact single-beneficiary vulnerability M8-R disclosed as open', () => {
      const outcome = releaseOutcome('100000')
      const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 50_000 }]) // "50,000 sats fee"
      const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
      expect(result.ok).toBe(false)
      expect(result.mismatches[0]).toMatch(/exceeds the deterministic ceiling/)
      expect(() => assertTranslationMatchesOutcome(psbt, outcome, NETWORK)).toThrow(TranslationGuardError)
    })
  })

  it('closes the adjacent, genuinely catchable case: a translator whose declared minerFeeSats disagrees with what it actually built is caught', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 90_000 }]) // implies a 10500 sat fee
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK, 500) // but claims only 500
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/internally inconsistent/)
  })

  it('a translator whose declared minerFeeSats DOES match its own PSBT passes the fee-consistency check', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 100_000 }])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK, 500)
    expect(result).toEqual({ ok: true, mismatches: [] })
  })

  it('SPLIT: swapped outputs (buyer\'s share sent to seller\'s address and vice versa) is caught', () => {
    const outcome = splitOutcome('100000', 7000)
    const psbt = buildPsbt(100_000, [
      { address: BUYER_ADDRESS, value: 29_850 }, // swapped
      { address: SELLER_ADDRESS, value: 69_650 }, // swapped
    ])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches.length).toBeGreaterThan(0)
  })

  it('SPLIT: 70/30 shifted to 60/40 is caught even though destinations are both correct', () => {
    const outcome = splitOutcome('100000', 7000)
    // 60/40 of 99500 instead of 70/30
    const psbt = buildPsbt(100_000, [
      { address: BUYER_ADDRESS, value: 59_700 },
      { address: SELLER_ADDRESS, value: 39_800 },
    ])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
  })

  it('added unauthorized output that inflates total delivered value beyond gross is caught by conservation, before the output-count check even runs', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(150_500, [
      { address: BUYER_ADDRESS, value: 100_000 },
      { address: ATTACKER_ADDRESS, value: 50_000 },
    ])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/delivered total .* exceeds the authorized gross entitlement/)
  })

  it('added unauthorized output disguised WITHIN the gross total (no conservation violation) is still caught by the output-count check', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(100_500, [
      { address: BUYER_ADDRESS, value: 99_000 },
      { address: ATTACKER_ADDRESS, value: 1_000 },
    ])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches.some((m) => m.includes('output(s), expected exactly'))).toBe(true)
  })

  it('omitted output (missing beneficiary in a SPLIT) is caught', () => {
    const outcome = splitOutcome('100000', 7000)
    const psbt = buildPsbt(100_000, [{ address: BUYER_ADDRESS, value: 99_500 }]) // seller's leg entirely missing
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
  })

  it('outputs exceeding input (negative implied fee) is caught', () => {
    const outcome = releaseOutcome('100000')
    const psbt = buildPsbt(90_000, [{ address: BUYER_ADDRESS, value: 100_000 }])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/exceed its own declared input/)
  })

  it('a malformed/undecodable PSBT is caught, never thrown as an uncaught exception', () => {
    const outcome = releaseOutcome('100000')
    const result = validateTranslatedOutputsAgainstOutcome('not-a-real-psbt', outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/failed to decode/)
  })

  it('an Outcome with no destination binding at all is refused, never silently passed', () => {
    const content = buildRulingOutcomeContent('RELEASE', '100000', 'BTC', 'buyer-1', 'seller-1', null)
    // Bypass buildArbitrationOutcome()'s own construction-time guard by
    // constructing the Outcome shape directly, to prove THIS function's
    // own independent fail-closed check (defense in depth).
    const outcome = { content, destinationBinding: { reference: [] } }
    const psbt = buildPsbt(100_500, [{ address: BUYER_ADDRESS, value: 100_000 }])
    const result = validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatch(/no destination binding/)
  })
})

describe('Determinism', () => {
  it('the same PSBT and Outcome produce the identical verdict across repeated calls', () => {
    const outcome = splitOutcome('100000', 7000)
    const psbt = buildPsbt(100_000, [
      { address: BUYER_ADDRESS, value: 69_650 },
      { address: SELLER_ADDRESS, value: 29_850 },
    ])
    const results = Array.from({ length: 5 }, () => JSON.stringify(validateTranslatedOutputsAgainstOutcome(psbt, outcome, NETWORK)))
    expect(new Set(results).size).toBe(1)
  })
})

describe('TranslationGuardError - error contract (GK-M9R-D R2, CTO 25 item 1)', () => {
  it('is a classified 409 AppError whose details carry the mismatches, so app.ts maps it like any other expected refusal', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppError } = require('../src/common/errors')
    const err = new TranslationGuardError(['output 0 pays 8500 sats, expected 7000'])
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(409)
    expect(err.toResponse()).toMatchObject({ success: false, error: 'TRANSLATION_GUARD_MISMATCH', details: ['output 0 pays 8500 sats, expected 7000'] })
    expect(err.mismatches).toEqual(['output 0 pays 8500 sats, expected 7000'])
  })
})
