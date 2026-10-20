/**
 * #235 R7G-F6B-P1 — WDK treasury nonce lane governance (WDK_LANE_RESUME_AUTHORITY_V1,
 * WDK_LOWEST_UNRESOLVED_NONCE_BACKPRESSURE_V1).
 *
 * A lane signs nothing new while any halt is active (wdk_lane_halts). Halt reasons decide who may clear them:
 *
 *   OPERATOR_PAUSE                        availability authority: the operator raises it and removes it
 *                                         (unpause), but only while no economic halt is active.
 *   STUCK_LOWEST_NONCE                    the lane's lowest unresolved signed transaction has waited
 *                                         WDK_LANE_STUCK_BLOCKS blocks (operational attention, not failure).
 *   SUSPECTED_EXTERNAL_NONCE_CONSUMPTION  one RPC shows the treasury nonce consumed by a transaction Sails did
 *                                         not sign.
 *   PROVEN_EXTERNAL_NONCE_CONSUMPTION     both RPCs show it (a Sails attempt is NONCE_CONSUMED_ELSEWHERE).
 *
 * Economic halts clear only through resume(), and only on mechanical proof: both RPCs agree on the treasury's
 * final nonce N_f, nothing past it is pending or unfinal, every Sails signed transaction of the lane is
 * terminal (all of them below N_f), and the lane moves forward to N_f — the realignment, the audit record and
 * the clearing in one transaction. There is no force option and no way to set nextNonce directly; the
 * database refuses each of those outside this path (migration 20261010120000).
 *
 * Operator identity: the operator acts from the server shell with database access (scripts/wdk-lane.ts);
 * the current model has no authenticated operator identity, so `actor` is the label the operator declares,
 * recorded verbatim in the audit trail.
 */
import { getAddress } from 'ethers'
import type { Prisma, WdkLaneHalt, WdkLaneHaltReason } from '@prisma/client'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { wdkSettlementProvider } from './wdk-settlement.provider'

const log = childLogger('wdk-lane-governance')

type Db = Prisma.TransactionClient | typeof prisma

export type LaneKey = { chainId: number; account: string }

export const ECONOMIC_HALT_REASONS: ReadonlySet<WdkLaneHaltReason> = new Set<WdkLaneHaltReason>([
  'STUCK_LOWEST_NONCE', 'SUSPECTED_EXTERNAL_NONCE_CONSUMPTION', 'PROVEN_EXTERNAL_NONCE_CONSUMPTION',
])

/** Serializes every decision on a lane — signing, raising or clearing a halt, realignment — across nodes. */
export async function lockLaneGovernance(tx: Prisma.TransactionClient, lane: LaneKey): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wdk-lane:${lane.chainId}:${lane.account}`})::bigint)`
}

export async function activeLaneHalts(db: Db, lane: LaneKey): Promise<WdkLaneHalt[]> {
  return db.wdkLaneHalt.findMany({ where: { chainId: lane.chainId, account: lane.account, clearedAt: null }, orderBy: { raisedAt: 'asc' } })
}

/** The lane's next nonce (null before its first allocation), recorded on every audit record as the lane state. */
async function laneNextNonce(tx: Prisma.TransactionClient, lane: LaneKey): Promise<bigint | null> {
  return (await tx.wdkNonceLane.findUnique({ where: { chainId_account: lane }, select: { nextNonce: true } }))?.nextNonce ?? null
}

/**
 * Raises a halt with its audit record inside the caller's transaction, under the lane lock. Idempotent per
 * active reason: returns false when that reason is already active. The audit record carries the lane's next
 * nonce at that moment: no nonce at or past it is signed until the halt is cleared.
 */
export async function raiseLaneHalt(tx: Prisma.TransactionClient, lane: LaneKey, reason: WdkLaneHaltReason, detail: string, actor: string): Promise<boolean> {
  await lockLaneGovernance(tx, lane)
  if (await tx.wdkLaneHalt.findFirst({ where: { ...lane, reason, clearedAt: null }, select: { id: true } })) return false
  const next = await laneNextNonce(tx, lane)
  await tx.wdkLaneAudit.create({ data: { ...lane, action: reason === 'OPERATOR_PAUSE' ? 'PAUSE' : 'HALT', reason, actor, detail, previousNextNonce: next, newNextNonce: next } })
  await tx.wdkLaneHalt.create({ data: { ...lane, reason, detail, raisedBy: actor } })
  log.error({ msg: 'WDK treasury lane halted', ...lane, reason, detail, actor })
  return true
}

/** Signed transactions of the lane that are not terminal yet. */
async function unresolvedSigned(db: Db, lane: LaneKey) {
  return db.wdkTransferAttempt.findMany({
    where: { chainId: lane.chainId, fromAddress: lane.account, signedRawTx: { not: null }, status: { in: ['SIGNED', 'SUBMITTED'] } },
    select: { id: true, escrowId: true, operationType: true, status: true, nonce: true, txHash: true, signedAtBlock: true },
    orderBy: { nonce: 'asc' },
  })
}

// ─── operator commands ───────────────────────────────────────────────────────────────────────────

function laneKey(chainId: unknown, account: unknown): LaneKey {
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw new EscrowError(`invalid chain id ${String(chainId)}`)
  if (typeof account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new EscrowError(`invalid lane account ${String(account)}`)
  let checksummed: string
  try {
    checksummed = getAddress(account)
  } catch {
    throw new EscrowError(`invalid lane account ${account} (bad checksum)`)
  }
  return { chainId, account: checksummed }
}

function actorOf(actor: unknown): string {
  if (typeof actor !== 'string' || actor.trim() === '') throw new EscrowError('an operator label is required for every lane action')
  return actor.trim()
}

/** Read-only: the lane, its active halts, its unresolved signed transactions and its recent audit trail. */
export async function laneStatus(chainId: number, account: string) {
  const lane = laneKey(chainId, account)
  const row = await prisma.wdkNonceLane.findUnique({ where: { chainId_account: lane } })
  const [halts, unresolved, audit] = await Promise.all([
    activeLaneHalts(prisma, lane),
    unresolvedSigned(prisma, lane),
    prisma.wdkLaneAudit.findMany({ where: lane, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  return {
    lane,
    nextNonce: row ? row.nextNonce.toString() : null,
    laneGap: await observeLaneGap(lane, unresolved.map((a) => a.nonce).filter((n): n is bigint => n !== null)),
    halted: halts.length > 0,
    activeHalts: halts.map((h) => ({ id: h.id, reason: h.reason, detail: h.detail, raisedBy: h.raisedBy, raisedAt: h.raisedAt })),
    unresolvedSigned: unresolved.map((a) => ({ ...a, nonce: a.nonce?.toString() ?? null, signedAtBlock: a.signedAtBlock?.toString() ?? null })),
    stuckThresholdBlocks: config.wdk.laneStuckBlocks ?? null,
    recentAudit: audit.map((a) => ({ ...a, previousNextNonce: a.previousNextNonce?.toString() ?? null, newNextNonce: a.newNextNonce?.toString() ?? null, dbTxId: a.dbTxId.toString() })),
  }
}

/**
 * UNFILLABLE_LANE_GAP_V1 (operator visibility): nonces the chain is still waiting for below the lane's lowest
 * unresolved signed transaction, that no Sails transaction uses - a foreign pending transaction the lane was
 * initialized past has disappeared. Sails' transactions behind the gap can never be mined; the lane fails closed
 * (no resume, no rewind, no filler transaction) until an operator recovery policy exists. Null when there is no
 * gap or the chain cannot be read (status stays read-only and never fails on it).
 */
async function observeLaneGap(lane: LaneKey, unresolvedNonces: bigint[]): Promise<{ chainLatestNonce: number; lowestUnresolvedNonce: number; unsignedNonces: number[] } | null> {
  if (unresolvedNonces.length === 0 || config.wdk.chainId !== lane.chainId) return null
  let chainLatest: number
  try {
    chainLatest = await wdkSettlementProvider.rpc().nonce(lane.account, 'latest')
  } catch {
    return null
  }
  const lowest = Number(unresolvedNonces.reduce((a, b) => (a < b ? a : b)))
  if (lowest <= chainLatest) return null
  const signed = new Set((await prisma.wdkTransferAttempt.findMany({
    where: { chainId: lane.chainId, fromAddress: lane.account, signedRawTx: { not: null }, nonce: { gte: BigInt(chainLatest), lt: BigInt(lowest) } },
    select: { nonce: true },
  })).map((a) => Number(a.nonce)))
  const unsignedNonces = Array.from({ length: lowest - chainLatest }, (_, i) => chainLatest + i).filter((n) => !signed.has(n))
  return unsignedNonces.length > 0 ? { chainLatestNonce: chainLatest, lowestUnresolvedNonce: lowest, unsignedNonces } : null
}

/** Operator pause (availability). Returns false when the lane was already paused. */
export async function pauseLane(chainId: number, account: string, actor: string, detail: string): Promise<boolean> {
  const lane = laneKey(chainId, account)
  const who = actorOf(actor)
  return prisma.$transaction((tx) => raiseLaneHalt(tx, lane, 'OPERATOR_PAUSE', detail.trim() || 'operator pause', who))
}

/** Removes the operator pause — only it, and only while no economic halt is active. */
export async function unpauseLane(chainId: number, account: string, actor: string): Promise<void> {
  const lane = laneKey(chainId, account)
  const who = actorOf(actor)
  await prisma.$transaction(async (tx) => {
    await lockLaneGovernance(tx, lane)
    const halts = await activeLaneHalts(tx, lane)
    const pause = halts.find((h) => h.reason === 'OPERATOR_PAUSE')
    if (!pause) throw new EscrowError(`lane ${lane.chainId}/${lane.account} has no active operator pause`)
    const economic = halts.filter((h) => ECONOMIC_HALT_REASONS.has(h.reason))
    if (economic.length > 0) {
      throw new EscrowError(`lane ${lane.chainId}/${lane.account} also has economic halts (${economic.map((h) => h.reason).join(', ')}): an operator pause cannot be removed before they are resolved by a mechanical resume`)
    }
    const next = await laneNextNonce(tx, lane)
    await tx.wdkLaneAudit.create({ data: { ...lane, action: 'UNPAUSE', reason: 'OPERATOR_PAUSE', actor: who, detail: `removed operator pause ${pause.id}`, previousNextNonce: next, newNextNonce: next } })
    const cleared = await tx.wdkLaneHalt.updateMany({ where: { id: pause.id, clearedAt: null }, data: { clearedAt: new Date(), clearedBy: who } })
    if (cleared.count !== 1) throw new EscrowError(`operator pause ${pause.id} changed concurrently`)
  })
}

export type ResumeResult =
  | { resumed: true; previousNextNonce: string; newNextNonce: string; cleared: WdkLaneHaltReason[] }
  | { resumed: false; reason: string }

/**
 * Governed mechanical resume of economic halts (WDK_LANE_RESUME_AUTHORITY_V1). Refuses — clearing nothing —
 * unless every condition holds; see the module comment. The chain is observed first; the decision is made
 * again from the database under the lane lock, and only the halts that existed when the chain was observed
 * are cleared (a newer halt makes the resume refuse, so a stale request never clears newer evidence).
 */
export async function resumeLane(chainId: number, account: string, actor: string): Promise<ResumeResult> {
  const lane = laneKey(chainId, account)
  const who = actorOf(actor)
  const observed = (await activeLaneHalts(prisma, lane)).filter((h) => ECONOMIC_HALT_REASONS.has(h.reason))
  if (observed.length === 0) return { resumed: false, reason: 'no economic halt is active' }
  if (config.wdk.chainId !== lane.chainId) throw new EscrowError(`lane chain ${lane.chainId} is not the configured WDK_CHAIN_ID ${config.wdk.chainId ?? 'unset'}`)
  const required = config.wdk.finalityConfirmations
  if (!required) throw new EscrowError('no WDK finality policy is configured (WDK_FINALITY_CONFIRMATIONS): no final nonce can be established')

  // Corroborated final treasury nonce N_f, at a block both sources consider final.
  await wdkSettlementProvider.verifyNetwork()
  const primary = wdkSettlementProvider.rpc()
  const corroborator = await wdkSettlementProvider.verifyCorroboratorNetwork()
  const [headP, headC] = [await primary.blockNumber(), await corroborator.blockNumber()]
  const finalBlock = Math.min(headP, headC) - required + 1
  if (finalBlock < 0) throw new EscrowError(`no block is final under CONFIRMATIONS:${required} yet`)
  const [finalP, finalC] = [await primary.nonce(lane.account, finalBlock), await corroborator.nonce(lane.account, finalBlock)]
  if (finalP !== finalC) throw new EscrowError(`the RPCs disagree on the treasury's final nonce at block ${finalBlock} (${config.wdk.rpcLabel} ${finalP}, ${config.wdk.corroboratingRpcLabel} ${finalC})`)
  const [latestP, latestC, pendingP] = [await primary.nonce(lane.account, 'latest'), await corroborator.nonce(lane.account, 'latest'), await primary.nonce(lane.account, 'pending')]
  if (latestP !== finalP || latestC !== finalC || pendingP !== finalP) {
    throw new EscrowError(`treasury transactions past the final nonce ${finalP} are not final yet (latest ${latestP}/${latestC}, pending ${pendingP}): resume after they are final`)
  }
  const nFinal = BigInt(finalP)
  const evidence = `N_f=${nFinal} at block ${finalBlock} under CONFIRMATIONS:${required}; ${config.wdk.rpcLabel} head ${headP}, ${config.wdk.corroboratingRpcLabel} head ${headC}; latest ${latestP}/${latestC}, pending ${pendingP}`

  return prisma.$transaction(async (tx) => {
    await lockLaneGovernance(tx, lane)
    const current = (await activeLaneHalts(tx, lane)).filter((h) => ECONOMIC_HALT_REASONS.has(h.reason))
    if (current.length === 0) return { resumed: false as const, reason: 'no economic halt is active (resumed concurrently)' }
    const observedIds = new Set(observed.map((h) => h.id))
    const newer = current.filter((h) => !observedIds.has(h.id))
    if (newer.length > 0) throw new EscrowError(`a newer halt was raised while the chain was observed (${newer.map((h) => h.reason).join(', ')}): run resume again`)
    const unresolved = await unresolvedSigned(tx, lane)
    if (unresolved.length > 0) {
      throw new EscrowError(`signed transactions of the lane are not terminal (${unresolved.map((a) => `nonce ${a.nonce} ${a.status} ${a.txHash}`).join('; ')}): no resume until reconciliation resolves them`)
    }
    const highest = await tx.wdkTransferAttempt.findFirst({ where: { chainId: lane.chainId, fromAddress: lane.account, signedRawTx: { not: null } }, orderBy: { nonce: 'desc' }, select: { nonce: true, status: true, txHash: true } })
    if (highest && highest.nonce !== null && highest.nonce >= nFinal) {
      throw new EscrowError(`Sails signed nonce ${highest.nonce} (${highest.status} ${highest.txHash}) is not below the final nonce ${nFinal}: the chain view contradicts durable authority — manual investigation`)
    }
    const [row] = await tx.$queryRaw<Array<{ nextNonce: bigint }>>`
      SELECT "nextNonce" FROM wdk_nonce_lanes WHERE "chainId" = ${lane.chainId} AND account = ${lane.account} FOR UPDATE`
    if (!row) throw new EscrowError(`lane ${lane.chainId}/${lane.account} does not exist`)
    if (nFinal < row.nextNonce) {
      throw new EscrowError(`the final nonce ${nFinal} is below the lane's next nonce ${row.nextNonce}: nonces Sails reserved are not final on-chain — no resume (a lane never moves back)`)
    }
    await tx.wdkLaneAudit.create({
      data: { ...lane, action: 'RESUME', actor: who, previousNextNonce: row.nextNonce, newNextNonce: nFinal, detail: `${evidence}; clears ${current.map((h) => `${h.reason}:${h.id}`).join(', ')}` },
    })
    if (nFinal > row.nextNonce) {
      await tx.$executeRaw`UPDATE wdk_nonce_lanes SET "nextNonce" = ${nFinal}, "updatedAt" = now() WHERE "chainId" = ${lane.chainId} AND account = ${lane.account}`
    }
    const cleared = await tx.wdkLaneHalt.updateMany({ where: { id: { in: current.map((h) => h.id) }, clearedAt: null }, data: { clearedAt: new Date(), clearedBy: who } })
    if (cleared.count !== current.length) throw new EscrowError('lane halts changed concurrently')
    log.warn({ msg: 'WDK treasury lane resumed on mechanical proof', ...lane, previousNextNonce: row.nextNonce.toString(), newNextNonce: nFinal.toString(), cleared: current.map((h) => h.reason), actor: who })
    return { resumed: true as const, previousNextNonce: row.nextNonce.toString(), newNextNonce: nFinal.toString(), cleared: current.map((h) => h.reason) }
  })
}
