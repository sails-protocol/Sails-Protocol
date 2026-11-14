/**
 * CTO 61 / GK ADR-004 A8, A8b, A9, A11 - authorization at the MULTISIG provider's effective broadcast point.
 *
 * Every MULTISIG transaction Sails sends (finalizeRelease/Refund/Split through finalizeSpend(), and every recovery
 * through reconcilePendingSettlement(): PASS 0, PASS 1, completion-effects catch-up) passes MultisigProvider.broadcast(),
 * which calls this before the POST. It does not depend on any callback or argument a caller supplies: it re-derives
 * everything from the signed transaction itself and from durable rows.
 *
 *   1. The transaction spends exactly one input, and that outpoint is the recorded funding (txLockId:txLockVout) of
 *      exactly one MULTISIG escrow.
 *   2. That escrow's persisted pending round is this transaction: the round's unsigned txid equals the signed
 *      transaction's txid (segwit: the witness is not part of the txid). A round for operation A can therefore never
 *      carry a transaction of operation B, and a transaction no round persisted is never sent.
 *   3. With ENFORCE_CAPABILITIES on, that round has the durable ADR-004 execution authorization the live path commits
 *      (assertDurableExecutionAuthorization(): same operation digest, grantee, capability and scope). Read-only: no
 *      grant is evaluated or written here, so the broadcast point can never become a first authorization.
 *
 * With ENFORCE_CAPABILITIES off (development/test only; a production process refuses to boot that way, see
 * config/index.ts) step 3 is skipped exactly as the live path skips committing it; steps 1 and 2 still apply.
 * A transaction already on the network never reaches here (recovery converges to it without a broadcast).
 */
import * as bitcoin from 'bitcoinjs-lib'
import { prisma } from '../../common/database'
import { BroadcastNotAuthorized } from './broadcast-outcome'
import { assertDurableExecutionAuthorization } from './capability-execution-authorization'

function roundTxid(unsignedPsbtBase64: string): string {
  const psbt = bitcoin.Psbt.fromBase64(unsignedPsbtBase64)
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer()).getId()
}

export async function assertBroadcastAuthorized(tx: bitcoin.Transaction): Promise<void> {
  const txid = tx.getId()
  const refuse = (why: string): never => {
    throw new BroadcastNotAuthorized(`MULTISIG broadcast of ${txid} refused before any POST: ${why}`)
  }
  if (tx.ins.length !== 1) refuse(`it spends ${tx.ins.length} inputs, a Sails round spends exactly 1`)
  const input = tx.ins[0]
  const fundingTxid = Buffer.from(input.hash).reverse().toString('hex')
  const escrows = await prisma.escrow.findMany({
    where: { type: 'MULTISIG', txLockId: fundingTxid, txLockVout: input.index },
    select: { id: true },
    take: 2,
  })
  if (escrows.length !== 1) refuse(`${escrows.length} MULTISIG escrows record ${fundingTxid}:${input.index} as their funding, expected exactly 1`)
  const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrows[0].id } })
  if (!pending) refuse(`escrow ${escrows[0].id} has no persisted round`)
  let persisted: string
  try { persisted = roundTxid(pending!.unsignedPsbtBase64) } catch { return refuse(`escrow ${escrows[0].id}'s persisted round cannot be decoded`) }
  if (persisted !== txid) refuse(`escrow ${escrows[0].id}'s persisted round ${pending!.id} is transaction ${persisted}, not this one`)
  try {
    await assertDurableExecutionAuthorization(pending!)
  } catch (err) {
    refuse(`round ${pending!.id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
