import * as bitcoin from 'bitcoinjs-lib'

/**
 * P4 / Gate 3 (iii-a) - the txid of the transaction a signing round will produce, derived from the round's unsigned
 * transaction alone. A segwit txid does not commit to witnesses, so it is the same before and after signing and the
 * network can be asked about it even when the signed round itself is gone (MultisigProvider.inspectRound() derives the
 * same value). Returns null when the stored round cannot be decoded: an unprovable identity is recorded as absent
 * (the guard then treats the authorization as legacy and refuses), never as a guess.
 */
export function unsignedTxidOfPsbt(psbtBase64: string): string | null {
  try {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64)
    return bitcoin.Transaction.fromBuffer(Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer())).getId()
  } catch {
    return null
  }
}
