/**
 * Issue #239 - pure Bitcoin checks for a MULTISIG signing round. No I/O, no database: the callers decide what
 * a failed proof means (refuse a signature, or route an external spend to manual review).
 *
 * 1. verifySignerPartialSignature(): a submitted PSBT may add exactly ONE partial signature, by the signer's
 *    registered key, SIGHASH_ALL, valid over the SERVER's own copy of the round (its witnessUtxo and
 *    witnessScript, never the client's). The returned PSBT is that server copy plus the one signature.
 * 2. proveExternalCompletion(): a transaction found spending the funding outpoint is this exact round, signed
 *    by exactly its required signers - the condition Sails' own finalize requires, rebuilt from the chain.
 */
import * as ecc from 'tiny-secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import { networkFor } from './multisig.provider'

type Network = (typeof bitcoin.networks)[keyof typeof bitcoin.networks]

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL
// n / 2 for secp256k1 (BIP 62 / BIP 146 LOW_S): a standard ECDSA signature has s <= this value.
const SECP256K1_HALF_ORDER = Buffer.from('7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0', 'hex')

/** A submitted signature that does not belong to the live round. Nothing is written when this is thrown. */
export class RoundSignatureRejected extends EscrowError {}

function unsignedTxBytes(psbt: bitcoin.Psbt): string {
  return toHex(psbt.data.globalMap.unsignedTx.toBuffer())
}

/** The round's txid. For a P2WSH spend the witness is not hashed, so this IS the final transaction's txid. */
export function roundUnsignedTxid(unsignedPsbtBase64: string, network: Network): string {
  const psbt = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network })
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer()).getId()
}

export function verifySignerPartialSignature(
  unsignedPsbtBase64: string,
  signedPsbtBase64: string,
  signerPubkeyHex: string,
  network: Network = networkFor(config.multisig.network)
): string {
  let live: bitcoin.Psbt
  let submitted: bitcoin.Psbt
  try {
    live = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network })
    submitted = bitcoin.Psbt.fromBase64(signedPsbtBase64, { network })
  } catch {
    throw new RoundSignatureRejected('Submitted signature is not a valid PSBT')
  }
  if (unsignedTxBytes(submitted) !== unsignedTxBytes(live)) {
    throw new RoundSignatureRejected("Submitted PSBT does not sign this round's transaction")
  }

  const server = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network })
  submitted.data.inputs.forEach((input, i) => {
    if (input.finalScriptSig || input.finalScriptWitness) {
      throw new RoundSignatureRejected(`Submitted PSBT input ${i} is already finalized`)
    }
    if (input.sighashType !== undefined && input.sighashType !== SIGHASH_ALL) {
      throw new RoundSignatureRejected(`Submitted PSBT input ${i} requests a sighash other than SIGHASH_ALL`)
    }
    const known = new Set((live.data.inputs[i].partialSig ?? []).map((p) => toHex(p.pubkey) + toHex(p.signature)))
    const added = (input.partialSig ?? []).filter((p) => !known.has(toHex(p.pubkey) + toHex(p.signature)))
    if (added.length !== 1 || toHex(added[0].pubkey) !== signerPubkeyHex) {
      throw new RoundSignatureRejected(`Submitted PSBT input ${i} must add exactly one partial signature, by the signer's registered key`)
    }
    let decoded: { signature: Uint8Array; hashType: number }
    try {
      decoded = bitcoin.script.signature.decode(added[0].signature)
    } catch {
      throw new RoundSignatureRejected(`Submitted signature on input ${i} is not a valid DER signature`)
    }
    if (decoded.hashType !== SIGHASH_ALL) {
      throw new RoundSignatureRejected(`Submitted signature on input ${i} is not SIGHASH_ALL`)
    }
    // A high-S signature is consensus-valid but non-standard: nodes refuse to relay it, so accepting it would let a
    // co-signer turn a cancellable round into a fully signed one that can never be broadcast. Refused, never normalized.
    if (Buffer.compare(Buffer.from(decoded.signature.subarray(32, 64)), SECP256K1_HALF_ORDER) > 0) {
      throw new RoundSignatureRejected(`Submitted signature on input ${i} is not low-S (non-standard, would never relay)`)
    }
    server.updateInput(i, { partialSig: [added[0]] })
    if (!server.validateSignaturesOfInput(i, (pubkey, hash, signature) => ecc.verify(hash, pubkey, signature), added[0].pubkey)) {
      throw new RoundSignatureRejected(`Submitted signature on input ${i} does not verify against this round`)
    }
  })
  return server.toBase64()
}

export type ExternalCompletionProof = { ok: true } | { ok: false; reason: string }

export function proveExternalCompletion(args: {
  spendingTxHex: string
  spendingTxid: string
  unsignedPsbtBase64: string
  fundingTxid: string
  fundingVout: number
  /** The escrow's three script keys (buyer, seller, arbiter), from EscrowParticipantKey. */
  scriptPubkeysHex: string[]
  requiredSignerPubkeysHex: string[]
  network: Network
}): ExternalCompletionProof {
  const fail = (reason: string): ExternalCompletionProof => ({ ok: false, reason })
  let tx: bitcoin.Transaction
  let live: bitcoin.Psbt
  try {
    tx = bitcoin.Transaction.fromHex(args.spendingTxHex)
    live = bitcoin.Psbt.fromBase64(args.unsignedPsbtBase64, { network: args.network })
  } catch {
    return fail('spending transaction or round PSBT cannot be parsed')
  }
  // The explorer's txid is never trusted: it must be the hash of the bytes it served.
  if (tx.getId() !== args.spendingTxid) return fail('served transaction bytes do not hash to the reported txid')
  if (tx.ins.length !== 1) return fail(`spending transaction has ${tx.ins.length} inputs, expected exactly the funding outpoint`)
  const input = tx.ins[0]
  if (toHex(Buffer.from(input.hash).reverse()) !== args.fundingTxid || input.index !== args.fundingVout) {
    return fail('spending transaction does not spend the funding outpoint of this escrow')
  }

  // Byte identity with the round: version, input, sequence, outputs and locktime (the witness is not part of it).
  const stripped = bitcoin.Transaction.fromHex(args.spendingTxHex)
  stripped.ins.forEach((i) => { i.witness = [] })
  if (toHex(stripped.toBuffer()) !== unsignedTxBytes(live)) return fail('spending transaction is not byte-identical to the round')

  const witness = input.witness
  if (witness.length !== 4 || witness[0].length !== 0) return fail('witness is not a 2-of-3 P2WSH multisig spend')
  const expectedScript = bitcoin.payments.p2ms({
    m: 2, pubkeys: args.scriptPubkeysHex.map((h) => Buffer.from(h, 'hex')).sort(Buffer.compare), network: args.network,
  }).output!
  if (toHex(witness[3]) !== toHex(expectedScript)) return fail('witness script is not the script of this escrow')
  const prevout = live.data.inputs[0].witnessUtxo
  if (!prevout) return fail('round PSBT carries no witnessUtxo')

  const sighash = tx.hashForWitnessV0(0, witness[3], prevout.value, SIGHASH_ALL)
  const signers = new Set<string>()
  for (const encoded of [witness[1], witness[2]]) {
    let decoded: { signature: Uint8Array; hashType: number }
    try {
      decoded = bitcoin.script.signature.decode(encoded)
    } catch {
      return fail('witness signature is not a valid DER signature')
    }
    if (decoded.hashType !== SIGHASH_ALL) return fail('witness signature is not SIGHASH_ALL')
    const signer = args.scriptPubkeysHex.find((pk) => ecc.verify(sighash, Buffer.from(pk, 'hex'), decoded.signature))
    if (!signer) return fail('witness signature does not verify against any script key')
    signers.add(signer)
  }
  const required = new Set(args.requiredSignerPubkeysHex)
  if (signers.size !== required.size || [...signers].some((pk) => !required.has(pk))) {
    return fail('witness is not signed by exactly the required signers of the round')
  }
  return { ok: true }
}
