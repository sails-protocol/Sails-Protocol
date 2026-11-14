/**
 * MULTISIG round input binding - a round may only spend the funding outpoint this escrow recorded at lockFunds():
 * exactly one input, that txid:vout, this escrow's own P2WSH script, and the value observed when the funding was
 * locked. Checked when a round is created and again right before it is executed, independently of whoever built the
 * PSBT. The same fields the SDK's verifySigningIntent() checks client-side (input count, txid, vout, value, script).
 * Pure: decodes and compares, never signs, never broadcasts, never writes.
 */
import * as bitcoin from 'bitcoinjs-lib'
import { Prisma } from '@prisma/client'
import { AppError } from '../../common/errors'
import { config } from '../../config'
import { networkFor } from './multisig.provider'

export interface FundedEscrowFacts {
  id: string
  txLockId: string | null
  txLockVout: number | null
  multisigAddr: string | null
  fundedAmount: Prisma.Decimal | string | null
}

/** An expected refusal (409, mismatches in `details`): nothing was persisted or broadcast because of this round. */
export class RoundInputMismatch extends AppError {
  constructor(public readonly mismatches: readonly string[]) {
    super(`MULTISIG round does not spend this escrow's recorded funding (${mismatches.length} mismatch(es)): ${mismatches.join('; ')}`, 409, 'ROUND_INPUT_MISMATCH', mismatches)
  }
}

export function roundInputMismatches(psbtBase64: string, escrow: FundedEscrowFacts, network: bitcoin.Network): string[] {
  if (!escrow.txLockId || escrow.txLockVout === null || escrow.txLockVout === undefined) {
    return [`escrow ${escrow.id} has no recorded funding outpoint (txid:vout)`]
  }
  if (!escrow.multisigAddr) return [`escrow ${escrow.id} has no committed MULTISIG address`]
  if (escrow.fundedAmount === null || escrow.fundedAmount === undefined) return [`escrow ${escrow.id} has no recorded funded amount`]

  let psbt: bitcoin.Psbt
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  } catch (err) {
    return [`failed to decode the round's PSBT: ${err instanceof Error ? err.message : String(err)}`]
  }
  if (psbt.txInputs.length !== 1) return [`round spends ${psbt.txInputs.length} input(s), expected exactly 1`]

  const mismatches: string[] = []
  const input = psbt.txInputs[0]
  const txid = Buffer.from(input.hash).reverse().toString('hex')
  if (txid !== escrow.txLockId || input.index !== escrow.txLockVout) {
    mismatches.push(`round spends ${txid}:${input.index}, the recorded funding outpoint is ${escrow.txLockId}:${escrow.txLockVout}`)
  }
  const expectedScript = bitcoin.address.toOutputScript(escrow.multisigAddr, network)
  const { witnessUtxo, witnessScript } = psbt.data.inputs[0]
  if (!witnessUtxo) return [...mismatches, 'round input has no witnessUtxo']
  if (!Buffer.from(witnessUtxo.script).equals(Buffer.from(expectedScript))) {
    mismatches.push(`round input script is not this escrow's P2WSH (${escrow.multisigAddr})`)
  }
  const p2wsh = witnessScript ? bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network }).output : undefined
  if (!p2wsh || !Buffer.from(p2wsh).equals(Buffer.from(expectedScript))) {
    mismatches.push(`round input witnessScript does not hash to this escrow's P2WSH (${escrow.multisigAddr})`)
  }
  const fundedSats = BigInt(new Prisma.Decimal(escrow.fundedAmount).times(1e8).toFixed(0))
  if (BigInt(witnessUtxo.value) !== fundedSats) {
    mismatches.push(`round input value is ${witnessUtxo.value} sats, the recorded funded amount is ${fundedSats} sats`)
  }
  return mismatches
}

export function assertRoundInputBinding(psbtBase64: string, escrow: FundedEscrowFacts): void {
  const mismatches = roundInputMismatches(psbtBase64, escrow, networkFor(config.multisig.network))
  if (mismatches.length > 0) throw new RoundInputMismatch(mismatches)
}
