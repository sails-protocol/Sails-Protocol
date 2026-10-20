/**
 * #235 R7G-F6B — WDK LOCK authority (WDK_LOCK_EXACTLY_ONE_TRANSACTION_V1, WDK_SIGNED_TRANSACTION_IDENTITY_V1,
 * TREASURY_NONCE_AUTHORITY_V1, WDK_LOCK_PROVEN_FUNDING_PROJECTION_V1).
 *
 * One logical LOCK (an escrow's active LOCK attempt) has at most one signed transaction:
 *
 *   PREPARED       intent recorded (escrow, escrow account, amount); nothing signed.
 *   — read-only preparation: gas and fee quote, the treasury's chain nonces. A failure here is
 *     mechanically pre-broadcast: FAILED_BEFORE_SUBMISSION, and a later call starts a new generation.
 *   SIGNED         one PostgreSQL transaction, under the trade-lifecycle lock: the nonce is allocated
 *                  from the (chainId, treasury) lane, the transaction is built with every field explicit,
 *                  signed locally, decoded and checked, and persisted with its hash. Nothing has been
 *                  broadcast yet, but from here the signed bytes are a bearer authorization: the escrow
 *                  is economically committed (no cancellation, no refund-from-CREATED).
 *   SUBMITTED      an RPC returned exactly its hash.
 *   CONFIRMED      receipt status 1, final under WDK_FINALITY_CONFIRMATIONS — projected FUNDS_LOCKED in the
 *                  same transaction. REVERTED: status 0, final. NONCE_CONSUMED_ELSEWHERE: the nonce is
 *                  final on-chain with a different transaction (operator review).
 *
 * #235 R7G-F6B-P1 — WDK_IRREVERSIBLE_RPC_CORROBORATION_V1: the primary RPC (WDK_RPC_URL) observes, broadcasts
 * and finds candidates; none of the three terminal states is written before the corroborating RPC
 * (WDK_CORROBORATING_RPC_URL, evidence only, never broadcasts) independently agrees, and both sources are
 * recorded with the evidence. That the two URLs are independent infrastructure is an operational assumption,
 * not something two URLs prove. Treasury lanes are governed by wdk-lane-governance.ts: nothing is signed
 * while a lane is halted, and a lane halts (WDK_LOWEST_UNRESOLVED_NONCE_BACKPRESSURE_V1) once its lowest
 * unresolved signed transaction has waited WDK_LANE_STUCK_BLOCKS blocks.
 *
 * Every broadcast — first or any later one, by the caller or by reconciliation on any node — sends the
 * persisted bytes, after decoding them and checking them against the attempt, the escrow and the
 * configuration. A timeout, an RPC error, a missing or malformed receipt never produce a new transaction:
 * the same one is rebroadcast and reconciled. Escrow.status stays CREATED until the funding is final.
 */
import { Interface, Transaction, getAddress } from 'ethers'
import type { Prisma, WdkTransferAttempt } from '@prisma/client'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { lockTradeLifecycle } from '../open-p2p/trade-lifecycle-lock'
import { claimEscrowTransitionRecord } from './escrow-transition-claim'
import { publishEscrowTransition } from './escrow-lifecycle'
import { wdkSettlementProvider, type WdkEscrowAccountIdentity } from './wdk-settlement.provider'
import { wdkAttemptIsNonEconomic } from './wdk-attempt-economics'
import { activeLaneHalts, lockLaneGovernance, raiseLaneHalt, type LaneKey } from './wdk-lane-governance'
import type { WdkRpc } from './wdk-rpc'

const log = childLogger('wdk-lock-authority')

const USDT_DECIMALS = 6
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const GAS_HEADROOM_PERCENT = 120n

type EscrowRow = NonNullable<Awaited<ReturnType<typeof prisma.escrow.findUnique>>>
type LockEscrow = WdkEscrowAccountIdentity & { tradeId: string; lockedAmount: { toFixed(): string }; status: string; timelockHours: number }

/** Signed-raw attempt states with a durable signed transaction. */
const SIGNED_STATES: ReadonlySet<string> = new Set(['SIGNED', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'NONCE_CONSUMED_ELSEWHERE'])

/** Exact decimal string -> token base units; refuses (never truncates) precision beyond the token's decimals. */
export function toExactBaseUnits(decimal: string, decimals = USDT_DECIMALS): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (!match) throw new EscrowError(`WDK amount ${decimal} is not a plain non-negative decimal`)
  const [, whole, fraction = ''] = match
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new EscrowError(`WDK amount ${decimal} has more precision than the token's ${decimals} decimals — refusing to lock a truncated amount`)
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0'))
}

// ─── receipts ─────────────────────────────────────────────────────────────────────────────────────

export type LockReceipt =
  | { kind: 'NONE' }
  | { kind: 'UNRESOLVED'; reason: string }
  | { kind: 'MINED'; success: boolean; blockNumber: number; blockHash: string }

/**
 * Classifies a raw eth_getTransactionReceipt result. Only status '0x1' (success) and '0x0' (revert) with a
 * block number mean anything; null is "no receipt"; every other shape is unresolved. Never a revert by default.
 */
export function classifyLockReceipt(raw: unknown, txHash: string): LockReceipt {
  if (raw === null) return { kind: 'NONE' }
  const r = raw as { status?: unknown; blockNumber?: unknown; blockHash?: unknown; transactionHash?: unknown } | undefined
  if (!r || typeof r !== 'object') return { kind: 'UNRESOLVED', reason: `malformed receipt ${JSON.stringify(raw)}` }
  if (typeof r.transactionHash === 'string' && r.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    return { kind: 'UNRESOLVED', reason: `receipt is for ${r.transactionHash}, not ${txHash}` }
  }
  if (typeof r.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r.blockNumber)) return { kind: 'UNRESOLVED', reason: `receipt without a block number (${JSON.stringify(r.blockNumber)})` }
  if (typeof r.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.blockHash)) return { kind: 'UNRESOLVED', reason: `receipt without a block hash (${JSON.stringify(r.blockHash)})` }
  const blockHash = r.blockHash.toLowerCase()
  if (r.status === '0x1') return { kind: 'MINED', success: true, blockNumber: Number(BigInt(r.blockNumber)), blockHash }
  if (r.status === '0x0') return { kind: 'MINED', success: false, blockNumber: Number(BigInt(r.blockNumber)), blockHash }
  return { kind: 'UNRESOLVED', reason: `receipt status ${JSON.stringify(r.status)} is neither 0x1 nor 0x0` }
}

/** A receipt query that cannot fail into a conclusion: an RPC error is UNRESOLVED, never NONE or a revert. */
export async function queryReceipt(txHash: string, rpc: WdkRpc = wdkSettlementProvider.rpc()): Promise<LockReceipt> {
  try {
    return classifyLockReceipt(await rpc.receipt(txHash), txHash)
  } catch (err) {
    return { kind: 'UNRESOLVED', reason: `receipt query failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * #235 R7G-F6B-P — the evidence that made a LOCK receipt final, persisted with its terminal state (CONFIRMED /
 * REVERTED) and immutable from then on: the receipt's block (number and hash), the head that was observed, and
 * the rule applied — the policy version, so a later change of WDK_FINALITY_CONFIRMATIONS never reinterprets an
 * authorization already made.
 */
export type FinalityEvidence = { receiptBlockNumber: bigint; receiptBlockHash: string; finalityHeadBlock: bigint; finalityRule: string; finalizedAt: Date }

/**
 * #235 R7G-F6B-P1 — who agreed: the two source labels and the corroborator's head (which satisfies the same
 * rule). Persisted with the terminal state and immutable (database CHECK + trigger).
 */
export type Corroboration = { primarySource: string; corroboratingSource: string; corroboratingHeadBlock: bigint }

/** Finality under WDK_FINALITY_CONFIRMATIONS, as the primary RPC sees it; unset means nothing is ever final. */
export async function isFinal(receipt: { blockNumber: number; blockHash: string }): Promise<{ final: true; evidence: FinalityEvidence } | { final: false; reason: string }> {
  const required = config.wdk.finalityConfirmations
  if (!required) return { final: false, reason: 'no WDK finality policy is configured (WDK_FINALITY_CONFIRMATIONS)' }
  const head = await wdkSettlementProvider.rpc().blockNumber()
  const confirmations = head - receipt.blockNumber + 1
  if (confirmations < required) return { final: false, reason: `${confirmations}/${required} confirmations` }
  return {
    final: true,
    evidence: {
      receiptBlockNumber: BigInt(receipt.blockNumber), receiptBlockHash: receipt.blockHash, finalityHeadBlock: BigInt(head),
      finalityRule: `CONFIRMATIONS:${required}`, finalizedAt: new Date(),
    },
  }
}

type CorroboratorView = { ok: true; rpc: WdkRpc; head: number } | { ok: false; disagreement: boolean; reason: string }

/**
 * The corroborating RPC, checked for the pinned chain. Not configured or unreachable: no conclusion yet
 * (disagreement false). Serving another chain: a disagreement, surfaced for review.
 */
async function corroboratorView(): Promise<CorroboratorView> {
  let rpc: WdkRpc
  try {
    rpc = wdkSettlementProvider.corroboratorRpc()
  } catch (err) {
    return { ok: false, disagreement: false, reason: err instanceof Error ? err.message : String(err) }
  }
  try {
    const chainId = await rpc.chainId()
    if (chainId !== BigInt(config.wdk.chainId as number)) {
      return { ok: false, disagreement: true, reason: `corroborating RPC ${config.wdk.corroboratingRpcLabel} serves chain ${chainId}, WDK_CHAIN_ID is ${config.wdk.chainId}` }
    }
    return { ok: true, rpc, head: await rpc.blockNumber() }
  } catch (err) {
    return { ok: false, disagreement: false, reason: `corroborating RPC ${config.wdk.corroboratingRpcLabel} unavailable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

type Corroborated = { agreed: true; corroboration: Corroboration } | { agreed: false; disagreement: boolean; reason: string }

/**
 * WDK_IRREVERSIBLE_RPC_CORROBORATION_V1 for a receipt the primary RPC found final: the corroborator must serve
 * the pinned chain and have its own receipt for the same transaction with the same status, block number and
 * block hash, final under the same rule at its own head. Missing, stale or unreachable: not yet. Contradicting:
 * a disagreement.
 */
export async function corroborateReceipt(txHash: string, primary: { success: boolean; blockNumber: number; blockHash: string }, required: number): Promise<Corroborated> {
  const view = await corroboratorView()
  if (!view.ok) return { agreed: false, disagreement: view.disagreement, reason: view.reason }
  const label = config.wdk.corroboratingRpcLabel
  const theirs = await queryReceipt(txHash, view.rpc)
  if (theirs.kind === 'UNRESOLVED') return { agreed: false, disagreement: false, reason: `corroborating RPC ${label}: ${theirs.reason}` }
  if (theirs.kind === 'NONE') {
    return view.head >= primary.blockNumber
      ? { agreed: false, disagreement: true, reason: `corroborating RPC ${label} at block ${view.head} has no receipt for ${txHash}, which the primary RPC has in block ${primary.blockNumber}` }
      : { agreed: false, disagreement: false, reason: `corroborating RPC ${label} is at block ${view.head}, behind the receipt's block ${primary.blockNumber}` }
  }
  if (theirs.success !== primary.success || theirs.blockNumber !== primary.blockNumber || theirs.blockHash !== primary.blockHash) {
    return {
      agreed: false, disagreement: true,
      reason: `RPCs disagree on ${txHash}: ${config.wdk.rpcLabel} status ${primary.success ? 1 : 0} block ${primary.blockNumber} ${primary.blockHash}, ${label} status ${theirs.success ? 1 : 0} block ${theirs.blockNumber} ${theirs.blockHash}`,
    }
  }
  const confirmations = view.head - theirs.blockNumber + 1
  if (confirmations < required) return { agreed: false, disagreement: false, reason: `corroborating RPC ${label}: ${confirmations}/${required} confirmations` }
  return { agreed: true, corroboration: { primarySource: config.wdk.rpcLabel, corroboratingSource: label, corroboratingHeadBlock: BigInt(view.head) } }
}

// ─── raw transaction self-verification ───────────────────────────────────────────────────────────

/** The intent a LOCK's signed transaction must encode, from durable authority independent of the bytes. */
interface LockIntent {
  chainId: number
  from: string
  token: string
  recipient: string
  baseUnits: bigint
  nonce: number
}

export class WdkSignedTransactionMismatch extends EscrowError {}

/**
 * Decodes signed bytes and requires every economically relevant field to equal the intent: chain, signer,
 * nonce, token contract, zero value, ERC-20 transfer(recipient, amount), EIP-1559 type, positive gas. Returns
 * the hash computed from the bytes.
 */
export function verifySignedLock(signedRawTx: string, intent: LockIntent, expectedHash?: string): string {
  let tx: Transaction
  try {
    tx = Transaction.from(signedRawTx)
  } catch (err) {
    throw new WdkSignedTransactionMismatch(`signed LOCK transaction does not decode: ${err instanceof Error ? err.message : String(err)}`)
  }
  const mismatch = (what: string, got: unknown, want: unknown) => {
    throw new WdkSignedTransactionMismatch(`signed LOCK transaction ${what} is ${String(got)}, expected ${String(want)} — refusing to broadcast it`)
  }
  if (!tx.isSigned() || !tx.hash || !tx.from) mismatch('signature', 'absent', 'present')
  if (tx.type !== 2) mismatch('type', tx.type, 2)
  if (tx.chainId !== BigInt(intent.chainId)) mismatch('chainId', tx.chainId, intent.chainId)
  if (getAddress(tx.from!) !== getAddress(intent.from)) mismatch('signer', tx.from, intent.from)
  if (tx.nonce !== intent.nonce) mismatch('nonce', tx.nonce, intent.nonce)
  if (!tx.to || getAddress(tx.to) !== getAddress(intent.token)) mismatch('token contract', tx.to, intent.token)
  if (tx.value !== 0n) mismatch('value', tx.value, 0)
  if (!(tx.gasLimit > 0n) || !(tx.maxFeePerGas !== null && tx.maxFeePerGas > 0n)) mismatch('gas', `${tx.gasLimit}/${tx.maxFeePerGas}`, 'positive')
  let decoded: ReturnType<Interface['parseTransaction']>
  try {
    decoded = ERC20.parseTransaction({ data: tx.data, value: tx.value })
  } catch {
    decoded = null
  }
  if (!decoded || decoded.name !== 'transfer' || tx.data.length !== 2 + 8 + 128) mismatch('calldata', tx.data.slice(0, 10), 'transfer(address,uint256)')
  if (getAddress(decoded!.args[0]) !== getAddress(intent.recipient)) mismatch('recipient', decoded!.args[0], intent.recipient)
  if (decoded!.args[1] !== intent.baseUnits) mismatch('amount', decoded!.args[1], intent.baseUnits)
  if (expectedHash !== undefined && tx.hash!.toLowerCase() !== expectedHash.toLowerCase()) mismatch('hash', tx.hash, expectedHash)
  return tx.hash!
}

/** Rebuilds the intent of a signed attempt from durable authority: the attempt, the escrow and the config. */
async function intentOf(attempt: WdkTransferAttempt, escrow: LockEscrow): Promise<LockIntent> {
  const chainId = config.wdk.chainId
  if (!chainId || attempt.chainId !== chainId) {
    throw new WdkSignedTransactionMismatch(`LOCK attempt ${attempt.id} was signed for chain ${attempt.chainId}, configured WDK_CHAIN_ID is ${chainId ?? 'unset'}`)
  }
  const [treasury, escrowAddress] = [await wdkSettlementProvider.treasuryAddress(), await wdkSettlementProvider.escrowAddress(escrow)]
  if (attempt.fromAddress !== treasury) throw new WdkSignedTransactionMismatch(`LOCK attempt ${attempt.id} was signed by ${attempt.fromAddress}, the treasury is ${treasury}`)
  if (attempt.destination !== escrowAddress) throw new WdkSignedTransactionMismatch(`LOCK attempt ${attempt.id} pays ${attempt.destination}, escrow ${escrow.id}'s account is ${escrowAddress}`)
  if (attempt.tokenContract !== getAddress(config.wdk.usdtContract)) throw new WdkSignedTransactionMismatch(`LOCK attempt ${attempt.id} uses token ${attempt.tokenContract}, configured WDK_USDT_CONTRACT is ${config.wdk.usdtContract}`)
  const baseUnits = toExactBaseUnits(attempt.amount.toFixed())
  if (baseUnits !== toExactBaseUnits(escrow.lockedAmount.toFixed())) {
    throw new WdkSignedTransactionMismatch(`LOCK attempt ${attempt.id} amount ${attempt.amount.toFixed()} is not escrow ${escrow.id}'s locked amount ${escrow.lockedAmount.toFixed()}`)
  }
  return { chainId, from: treasury, token: attempt.tokenContract, recipient: attempt.destination, baseUnits, nonce: Number(attempt.nonce) }
}

// ─── lock ────────────────────────────────────────────────────────────────────────────────────────

export type LockAdvance =
  | { outcome: 'PROJECTED'; txHash: string }
  | { outcome: 'ALREADY_PROJECTED'; txHash: string }
  | { outcome: 'PENDING'; txHash: string; reason: string }
  | { outcome: 'REVERTED'; txHash: string }
  | { outcome: 'NONCE_CONSUMED_ELSEWHERE'; txHash: string; reason: string }
  | { outcome: 'NONCE_CONSUMPTION_SUSPECTED'; txHash: string; reason: string }
  | { outcome: 'RPC_DISAGREEMENT'; txHash: string; reason: string }

const activeKeyOf = (escrowId: string) => `${escrowId}:LOCK`

async function latestLockAttempt(escrowId: string): Promise<WdkTransferAttempt | null> {
  return prisma.wdkTransferAttempt.findFirst({ where: { escrowId, operationType: 'LOCK' }, orderBy: { createdAt: 'desc' } })
}

/**
 * escrow.service's lockFunds() for WDK_USDT_EVM (authorization and the CREATED check already done there).
 * Returns the escrow once its LOCK is final and projected; otherwise throws an EscrowError that says what
 * is unresolved. Every call — first, retry, another node — converges on the same signed transaction.
 */
export async function lockWdkEscrow(escrowId: string, triggeredBy: string): Promise<EscrowRow> {
  // Cheap early refusal with the R7G-A/B1 wording; the authoritative check is repeated under the
  // trade-lifecycle lock when the transaction is signed.
  const { tradeId } = await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId }, select: { tradeId: true } })
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, select: { status: true } })
  if (trade?.status === 'CANCELLED') throw new EscrowError(`Trade ${tradeId} is CANCELLED: its escrow cannot be locked`)
  await wdkSettlementProvider.verifyNetwork()
  let attempt = await latestLockAttempt(escrowId)
  if (!attempt || startsNewGeneration(attempt)) attempt = await prepareAttempt(escrowId, attempt)
  assertResumable(attempt)
  if (attempt.status === 'PREPARED') attempt = await signAttempt(escrowId, attempt)
  const result = await advanceLockAttempt(attempt, { triggeredBy, waitForReceipt: true })
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  switch (result.outcome) {
    case 'PROJECTED':
    case 'ALREADY_PROJECTED':
      return escrow
    case 'PENDING':
      throw new EscrowError(
        `WDK_USDT_EVM LOCK ${result.txHash} for escrow ${escrowId} is signed and not yet final (${result.reason}); the escrow stays CREATED. ` +
        'Calling lockFunds again, or reconciliation, continues this same transaction — it never creates another one.'
      )
    case 'REVERTED':
      throw new EscrowError(`WDK_USDT_EVM LOCK ${result.txHash} for escrow ${escrowId} reverted on-chain (final): no funds were locked; a new lockFunds call signs a new LOCK`)
    case 'NONCE_CONSUMED_ELSEWHERE':
      throw new EscrowError(`WDK_USDT_EVM LOCK ${result.txHash} for escrow ${escrowId} can never be mined: ${result.reason}. Operator review required; nothing is retried automatically`)
    case 'NONCE_CONSUMPTION_SUSPECTED':
      throw new EscrowError(`WDK_USDT_EVM LOCK ${result.txHash} for escrow ${escrowId} is unresolved: ${result.reason}. The treasury lane is halted for operator review; the escrow stays CREATED and nothing is retried automatically`)
    case 'RPC_DISAGREEMENT':
      throw new EscrowError(`WDK_USDT_EVM LOCK ${result.txHash} for escrow ${escrowId} is unresolved: ${result.reason}. No conclusion while the RPCs disagree; the escrow stays CREATED and reconciliation keeps checking this same transaction (operator review)`)
  }
}

function startsNewGeneration(a: WdkTransferAttempt): boolean {
  if (a.authority === 'LEGACY_TRANSFER_V0') return a.status === 'PREPARED' || a.status === 'FAILED_BEFORE_SUBMISSION'
  return a.status === 'FAILED_BEFORE_SUBMISSION' || a.status === 'REVERTED'
}

function assertResumable(a: WdkTransferAttempt): void {
  if (a.authority !== 'SIGNED_RAW_V1') {
    throw new EscrowError(`Escrow ${a.escrowId} has a legacy WDK transfer() LOCK attempt ${a.id} in ${a.status}: its outcome cannot be verified from a signed transaction — manual review, nothing is re-signed or retried`)
  }
  if (a.status === 'NONCE_CONSUMED_ELSEWHERE') {
    throw new EscrowError(`Escrow ${a.escrowId}'s LOCK attempt ${a.id} is NONCE_CONSUMED_ELSEWHERE — operator review required, nothing is retried automatically`)
  }
}

async function prepareAttempt(escrowId: string, previous: WdkTransferAttempt | null): Promise<WdkTransferAttempt> {
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  const destination = await wdkSettlementProvider.escrowAddress(escrow)
  const amount = escrow.lockedAmount.toFixed()
  toExactBaseUnits(amount)
  const data = {
    escrowId, operationType: 'LOCK' as const, destination, amount, authority: 'SIGNED_RAW_V1' as const,
    chainId: config.wdk.chainId, fromAddress: await wdkSettlementProvider.treasuryAddress(), tokenContract: getAddress(config.wdk.usdtContract),
  }
  try {
    return await prisma.$transaction(async (tx) => {
      if (previous?.activeKey) {
        const released = await tx.wdkTransferAttempt.updateMany({ where: { id: previous.id, activeKey: previous.activeKey, status: previous.status }, data: { activeKey: null } })
        if (released.count !== 1) throw new EscrowError(`LOCK attempt ${previous.id} for escrow ${escrowId} changed concurrently`)
      }
      return tx.wdkTransferAttempt.create({ data: { ...data, activeKey: activeKeyOf(escrowId) } })
    })
  } catch (err) {
    // Another node created this generation first: continue with it.
    const current = await latestLockAttempt(escrowId)
    if (current && current.id !== previous?.id && current.authority === 'SIGNED_RAW_V1') return current
    throw err
  }
}

async function markFailedBeforeSubmission(attempt: WdkTransferAttempt, reason: string): Promise<void> {
  const marked = await prisma.wdkTransferAttempt.updateMany({ where: { id: attempt.id, status: 'PREPARED' }, data: { status: 'FAILED_BEFORE_SUBMISSION' } })
  log.warn({ msg: 'WDK LOCK failed before any transaction was signed', attemptId: attempt.id, escrowId: attempt.escrowId, reason, marked: marked.count })
}

export class LaneHalted extends EscrowError {}

/**
 * Allocates the nonce and persists the signed transaction (TREASURY_NONCE_AUTHORITY_V1 +
 * WDK_SIGNED_TRANSACTION_IDENTITY_V1). Nothing is broadcast here.
 */
async function signAttempt(escrowId: string, attempt: WdkTransferAttempt): Promise<WdkTransferAttempt> {
  const chainId = config.wdk.chainId as number
  const rpc = wdkSettlementProvider.rpc()
  const treasury = attempt.fromAddress as string
  const token = attempt.tokenContract as string
  const baseUnits = toExactBaseUnits(attempt.amount.toFixed())
  const data = ERC20.encodeFunctionData('transfer', [attempt.destination, baseUnits])

  // Read-only preparation. Any failure here precedes every signature: FAILED_BEFORE_SUBMISSION.
  let quote: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; latest: number; pending: number; head: number }
  try {
    const gas = await rpc.estimateGas({ from: treasury, to: token, data })
    const fee = await rpc.feeData()
    quote = {
      gasLimit: (gas * GAS_HEADROOM_PERCENT) / 100n, ...fee,
      latest: await rpc.nonce(treasury, 'latest'), pending: await rpc.nonce(treasury, 'pending'), head: await rpc.blockNumber(),
    }
  } catch (err) {
    await markFailedBeforeSubmission(attempt, err instanceof Error ? err.message : String(err))
    throw new EscrowError(`WDK_USDT_EVM LOCK for escrow ${escrowId} could not be prepared (nothing was signed or broadcast): ${err instanceof Error ? err.message : String(err)}`)
  }

  let halted: string | null = null
  try {
    const signed = await prisma.$transaction(async (tx) => {
      const escrow = await tx.escrow.findUniqueOrThrow({ where: { id: escrowId } })
      await lockTradeLifecycle(tx, escrow.tradeId)
      const trade = await tx.trade.findUnique({ where: { id: escrow.tradeId }, select: { status: true } })
      if (trade?.status === 'CANCELLED') throw new EscrowError(`Trade ${escrow.tradeId} is CANCELLED: its escrow cannot be locked`)
      const current = await tx.escrow.findUniqueOrThrow({ where: { id: escrowId } })
      if (current.status !== 'CREATED') throw new EscrowError(`Escrow ${escrowId} is ${current.status}, not CREATED: no LOCK is signed`)
      const [row] = await tx.$queryRaw<WdkTransferAttempt[]>`SELECT * FROM wdk_transfer_attempts WHERE id = ${attempt.id} FOR UPDATE`
      if (!row || row.status !== 'PREPARED') return null // signed (or abandoned) by another caller meanwhile

      const laneKey: LaneKey = { chainId, account: treasury }
      await lockLaneGovernance(tx, laneKey)
      const halts = await activeLaneHalts(tx, laneKey)
      if (halts.length > 0) throw new LaneHalted(`WDK nonce lane (${chainId}, ${treasury}) is halted (${halts.map((h) => `${h.reason} since ${h.raisedAt.toISOString()}: ${h.detail}`).join('; ')}) — nothing new is signed`)
      const lane = await lockNonceLane(tx, chainId, treasury, Math.max(quote.latest, quote.pending))
      if (quote.latest > lane.nextNonce || quote.pending > lane.nextNonce) {
        halted = `chain nonce of ${treasury} (latest ${quote.latest}, pending ${quote.pending}) is past the next nonce Sails would allocate (${lane.nextNonce}): a transaction Sails did not sign used the treasury (single RPC observation)`
        await raiseLaneHalt(tx, laneKey, 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', halted, 'system:wdk-lock-signing')
        return 'HALTED' as const
      }
      const stuck = await stuckLowestNonce(tx, laneKey, quote.head, quote.latest)
      if (stuck) {
        halted = stuck
        await raiseLaneHalt(tx, laneKey, 'STUCK_LOWEST_NONCE', stuck, 'system:wdk-lock-signing')
        return 'HALTED' as const
      }
      const nonce = lane.nextNonce
      await tx.$executeRaw`UPDATE wdk_nonce_lanes SET "nextNonce" = ${nonce + 1}, "updatedAt" = now() WHERE "chainId" = ${chainId} AND account = ${treasury}`

      const signedRawTx = await wdkSettlementProvider.signTreasuryTransaction({
        type: 2, chainId: BigInt(chainId), nonce, to: token, value: 0n, data,
        gasLimit: quote.gasLimit, maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      })
      const txHash = verifySignedLock(signedRawTx, { chainId, from: treasury, token, recipient: attempt.destination, baseUnits, nonce })
      const updated = await tx.wdkTransferAttempt.updateMany({
        where: { id: attempt.id, status: 'PREPARED' },
        data: { status: 'SIGNED', nonce: BigInt(nonce), signedRawTx, txHash, signedAtBlock: BigInt(quote.head) },
      })
      if (updated.count !== 1) throw new EscrowError(`LOCK attempt ${attempt.id} changed while being signed`)
      return 'SIGNED' as const
    })
    if (signed === 'HALTED') throw new LaneHalted(`WDK LOCK for escrow ${escrowId} refused: ${halted}. The treasury lane is halted for operator review; nothing was signed`)
  } catch (err) {
    // Rolled back: no nonce consumed, nothing signed or persisted — mechanically pre-broadcast. (If another
    // caller signed this attempt meanwhile, the PREPARED-only update below changes nothing.)
    await markFailedBeforeSubmission(attempt, err instanceof Error ? err.message : String(err))
    throw err
  }
  return prisma.wdkTransferAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
}

/** Creates the lane once (from the chain's nonce, never lower than it) and locks it for this transaction. */
export async function lockNonceLane(tx: Prisma.TransactionClient, chainId: number, account: string, chainNonce: number) {
  await tx.$executeRaw`
    INSERT INTO wdk_nonce_lanes ("chainId", account, "nextNonce", "updatedAt") VALUES (${chainId}, ${account}, ${chainNonce}, now())
    ON CONFLICT ("chainId", account) DO NOTHING`
  const [lane] = await tx.$queryRaw<Array<{ nextNonce: bigint }>>`
    SELECT "nextNonce" FROM wdk_nonce_lanes WHERE "chainId" = ${chainId} AND account = ${account} FOR UPDATE`
  return { nextNonce: Number(lane.nextNonce) }
}

/**
 * WDK_LOWEST_UNRESOLVED_NONCE_BACKPRESSURE_V1 — the lane's lowest unresolved signed transaction the chain has
 * not mined yet (nonce >= the account's latest nonce; one already mined only awaits finality and
 * reconciliation) is STUCK once it has waited WDK_LANE_STUCK_BLOCKS blocks: head - signedAtBlock >= threshold.
 * Operational attention only: the transaction stays SIGNED/SUBMITTED and keeps being rebroadcast and
 * reconciled. Unset threshold: no stuck classification. Returns the auditable observation, or null.
 */
export async function stuckLowestNonce(db: Prisma.TransactionClient | typeof prisma, lane: LaneKey, head: number, chainLatestNonce: number): Promise<string | null> {
  const threshold = config.wdk.laneStuckBlocks
  if (!threshold) return null
  const lowest = await db.wdkTransferAttempt.findFirst({
    where: { chainId: lane.chainId, fromAddress: lane.account, signedRawTx: { not: null }, status: { in: ['SIGNED', 'SUBMITTED'] }, nonce: { gte: BigInt(chainLatestNonce) } },
    orderBy: { nonce: 'asc' },
    select: { id: true, nonce: true, txHash: true, signedAtBlock: true },
  })
  if (!lowest || lowest.signedAtBlock === null) return null
  const waited = head - Number(lowest.signedAtBlock)
  if (waited < threshold) return null
  return `lowest unmined nonce ${lowest.nonce} (${lowest.txHash}, attempt ${lowest.id}; account latest nonce ${chainLatestNonce}) signed at block ${lowest.signedAtBlock}, observed head ${head}: waited ${waited} blocks >= WDK_LANE_STUCK_BLOCKS ${threshold}`
}

// ─── advance: verify, (re)broadcast, receipt, finality, projection ────────────────────────────────

/**
 * Moves a signed LOCK attempt toward its truth, from durable state only (any node, any time). Never signs.
 */
export async function advanceLockAttempt(attempt: WdkTransferAttempt, opts: { triggeredBy: string; waitForReceipt: boolean }): Promise<LockAdvance> {
  if (attempt.authority !== 'SIGNED_RAW_V1' || !attempt.signedRawTx || !attempt.txHash || !SIGNED_STATES.has(attempt.status)) {
    throw new EscrowError(`LOCK attempt ${attempt.id} has no signed transaction to advance (${attempt.authority}/${attempt.status})`)
  }
  const txHash = attempt.txHash
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: attempt.escrowId } })
  if (attempt.status === 'REVERTED') return { outcome: 'REVERTED', txHash }
  if (attempt.status === 'NONCE_CONSUMED_ELSEWHERE') return { outcome: 'NONCE_CONSUMED_ELSEWHERE', txHash, reason: 'recorded earlier' }
  await wdkSettlementProvider.verifyNetwork()
  // Never trust the stored bytes because Sails once wrote them: decode and check before any use.
  verifySignedLock(attempt.signedRawTx, await intentOf(attempt, escrow), txHash)
  if (attempt.status === 'CONFIRMED') return projectLock(attempt, opts.triggeredBy)

  let receipt = await queryReceipt(txHash)
  if (receipt.kind !== 'MINED') {
    await broadcast(attempt)
    const polls = opts.waitForReceipt ? config.wdk.receiptPollAttempts : 1
    for (let i = 0; i < polls; i++) {
      receipt = await queryReceipt(txHash)
      if (receipt.kind === 'MINED') break
      if (i < polls - 1) await new Promise((r) => setTimeout(r, config.wdk.receiptPollIntervalMs))
    }
  }

  if (receipt.kind === 'MINED') {
    const finality = await isFinal(receipt)
    if (!finality.final) return { outcome: 'PENDING', txHash, reason: `mined in block ${receipt.blockNumber} with status ${receipt.success ? 1 : 0}; not final: ${finality.reason}` }
    // A single RPC's final receipt is a candidate; the terminal state needs the corroborator's agreement.
    const corroborated = await corroborateReceipt(txHash, receipt, config.wdk.finalityConfirmations as number)
    if (!corroborated.agreed) {
      const candidate = `${config.wdk.rpcLabel} has it final in block ${receipt.blockNumber} with status ${receipt.success ? 1 : 0}`
      return corroborated.disagreement
        ? { outcome: 'RPC_DISAGREEMENT', txHash, reason: `${candidate}; ${corroborated.reason}` }
        : { outcome: 'PENDING', txHash, reason: `${candidate}; not corroborated yet: ${corroborated.reason}` }
    }
    const evidence = { ...finality.evidence, ...corroborated.corroboration }
    if (receipt.success) return projectLock(attempt, opts.triggeredBy, evidence)
    await prisma.wdkTransferAttempt.updateMany({ where: { id: attempt.id, status: { in: ['SIGNED', 'SUBMITTED'] } }, data: { status: 'REVERTED', ...evidence } })
    return { outcome: 'REVERTED', txHash }
  }
  if (receipt.kind === 'NONE') {
    const consumed = await observeNonceConsumption(attempt)
    if (consumed) return consumed
  }
  return { outcome: 'PENDING', txHash, reason: receipt.kind === 'NONE' ? 'no receipt yet' : receipt.reason }
}

/** Broadcasts the persisted bytes (already verified by the caller). Any RPC failure leaves the attempt as it is. */
export async function broadcast(attempt: WdkTransferAttempt): Promise<void> {
  try {
    const result = await wdkSettlementProvider.rpc().sendRawTransaction(attempt.signedRawTx as string)
    if (typeof result === 'string' && result.toLowerCase() === (attempt.txHash as string).toLowerCase()) {
      await prisma.wdkTransferAttempt.updateMany({ where: { id: attempt.id, status: 'SIGNED' }, data: { status: 'SUBMITTED' } })
    } else {
      log.error({ msg: 'WDK LOCK broadcast returned an unexpected result; the signed transaction stays authoritative', attemptId: attempt.id, txHash: attempt.txHash, result })
    }
  } catch (err) {
    // "already known", "nonce too low", a timeout, a reset: the same transaction stays authoritative and
    // its receipt / nonce decide; nothing new is signed.
    log.warn({ msg: 'WDK LOCK broadcast did not confirm acceptance; reconciling the same transaction', attemptId: attempt.id, txHash: attempt.txHash, err: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * NONCE_CONSUMED_ELSEWHERE under WDK_IRREVERSIBLE_RPC_CORROBORATION_V1. The primary RPC showing the treasury's
 * nonce at its newest final block past this attempt's nonce, with no receipt for the attempt, is a candidate:
 * the lane is halted (SUSPECTED_EXTERNAL_NONCE_CONSUMPTION) and the attempt is left as it is. It becomes
 * terminal only when the corroborator independently shows the same thing at a block final for both sources —
 * nonce consumed past n there, no receipt for the transaction (a transaction with nonce n in a final block
 * would have one) — and then, in one transaction, the attempt is NONCE_CONSUMED_ELSEWHERE with both
 * observations and the lane halts with PROVEN_EXTERNAL_NONCE_CONSUMPTION (realignment needs the governed
 * resume). Anything less — corroborator missing, stale, unavailable, or of another view — stays a suspicion.
 */
export async function observeNonceConsumption(attempt: WdkTransferAttempt): Promise<LockAdvance | null> {
  const required = config.wdk.finalityConfirmations
  if (!required) return null
  const from = attempt.fromAddress as string
  const nonce = Number(attempt.nonce)
  const txHash = attempt.txHash as string
  const rpc = wdkSettlementProvider.rpc()
  const headP = await rpc.blockNumber()
  const finalP = headP - required + 1
  if (finalP < 0) return null
  const nonceAtFinal = await rpc.nonce(from, finalP)
  if (nonceAtFinal <= nonce) return null
  if ((await queryReceipt(txHash)).kind !== 'NONE') return null
  const lane: LaneKey = { chainId: attempt.chainId as number, account: from }
  const candidate = `nonce ${nonce} of ${from} appears consumed at block ${finalP} (${config.wdk.rpcLabel} account nonce ${nonceAtFinal}) while ${txHash} has no receipt`

  const view = await corroboratorView()
  let notProven: string
  if (!view.ok) notProven = view.reason
  else {
    const block = Math.min(headP, view.head) - required + 1
    const [primaryAt, corroboratorAt] = block < 0 ? [0, 0] : [await rpc.nonce(from, block), await view.rpc.nonce(from, block)]
    const corroboratorReceipt = await queryReceipt(txHash, view.rpc)
    if (block >= 0 && primaryAt > nonce && corroboratorAt > nonce && corroboratorReceipt.kind === 'NONE') {
      const reason = `external nonce consumption corroborated: nonce ${nonce} of ${from} consumed at block ${block} (${config.wdk.rpcLabel} ${primaryAt}, head ${headP}; ${config.wdk.corroboratingRpcLabel} ${corroboratorAt}, head ${view.head}) and neither has a receipt for ${txHash}`
      const proven = await prisma.$transaction(async (tx) => {
        await lockLaneGovernance(tx, lane)
        const marked = await tx.wdkTransferAttempt.updateMany({
          where: { id: attempt.id, status: { in: ['SIGNED', 'SUBMITTED'] } },
          data: {
            status: 'NONCE_CONSUMED_ELSEWHERE', primarySource: config.wdk.rpcLabel, corroboratingSource: config.wdk.corroboratingRpcLabel,
            finalityHeadBlock: BigInt(headP), corroboratingHeadBlock: BigInt(view.head), nonceConsumedAtBlock: BigInt(block),
            finalityRule: `CONFIRMATIONS:${required}`, finalizedAt: new Date(),
          },
        })
        if (marked.count === 1) await raiseLaneHalt(tx, lane, 'PROVEN_EXTERNAL_NONCE_CONSUMPTION', `attempt ${attempt.id}: ${reason}`, 'system:wdk-lock-reconciliation')
        return marked.count === 1
      })
      if (proven) log.error({ msg: 'WDK LOCK nonce consumed by another transaction (corroborated) - lane halted for operator review', attemptId: attempt.id, escrowId: attempt.escrowId, reason })
      return { outcome: 'NONCE_CONSUMED_ELSEWHERE', txHash, reason }
    }
    notProven = `${config.wdk.corroboratingRpcLabel} does not corroborate it (account nonce ${corroboratorAt} at block ${block}, receipt ${corroboratorReceipt.kind})`
  }
  const reason = `suspected external nonce consumption (single RPC observation): ${candidate}; not corroborated: ${notProven}`
  await prisma.$transaction((tx) => raiseLaneHalt(tx, lane, 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', `attempt ${attempt.id}: ${reason}`, 'system:wdk-lock-reconciliation'))
  return { outcome: 'NONCE_CONSUMPTION_SUSPECTED', txHash, reason }
}

/**
 * WDK_LOCK_PROVEN_FUNDING_PROJECTION_V1: one transaction, under the trade-lifecycle and escrow locks —
 * the attempt becomes CONFIRMED, the escrow FUNDS_LOCKED with txLockId/lockedAt/expiresAt and its funding
 * address, and the transition is claimed (PASS 3 republishes it if the publish below never happens).
 */
async function projectLock(attempt: WdkTransferAttempt, triggeredBy: string, evidence?: FinalityEvidence & Corroboration): Promise<LockAdvance> {
  const txHash = attempt.txHash as string
  const result = await prisma.$transaction(async (tx) => {
    const escrow = await tx.escrow.findUniqueOrThrow({ where: { id: attempt.escrowId } })
    await lockTradeLifecycle(tx, escrow.tradeId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrow.id})::bigint)`
    // A CONFIRMED attempt already carries its corroborated finality evidence (database CHECK); otherwise the
    // evidence that made this receipt final is written together with the terminal state.
    if (evidence) await tx.wdkTransferAttempt.updateMany({ where: { id: attempt.id, status: { in: ['SIGNED', 'SUBMITTED'] } }, data: { status: 'CONFIRMED', ...evidence } })
    const confirmed = await tx.wdkTransferAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
    if (confirmed.status !== 'CONFIRMED') throw new EscrowError(`LOCK attempt ${attempt.id} is ${confirmed.status}, not CONFIRMED: no projection`)
    const current = await tx.escrow.findUniqueOrThrow({ where: { id: attempt.escrowId } })
    if (current.status !== 'CREATED') {
      if (current.txLockId === txHash) return { tradeId: current.tradeId, transitionId: null }
      throw new EscrowError(`Escrow ${current.id} is ${current.status} with txLockId ${current.txLockId}, but its final LOCK is ${txHash} — anomaly, nothing projected`)
    }
    const now = new Date()
    const projected = await tx.escrow.updateMany({
      where: { id: current.id, status: 'CREATED' },
      data: {
        status: 'FUNDS_LOCKED', txLockId: txHash, txLockVout: null, lockedAt: now,
        expiresAt: new Date(now.getTime() + current.timelockHours * 3600 * 1000),
        ...(current.multisigAddr ? {} : { multisigAddr: attempt.destination }),
      },
    })
    if (projected.count !== 1) throw new EscrowError(`Escrow ${current.id} changed while its LOCK was projected`)
    const transitionId = await claimEscrowTransitionRecord(tx, {
      escrowId: current.id, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy, eventName: 'settlement.escrow.locked',
    })
    return { tradeId: current.tradeId, transitionId: transitionId || null }
  })
  if (!result.transitionId) return { outcome: 'ALREADY_PROJECTED', txHash }
  await publishEscrowTransition(attempt.escrowId, result.tradeId, 'CREATED', 'FUNDS_LOCKED', triggeredBy, 'settlement.escrow.locked', { txId: txHash }, result.transitionId)
  return { outcome: 'PROJECTED', txHash }
}

// ─── guards used by escrow.service ─────────────────────────────────────────────────────────────

/**
 * PAYMENT_CLAIM_REQUIRES_PROVEN_FUNDING_V1: a WDK escrow's buyer may claim payment only when its canonical
 * LOCK is a final signed transaction, CONFIRMED, and is the escrow's txLockId.
 */
export async function assertWdkFundingProven(tx: Prisma.TransactionClient, escrowId: string): Promise<void> {
  const escrow = await tx.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  const lock = await tx.wdkTransferAttempt.findFirst({ where: { escrowId, operationType: 'LOCK' }, orderBy: { createdAt: 'desc' } })
  const proven = escrow.status === 'FUNDS_LOCKED' && lock?.authority === 'SIGNED_RAW_V1' && lock.status === 'CONFIRMED' && !!lock.txHash && lock.txHash === escrow.txLockId
  if (!proven) {
    throw new EscrowError(
      `Escrow ${escrowId}'s WDK funding is not proven (escrow ${escrow.status}, LOCK ${lock ? `${lock.authority}/${lock.status}` : 'none'}) — refusing to record a payment claim`
    )
  }
}

/** DF2: true while any LOCK attempt of this escrow may hold or move funds. */
export async function wdkLockMayHoldFunds(escrowId: string): Promise<boolean> {
  const attempts = await prisma.wdkTransferAttempt.findMany({ where: { escrowId, operationType: 'LOCK' }, select: { status: true, authority: true } })
  return attempts.some((a) => !wdkAttemptIsNonEconomic(a))
}

// ─── reconciliation ────────────────────────────────────────────────────────────────────────────

const LOCK_RECONCILE_BATCH = 50

export type LockReconcileReport = {
  requiresManualReview: Array<{ escrowId: string; reason: string }>
  failed: Array<{ escrowId: string; error: string }>
  locksAdvanced: Array<{ escrowId: string; attemptId: string; outcome: LockAdvance['outcome'] }>
}

/**
 * Restart-safe LOCK pass: every unresolved signed LOCK (SIGNED/SUBMITTED, or CONFIRMED under a CREATED
 * escrow) is verified, rebroadcast as the same bytes, checked for a final receipt and projected; nothing is
 * signed. Legacy transfer() LOCK attempts that may hold funds and halted nonce lanes are surfaced for
 * operator review; a lane whose lowest unresolved transaction is stuck is halted. No WDK or RPC access at all
 * when there is nothing to do.
 */
export async function reconcileWdkLocks(report: LockReconcileReport): Promise<void> {
  const candidates = await prisma.wdkTransferAttempt.findMany({
    where: {
      operationType: 'LOCK', authority: 'SIGNED_RAW_V1',
      OR: [{ status: { in: ['SIGNED', 'SUBMITTED'] } }, { status: 'CONFIRMED', escrow: { status: 'CREATED' } }],
    },
    orderBy: { updatedAt: 'asc' },
    take: LOCK_RECONCILE_BATCH,
  })
  for (const attempt of candidates) {
    try {
      const result = await advanceLockAttempt(attempt, { triggeredBy: 'system:wdk-lock-reconciliation', waitForReceipt: false })
      report.locksAdvanced.push({ escrowId: attempt.escrowId, attemptId: attempt.id, outcome: result.outcome })
      if (result.outcome === 'NONCE_CONSUMED_ELSEWHERE' || result.outcome === 'NONCE_CONSUMPTION_SUSPECTED' || result.outcome === 'RPC_DISAGREEMENT') {
        report.requiresManualReview.push({ escrowId: attempt.escrowId, reason: `WDK LOCK ${attempt.txHash}: ${result.reason}` })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof WdkSignedTransactionMismatch) report.requiresManualReview.push({ escrowId: attempt.escrowId, reason: `WDK LOCK attempt ${attempt.id}: ${message}` })
      else report.failed.push({ escrowId: attempt.escrowId, error: message })
    }
  }
  const legacy = await prisma.wdkTransferAttempt.findMany({
    where: { operationType: 'LOCK', authority: 'LEGACY_TRANSFER_V0', status: { in: ['SUBMISSION_UNKNOWN', 'SUBMITTED', 'CONFIRMED', 'REVERTED'] }, escrow: { status: 'CREATED' } },
    select: { id: true, escrowId: true, status: true },
    take: LOCK_RECONCILE_BATCH,
  })
  for (const a of legacy) {
    report.requiresManualReview.push({ escrowId: a.escrowId, reason: `legacy WDK transfer() LOCK attempt ${a.id} is ${a.status}: not verifiable from a signed transaction — manual review` })
  }
  // Backpressure is also observed here, so a lane halts before the next LOCK is even requested.
  const unresolvedLanes = await prisma.wdkTransferAttempt.findMany({
    where: { authority: 'SIGNED_RAW_V1', signedRawTx: { not: null }, status: { in: ['SIGNED', 'SUBMITTED'] } },
    distinct: ['chainId', 'fromAddress'],
    select: { chainId: true, fromAddress: true },
  })
  for (const { chainId, fromAddress } of unresolvedLanes) {
    // Only the pinned chain is observable; no threshold, no classification.
    if (!config.wdk.laneStuckBlocks || chainId !== config.wdk.chainId) continue
    const lane: LaneKey = { chainId, account: fromAddress as string }
    try {
      const rpc = wdkSettlementProvider.rpc()
      const stuck = await stuckLowestNonce(prisma, lane, await rpc.blockNumber(), await rpc.nonce(lane.account, 'latest'))
      if (stuck) await prisma.$transaction((tx) => raiseLaneHalt(tx, lane, 'STUCK_LOWEST_NONCE', stuck, 'system:wdk-lock-reconciliation'))
    } catch (err) {
      report.failed.push({ escrowId: `wdk-nonce-lane:${lane.chainId}:${lane.account}`, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const halts = await prisma.wdkLaneHalt.findMany({ where: { clearedAt: null }, orderBy: { raisedAt: 'asc' } })
  for (const h of halts) {
    report.requiresManualReview.push({ escrowId: `wdk-nonce-lane:${h.chainId}:${h.account}`, reason: `WDK nonce lane halted (${h.reason}) since ${h.raisedAt.toISOString()}: ${h.detail}` })
  }
}
