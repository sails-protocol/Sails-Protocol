// tests/multisigRoundProofs.test.ts
//
// Issue #239 - the pure Bitcoin checks behind the signing-round lifecycle, with REAL keys, REAL 2-of-3 P2WSH PSBTs
// and REAL signatures (bitcoinjs-lib + secp256k1). Nothing here is mocked: these are the properties themselves.
//   - verifySignerPartialSignature(): exactly one new SIGHASH_ALL partial signature by the signer's registered key,
//     valid over the SERVER's copy of the round (T11);
//   - proveExternalCompletion(): a spend is this exact round, signed by exactly its required signers (C-1);
//   - the premise of both: a P2WSH round's unsigned txid IS its final txid, with and without a fee output.
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as productionEcc from 'tiny-secp256k1' // the library the server verifies with
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import { verifySignerPartialSignature, proveExternalCompletion, roundUnsignedTxid, RoundSignatureRejected, findHighSPartialSignatures } from '../src/modules/open-settlement/multisig-round-proofs'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NETWORK = bitcoin.networks.testnet
const { SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } = bitcoin.Transaction

const key = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`239-proofs-${label}`).digest(), { network: NETWORK })
const buyer = key('buyer')
const seller = key('seller')
const arbiter = key('arbiter')
const stranger = key('stranger')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const address = (label: string) => bitcoin.payments.p2wpkh({ pubkey: key(label).publicKey, network: NETWORK }).address!
const FUNDING_TXID = createHash('sha256').update('239-proofs-funding').digest('hex')
const VALUE = 100_000n

function script(keys = [buyer, seller, arbiter]) {
  const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys: keys.map((k) => Buffer.from(k.publicKey)).sort(Buffer.compare), network: NETWORK })
  return { p2ms, p2wsh: bitcoin.payments.p2wsh({ redeem: p2ms, network: NETWORK }) }
}

/** A round as multisig.provider.ts builds it: one funding input, the payout, and optionally the Sails fee output. */
function round(opts: { fee?: boolean; payout?: bigint } = {}) {
  const { p2ms, p2wsh } = script()
  const psbt = new bitcoin.Psbt({ network: NETWORK })
  psbt.addInput({ hash: FUNDING_TXID, index: 0, witnessUtxo: { script: p2wsh.output!, value: VALUE }, witnessScript: p2ms.output! })
  psbt.addOutput({ address: address('payout'), value: opts.payout ?? 90_000n })
  if (opts.fee !== false) psbt.addOutput({ address: address('fee'), value: 5_000n })
  return psbt.toBase64()
}

const sign = (unsigned: string, signer: ReturnType<typeof key>, hashType = SIGHASH_ALL) => {
  const psbt = bitcoin.Psbt.fromBase64(unsigned, { network: NETWORK })
  if (hashType !== SIGHASH_ALL) psbt.updateInput(0, { sighashType: hashType })
  psbt.signInput(0, signer, [hashType])
  return psbt
}

const finalize = (unsigned: string, signed: string[]) => {
  const merged = bitcoin.Psbt.fromBase64(unsigned, { network: NETWORK })
  for (const s of signed) merged.combine(bitcoin.Psbt.fromBase64(s, { network: NETWORK }))
  merged.finalizeAllInputs()
  return merged.extractTransaction()
}

const withSignature = (psbt: bitcoin.Psbt, edit: (sig: Buffer) => Buffer) => {
  psbt.data.inputs[0].partialSig![0].signature = edit(Buffer.from(psbt.data.inputs[0].partialSig![0].signature))
  return psbt
}

describe('verifySignerPartialSignature() - T11, real PSBTs', () => {
  const unsigned = round()

  it('accepts one SIGHASH_ALL signature by the signer and returns the server copy plus exactly that signature', () => {
    const stored = verifySignerPartialSignature(unsigned, sign(unsigned, buyer).toBase64(), hex(buyer.publicKey), NETWORK)
    const parsed = bitcoin.Psbt.fromBase64(stored, { network: NETWORK })
    expect(parsed.data.inputs[0].partialSig!.map((p) => hex(p.pubkey))).toEqual([hex(buyer.publicKey)])
    // What is stored combines and finalizes for real with the other required signer.
    const sellerStored = verifySignerPartialSignature(unsigned, sign(unsigned, seller).toBase64(), hex(seller.publicKey), NETWORK)
    expect(finalize(unsigned, [stored, sellerStored]).getId()).toBe(roundUnsignedTxid(unsigned, NETWORK))
  })

  it('accepts a signature next to an already-embedded arbiter signature (disputed round shape)', () => {
    const withArbiter = sign(unsigned, arbiter).toBase64()
    expect(() => verifySignerPartialSignature(withArbiter, sign(withArbiter, buyer).toBase64(), hex(buyer.publicKey), NETWORK)).not.toThrow()
  })

  const refusals: Array<[string, () => string, RegExp]> = [
    ['not a PSBT', () => 'not-base64-psbt', /not a valid PSBT/],
    ['a signature of another transaction', () => sign(round({ payout: 89_000n }), buyer).toBase64(), /does not sign this round/],
    ['SIGHASH_NONE (field and signature)', () => sign(unsigned, buyer, SIGHASH_NONE).toBase64(), /sighash other than SIGHASH_ALL/],
    ['SIGHASH_SINGLE', () => sign(unsigned, buyer, SIGHASH_SINGLE).toBase64(), /sighash other than SIGHASH_ALL/],
    ['SIGHASH_ALL|ANYONECANPAY', () => sign(unsigned, buyer, SIGHASH_ALL | SIGHASH_ANYONECANPAY).toBase64(), /sighash other than SIGHASH_ALL/],
    ['a non-ALL signature with the sighash field stripped', () => {
      const psbt = sign(unsigned, buyer, SIGHASH_NONE)
      delete (psbt.data.inputs[0] as { sighashType?: number }).sighashType
      return psbt.toBase64()
    }, /is not SIGHASH_ALL/],
    ['the wrong key (seller signs, submitted as the buyer)', () => sign(unsigned, seller).toBase64(), /exactly one partial signature/],
    ['two new partial signatures', () => sign(sign(unsigned, buyer).toBase64(), seller).toBase64(), /exactly one partial signature/],
    ['no new partial signature', () => unsigned, /exactly one partial signature/],
    ['a finalized input', () => {
      const psbt = sign(sign(unsigned, buyer).toBase64(), seller)
      psbt.finalizeAllInputs()
      return psbt.toBase64()
    }, /already finalized/],
    ['a signature over a tampered witnessUtxo amount', () => {
      const tampered = bitcoin.Psbt.fromBase64(unsigned, { network: NETWORK })
      tampered.data.inputs[0].witnessUtxo!.value = 1n
      tampered.signInput(0, buyer)
      return tampered.toBase64()
    }, /does not verify/],
    ['a signature with one bit flipped', () => withSignature(sign(unsigned, buyer), (sig) => { sig[10] ^= 0x01; return sig }).toBase64(), /does not verify/],
    // GK B1 / F-1: consensus-valid but non-standard; a node refuses to relay it.
    ['a high-S signature (s replaced by n - s)', () => withSignature(sign(unsigned, buyer), highS).toBase64(), /not low-S/],
    ['a malformed DER signature (bad sequence tag)', () => withSignature(sign(unsigned, buyer), (sig) => { sig[0] = 0x31; return sig }).toBase64(), /not a valid DER signature/],
    ['a truncated DER signature', () => withSignature(sign(unsigned, buyer), (sig) => sig.subarray(0, 20)).toBase64(), /not a valid DER signature/],
  ]
  it.each(refusals)('refuses %s, with its reason', (_name, submitted, reason) => {
    expect(() => verifySignerPartialSignature(unsigned, submitted(), hex(buyer.publicKey), NETWORK)).toThrow(RoundSignatureRejected)
    expect(() => verifySignerPartialSignature(unsigned, submitted(), hex(buyer.publicKey), NETWORK)).toThrow(reason)
  })

  it('the high-S signature is otherwise valid: refused only for its S, not as a forgery', () => {
    const psbt = withSignature(sign(unsigned, buyer), highS)
    expect(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => productionEcc.verify(hash, pubkey, signature))).toBe(true)
    expect(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => productionEcc.verify(hash, pubkey, signature, true))).toBe(false)
  })

  it('every ordinary signature is accepted, whatever its r (the check reads S only)', () => {
    let highR = 0
    for (let i = 0; i < 40; i++) {
      const variant = round({ payout: 80_000n + BigInt(i) })
      const psbt = sign(variant, buyer)
      if (Buffer.from(psbt.data.inputs[0].partialSig![0].signature).readUInt8(3) === 33) highR++ // DER r padded: top bit set
      expect(() => verifySignerPartialSignature(variant, psbt.toBase64(), hex(buyer.publicKey), NETWORK)).not.toThrow()
    }
    expect(highR).toBeGreaterThan(0)
  })
})

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
/** The same signature with s replaced by n - s: still valid for consensus, but high-S. */
function highS(der: Buffer): Buffer {
  const { signature, hashType } = bitcoin.script.signature.decode(der)
  const s = BigInt('0x' + Buffer.from(signature.subarray(32)).toString('hex'))
  const flipped = Buffer.from((SECP256K1_ORDER - s).toString(16).padStart(64, '0'), 'hex')
  return Buffer.from(bitcoin.script.signature.encode(Buffer.concat([Buffer.from(signature.subarray(0, 32)), flipped]), hashType))
}

describe('findHighSPartialSignatures() - D1 pre-deploy sweep, real PSBTs', () => {
  const unsigned = round()
  const pubkey = hex(buyer.publicKey)

  it('reports nothing for ordinary low-S signatures, or for a PSBT with none', () => {
    expect(findHighSPartialSignatures(sign(sign(unsigned, buyer).toBase64(), seller).toBase64(), NETWORK)).toEqual([])
    expect(findHighSPartialSignatures(unsigned, NETWORK)).toEqual([])
  })

  it('reports a stored high-S signature with its input and key, alongside a low-S one it leaves alone', () => {
    const psbt = withSignature(sign(unsigned, buyer), highS)
    psbt.signInput(0, seller)
    expect(findHighSPartialSignatures(psbt.toBase64(), NETWORK)).toEqual([{ input: 0, pubkey, reason: 'HIGH_S' }])
  })

  it('reports an undecodable signature instead of assuming it is low-S', () => {
    const psbt = withSignature(sign(unsigned, buyer), (sig) => { sig[0] = 0x31; return sig })
    expect(findHighSPartialSignatures(psbt.toBase64(), NETWORK)).toEqual([{ input: 0, pubkey, reason: 'UNDECODABLE' }])
  })

  it('throws on a PSBT it cannot parse (the sweep counts it as a finding)', () => {
    expect(() => findHighSPartialSignatures('not-a-psbt', NETWORK)).toThrow()
  })
})

describe('proveExternalCompletion() - C-1, real transactions', () => {
  const unsigned = round()
  const scriptPubkeysHex = [buyer, seller, arbiter].map((k) => hex(k.publicKey))
  const required = [hex(buyer.publicKey), hex(seller.publicKey)]
  const prove = (tx: bitcoin.Transaction, overrides: Partial<Parameters<typeof proveExternalCompletion>[0]> = {}) => proveExternalCompletion({
    spendingTxHex: tx.toHex(), spendingTxid: tx.getId(), unsignedPsbtBase64: unsigned, fundingTxid: FUNDING_TXID, fundingVout: 0,
    scriptPubkeysHex, requiredSignerPubkeysHex: required, network: NETWORK, ...overrides,
  })

  /** The round's transaction with a hand-built witness: [empty, ...signatures, witnessScript]. */
  function spend(signers: Array<{ k: ReturnType<typeof key>; hashType?: number }>, witnessScript = script().p2ms.output!, base = unsigned) {
    const tx = bitcoin.Transaction.fromBuffer(bitcoin.Psbt.fromBase64(base, { network: NETWORK }).data.globalMap.unsignedTx.toBuffer())
    const sigs = signers.map(({ k, hashType = SIGHASH_ALL }) =>
      bitcoin.script.signature.encode(k.sign(tx.hashForWitnessV0(0, witnessScript, VALUE, hashType)), hashType))
    tx.setWitness(0, [Buffer.alloc(0), ...sigs, witnessScript])
    return tx
  }

  it('proves a real external completion by the buyer and the seller', () => {
    const tx = finalize(unsigned, [sign(unsigned, seller).toBase64(), sign(unsigned, buyer).toBase64()])
    expect(prove(tx)).toEqual({ ok: true })
  })

  const negatives: Array<[string, RegExp, () => ReturnType<typeof prove>]> = [
    ['a signature with one bit flipped', /does not verify against any script key|not a valid DER/, () => {
      const tx = spend([{ k: buyer }, { k: seller }])
      const bad = Buffer.from(tx.ins[0].witness[1]); bad[8] ^= 0x01
      tx.ins[0].witness[1] = bad
      return prove(tx)
    }],
    ['SIGHASH_NONE inside the witness', /not SIGHASH_ALL/, () => prove(spend([{ k: buyer, hashType: SIGHASH_NONE }, { k: seller }]))],
    ['SIGHASH_SINGLE inside the witness', /not SIGHASH_ALL/, () => prove(spend([{ k: buyer }, { k: seller, hashType: SIGHASH_SINGLE }]))],
    ['SIGHASH_ALL|ANYONECANPAY inside the witness', /not SIGHASH_ALL/, () => prove(spend([{ k: buyer, hashType: SIGHASH_ALL | SIGHASH_ANYONECANPAY }, { k: seller }]))],
    ['one signature only', /not a 2-of-3/, () => prove(spend([{ k: buyer }]))],
    ['three signatures', /not a 2-of-3/, () => prove(spend([{ k: buyer }, { k: seller }, { k: arbiter }]))],
    ['the arbiter key in place of a required signer', /exactly the required signers/, () => prove(spend([{ k: buyer }, { k: arbiter }]))],
    ['a stranger key', /does not verify against any script key/, () => prove(spend([{ k: buyer }, { k: stranger }]))],
    ['a different witness script', /witness script is not/, () => prove(spend([{ k: buyer }, { k: seller }], script([buyer, seller, stranger]).p2ms.output!))],
    ['a transaction that is not byte-identical to the round', /not byte-identical/, () => prove(spend([{ k: buyer }, { k: seller }], undefined, round({ payout: 89_000n })))],
    ['two inputs', /2 inputs/, () => {
      const tx = spend([{ k: buyer }, { k: seller }])
      tx.addInput(Buffer.alloc(32, 7), 1)
      return prove(tx)
    }],
    ['a different funding outpoint', /funding outpoint/, () => prove(spend([{ k: buyer }, { k: seller }]), { fundingVout: 1 })],
    ['served bytes that do not hash to the reported txid (lying explorer)', /do not hash to the reported txid/, () => prove(spend([{ k: buyer }, { k: seller }]), { spendingTxid: 'ab'.repeat(32) })],
    ['unparseable bytes', /cannot be parsed/, () => prove(spend([{ k: buyer }, { k: seller }]), { spendingTxHex: 'zz' })],
  ]
  it.each(negatives)('refuses %s', (_name, reason, attempt) => {
    expect(attempt()).toEqual({ ok: false, reason: expect.stringMatching(reason) })
  })
})

describe('premise of B1 - a P2WSH round keeps its txid when finalized', () => {
  it.each([['release with a fee output', { fee: true }], ['refund without a fee output', { fee: false }]] as const)('%s', (_n, opts) => {
    const unsigned = round(opts)
    const final = finalize(unsigned, [sign(unsigned, buyer).toBase64(), sign(unsigned, seller).toBase64()])
    expect(final.getId()).toBe(roundUnsignedTxid(unsigned, NETWORK))
    expect(final.hasWitnesses()).toBe(true)
  })
})
