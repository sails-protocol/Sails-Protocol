/**
 * E25/E26 F3 (CTO 28 Despacho 021, P63) - persistence of the bilateral commitment pair. Design and contract:
 * EPM-registros PRINCIPAL-P43-F3-desenho-v2.md (GK GO) and PRINCIPAL-F3-contrato-congelado-para-F4.md.
 *
 * Every operation is one transaction that (1) locks the pair row (sign/withdraw), (2) reads the database clock ONCE,
 * (3) re-admits the stored canonical objects with that instant through admitCommitmentPair() (F2.1), (4) writes the
 * row from the verdict only, and (5) writes its idempotency claim already COMPLETED in the same transaction (D-1), so
 * no claim is ever left IN_PROGRESS and a replay re-reads the pair, never a cached answer. The database enforces the
 * rest (migration 20261120120000: K1-K4, write-once signatures, stamp window, transitions, append-only).
 * Not exported from the SDK; no route yet (F4).
 */
import type { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { prisma } from '../../common/database'
import { AppError, NotFoundError, ValidationError } from '../../common/errors'
import { hashIdempotentPayload, isUniqueConstraintError } from '../../common/idempotency'
import { offerEnvelopeRepository } from '../open-liquidity/offer-envelope-repository'
import type { ArbitrationCommitmentV1, ArbitrationPolicyV1, CommitmentPairVerdict } from './arbitration-commitment'
import { admitCommitmentPair, executionReadiness, type ExecutionReadiness } from './commitment-admission'
import { verifyDigestSignature, type FeePolicyV1, type PartySignature, type TradeCommitmentV1 } from './trade-commitment'

export type PairRole = 'maker' | 'taker'
export type PairState = 'PROPOSED' | 'PARTIALLY_SIGNED' | 'COMMITTED' | 'WITHDRAWN' | 'EXPIRED'
export interface PairView {
  pairId: string; anchorRef: string; state: PairState; executable: boolean; reason: string | null
  commitmentDigest: string; arbitrationCommitmentDigest: string
}
type PairRow = Prisma.CommitmentPairGetPayload<Record<string, never>>

/** A refusal of the pair, with the same codes as the pure verdict (E25/E26) plus the persistence ones. */
export class CommitmentPairRefused extends AppError {
  constructor(code: string, details?: { field?: string; terms?: string[] }) {
    super(`commitment pair refused: ${code}${details?.field ? ` (${details.field})` : ''}`, 409, code, details)
  }
}

export const WITHDRAW_PROOF_DOMAIN_TAG = 'sails-commitment-pair-withdraw-v1'
/** The digest a party signs to withdraw (B8): bound to both digests of the pair. */
export function withdrawProofDigest(commitmentDigest: string, arbitrationCommitmentDigest: string): string {
  return createHash('sha256').update([WITHDRAW_PROOF_DOMAIN_TAG, commitmentDigest, arbitrationCommitmentDigest].join('\x1f'), 'utf8').digest('hex')
}

const SCOPE = (op: string) => `commitment_pair.${op}`
const TERMINAL: readonly PairState[] = ['COMMITTED', 'WITHDRAWN', 'EXPIRED']
const view = (r: PairRow): PairView => ({
  pairId: r.id, anchorRef: r.anchorRef, state: r.state as PairState, executable: r.state === 'COMMITTED', reason: r.reason,
  commitmentDigest: r.commitmentDigest, arbitrationCommitmentDigest: r.arbitrationCommitmentDigest,
})

/** The database clock, read once inside the transaction (after the row lock), truncated to the column's precision. */
async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ t }] = await tx.$queryRaw<Array<{ t: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS t`
  return t
}

/** A fee policy version as FeePolicyV1 (the digest input); an unusable row simply fails the digest check, fail-closed. */
async function loadFeePolicy(id: string): Promise<FeePolicyV1> {
  const v = await prisma.feePolicyVersion.findUnique({ where: { id } })
  if (!v) throw new CommitmentPairRefused('E25_FEE_POLICY_DIGEST_MISMATCH', { field: 'feePolicyVersionId' })
  const rate = v.protocolFeeRate.toFixed(8).replace(/\.?0+$/, '')
  return { protocolFeeRate: rate, payerModel: v.payerModel, economicBasis: v.economicBasis, requiredConfirmations: v.requiredConfirmations as number, smallTradeRule: v.smallTradeRule }
}

/** T3: the offer's CURRENT signed state, read at every operation; an equivocated or missing offer refuses. */
async function loadEnvelope(c: TradeCommitmentV1) {
  const latest = await offerEnvelopeRepository.getLatest(c.makerPublicKey, c.offerLogicalId)
  if (latest.status !== 'RESOLVED') throw new CommitmentPairRefused('E25_OFFER_ENVELOPE_INVALID', { field: `envelope.${latest.status}` })
  return offerEnvelopeRepository.reconstructSignedEnvelope(latest.row)
}

async function assertParty(participantId: string, roleKey: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: participantId }, select: { publicKey: true } })
  if (!user || user.publicKey !== roleKey) throw new CommitmentPairRefused('E25_NOT_A_PARTY')
}

function refusal(v: Exclude<CommitmentPairVerdict, { ok: true }>): CommitmentPairRefused {
  return new CommitmentPairRefused(v.code, { ...(v.field ? { field: v.field } : {}), ...('terms' in v && v.terms ? { terms: v.terms } : {}) })
}

/**
 * The stored `reason` is only the capability's non-executability reason (P22/P32, CHECK K3). The admitted verdict also
 * carries a readiness reason for a pair that is merely not COMMITTED yet (E25_NOT_COMMITTED): that one is not stored.
 */
const CAPABILITY_REASONS = new Set(['E26_CAPABILITY_UNPROVEN', 'E26_ARBITRATION_UNAVAILABLE'])
const capabilityReason = (v: { reason?: string }): string | null => (v.reason && CAPABILITY_REASONS.has(v.reason) ? v.reason : null)

const stampOf = (sig: string | null, at: Date | null): PartySignature | undefined => (sig && at ? { signature: sig, receivedAt: at.toISOString() } : undefined)

export class CommitmentPairService {
  constructor(private readonly opts: { enabledRails: () => ReadonlySet<string> } = { enabledRails: () => new Set() }) {}

  /** The same key + body returns the pair as it is NOW (re-read); the same key with another body is refused. */
  private async replay(op: string, participantId: string, key: string, requestHash: string): Promise<PairView | null> {
    const claim = await prisma.idempotencyKey.findUnique({ where: { scope_participantId_key: { scope: SCOPE(op), participantId, key } } })
    if (!claim) return null
    if (claim.requestHash !== requestHash) throw new ValidationError(`Idempotency key ${key} was already used for a different ${SCOPE(op)} request`)
    const row = await prisma.commitmentPair.findUnique({ where: { id: claim.resultRef! } })
    if (!row) throw new NotFoundError('CommitmentPair', claim.resultRef!)
    return view(row)
  }

  private claim(tx: Prisma.TransactionClient, op: string, participantId: string, key: string, requestHash: string, pairId: string, at: Date) {
    return tx.idempotencyKey.create({ data: { scope: SCOPE(op), participantId, key, requestHash, status: 'COMPLETED', resultRef: pairId, completedAt: at } })
  }

  async proposePair(i: {
    participantId: string; idempotencyKey: string
    trade: { commitment: TradeCommitmentV1; declaredDigest: string; takerSignature: string }
    arbitration: { commitment: ArbitrationCommitmentV1; declaredDigest: string; policy: ArbitrationPolicyV1; takerSignature: string }
  }): Promise<PairView> {
    const c = i.trade.commitment
    const requestHash = hashIdempotentPayload({
      op: 'propose', commitmentDigest: i.trade.declaredDigest, arbitrationCommitmentDigest: i.arbitration.declaredDigest,
      tradeSignature: i.trade.takerSignature, arbitrationSignature: i.arbitration.takerSignature,
    })
    const replayed = await this.replay('propose', i.participantId, i.idempotencyKey, requestHash)
    if (replayed) return replayed
    await assertParty(i.participantId, c.takerPublicKey)
    const [feePolicy, envelope] = await Promise.all([loadFeePolicy(c.feePolicyVersionId), loadEnvelope(c)])
    try {
      return await prisma.$transaction(async (tx) => {
        const t = await databaseNow(tx)
        const v = admitCommitmentPair({
          envelope, now: t,
          trade: { commitment: c, declaredDigest: i.trade.declaredDigest, feePolicy, enabledRails: this.opts.enabledRails(), taker: { signature: i.trade.takerSignature, receivedAt: t.toISOString() } },
          arbitration: { commitment: i.arbitration.commitment, declaredDigest: i.arbitration.declaredDigest, policy: i.arbitration.policy, taker: { signature: i.arbitration.takerSignature, receivedAt: t.toISOString() } },
        })
        if (!v.ok) throw refusal(v)
        const row = await tx.commitmentPair.create({
          data: {
            anchorRef: c.anchorRef, commitmentDigest: v.commitmentDigest, arbitrationCommitmentDigest: v.arbitrationCommitmentDigest,
            trade: c as unknown as Prisma.InputJsonValue, arbitration: i.arbitration.commitment as unknown as Prisma.InputJsonValue,
            policy: i.arbitration.policy as unknown as Prisma.InputJsonValue, feePolicyVersionId: c.feePolicyVersionId,
            rail: c.rail, capability: i.arbitration.commitment.arbitrationCapability, state: v.state, reason: capabilityReason(v),
            takerTradeSig: i.trade.takerSignature, takerArbitrationSig: i.arbitration.takerSignature, takerReceivedAt: t,
          },
        })
        await this.claim(tx, 'propose', i.participantId, i.idempotencyKey, requestHash, row.id, t)
        return view(row)
      })
    } catch (err) {
      // D025: the anchor must be an admitted trade's own Intent (FK) owned by these parties in these roles, same asset and amount, PENDING or ACTIVE (guard).
      // Only THIS foreign key means "not admitted"; any other FK failure stays the raw error it is.
      if ((err as { code?: unknown })?.code === 'P2003' && JSON.stringify(err, Object.getOwnPropertyNames(err)).includes('commitment_pairs_anchorRef_fkey')) throw new CommitmentPairRefused('E25_ANCHOR_NOT_ADMITTED')
      if (err instanceof Error && err.message.includes('commitment_pairs: anchor mismatch')) throw new CommitmentPairRefused('E25_ANCHOR_MISMATCH')
      if (!isUniqueConstraintError(err)) throw err
      // The loser of a race: the same key (replay), or the same pair digests already proposed (R3).
      const again = await this.replay('propose', i.participantId, i.idempotencyKey, requestHash)
      if (again) return again
      const existing = await prisma.commitmentPair.findFirst({
        where: { OR: [{ commitmentDigest: i.trade.declaredDigest }, { arbitrationCommitmentDigest: i.arbitration.declaredDigest }] },
      })
      if (existing && existing.commitmentDigest === i.trade.declaredDigest && existing.arbitrationCommitmentDigest === i.arbitration.declaredDigest) return view(existing)
      throw new CommitmentPairRefused('E26_EQUIVOCATED')
    }
  }

  async signPair(i: { participantId: string; idempotencyKey: string; pairId: string; role: PairRole; tradeSignature: string; arbitrationSignature: string }): Promise<PairView> {
    const op = `sign_${i.role}`
    const requestHash = hashIdempotentPayload({ op, pairId: i.pairId, tradeSignature: i.tradeSignature, arbitrationSignature: i.arbitrationSignature })
    const replayed = await this.replay(op, i.participantId, i.idempotencyKey, requestHash)
    if (replayed) return replayed
    const pre = await prisma.commitmentPair.findUnique({ where: { id: i.pairId } })
    if (!pre) throw new NotFoundError('CommitmentPair', i.pairId)
    const c = pre.trade as unknown as TradeCommitmentV1
    await assertParty(i.participantId, i.role === 'maker' ? c.makerPublicKey : c.takerPublicKey)
    const [feePolicy, envelope] = await Promise.all([loadFeePolicy(pre.feePolicyVersionId), loadEnvelope(c)])
    try {
      return await prisma.$transaction(async (tx) => {
        // B3: lock the pair row BEFORE re-reading and re-admitting it; the clock is read after the lock (B4/(A)).
        await tx.$queryRaw`SELECT "id" FROM "commitment_pairs" WHERE "id" = ${i.pairId} FOR UPDATE`
        const row = await tx.commitmentPair.findUniqueOrThrow({ where: { id: i.pairId } })
        if (row.state === 'WITHDRAWN' || row.state === 'EXPIRED') throw new CommitmentPairRefused('E25_COMMITMENT_SUPERSEDED')
        const already = i.role === 'maker' ? row.makerReceivedAt : row.takerReceivedAt
        if (already || row.state === 'COMMITTED') throw new CommitmentPairRefused('E25_ROLE_ALREADY_SIGNED', { field: i.role })
        const t = await databaseNow(tx)
        const mine = (sig: string): PartySignature => ({ signature: sig, receivedAt: t.toISOString() })
        const trade = { maker: stampOf(row.makerTradeSig, row.makerReceivedAt), taker: stampOf(row.takerTradeSig, row.takerReceivedAt) }
        const arbitration = { maker: stampOf(row.makerArbitrationSig, row.makerReceivedAt), taker: stampOf(row.takerArbitrationSig, row.takerReceivedAt) }
        trade[i.role] = mine(i.tradeSignature)
        arbitration[i.role] = mine(i.arbitrationSignature)
        const v = admitCommitmentPair({
          envelope, now: t,
          trade: { commitment: c, declaredDigest: row.commitmentDigest, feePolicy, enabledRails: this.opts.enabledRails(), ...trade },
          arbitration: { commitment: row.arbitration as unknown as ArbitrationCommitmentV1, declaredDigest: row.arbitrationCommitmentDigest, policy: row.policy as unknown as ArbitrationPolicyV1, ...arbitration },
        })
        if (!v.ok) throw refusal(v)
        const updated = await tx.commitmentPair.update({
          where: { id: row.id },
          data: i.role === 'maker'
            ? { makerTradeSig: i.tradeSignature, makerArbitrationSig: i.arbitrationSignature, makerReceivedAt: t, state: v.state, committedAnchorRef: v.state === 'COMMITTED' ? row.anchorRef : null }
            : { takerTradeSig: i.tradeSignature, takerArbitrationSig: i.arbitrationSignature, takerReceivedAt: t, state: v.state, committedAnchorRef: v.state === 'COMMITTED' ? row.anchorRef : null },
        })
        await this.claim(tx, op, i.participantId, i.idempotencyKey, requestHash, row.id, t)
        return view(updated)
      })
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      const again = await this.replay(op, i.participantId, i.idempotencyKey, requestHash)
      if (again) return again
      throw new CommitmentPairRefused('E25_ANCHOR_ALREADY_COMMITTED') // C2: another pair of this anchor won COMMITTED
    }
  }

  async withdrawPair(i: { participantId: string; idempotencyKey: string; pairId: string; role: PairRole; proof: string }): Promise<PairView> {
    const op = 'withdraw'
    const requestHash = hashIdempotentPayload({ op, pairId: i.pairId, role: i.role, proof: i.proof })
    const replayed = await this.replay(op, i.participantId, i.idempotencyKey, requestHash)
    if (replayed) return replayed
    const pre = await prisma.commitmentPair.findUnique({ where: { id: i.pairId } })
    if (!pre) throw new NotFoundError('CommitmentPair', i.pairId)
    const c = pre.trade as unknown as TradeCommitmentV1
    const key = i.role === 'maker' ? c.makerPublicKey : c.takerPublicKey
    await assertParty(i.participantId, key)
    if (!verifyDigestSignature(withdrawProofDigest(pre.commitmentDigest, pre.arbitrationCommitmentDigest), i.proof, key)) {
      throw new CommitmentPairRefused('E25_SIGNATURE_INVALID', { field: 'withdrawProof' })
    }
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commitment_pairs" WHERE "id" = ${i.pairId} FOR UPDATE`
      const row = await tx.commitmentPair.findUniqueOrThrow({ where: { id: i.pairId } })
      if (row.state === 'COMMITTED') throw new CommitmentPairRefused('E25_ANCHOR_ALREADY_COMMITTED') // T5: never after COMMITTED
      if (TERMINAL.includes(row.state as PairState)) throw new CommitmentPairRefused('E25_COMMITMENT_SUPERSEDED')
      const t = await databaseNow(tx)
      const updated = await tx.commitmentPair.update({ where: { id: row.id }, data: { state: 'WITHDRAWN', withdrawnBy: i.role, withdrawProof: i.proof } })
      await this.claim(tx, op, i.participantId, i.idempotencyKey, requestHash, row.id, t)
      return view(updated)
    })
  }
}

/**
 * For F4 (B6): the first step of the transaction of an economic effect (createEscrow, submitParticipantKey,
 * lockFunds). Locks the pair row, reads the database clock ONCE after the lock (B4) and evaluates readiness on what
 * is STORED; the caller then takes the exposure, economic and escrow locks, in that order, never the reverse.
 * By anchor, only the anchor's COMMITTED pair is considered (there is at most one); none -> E25_COMMITMENT_MISSING.
 */
export async function lockPairForEffect(
  tx: Prisma.TransactionClient, ref: { pairId: string } | { anchorRef: string },
): Promise<{ row: PairRow | null; readiness: ExecutionReadiness; t: Date }> {
  const locked = 'pairId' in ref
    ? await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "commitment_pairs" WHERE "id" = ${ref.pairId} FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "commitment_pairs" WHERE "committedAnchorRef" = ${ref.anchorRef} FOR UPDATE`
  const t = await databaseNow(tx)
  if (locked.length === 0) {
    if ('pairId' in ref) throw new NotFoundError('CommitmentPair', ref.pairId)
    return { row: null, readiness: { ok: false, code: 'E25_COMMITMENT_MISSING' }, t }
  }
  const row = await tx.commitmentPair.findUniqueOrThrow({ where: { id: locked[0].id } })
  const digests = { commitmentDigest: row.commitmentDigest, arbitrationCommitmentDigest: row.arbitrationCommitmentDigest }
  const verdict: CommitmentPairVerdict =
    row.state === 'WITHDRAWN' ? { ok: false, code: 'E25_COMMITMENT_SUPERSEDED' } as unknown as CommitmentPairVerdict
    : row.state === 'EXPIRED' ? { ok: false, code: 'E25_EXPIRED' } as unknown as CommitmentPairVerdict
    : row.reason ? { ok: true, state: 'PROPOSED', executable: false, reason: row.reason as 'E26_CAPABILITY_UNPROVEN' | 'E26_ARBITRATION_UNAVAILABLE', ...digests }
    : { ok: true, state: row.state as 'PROPOSED' | 'PARTIALLY_SIGNED' | 'COMMITTED', ...digests }
  return { row, readiness: executionReadiness(verdict, row.arbitration as unknown as ArbitrationCommitmentV1), t }
}
