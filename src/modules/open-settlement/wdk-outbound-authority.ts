/**
 * #235 R7G-F6C — WDK outbound settlement authority: RELEASE, REFUND and SPLIT of a WDK_USDT_EVM escrow.
 *
 * The principal sits in the escrow's own account (its persisted derivation path, F6A-1), so every outbound
 * leg is a transaction of that account. One settlement obligation per escrow, frozen before anything is
 * signed:
 *
 *   RELEASE      one leg: the escrow's full locked amount to the buyer's registered payout address.
 *   REFUND       one leg: the full locked amount back to the treasury that funded the LOCK.
 *   SPLIT        two legs, in order: floor(amount * buyerBps / 10000) to the buyer's payout address, the exact
 *                remainder to the seller's. The seller leg is signed only once the buyer leg is final.
 *
 * Which of the three it is was already decided by the escrow's terminal claim (COMPLETED / REFUNDED / SPLIT,
 * with its frozen intent, #247/#248); the database lets no second family exist economically. Each leg:
 *
 *   PREPARED     recipient and amount recorded (frozen by the database from here on).
 *   SIGNED       one PostgreSQL transaction, with the escrow row locked and still in its claimed terminal
 *                status: the nonce is allocated from the escrow account's lane (WdkNonceLane, the same
 *                governed lane as the treasury's), the ERC-20 transfer is built with every field explicit,
 *                signed with the escrow account, decoded and checked against the obligation, and persisted.
 *   gas          the escrow account holds the token but normally no native currency. The leg's maximum gas
 *                cost (its signed gas limit x its signed maxFeePerGas) minus the account's balance is sent by
 *                one GAS_FUNDING treasury transaction - itself signed, persisted, broadcast and made final on
 *                corroborated evidence, at most one per signed leg. The leg is broadcast only after that.
 *   SUBMITTED / CONFIRMED / REVERTED / NONCE_CONSUMED_ELSEWHERE   as for the LOCK, with the same corroborated
 *                finality (WDK_IRREVERSIBLE_RPC_CORROBORATION_V1).
 *
 * DF1: nothing here turns an error, a timeout, a missing or malformed receipt into a failure. Before any leg is
 * signed, a failure abandons the obligation and the escrow claim is reverted (nothing could have moved). Once a
 * leg is signed the escrow stays claimed and the same bytes are rebroadcast and reconciled; a final revert or a
 * nonce consumed elsewhere stops the obligation for manual review - nothing ever signs a transaction B for a leg
 * whose transaction A exists. No replacement, no nonce rewind (NO_AUTOMATIC_WDK_REPLACEMENT_V1).
 *
 * Gas policy (network policy, no defaults): WDK_OUTBOUND_MAX_GAS_LIMIT and WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI cap
 * what a leg may be signed with, so one funding never exceeds their product. Leftover native currency stays in
 * the escrow account (one account per escrow, controlled only by the Sails seed): bounded, never reused by
 * another escrow.
 */
import { Transaction, getAddress, ZeroAddress, Interface } from 'ethers'
import type { Prisma, WdkTransferAttempt } from '@prisma/client'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { lockTradeLifecycle } from '../open-p2p/trade-lifecycle-lock'
import { wdkSettlementProvider, fromBaseUnits, type WdkEscrowAccountIdentity } from './wdk-settlement.provider'
import { activeLaneHalts, lockLaneGovernance, raiseLaneHalt, type LaneKey } from './wdk-lane-governance'
import { payoutAddressService } from './payout-address.service'
import {
  broadcast, corroborateReceipt, isFinal, LaneHalted, lockNonceLane, observeNonceConsumption, queryReceipt, stuckLowestNonce,
  toExactBaseUnits, verifySignedLock, WdkSignedTransactionMismatch,
} from './wdk-lock-authority'

const log = childLogger('wdk-outbound-authority')

const USDT_DECIMALS = 6
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const GAS_HEADROOM_PERCENT = 120n
const NATIVE_TRANSFER_GAS = 21_000n

export type OutboundKind = 'RELEASE' | 'REFUND' | 'SPLIT'
export type OutboundLegOp = 'RELEASE' | 'REFUND' | 'SPLIT_BUYER' | 'SPLIT_SELLER'
export type OutboundLeg = { operationType: OutboundLegOp; destination: string; amount: string }

const LEG_OPS: Record<OutboundKind, OutboundLegOp[]> = { RELEASE: ['RELEASE'], REFUND: ['REFUND'], SPLIT: ['SPLIT_BUYER', 'SPLIT_SELLER'] }
export const OUTBOUND_TERMINAL_STATUS: Record<OutboundKind, 'COMPLETED' | 'REFUNDED' | 'SPLIT'> = { RELEASE: 'COMPLETED', REFUND: 'REFUNDED', SPLIT: 'SPLIT' }
const OUTBOUND_OPS: OutboundLegOp[] = ['RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER']
const kindOf = (op: string): OutboundKind => (op === 'SPLIT_BUYER' || op === 'SPLIT_SELLER' ? 'SPLIT' : op as OutboundKind)

type EscrowRow = NonNullable<Awaited<ReturnType<typeof prisma.escrow.findUnique>>>

// ─── policy ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything an outbound obligation needs to reach a final conclusion. Refused before any claim when missing:
 * an obligation that could never become final would only strand the escrow.
 */
export function assertWdkOutboundPolicy(escrowId: string): void {
  // A partial configuration (a test's narrow config mock included) is simply a missing policy.
  const wdk: Partial<typeof config.wdk> = config.wdk ?? {}
  const missing = [
    !wdk.chainId && 'WDK_CHAIN_ID',
    !wdk.finalityConfirmations && 'WDK_FINALITY_CONFIRMATIONS',
    (!wdk.corroboratingRpcUrl || wdk.corroboratingRpcUrl.toLowerCase() === (wdk.rpcUrl ?? '').trim().toLowerCase()) && 'WDK_CORROBORATING_RPC_URL',
    !wdk.outboundMaxGasLimit && 'WDK_OUTBOUND_MAX_GAS_LIMIT',
    !wdk.outboundMaxFeePerGasWei && 'WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new EscrowError(`WDK_USDT_EVM outbound settlement for escrow ${escrowId} is unavailable: no ${missing.join(', ')} configured (network policy). Nothing was executed.`, 'UNAVAILABLE')
  }
}

// ─── obligation ───────────────────────────────────────────────────────────────────────────────────

function evmRecipient(address: string, what: string, escrowAccount: string): string {
  let checksummed: string
  try {
    checksummed = getAddress(address)
  } catch {
    throw new EscrowError(`${what} ${address} is not an EVM address — refusing to settle to it`)
  }
  if (checksummed === ZeroAddress || checksummed === escrowAccount) throw new EscrowError(`${what} ${checksummed} cannot receive this escrow's funds`)
  return checksummed
}

/**
 * The legs of an escrow's outbound obligation, from durable authority only: the funded escrow (its canonical
 * LOCK is a final signed transaction and is the escrow's txLockId), its locked amount, the frozen SPLIT
 * allocation, and the registered payout addresses / the treasury. No caller-supplied recipient or amount.
 */
export async function planWdkOutbound(
  escrow: EscrowRow, kind: OutboundKind, payout: { buyer?: string; seller?: string }, buyerBps?: number,
): Promise<OutboundLeg[]> {
  const lock = await prisma.wdkTransferAttempt.findFirst({ where: { escrowId: escrow.id, operationType: 'LOCK' }, orderBy: { createdAt: 'desc' } })
  if (!lock || lock.authority !== 'SIGNED_RAW_V1' || lock.status !== 'CONFIRMED' || !lock.txHash || lock.txHash !== escrow.txLockId) {
    throw new EscrowError(`Escrow ${escrow.id}'s WDK funding is not proven (LOCK ${lock ? `${lock.authority}/${lock.status}` : 'none'}) — nothing to settle from`)
  }
  const escrowAccount = await wdkSettlementProvider.escrowAddress(escrow)
  if (lock.destination !== escrowAccount) throw new EscrowError(`Escrow ${escrow.id}'s LOCK paid ${lock.destination}, not its account ${escrowAccount}`)
  const total = toExactBaseUnits(escrow.lockedAmount.toFixed())
  if (total <= 0n) throw new EscrowError(`Escrow ${escrow.id} has no locked amount to settle`)
  const amount = (units: bigint) => fromBaseUnits(units, USDT_DECIMALS)
  switch (kind) {
    case 'RELEASE':
      return [{ operationType: 'RELEASE', destination: evmRecipient(payout.buyer ?? '', 'buyer payout address', escrowAccount), amount: amount(total) }]
    case 'REFUND':
      return [{ operationType: 'REFUND', destination: evmRecipient(await wdkSettlementProvider.treasuryAddress(), 'treasury', escrowAccount), amount: amount(total) }]
    case 'SPLIT': {
      if (buyerBps === undefined || !Number.isInteger(buyerBps) || buyerBps <= 0 || buyerBps >= 10000) {
        throw new EscrowError(`SPLIT of escrow ${escrow.id} needs a buyerBps strictly between 0 and 10000 (got ${buyerBps})`)
      }
      const buyerUnits = (total * BigInt(buyerBps)) / 10000n
      const sellerUnits = total - buyerUnits
      if (buyerUnits <= 0n || sellerUnits <= 0n) throw new EscrowError(`SPLIT of escrow ${escrow.id} at ${buyerBps} bps leaves a leg empty (${buyerUnits}/${sellerUnits} base units)`)
      return [
        { operationType: 'SPLIT_BUYER', destination: evmRecipient(payout.buyer ?? '', 'buyer payout address', escrowAccount), amount: amount(buyerUnits) },
        { operationType: 'SPLIT_SELLER', destination: evmRecipient(payout.seller ?? '', 'seller payout address', escrowAccount), amount: amount(sellerUnits) },
      ]
    }
  }
}

const sameLeg = (row: WdkTransferAttempt, leg: OutboundLeg) =>
  row.operationType === leg.operationType && row.destination === leg.destination && toExactBaseUnits(row.amount.toFixed()) === toExactBaseUnits(leg.amount)

/**
 * Records the obligation's legs (PREPARED), once. While any leg is live (prepared, signed or beyond) the
 * obligation is frozen: the same legs continue it, different legs are refused. An obligation abandoned before
 * anything was signed (every row FAILED_BEFORE_SUBMISSION, the claim reverted) is history: a new request
 * records a new generation.
 */
export async function prepareWdkOutbound(escrow: EscrowRow, legs: OutboundLeg[], claimed?: string): Promise<void> {
  const fromAddress = await wdkSettlementProvider.escrowAddress(escrow)
  const tokenContract = getAddress(config.wdk.usdtContract)
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ status: string; txReleaseId: string | null }>>`SELECT status::text AS status, "txReleaseId" FROM escrows WHERE id = ${escrow.id} FOR UPDATE`
    if (claimed && (row?.status !== claimed || row.txReleaseId !== null)) {
      throw new EscrowError(`Escrow ${escrow.id} is no longer a pending ${claimed} (now ${row?.status ?? 'missing'}) — no outbound obligation recorded`)
    }
    const existing = (await outboundRows(tx, escrow.id)).filter((r) => r.status !== 'FAILED_BEFORE_SUBMISSION')
    if (existing.length > 0) {
      const latest = latestPerLeg(existing)
      const mismatched = legs.filter((leg) => !latest.get(leg.operationType) || !sameLeg(latest.get(leg.operationType)!, leg))
      if (mismatched.length > 0 || latest.size !== legs.length) {
        throw new EscrowError(`Escrow ${escrow.id} already has a frozen outbound obligation (${[...latest.values()].map((r) => `${r.operationType} ${r.amount.toFixed()} to ${r.destination}`).join('; ')}) — refusing different legs`)
      }
      return
    }
    for (const leg of legs) {
      // A legacy transfer() row may own this operation's active key; it relinquishes it only if it proved
      // nothing moved (the database refuses a signed obligation next to one that may have).
      await tx.wdkTransferAttempt.updateMany({
        where: { activeKey: `${escrow.id}:${leg.operationType}`, status: { in: ['PREPARED', 'FAILED_BEFORE_SUBMISSION'] } },
        data: { activeKey: null },
      })
      await tx.wdkTransferAttempt.create({
        data: {
          escrowId: escrow.id, operationType: leg.operationType, destination: leg.destination, amount: leg.amount, authority: 'SIGNED_RAW_V1',
          chainId: config.wdk.chainId, fromAddress, tokenContract, activeKey: `${escrow.id}:${leg.operationType}`,
        },
      })
    }
  })
}

async function outboundRows(db: Prisma.TransactionClient | typeof prisma, escrowId: string): Promise<WdkTransferAttempt[]> {
  return db.wdkTransferAttempt.findMany({
    where: { escrowId, authority: 'SIGNED_RAW_V1', operationType: { in: OUTBOUND_OPS } },
    orderBy: { createdAt: 'asc' },
  })
}

/** The newest generation of each leg. */
function latestPerLeg(rows: WdkTransferAttempt[]): Map<OutboundLegOp, WdkTransferAttempt> {
  const latest = new Map<OutboundLegOp, WdkTransferAttempt>()
  for (const r of rows) latest.set(r.operationType as OutboundLegOp, r)
  return latest
}

export async function hasSignedOutbound(escrowId: string): Promise<boolean> {
  return (await prisma.wdkTransferAttempt.count({ where: { escrowId, authority: 'SIGNED_RAW_V1', operationType: { in: OUTBOUND_OPS } } })) > 0
}

/** A legacy transfer() outbound attempt exists: the escrow converges through the legacy read-only path only. */
export async function hasLegacyOutbound(escrowId: string): Promise<boolean> {
  return (await prisma.wdkTransferAttempt.count({ where: { escrowId, authority: 'LEGACY_TRANSFER_V0', operationType: { in: OUTBOUND_OPS } } })) > 0
}

/**
 * Crash matrix R1: the escrow claimed its terminal status but the process died before the obligation was
 * recorded (or a later generation was), so nothing was signed and nothing could move. The claim is the economic
 * decision; its obligation is re-derived from the same durable authority the live call plans from - the
 * registered payout addresses, the treasury, the frozen buyerBps - and recorded under the escrow row lock while
 * the escrow is still that pending claim. A live call still in flight records the same legs (prepare is
 * idempotent) or, if they differ, is refused and its DF1 handling decides; either way one obligation exists.
 */
export async function recordClaimedWdkOutbound(escrow: EscrowRow, trade: { buyerId: string; sellerId: string }): Promise<void> {
  const kind = ({ COMPLETED: 'RELEASE', REFUNDED: 'REFUND', SPLIT: 'SPLIT' } as Record<string, OutboundKind | undefined>)[escrow.status]
  if (!kind || escrow.txReleaseId !== null) throw new EscrowError(`Escrow ${escrow.id} is ${escrow.status}${escrow.txReleaseId ? ' with a settlement result' : ''}, not a pending outbound claim`)
  assertWdkOutboundPolicy(escrow.id)
  const registered = async (participantId: string, role: string) => {
    const payout = await payoutAddressService.getPayoutAddress(participantId, escrow.asset)
    if (!payout) throw new EscrowError(`Escrow ${escrow.id}: the ${role} has no registered ${escrow.asset} payout address`)
    return payout.address
  }
  const payout = kind === 'REFUND' ? {} : { buyer: await registered(trade.buyerId, 'buyer'), ...(kind === 'SPLIT' ? { seller: await registered(trade.sellerId, 'seller') } : {}) }
  await prepareWdkOutbound(escrow, await planWdkOutbound(escrow, kind, payout, escrow.splitBuyerBps ?? undefined), escrow.status)
}

/**
 * DF1, the only place an outbound obligation is given up: when NO leg was ever signed (nothing can have
 * moved), its prepared legs are closed as FAILED_BEFORE_SUBMISSION and the escrow claim is reverted - one
 * transaction, the escrow row locked, so signing (which locks the same row) can never interleave. Returns
 * false, changing nothing, once any leg is signed.
 */
export async function abandonUnsignedWdkOutbound(escrowId: string, claimedStatus: string, fromStatus: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM escrows WHERE id = ${escrowId} FOR UPDATE`
    const rows = await outboundRows(tx, escrowId)
    if (rows.some((r) => r.signedRawTx)) return false
    await tx.wdkTransferAttempt.updateMany({ where: { escrowId, authority: 'SIGNED_RAW_V1', operationType: { in: OUTBOUND_OPS }, status: 'PREPARED' }, data: { status: 'FAILED_BEFORE_SUBMISSION' } })
    await tx.escrow.updateMany({ where: { id: escrowId, status: claimedStatus as never, txReleaseId: null }, data: { status: fromStatus as never } })
    return true
  })
}

// ─── signing ──────────────────────────────────────────────────────────────────────────────────────

export class WdkOutboundPolicyRefusal extends EscrowError {}

type Quote = { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; latest: number; pending: number; head: number }

async function quote(from: string, gasLimit: () => Promise<bigint>): Promise<Quote> {
  const rpc = wdkSettlementProvider.rpc()
  const fee = await rpc.feeData()
  const maxFeeCap = config.wdk.outboundMaxFeePerGasWei as bigint
  if (fee.maxFeePerGas > maxFeeCap) {
    throw new WdkOutboundPolicyRefusal(`maxFeePerGas ${fee.maxFeePerGas} is above WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI ${maxFeeCap}`)
  }
  const limit = await gasLimit()
  if (limit > BigInt(config.wdk.outboundMaxGasLimit as number)) {
    throw new WdkOutboundPolicyRefusal(`gas limit ${limit} is above WDK_OUTBOUND_MAX_GAS_LIMIT ${config.wdk.outboundMaxGasLimit}`)
  }
  return {
    gasLimit: limit, maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas < fee.maxFeePerGas ? fee.maxPriorityFeePerGas : fee.maxFeePerGas,
    latest: await rpc.nonce(from, 'latest'), pending: await rpc.nonce(from, 'pending'), head: await rpc.blockNumber(),
  }
}

/**
 * Allocates the next nonce of `lane` under its governance (halts, foreign use, stuck backpressure) and persists
 * the signed transaction `sign(nonce)` returns, inside the caller's transaction. Returns 'HALTED' (the halt is
 * committed with it) or the persisted attempt.
 */
async function allocateAndSign(
  tx: Prisma.TransactionClient, attempt: WdkTransferAttempt, lane: LaneKey, q: Quote,
  sign: (nonce: number) => Promise<{ signedRawTx: string; txHash: string }>,
): Promise<{ halted: string } | { signed: true }> {
  await lockLaneGovernance(tx, lane)
  const halts = await activeLaneHalts(tx, lane)
  if (halts.length > 0) throw new LaneHalted(`WDK nonce lane (${lane.chainId}, ${lane.account}) is halted (${halts.map((h) => `${h.reason}: ${h.detail}`).join('; ')}) — nothing new is signed`)
  const laneRow = await lockNonceLane(tx, lane.chainId, lane.account, Math.max(q.latest, q.pending))
  if (q.latest > laneRow.nextNonce || q.pending > laneRow.nextNonce) {
    const halted = `chain nonce of ${lane.account} (latest ${q.latest}, pending ${q.pending}) is past the next nonce Sails would allocate (${laneRow.nextNonce}): a transaction Sails did not sign used the account (single RPC observation)`
    await raiseLaneHalt(tx, lane, 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', halted, 'system:wdk-outbound-signing')
    return { halted }
  }
  const stuck = await stuckLowestNonce(tx, lane, q.head, q.latest)
  if (stuck) {
    await raiseLaneHalt(tx, lane, 'STUCK_LOWEST_NONCE', stuck, 'system:wdk-outbound-signing')
    return { halted: stuck }
  }
  const nonce = laneRow.nextNonce
  await tx.$executeRaw`UPDATE wdk_nonce_lanes SET "nextNonce" = ${nonce + 1}, "updatedAt" = now() WHERE "chainId" = ${lane.chainId} AND account = ${lane.account}`
  const { signedRawTx, txHash } = await sign(nonce)
  const updated = await tx.wdkTransferAttempt.updateMany({
    where: { id: attempt.id, status: 'PREPARED' },
    data: { status: 'SIGNED', nonce: BigInt(nonce), signedRawTx, txHash, signedAtBlock: BigInt(q.head) },
  })
  if (updated.count !== 1) throw new EscrowError(`WDK attempt ${attempt.id} changed while being signed`)
  return { signed: true }
}

async function markFailedBeforeSubmission(attemptId: string, reason: string): Promise<void> {
  const marked = await prisma.wdkTransferAttempt.updateMany({ where: { id: attemptId, status: 'PREPARED' }, data: { status: 'FAILED_BEFORE_SUBMISSION' } })
  log.warn({ msg: 'WDK outbound attempt failed before any transaction was signed', attemptId, reason, marked: marked.count })
}

/** Signs one PREPARED outbound leg with the escrow account (see the module comment). Never broadcasts. */
async function signLeg(escrow: EscrowRow, leg: WdkTransferAttempt): Promise<WdkTransferAttempt> {
  const chainId = config.wdk.chainId as number
  const from = leg.fromAddress as string
  const token = leg.tokenContract as string
  const baseUnits = toExactBaseUnits(leg.amount.toFixed())
  const data = ERC20.encodeFunctionData('transfer', [leg.destination, baseUnits])
  let q: Quote
  try {
    q = await quote(from, async () => ((await wdkSettlementProvider.rpc().estimateGas({ from, to: token, data })) * GAS_HEADROOM_PERCENT) / 100n)
  } catch (err) {
    await markFailedBeforeSubmission(leg.id, err instanceof Error ? err.message : String(err))
    throw new EscrowError(`WDK_USDT_EVM ${leg.operationType} for escrow ${escrow.id} could not be prepared (nothing was signed or broadcast): ${err instanceof Error ? err.message : String(err)}`)
  }
  let halted: string | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
      await lockTradeLifecycle(tx, current.tradeId)
      const [row] = await tx.$queryRaw<Array<{ status: string; txReleaseId: string | null }>>`SELECT status::text AS status, "txReleaseId" FROM escrows WHERE id = ${escrow.id} FOR UPDATE`
      const terminal = OUTBOUND_TERMINAL_STATUS[kindOf(leg.operationType)]
      if (row.status !== terminal || row.txReleaseId !== null) throw new EscrowError(`Escrow ${escrow.id} is ${row.status}${row.txReleaseId ? ' with a settlement result' : ''}, not a pending ${terminal}: no ${leg.operationType} is signed`)
      const [locked] = await tx.$queryRaw<WdkTransferAttempt[]>`SELECT * FROM wdk_transfer_attempts WHERE id = ${leg.id} FOR UPDATE`
      if (!locked || locked.status !== 'PREPARED') return
      if (leg.operationType === 'SPLIT_SELLER') {
        const buyer = latestPerLeg(await outboundRows(tx, escrow.id)).get('SPLIT_BUYER')
        if (buyer?.status !== 'CONFIRMED') throw new EscrowError(`SPLIT of escrow ${escrow.id}: the seller leg is signed only after the buyer leg is final (buyer leg ${buyer?.status ?? 'missing'})`)
      }
      const result = await allocateAndSign(tx, leg, { chainId, account: from }, q, async (nonce) => {
        const signedRawTx = await wdkSettlementProvider.signEscrowTransaction(escrow, {
          type: 2, chainId: BigInt(chainId), nonce, to: token, value: 0n, data,
          gasLimit: q.gasLimit, maxFeePerGas: q.maxFeePerGas, maxPriorityFeePerGas: q.maxPriorityFeePerGas,
        })
        return { signedRawTx, txHash: verifySignedLock(signedRawTx, { chainId, from, token, recipient: leg.destination, baseUnits, nonce }) }
      })
      if ('halted' in result) halted = result.halted
    })
  } catch (err) {
    await markFailedBeforeSubmission(leg.id, err instanceof Error ? err.message : String(err))
    throw err
  }
  if (halted) {
    await markFailedBeforeSubmission(leg.id, halted)
    throw new LaneHalted(`WDK_USDT_EVM ${leg.operationType} for escrow ${escrow.id} refused: ${halted}. The escrow account's lane is halted for operator review; nothing was signed`)
  }
  return prisma.wdkTransferAttempt.findUniqueOrThrow({ where: { id: leg.id } })
}

/** Checks gas-funding bytes against their durable intent: chain, treasury signer, nonce, recipient, exact value, no data. */
export function verifySignedGasFunding(signedRawTx: string, intent: { chainId: number; from: string; to: string; valueWei: bigint; nonce: number }, expectedHash?: string): string {
  let tx: Transaction
  try {
    tx = Transaction.from(signedRawTx)
  } catch (err) {
    throw new WdkSignedTransactionMismatch(`signed gas funding does not decode: ${err instanceof Error ? err.message : String(err)}`)
  }
  const mismatch = (what: string, got: unknown, want: unknown): never => {
    throw new WdkSignedTransactionMismatch(`signed gas funding ${what} is ${String(got)}, expected ${String(want)} — refusing to broadcast it`)
  }
  if (!tx.isSigned() || !tx.hash || !tx.from) mismatch('signature', 'absent', 'present')
  if (tx.type !== 2) mismatch('type', tx.type, 2)
  if (tx.chainId !== BigInt(intent.chainId)) mismatch('chainId', tx.chainId, intent.chainId)
  if (getAddress(tx.from!) !== getAddress(intent.from)) mismatch('signer', tx.from, intent.from)
  if (tx.nonce !== intent.nonce) mismatch('nonce', tx.nonce, intent.nonce)
  if (!tx.to || getAddress(tx.to) !== getAddress(intent.to)) mismatch('recipient', tx.to, intent.to)
  if (tx.value !== intent.valueWei) mismatch('value', tx.value, intent.valueWei)
  if (tx.data !== '0x') mismatch('data', tx.data.slice(0, 10), '0x')
  if (tx.gasLimit !== NATIVE_TRANSFER_GAS) mismatch('gas limit', tx.gasLimit, NATIVE_TRANSFER_GAS)
  if (expectedHash !== undefined && tx.hash!.toLowerCase() !== expectedHash.toLowerCase()) mismatch('hash', tx.hash, expectedHash)
  return tx.hash!
}

/**
 * Signs a PREPARED gas funding with the treasury, from the treasury lane (the same lane as every LOCK). A refusal
 * before signing (a halted lane, a fee above the cap, an unreachable RPC) leaves the funding PREPARED - nothing
 * was signed, its value is frozen, and it is the leg's only funding - so a later pass signs it.
 */
async function signGasFunding(funding: WdkTransferAttempt): Promise<WdkTransferAttempt> {
  const chainId = config.wdk.chainId as number
  const treasury = funding.fromAddress as string
  const valueWei = BigInt(funding.valueWei!.toFixed())
  let q: Quote
  try {
    q = await quote(treasury, async () => NATIVE_TRANSFER_GAS)
  } catch (err) {
    throw new EscrowError(`WDK gas funding ${funding.id} could not be prepared (nothing was signed; retried later): ${err instanceof Error ? err.message : String(err)}`)
  }
  let halted: string | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<WdkTransferAttempt[]>`SELECT * FROM wdk_transfer_attempts WHERE id = ${funding.id} FOR UPDATE`
      if (!locked || locked.status !== 'PREPARED') return
      const result = await allocateAndSign(tx, funding, { chainId, account: treasury }, q, async (nonce) => {
        const signedRawTx = await wdkSettlementProvider.signTreasuryTransaction({
          type: 2, chainId: BigInt(chainId), nonce, to: funding.destination, value: valueWei, data: '0x',
          gasLimit: NATIVE_TRANSFER_GAS, maxFeePerGas: q.maxFeePerGas, maxPriorityFeePerGas: q.maxPriorityFeePerGas,
        })
        return { signedRawTx, txHash: verifySignedGasFunding(signedRawTx, { chainId, from: treasury, to: funding.destination, valueWei, nonce }) }
      })
      if ('halted' in result) halted = result.halted
    })
  } catch (err) {
    log.warn({ msg: 'WDK gas funding not signed this time; it stays PREPARED', fundingId: funding.id, err: err instanceof Error ? err.message : String(err) })
    throw err
  }
  if (halted) {
    throw new LaneHalted(`WDK gas funding ${funding.id} refused: ${halted}. The treasury lane is halted for operator review; nothing was signed (the funding stays PREPARED)`)
  }
  return prisma.wdkTransferAttempt.findUniqueOrThrow({ where: { id: funding.id } })
}

// ─── advance: verify, (re)broadcast, receipt, corroborated finality ───────────────────────────────

type SignedOutcome =
  | { outcome: 'CONFIRMED' | 'REVERTED'; txHash: string }
  | { outcome: 'PENDING' | 'RPC_DISAGREEMENT' | 'NONCE_CONSUMED_ELSEWHERE' | 'NONCE_CONSUMPTION_SUSPECTED'; txHash: string; reason: string }

/** Moves one signed transaction toward its corroborated truth. Never signs; `verify` re-derives its intent. */
async function advanceSigned(attempt: WdkTransferAttempt, verify: () => Promise<void>, waitForReceipt: boolean): Promise<SignedOutcome> {
  const txHash = attempt.txHash as string
  if (attempt.status === 'CONFIRMED' || attempt.status === 'REVERTED') return { outcome: attempt.status, txHash }
  if (attempt.status === 'NONCE_CONSUMED_ELSEWHERE') return { outcome: 'NONCE_CONSUMED_ELSEWHERE', txHash, reason: 'recorded earlier' }
  await wdkSettlementProvider.verifyNetwork()
  await verify()
  let receipt = await queryReceipt(txHash)
  if (receipt.kind !== 'MINED') {
    await broadcast(attempt)
    const polls = waitForReceipt ? config.wdk.receiptPollAttempts : 1
    for (let i = 0; i < polls; i++) {
      receipt = await queryReceipt(txHash)
      if (receipt.kind === 'MINED') break
      if (i < polls - 1) await new Promise((r) => setTimeout(r, config.wdk.receiptPollIntervalMs))
    }
  }
  if (receipt.kind === 'MINED') {
    const finality = await isFinal(receipt)
    if (!finality.final) return { outcome: 'PENDING', txHash, reason: `mined in block ${receipt.blockNumber} with status ${receipt.success ? 1 : 0}; not final: ${finality.reason}` }
    const corroborated = await corroborateReceipt(txHash, receipt, config.wdk.finalityConfirmations as number)
    if (!corroborated.agreed) {
      const candidate = `${config.wdk.rpcLabel} has it final in block ${receipt.blockNumber} with status ${receipt.success ? 1 : 0}`
      return corroborated.disagreement
        ? { outcome: 'RPC_DISAGREEMENT', txHash, reason: `${candidate}; ${corroborated.reason}` }
        : { outcome: 'PENDING', txHash, reason: `${candidate}; not corroborated yet: ${corroborated.reason}` }
    }
    const status = receipt.success ? 'CONFIRMED' : 'REVERTED'
    await prisma.wdkTransferAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['SIGNED', 'SUBMITTED'] } },
      data: { status, ...finality.evidence, ...corroborated.corroboration },
    })
    const now = await prisma.wdkTransferAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
    if (now.status !== status) throw new EscrowError(`WDK attempt ${attempt.id} is ${now.status}, not ${status}, after its corroborated receipt — anomaly`)
    return { outcome: status, txHash }
  }
  if (receipt.kind === 'NONE') {
    const consumed = await observeNonceConsumption(attempt)
    if (consumed && (consumed.outcome === 'NONCE_CONSUMED_ELSEWHERE' || consumed.outcome === 'NONCE_CONSUMPTION_SUSPECTED')) return consumed
  }
  return { outcome: 'PENDING', txHash, reason: receipt.kind === 'NONE' ? 'no receipt yet' : receipt.reason }
}

/** The intent a signed leg must encode, from the frozen leg and the escrow's persisted account. */
async function verifyLeg(escrow: EscrowRow, leg: WdkTransferAttempt): Promise<void> {
  const chainId = config.wdk.chainId
  if (!chainId || leg.chainId !== chainId) throw new WdkSignedTransactionMismatch(`WDK ${leg.operationType} attempt ${leg.id} was signed for chain ${leg.chainId}, configured WDK_CHAIN_ID is ${chainId ?? 'unset'}`)
  const account = await wdkSettlementProvider.escrowAddress(escrow)
  if (leg.fromAddress !== account) throw new WdkSignedTransactionMismatch(`WDK ${leg.operationType} attempt ${leg.id} was signed by ${leg.fromAddress}, escrow ${escrow.id}'s account is ${account}`)
  if (leg.tokenContract !== getAddress(config.wdk.usdtContract)) throw new WdkSignedTransactionMismatch(`WDK ${leg.operationType} attempt ${leg.id} uses token ${leg.tokenContract}, configured WDK_USDT_CONTRACT is ${config.wdk.usdtContract}`)
  verifySignedLock(leg.signedRawTx as string, {
    chainId, from: account, token: leg.tokenContract as string, recipient: leg.destination, baseUnits: toExactBaseUnits(leg.amount.toFixed()), nonce: Number(leg.nonce),
  }, leg.txHash as string)
}

async function verifyFunding(escrow: EscrowRow, leg: WdkTransferAttempt, funding: WdkTransferAttempt): Promise<void> {
  const chainId = config.wdk.chainId as number
  const treasury = await wdkSettlementProvider.treasuryAddress()
  if (funding.chainId !== chainId || funding.fromAddress !== treasury || funding.destination !== leg.fromAddress || funding.escrowId !== escrow.id) {
    throw new WdkSignedTransactionMismatch(`WDK gas funding ${funding.id} does not match its leg ${leg.id} (chain ${funding.chainId}, from ${funding.fromAddress}, to ${funding.destination})`)
  }
  verifySignedGasFunding(funding.signedRawTx as string, { chainId, from: treasury, to: funding.destination, valueWei: BigInt(funding.valueWei!.toFixed()), nonce: Number(funding.nonce) }, funding.txHash as string)
}

/** The native currency a signed leg may spend on gas: its signed gas limit x its signed maxFeePerGas. */
export function legMaxGasCost(signedRawTx: string): bigint {
  const tx = Transaction.from(signedRawTx)
  return tx.gasLimit * (tx.maxFeePerGas ?? 0n)
}

type GasState = { ready: true } | { ready: false; outcome: SignedOutcome['outcome'] | 'NOT_SIGNED'; reason: string }

/**
 * Gas authority for one signed leg: if the escrow account cannot pay the leg's maximum gas cost, one treasury
 * funding of exactly the deficit (bounded by the policy caps the leg was signed under), created once per leg
 * and made final on corroborated evidence before the leg is broadcast.
 */
async function ensureGas(escrow: EscrowRow, leg: WdkTransferAttempt, waitForReceipt: boolean): Promise<GasState> {
  let funding = await prisma.wdkTransferAttempt.findUnique({ where: { fundsAttemptId: leg.id } })
  if (!funding) {
    if (leg.status === 'SUBMITTED') return { ready: true } // already accepted by a node: it was payable then
    const required = legMaxGasCost(leg.signedRawTx as string)
    const balance = await wdkSettlementProvider.rpc().balance(leg.fromAddress as string, 'latest')
    if (balance >= required) return { ready: true }
    const deficit = required - balance
    const cap = BigInt(config.wdk.outboundMaxGasLimit as number) * (config.wdk.outboundMaxFeePerGasWei as bigint)
    if (deficit > cap) throw new EscrowError(`WDK gas funding for leg ${leg.id} would be ${deficit} wei, above the policy bound ${cap} — refusing`)
    try {
      funding = await prisma.wdkTransferAttempt.create({
        data: {
          escrowId: escrow.id, operationType: 'GAS_FUNDING', destination: leg.fromAddress as string, amount: '0', authority: 'SIGNED_RAW_V1',
          chainId: config.wdk.chainId, fromAddress: await wdkSettlementProvider.treasuryAddress(), fundsAttemptId: leg.id, valueWei: deficit.toString(),
        },
      })
    } catch (err) {
      funding = await prisma.wdkTransferAttempt.findUnique({ where: { fundsAttemptId: leg.id } })
      if (!funding) throw err
    }
  }
  if (funding.status === 'FAILED_BEFORE_SUBMISSION') {
    return { ready: false, outcome: 'NOT_SIGNED', reason: `gas funding ${funding.id} for leg ${leg.id} failed before it was signed — manual review` }
  }
  if (funding.status === 'PREPARED') funding = await signGasFunding(funding)
  const result = await advanceSigned(funding, () => verifyFunding(escrow, leg, funding!), waitForReceipt)
  if (result.outcome === 'CONFIRMED') return { ready: true }
  return { ready: false, outcome: result.outcome, reason: `gas funding ${funding.txHash}: ${'reason' in result ? result.reason : result.outcome}` }
}

// ─── run ──────────────────────────────────────────────────────────────────────────────────────────

export type OutboundRun =
  | { state: 'COMPLETE'; kind: OutboundKind; txIds: string[] }
  | { state: 'PENDING'; reason: string }
  | { state: 'REVIEW'; reason: string }
  | { state: 'NOT_STARTED'; reason: string }

/**
 * Drives an escrow's outbound obligation from durable state (any node, any time, a retry or reconciliation):
 * each leg in order is signed if only prepared, its gas made available, its same bytes (re)broadcast and its
 * corroborated truth recorded. The second SPLIT leg starts only after the first is final.
 */
export async function runWdkOutbound(escrowId: string, opts: { waitForReceipt: boolean }): Promise<OutboundRun> {
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  const rows = await outboundRows(prisma, escrowId)
  if (rows.length === 0) return { state: 'NOT_STARTED', reason: 'no outbound obligation' }
  // WDK_CHAIN_ID_PINNING_V1: nothing is signed or broadcast unless the primary RPC serves the pinned chain.
  await wdkSettlementProvider.verifyNetwork()
  const latest = latestPerLeg(rows)
  const kind = kindOf(rows[0].operationType)
  const txIds: string[] = []
  const anySigned = rows.some((r) => r.signedRawTx)
  for (const op of LEG_OPS[kind]) {
    let leg = latest.get(op)
    if (!leg) return { state: 'REVIEW', reason: `the ${kind} obligation of escrow ${escrowId} has no ${op} leg — anomaly` }
    if (leg.status === 'FAILED_BEFORE_SUBMISSION') {
      // Nothing of this leg was signed. Before any leg was signed the obligation was abandoned (DF1); after one
      // was, the committed obligation continues with a new generation of exactly this frozen leg.
      if (!anySigned) return { state: 'NOT_STARTED', reason: `${op} failed before anything was signed` }
      leg = await regenerateLeg(escrow, leg)
    }
    if (leg.status === 'PREPARED') leg = await signLeg(escrow, leg)
    if (leg.status === 'REVERTED') return { state: 'REVIEW', reason: `${op} ${leg.txHash} reverted on-chain (final, corroborated): no funds moved by it; the obligation stops here for manual review — nothing is re-signed` }
    if (leg.status === 'NONCE_CONSUMED_ELSEWHERE') return { state: 'REVIEW', reason: `${op} ${leg.txHash}: its nonce was consumed by another transaction of the escrow account (corroborated) — manual review` }
    if (leg.status !== 'CONFIRMED') {
      const gas = await ensureGas(escrow, leg, opts.waitForReceipt)
      if (!gas.ready) {
        return gas.outcome === 'PENDING' ? { state: 'PENDING', reason: `${op}: waiting for its ${gas.reason}` } : { state: 'REVIEW', reason: `${op}: ${gas.reason}` }
      }
      const result = await advanceSigned(leg, () => verifyLeg(escrow, leg!), opts.waitForReceipt)
      if (result.outcome === 'PENDING') return { state: 'PENDING', reason: `${op} ${result.txHash}: ${result.reason}` }
      if (result.outcome !== 'CONFIRMED') return { state: 'REVIEW', reason: `${op} ${result.txHash}: ${'reason' in result ? result.reason : result.outcome}` }
      leg = await prisma.wdkTransferAttempt.findUniqueOrThrow({ where: { id: leg.id } })
      if (leg.status === 'REVERTED') return { state: 'REVIEW', reason: `${op} ${leg.txHash} reverted on-chain (final, corroborated) — manual review` }
    }
    txIds.push(leg.txHash as string)
  }
  return { state: 'COMPLETE', kind, txIds }
}

async function regenerateLeg(escrow: EscrowRow, failed: WdkTransferAttempt): Promise<WdkTransferAttempt> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM escrows WHERE id = ${escrow.id} FOR UPDATE`
    const latest = latestPerLeg(await outboundRows(tx, escrow.id)).get(failed.operationType as OutboundLegOp)
    if (latest && latest.id !== failed.id) return latest
    await tx.wdkTransferAttempt.updateMany({ where: { id: failed.id, activeKey: { not: null }, status: 'FAILED_BEFORE_SUBMISSION' }, data: { activeKey: null } })
    return tx.wdkTransferAttempt.create({
      data: {
        escrowId: failed.escrowId, operationType: failed.operationType, destination: failed.destination, amount: failed.amount.toFixed(),
        authority: 'SIGNED_RAW_V1', chainId: failed.chainId, fromAddress: failed.fromAddress, tokenContract: failed.tokenContract,
        activeKey: `${failed.escrowId}:${failed.operationType}`,
      },
    })
  })
}

// ─── escrow.service entry points ──────────────────────────────────────────────────────────────────

/**
 * The live path, right after escrow.service claimed the terminal status: records the obligation and drives it.
 * Returns the leg transaction hashes once every leg is final and corroborated; otherwise throws (see
 * wdkOutboundFailure() for what happens to the claim).
 */
export async function settleWdkOutbound(escrowId: string, legs: OutboundLeg[]): Promise<string[]> {
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  await prepareWdkOutbound(escrow, legs)
  const run = await runWdkOutbound(escrowId, { waitForReceipt: true })
  if (run.state === 'COMPLETE') return run.txIds
  throw new EscrowError(`WDK_USDT_EVM ${legs.map((l) => l.operationType).join('+')} for escrow ${escrowId}: ${run.reason}`)
}

/**
 * DF1 — what a failed live outbound call does to the escrow claim. Nothing signed: the obligation is abandoned
 * and the claim reverted (the original error is returned). Anything signed: the claim stays and reconciliation
 * continues the same transaction(s); the error says so.
 */
export async function wdkOutboundFailure(escrowId: string, claimedStatus: string, fromStatus: string, err: unknown): Promise<Error> {
  const reason = err instanceof Error ? err.message : String(err)
  if (await abandonUnsignedWdkOutbound(escrowId, claimedStatus, fromStatus)) return err instanceof Error ? err : new Error(reason)
  log.warn({ msg: 'WDK outbound signed but not final: the escrow claim stays, reconciliation continues the same transaction(s)', escrowId, claimedStatus, reason })
  return new EscrowError(
    `${reason}. Escrow ${escrowId} stays ${claimedStatus}: its outbound transaction is signed, so nothing is reverted or re-signed; ` +
    'reconciliation continues this same obligation until it is final.'
  )
}
