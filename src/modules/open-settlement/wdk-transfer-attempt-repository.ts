/**
 * WdkTransferAttemptRepository — Bounded Remediation (WDK Fund-Moving
 * Safety, 2026-09-08).
 *
 * Persistence for WdkTransferAttempt (schema.prisma's own header comment
 * has the full rationale). One row per attempt generation, append-only —
 * a new row is only ever created via create() once a prior row for the
 * same (escrowId, operationType) reached a state
 * wdk-execution-truth.ts's own state machine has determined is safe to
 * retry from. This repository has no opinion on that decision — it only
 * persists what the caller decides.
 */
import { prisma } from '../../common/database'
import type { WdkTransferOperationType, WdkTransferAttemptStatus } from '@prisma/client'

type WdkTransferAttemptRow = NonNullable<Awaited<ReturnType<typeof prisma.wdkTransferAttempt.findFirst>>>

// D7 (#341, Gatekeeper 6675288389) - the transfers that move an escrow's funds out (LOCK funds it), and the states in
// which such a transfer may have reached the network (SUBMISSION_UNKNOWN, SUBMITTED) or did (CONFIRMED).
export const OUTBOUND_OPERATION_TYPES: WdkTransferOperationType[] = ['RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER']
export const POTENTIALLY_SENT_STATUSES: WdkTransferAttemptStatus[] = ['SUBMISSION_UNKNOWN', 'SUBMITTED', 'CONFIRMED']

export interface CreateWdkTransferAttemptInput {
  escrowId: string
  operationType: WdkTransferOperationType
  destination: string
  amount: string
}

export interface WdkTransferAttemptRepository {
  /** Most recent attempt for this exact logical operation, or null if none was ever started. */
  findLatest(escrowId: string, operationType: WdkTransferOperationType): Promise<WdkTransferAttemptRow | null>
  /** The oldest attempt of this escrow, among `operationTypes`, in a POTENTIALLY_SENT_STATUSES state; read through `client` when given (a caller's transaction). */
  findPotentiallySent(escrowId: string, operationTypes: WdkTransferOperationType[], client?: Pick<typeof prisma, 'wdkTransferAttempt'>): Promise<WdkTransferAttemptRow | null>
  create(input: CreateWdkTransferAttemptInput): Promise<WdkTransferAttemptRow>
  replaceActive(previousId: string, expectedStatuses: WdkTransferAttemptStatus[], input: CreateWdkTransferAttemptInput): Promise<WdkTransferAttemptRow>
  updateStatus(id: string, status: WdkTransferAttemptStatus, extra?: { txHash?: string; chainId?: number }, expectedStatuses?: WdkTransferAttemptStatus[]): Promise<WdkTransferAttemptRow>
}

class PrismaWdkTransferAttemptRepository implements WdkTransferAttemptRepository {
  async findLatest(escrowId: string, operationType: WdkTransferOperationType) {
    return prisma.wdkTransferAttempt.findFirst({
      where: { escrowId, operationType },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findPotentiallySent(escrowId: string, operationTypes: WdkTransferOperationType[], client: Pick<typeof prisma, 'wdkTransferAttempt'> = prisma) {
    return client.wdkTransferAttempt.findFirst({
      where: { escrowId, operationType: { in: operationTypes }, status: { in: POTENTIALLY_SENT_STATUSES } },
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(input: CreateWdkTransferAttemptInput) {
    return prisma.wdkTransferAttempt.create({
      data: {
        escrowId: input.escrowId,
        operationType: input.operationType,
        destination: input.destination,
        amount: input.amount,
        activeKey: `${input.escrowId}:${input.operationType}`,
      },
    })
  }

  async replaceActive(previousId: string, expectedStatuses: WdkTransferAttemptStatus[], input: CreateWdkTransferAttemptInput) {
    const activeKey = `${input.escrowId}:${input.operationType}`
    return prisma.$transaction(async (tx) => {
      const released = await tx.wdkTransferAttempt.updateMany({
        where: { id: previousId, activeKey, status: { in: expectedStatuses } },
        data: { activeKey: null },
      })
      if (released.count !== 1) {
        throw new Error(`WdkTransferAttempt ${previousId} cannot relinquish active generation ${activeKey}: expected status ${expectedStatuses.join('|')} or ownership was lost`)
      }
      return tx.wdkTransferAttempt.create({
        data: {
          escrowId: input.escrowId,
          operationType: input.operationType,
          destination: input.destination,
          amount: input.amount,
          activeKey,
        },
      })
    })
  }

  async updateStatus(
    id: string,
    status: WdkTransferAttemptStatus,
    extra?: { txHash?: string; chainId?: number },
    expectedStatuses?: WdkTransferAttemptStatus[]
  ) {
    if (!expectedStatuses?.length) {
      return prisma.wdkTransferAttempt.update({
        where: { id },
        data: { status, ...(extra?.txHash !== undefined ? { txHash: extra.txHash } : {}), ...(extra?.chainId !== undefined ? { chainId: extra.chainId } : {}) },
      })
    }

    const claimed = await prisma.wdkTransferAttempt.updateMany({
      where: { id, status: { in: expectedStatuses } },
      data: { status, ...(extra?.txHash !== undefined ? { txHash: extra.txHash } : {}), ...(extra?.chainId !== undefined ? { chainId: extra.chainId } : {}) },
    })
    if (claimed.count !== 1) {
      const current = await prisma.wdkTransferAttempt.findUnique({ where: { id } })
      throw new Error(
        `WdkTransferAttempt ${id} transition ownership lost: expected ${expectedStatuses.join('|')}, current=${current?.status ?? 'MISSING'}, requested=${status}`
      )
    }
    const updated = await prisma.wdkTransferAttempt.findUnique({ where: { id } })
    if (!updated) throw new Error(`WdkTransferAttempt ${id} disappeared after status transition`)
    return updated
  }
}

export const wdkTransferAttemptRepository: WdkTransferAttemptRepository = new PrismaWdkTransferAttemptRepository()
