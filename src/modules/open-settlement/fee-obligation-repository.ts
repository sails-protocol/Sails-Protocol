/**
 * FeeObligationRepository — Missão 11 Fase 2.2 economic accounting
 * foundation.
 *
 * STRUCTURAL FOUNDATION ONLY — see fee-obligation.service.ts's header for
 * the full scope disclaimer. Deliberately NOT called from any real
 * release/refund/split flow in this pass (Fase 2.2 §6's explicit
 * instruction) — every caller in this codebase's own tests invokes this
 * service/repository in isolation.
 *
 * One row per escrow that has BOTH a non-null Escrow.feePolicyVersionId AND
 * has reached a terminal settlement outcome (Fase 2.1 §3 — revising Fase 2's
 * original "absence = not applicable" design). The `escrowId @unique`
 * constraint on the underlying table is the real DB-level guarantee behind
 * "a FeeObligation cannot be created twice for the same escrow" — this
 * repository does not pre-check for an existing row before create(),
 * matching this module's established "let the database's own constraint be
 * the real guarantee" discipline (Missão 10's outpoint double-claim
 * protection).
 */
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'
import type { AssetType } from '../../common/types'
import { EscrowError } from '../../common/errors'

type FeeObligationRow = NonNullable<Awaited<ReturnType<typeof prisma.feeObligation.findUnique>>>

export type FeeCollectionStatus =
  | 'PENDING_COLLECTION'
  | 'IN_PROGRESS'
  | 'WAIVED'
  | 'UNCOLLECTIBLE_BYPASSED'
  | 'COLLECTED'
  | 'DISTRIBUTED'

export interface CreateOwedObligationData {
  escrowId: string
  feePolicyVersionId: string
  economicDetermination: 'OWED'
  basisAmount: Prisma.Decimal | string
  computedFee: Prisma.Decimal | string
  asset: AssetType
}

export interface CreateNotApplicableObligationData {
  escrowId: string
  feePolicyVersionId: string
  economicDetermination: 'NOT_APPLICABLE'
}

// Fase 2.1 §5's collection-status transition graph. Kept here (not in the
// service) so both the repository's own atomic guard and any future caller
// inspecting "what's legal from here" read the same single source of truth
// — same precedent as escrow-lifecycle.ts's own VALID_TRANSITIONS constant.
export const VALID_COLLECTION_TRANSITIONS: Record<FeeCollectionStatus, FeeCollectionStatus[]> = {
  PENDING_COLLECTION: ['IN_PROGRESS', 'WAIVED', 'UNCOLLECTIBLE_BYPASSED'],
  IN_PROGRESS: ['COLLECTED', 'PENDING_COLLECTION', 'UNCOLLECTIBLE_BYPASSED'],
  // Automatic backward transition on a pre-distribution reorg (Fase 2.1 §5)
  // — economicDetermination is never touched by this move.
  COLLECTED: ['IN_PROGRESS', 'DISTRIBUTED'],
  WAIVED: [],
  UNCOLLECTIBLE_BYPASSED: [],
  // DISTRIBUTED is terminal for automatic transitions — a post-distribution
  // reorg is a flagged manual-reconciliation case (Fase 2.1 §5), never an
  // automatic revert, so DISTRIBUTED intentionally has no outgoing edges
  // here.
  DISTRIBUTED: [],
}

export interface FeeObligationRepository {
  createOwed(input: CreateOwedObligationData): Promise<FeeObligationRow>
  createNotApplicable(input: CreateNotApplicableObligationData): Promise<FeeObligationRow>

  findByEscrowId(escrowId: string): Promise<FeeObligationRow | null>
  // Issue #245 - optional `tx`, same additive precedent claimCollectionStatusTransition()'s own
  // comment documents: recordBroadcastAndAdvance() needs to read the CURRENT status inside the same
  // transaction it will conditionally write to, so a concurrent caller's still-uncommitted write is
  // never read as final. Every existing caller omits it and gets the exact previous behavior.
  findById(id: string, tx?: Prisma.TransactionClient): Promise<FeeObligationRow | null>

  /** Atomic conditional transition — mirrors EscrowRepository.claimTransition()'s
   *  own updateMany+count pattern exactly. Returns the affected-row count (0
   *  = either the obligation wasn't in `fromStatus`, i.e. a concurrent
   *  caller already moved it, or the transition itself isn't in
   *  VALID_COLLECTION_TRANSITIONS — the caller, fee-obligation.service.ts,
   *  is responsible for checking the transition graph BEFORE calling this;
   *  this method enforces the fromStatus precondition atomically, it does
   *  not re-validate the graph itself.
   *
   *  Missão 11 Fase 7.2.1 — optional `tx`: when the caller already holds
   *  an open `prisma.$transaction` client (fee-collection-recognition.
   *  service.ts's recognizeConfirmation(), which must commit this claim
   *  atomically with its own CONFIRMED-evidence insert — see that
   *  method's own header comment for the adversarial proof of why),
   *  passing it here runs the claim inside that same transaction instead
   *  of a new top-level one. Additive: every existing caller omits it and
   *  gets the exact previous behavior. */
  claimCollectionStatusTransition(id: string, fromStatus: FeeCollectionStatus, toStatus: FeeCollectionStatus, tx?: Prisma.TransactionClient): Promise<number>
}

class PrismaFeeObligationRepository implements FeeObligationRepository {
  async createOwed(input: CreateOwedObligationData) {
    try {
      return await prisma.feeObligation.create({
        data: {
          escrowId: input.escrowId,
          feePolicyVersionId: input.feePolicyVersionId,
          economicDetermination: 'OWED',
          collectionStatus: 'PENDING_COLLECTION',
          basisAmount: input.basisAmount,
          computedFee: input.computedFee,
          asset: input.asset as any,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new EscrowError(`A FeeObligation already exists for escrow ${input.escrowId} — refusing to create a second one.`)
      }
      throw err
    }
  }

  async createNotApplicable(input: CreateNotApplicableObligationData) {
    try {
      return await prisma.feeObligation.create({
        data: {
          escrowId: input.escrowId,
          feePolicyVersionId: input.feePolicyVersionId,
          economicDetermination: 'NOT_APPLICABLE',
          collectionStatus: null,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new EscrowError(`A FeeObligation already exists for escrow ${input.escrowId} — refusing to create a second one.`)
      }
      throw err
    }
  }

  async findByEscrowId(escrowId: string) {
    return prisma.feeObligation.findUnique({ where: { escrowId } })
  }

  async findById(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.feeObligation.findUnique({ where: { id } })
  }

  async claimCollectionStatusTransition(id: string, fromStatus: FeeCollectionStatus, toStatus: FeeCollectionStatus, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? prisma
    const claim = await client.feeObligation.updateMany({
      where: { id, collectionStatus: fromStatus },
      data: { collectionStatus: toStatus },
    })
    return claim.count
  }
}

export const feeObligationRepository: FeeObligationRepository = new PrismaFeeObligationRepository()
