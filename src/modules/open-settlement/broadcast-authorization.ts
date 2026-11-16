/**
 * CTO 61 / CTO 88-90 - authorization at the MULTISIG provider's effective broadcast point (ADR-004 and ADR-005).
 *
 * Every MULTISIG transaction Sails sends (finalizeRelease/Refund/Split through finalizeSpend(), and every recovery
 * through reconcilePendingSettlement(): PASS 0, PASS 1, completion-effects catch-up) passes MultisigProvider.broadcast(),
 * which calls this before the POST. It does not depend on any callback or argument a caller supplies: it re-derives
 * everything from the signed transaction itself and from durable rows.
 *
 *   1. The transaction spends exactly one input, and that outpoint is the recorded funding (txLockId:txLockVout,
 *      unique across escrows) of a MULTISIG escrow.
 *   2. That escrow's persisted pending round is this transaction: the round's unsigned txid equals the signed
 *      transaction's txid (segwit: the witness is not part of the txid). A round for operation A can therefore never
 *      carry a transaction of operation B, and a transaction no round persisted is never sent.
 *   3. ADR-004, with ENFORCE_CAPABILITIES on: that round has the durable execution authorization the live path commits
 *      (assertDurableExecutionAuthorization(): same operation digest, grantee, capability and scope).
 *   4. ADR-005, always (the economic disposition gate is not behind the capabilities flag): the round's durable economic
 *      disposition authorization exists and matches, the dispute is still RESOLVED in that generation, and the durable
 *      Outcome corresponds to the round; a round with no recorded generation must be provably cooperative
 *      (assertDurableEconomicDispositionAuthorization()).
 * Steps 3 and 4 are read-only: no grant or authorization is evaluated or written here, so the broadcast point can never
 * become a first authorization.
 *
 * Read-then-POST consistency (corrected, CTO 119 / GK VERIFY #639): this is a check immediately before the POST, NOT a
 * lock held until it. A fact changed between this read and the POST is not seen (GK T1-T6 reproduced it by pausing
 * here). What keeps the stored facts from changing for a MULTISIG round that holds both durable authorizations is the
 * set of production writers, not this check: the authorizations have no writer in src after creation; a round is
 * deleted only after its settlement (or while cooperative and unsigned); the Outcome's only deleter is the R-1 revert,
 * which keeps a generation that has an economic disposition authorization; appeal() refuses every MULTISIG escrow
 * (script-committed arbiter); and every disputes writer is a conditional compare-and-set (submitEvidence's former
 * unconditional write, GK F1, is now one too). A future writer that breaks this, or direct database access, is not
 * covered by this check.
 *
 * With ENFORCE_CAPABILITIES off (development/test only; a production process refuses to boot that way, see
 * config/index.ts) step 3 is skipped exactly as the live path skips committing it; steps 1, 2 and 4 still apply.
 * A transaction already on the network never reaches here (recovery converges to it without a broadcast).
 */
import * as bitcoin from 'bitcoinjs-lib'
import { prisma } from '../../common/database'
import { BroadcastNotAuthorized } from './broadcast-outcome'
import { assertDurableExecutionAuthorization } from './capability-execution-authorization'
import { assertDurableEconomicDispositionAuthorization } from './economic-disposition-authority'

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
  // @@unique([txLockId, txLockVout]): at most one escrow, of any type, records a given outpoint as its funding.
  const escrow = await prisma.escrow.findUnique({ where: { txLockId_txLockVout: { txLockId: fundingTxid, txLockVout: input.index } }, select: { id: true, type: true } })
  if (!escrow || escrow.type !== 'MULTISIG') refuse(`${fundingTxid}:${input.index} is not the recorded funding of a MULTISIG escrow`)
  const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow!.id } })
  if (!pending) refuse(`escrow ${escrow!.id} has no persisted round`)
  let persisted: string
  try { persisted = roundTxid(pending!.unsignedPsbtBase64) } catch { return refuse(`escrow ${escrow!.id}'s persisted round cannot be decoded`) }
  if (persisted !== txid) refuse(`escrow ${escrow!.id}'s persisted round ${pending!.id} is transaction ${persisted}, not this one`)
  try {
    await assertDurableExecutionAuthorization(pending!)
  } catch (err) {
    refuse(`round ${pending!.id}, ADR-004: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    await assertDurableEconomicDispositionAuthorization(pending!)
  } catch (err) {
    refuse(`round ${pending!.id}, ADR-005: ${err instanceof Error ? err.message : String(err)}`)
  }
}
