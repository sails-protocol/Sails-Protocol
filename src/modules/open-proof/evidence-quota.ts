/**
 * Issue #267 — durable OpenProof evidence quota admission.
 *
 * PostgreSQL is the authoritative cumulative quota ledger. Admission is
 * serialized on two deterministic advisory-lock domains: the Proof budget
 * and the uploader+Proof budget. The transaction counts committed
 * EvidenceReference rows plus still-active pre-storage reservations, checks
 * all four CTO-frozen lifecycle budgets, and creates the reservation in the
 * SAME transaction. There is no read/check/unlocked-insert race.
 *
 * The reservation intentionally survives the transaction. Object storage
 * happens afterwards, with no database lock held across network/filesystem
 * I/O. RESERVED and UNKNOWN reservations consume quota until committed or
 * explicitly reconciled/released; UNKNOWN is never treated as FAILED.
 */
import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { computeEntryHash, GENESIS_HASH } from '../../common/events/event-store'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { ValidationError } from '../../common/errors'

export interface EvidenceQuotaReservationInput {
  proofId: string
  submittedBy: string
  sizeBytes: number
  operationKey: string
  mediaSha256: string
  mimeType: string
}

const activeReservationStatuses = ['RESERVED', 'UNKNOWN'] as const

function lockKey(value: string): string {
  return `openproof:evidence-quota:${createHash('sha256').update(value).digest('hex')}`
}

export async function reserveEvidenceQuota(input: EvidenceQuotaReservationInput) {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new ValidationError('Evidence decoded size must be a positive safe integer')
  }

  return prisma.$transaction(async (tx) => {
    // Fixed acquisition order prevents proof/uploader lock-order inversion.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(`proof:${input.proofId}`)})::bigint)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(`proof:${input.proofId}:uploader:${input.submittedBy}`)})::bigint)`

    // Same logical operation: return the durable reservation rather than
    // consuming quota a second time. A different payload under the same
    // operation key is forbidden.
    const existing = await tx.evidenceUploadReservation.findUnique({
      where: {
        submittedBy_operationKey: {
          submittedBy: input.submittedBy,
          operationKey: input.operationKey,
        },
      },
    })
    if (existing) {
      if (
        existing.proofId !== input.proofId ||
        existing.sizeBytes !== input.sizeBytes ||
        existing.mediaSha256 !== input.mediaSha256 ||
        existing.mimeType !== input.mimeType
      ) {
        throw new ValidationError('Evidence upload operation key was already used for a different request')
      }
      return existing
    }

    const [proofRefs, uploaderRefs, proofReservations, uploaderReservations] = await Promise.all([
      tx.evidenceReference.aggregate({
        where: { proofId: input.proofId },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      tx.evidenceReference.aggregate({
        where: { proofId: input.proofId, submittedBy: input.submittedBy },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      tx.evidenceUploadReservation.aggregate({
        where: { proofId: input.proofId, status: { in: [...activeReservationStatuses] } },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      tx.evidenceUploadReservation.aggregate({
        where: {
          proofId: input.proofId,
          submittedBy: input.submittedBy,
          status: { in: [...activeReservationStatuses] },
        },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
    ])

    const proofCount = proofRefs._count._all + proofReservations._count._all
    const proofBytes = (proofRefs._sum.sizeBytes ?? 0) + (proofReservations._sum.sizeBytes ?? 0)
    const uploaderCount = uploaderRefs._count._all + uploaderReservations._count._all
    const uploaderBytes = (uploaderRefs._sum.sizeBytes ?? 0) + (uploaderReservations._sum.sizeBytes ?? 0)

    if (proofCount + 1 > config.proof.evidenceMaxPerProofCount) {
      throw new ValidationError('Evidence Proof reference quota exceeded')
    }
    if (proofBytes + input.sizeBytes > config.proof.evidenceMaxPerProofBytes) {
      throw new ValidationError('Evidence Proof byte quota exceeded')
    }
    if (uploaderCount + 1 > config.proof.evidenceMaxPerUploaderProofCount) {
      throw new ValidationError('Evidence uploader+Proof reference quota exceeded')
    }
    if (uploaderBytes + input.sizeBytes > config.proof.evidenceMaxPerUploaderProofBytes) {
      throw new ValidationError('Evidence uploader+Proof byte quota exceeded')
    }

    return tx.evidenceUploadReservation.create({
      data: {
        proofId: input.proofId,
        submittedBy: input.submittedBy,
        sizeBytes: input.sizeBytes,
        operationKey: input.operationKey,
        mediaSha256: input.mediaSha256,
        mimeType: input.mimeType,
      },
    })
  })
}


export async function markEvidenceReservationUnknown(reservationId: string): Promise<void> {
  await prisma.evidenceUploadReservation.updateMany({
    where: { id: reservationId, status: 'RESERVED' },
    data: { status: 'UNKNOWN' },
  })
}

export async function releaseEvidenceReservation(reservationId: string): Promise<void> {
  await prisma.evidenceUploadReservation.updateMany({
    where: { id: reservationId, status: 'RESERVED' },
    data: { status: 'RELEASED' },
  })
}

export async function recoverCommittedEvidenceReservation(reservationId: string) {
  const reservation = await prisma.evidenceUploadReservation.findUnique({ where: { id: reservationId } })
  if (!reservation?.evidenceRefId) return null
  return prisma.evidenceReference.findUnique({ where: { id: reservation.evidenceRefId } })
}

/**
 * Atomically converts one active quota reservation into its durable
 * EvidenceReference. The reservation stops contributing as an active
 * reservation in the same transaction in which the committed reference
 * starts contributing, so quota accounting never observes a free gap or
 * double-counted committed operation.
 */
export async function commitEvidenceReservation(
  reservationId: string,
  stored: { provider: string; uri: string },
  signature: string
) {
  return prisma.$transaction(async (tx) => {
    // Serialize reference creation with orphan cleanup for this exact
    // content-addressed object. Cleanup uses the same provider+uri lock.
    const objectLockKey = `openproof:evidence-object:${stored.provider}:${stored.uri}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${objectLockKey})::bigint)`

    const cleanupClaim = await tx.evidenceObjectCleanupClaim.findUnique({
      where: { provider_uri: { provider: stored.provider, uri: stored.uri } },
    })
    if (cleanupClaim) {
      throw new ValidationError('Evidence object is under durable orphan cleanup and cannot receive a new reference')
    }

    const reservation = await tx.evidenceUploadReservation.findUnique({ where: { id: reservationId } })
    if (!reservation) throw new ValidationError('Evidence upload reservation no longer exists')

    if (reservation.status === 'COMMITTED') {
      if (!reservation.evidenceRefId) {
        throw new ValidationError('Committed evidence reservation is missing its durable reference')
      }
      const existing = await tx.evidenceReference.findUnique({ where: { id: reservation.evidenceRefId } })
      if (!existing) throw new ValidationError('Committed evidence reservation points to a missing durable reference')
      return existing
    }
    if (reservation.status === 'RELEASED') {
      throw new ValidationError('Released evidence reservation cannot be committed')
    }
    // UNKNOWN may be committed only after the caller has positively
    // re-observed a successful content-addressed store for the exact same
    // operation payload. reserveEvidenceQuota() already binds operationKey
    // to proof/uploader/size/hash/mime, so a retry cannot substitute bytes.
    // Re-PUT of identical content is the reconciliation primitive: failure
    // remains UNKNOWN; success gives us a fresh positive storage fact.
    const committableStatuses = ['RESERVED', 'UNKNOWN'] as const

    const reference = await tx.evidenceReference.create({
      data: {
        proofId: reservation.proofId,
        provider: stored.provider,
        uri: stored.uri,
        sha256: reservation.mediaSha256,
        mimeType: reservation.mimeType,
        signature,
        submittedBy: reservation.submittedBy,
        sizeBytes: reservation.sizeBytes,
      },
    })

    const committed = await tx.evidenceUploadReservation.updateMany({
      where: { id: reservation.id, status: { in: [...committableStatuses] } },
      data: { status: 'COMMITTED', evidenceRefId: reference.id },
    })
    if (committed.count !== 1) {
      throw new ValidationError('Evidence reservation changed concurrently while committing')
    }

    return reference
  })
}


/**
 * Persists the one canonical proof.submitted DurableEventRecord for an
 * idempotent evidence-upload operation and binds it to the reservation in
 * the SAME Postgres transaction. This proves durable-event uniqueness for
 * #267 without claiming exactly-once listener delivery, which the global
 * EventStore contract does not provide.
 */
export async function persistCanonicalEvidenceSubmittedEvent(reservationId: string) {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.evidenceUploadReservation.findUnique({ where: { id: reservationId } })
    if (!reservation) throw new ValidationError('Evidence upload reservation no longer exists')
    if (reservation.status !== 'COMMITTED' || !reservation.evidenceRefId) {
      throw new ValidationError('Evidence upload must be committed before its canonical event is persisted')
    }
    if (reservation.eventRecordId) {
      const existing = await tx.durableEventRecord.findUnique({ where: { id: reservation.eventRecordId } })
      if (!existing) throw new ValidationError('Evidence upload points to a missing durable event record')
      return existing
    }

    const proof = await tx.proof.findUnique({ where: { id: reservation.proofId }, select: { claimId: true } })
    if (!proof) throw new ValidationError('Committed evidence upload points to a missing Proof')

    const correlationId = proof.claimId
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${correlationId})::bigint)`

    // Re-read after the lock: another instance may have completed this
    // exact operation while this transaction waited.
    const locked = await tx.evidenceUploadReservation.findUnique({ where: { id: reservationId } })
    if (!locked) throw new ValidationError('Evidence upload reservation disappeared while publishing')
    if (locked.eventRecordId) {
      const existing = await tx.durableEventRecord.findUnique({ where: { id: locked.eventRecordId } })
      if (!existing) throw new ValidationError('Evidence upload points to a missing durable event record')
      return existing
    }

    const last = await tx.durableEventRecord.findFirst({
      where: { correlationId },
      orderBy: { publishedAt: 'desc' },
    })
    const prevHash = last?.entryHash ?? GENESIS_HASH
    let publishedAt = new Date().toISOString()
    if (last && publishedAt <= last.publishedAt) {
      publishedAt = new Date(new Date(last.publishedAt).getTime() + 1).toISOString()
    }
    const payload = { proofId: locked.proofId, claimId: proof.claimId }
    const eventName = 'proof.submitted'
    const eventId = randomUUID()
    const entryHash = computeEntryHash(eventName, publishedAt, payload, prevHash)

    const event = await tx.durableEventRecord.create({
      data: {
        id: eventId,
        eventName,
        correlationId,
        payload: payload as unknown as Prisma.InputJsonValue,
        publishedAt,
        entryHash,
        prevHash,
      },
    })

    const bound = await tx.evidenceUploadReservation.updateMany({
      where: { id: locked.id, eventRecordId: null },
      data: { eventRecordId: event.id },
    })
    if (bound.count !== 1) {
      throw new ValidationError('Evidence event binding changed concurrently')
    }
    return event
  })
}


/**
 * #267 content-addressed liveness guard.
 *
 * Deletion is deliberately two-phase: Postgres first serializes all cleanup
 * attempts for the same provider+uri and proves that no durable
 * EvidenceReference currently points at the object. Only then is the
 * provider delete attempted.
 *
 * This helper is ONLY for objects known to be orphan candidates. It never
 * deletes a valid EvidenceReference and it never treats provider failure as
 * proof of deletion. Callers must not use it as evidence-retention policy.
 */
export async function claimEvidenceObjectCleanup(provider: string, uri: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lockKey = `openproof:evidence-object:${provider}:${uri}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`

    const references = await tx.evidenceReference.count({ where: { provider, uri } })
    if (references !== 0) return false

    await tx.evidenceObjectCleanupClaim.upsert({
      where: { provider_uri: { provider, uri } },
      update: {},
      create: { provider, uri },
    })
    return true
  })
}

/**
 * Removes the durable cleanup claim after the provider object is known to
 * have been deleted, or when an operator/reconciler deliberately abandons
 * cleanup. The claim itself is what prevents a new EvidenceReference from
 * racing into the delete window.
 */
export async function releaseEvidenceObjectCleanupClaim(provider: string, uri: string): Promise<void> {
  await prisma.evidenceObjectCleanupClaim.deleteMany({ where: { provider, uri } })
}
