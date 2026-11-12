// CTO 25 funding binding - multisig-round-input-binding.ts against real 2-of-3 P2WSH PSBTs (bitcoinjs-lib), no mocks.
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import { roundInputMismatches, assertRoundInputBinding, RoundInputMismatch } from '../src/modules/open-settlement/multisig-round-input-binding'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet
const key = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(label).digest(), { network })
function script(labels: string[]) {
  const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys: labels.map((l) => Buffer.from(key(l).publicKey)).sort(Buffer.compare), network })
  return { p2ms, p2wsh: bitcoin.payments.p2wsh({ redeem: p2ms, network }) }
}
const OWN = script(['b', 's', 'a'])
const OTHER = script(['b2', 's2', 'a'])
const TXID = 'aa'.repeat(32)
const PAYOUT = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key('payout').publicKey), network }).address!
const escrow = { id: 'escrow-1', txLockId: TXID, txLockVout: 0, multisigAddr: OWN.p2wsh.address!, fundedAmount: '0.001' }

function psbt(opts: { txid?: string; vout?: number; value?: number; s?: typeof OWN; extraInput?: boolean; witnessScriptOf?: typeof OWN } = {}) {
  const s = opts.s ?? OWN
  const p = new bitcoin.Psbt({ network })
  p.addInput({ hash: opts.txid ?? TXID, index: opts.vout ?? 0, witnessUtxo: { script: s.p2wsh.output!, value: BigInt(opts.value ?? 100_000) }, witnessScript: (opts.witnessScriptOf ?? s).p2ms.output! })
  if (opts.extraInput) p.addInput({ hash: 'bb'.repeat(32), index: 0, witnessUtxo: { script: s.p2wsh.output!, value: 5_000n }, witnessScript: s.p2ms.output! })
  p.addOutput({ address: PAYOUT, value: 99_000n })
  return p.toBase64()
}

describe('round input binding', () => {
  it('accepts the round that spends exactly the recorded funding', () => {
    expect(roundInputMismatches(psbt(), escrow, network)).toEqual([])
    expect(() => assertRoundInputBinding(psbt(), { ...escrow, fundedAmount: '0.00100000' })).not.toThrow()
  })

  it.each([
    ['another txid', { txid: 'cc'.repeat(32) }, /round spends c{64}:0, the recorded funding outpoint is a{64}:0/],
    ['another vout', { vout: 1 }, /round spends a{64}:1/],
    ['another value', { value: 100_001 }, /input value is 100001 sats, the recorded funded amount is 100000 sats/],
    ['another escrow\'s script', { s: OTHER }, /input script is not this escrow's P2WSH/],
    ['a witnessScript that does not hash to the script', { witnessScriptOf: OTHER }, /witnessScript does not hash/],
    ['two inputs', { extraInput: true }, /spends 2 input\(s\), expected exactly 1/],
  ] as const)('refuses a round with %s', (_name, opts, message) => {
    const mismatches = roundInputMismatches(psbt(opts), escrow, network)
    expect(mismatches.join(' | ')).toMatch(message)
  })

  it.each([
    ['no recorded vout', { txLockVout: null }, /no recorded funding outpoint/],
    ['no recorded txid', { txLockId: null }, /no recorded funding outpoint/],
    ['no committed address', { multisigAddr: null }, /no committed MULTISIG address/],
    ['no recorded funded amount', { fundedAmount: null }, /no recorded funded amount/],
  ] as const)('refuses when the escrow has %s (fail closed)', (_name, patch, message) => {
    expect(roundInputMismatches(psbt(), { ...escrow, ...patch }, network).join(' ')).toMatch(message)
  })

  it('refuses a PSBT that does not decode', () => {
    expect(roundInputMismatches('not-a-psbt', escrow, network).join(' ')).toMatch(/failed to decode/)
  })

  it('assertRoundInputBinding throws a typed 409 carrying the mismatches', () => {
    let err: unknown
    try { assertRoundInputBinding(psbt({ vout: 3 }), escrow) } catch (e) { err = e }
    expect(err).toBeInstanceOf(RoundInputMismatch)
    expect(err).toMatchObject({ statusCode: 409, code: 'ROUND_INPUT_MISMATCH' })
    expect((err as RoundInputMismatch).mismatches).toHaveLength(1)
  })
})
