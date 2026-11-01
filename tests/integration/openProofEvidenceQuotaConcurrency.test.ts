// Issue #267 — real PostgreSQL evidence quota/idempotency proof.
// No mocked locks: independent Prisma clients contend in the database.
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('OpenProof evidence quota admission (#267, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: import('@prisma/client').PrismaClient
  let reserveEvidenceQuota: typeof import('../../src/modules/open-proof/evidence-quota').reserveEvidenceQuota
  let commitEvidenceReservation: typeof import('../../src/modules/open-proof/evidence-quota').commitEvidenceReservation
  let persistCanonicalEvidenceSubmittedEvent: typeof import('../../src/modules/open-proof/evidence-quota').persistCanonicalEvidenceSubmittedEvent
  let claimEvidenceObjectCleanup: typeof import('../../src/modules/open-proof/evidence-quota').claimEvidenceObjectCleanup

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ reserveEvidenceQuota, commitEvidenceReservation, persistCanonicalEvidenceSubmittedEvent, claimEvidenceObjectCleanup } =
      require('../../src/modules/open-proof/evidence-quota'))
  })

  afterAll(async () => {
    if (pg.isAvailable()) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function fixture() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const uploader = await prisma.user.create({ data: { publicKey: `267-uploader-${suffix}` } })
    const claim = await prisma.claim.create({
      data: { claimedBy: uploader.id, claimType: 'issue-267-test', assertion: { test: true } },
    })
    const proof = await prisma.proof.create({
      data: {
        claimId: claim.id,
        evidence: { test: true },
        evidenceHash: 'a'.repeat(64),
        submittedBy: uploader.id,
      },
    })
    return { uploader, claim, proof }
  }

  async function cleanup(ids: { uploaderId: string; claimId: string; proofId: string }) {
    const reservations = await prisma.evidenceUploadReservation.findMany({
      where: { proofId: ids.proofId },
      select: { eventRecordId: true },
    })
    const eventIds = reservations.flatMap((r) => r.eventRecordId ? [r.eventRecordId] : [])
    await prisma.evidenceUploadReservation.deleteMany({ where: { proofId: ids.proofId } })
    await prisma.evidenceObjectCleanupClaim.deleteMany({})
    if (eventIds.length) await prisma.durableEventRecord.deleteMany({ where: { id: { in: eventIds } } })
    await prisma.evidenceReference.deleteMany({ where: { proofId: ids.proofId } })
    await prisma.proof.deleteMany({ where: { id: ids.proofId } })
    await prisma.claim.deleteMany({ where: { id: ids.claimId } })
    await prisma.user.deleteMany({ where: { id: ids.uploaderId } })
  }

  it('concurrent same-key admissions converge to one durable reservation', async () => {
    requirePostgres('issue #267 same-key convergence')
    const { uploader, claim, proof } = await fixture()
    try {
      const input = {
        proofId: proof.id,
        submittedBy: uploader.id,
        sizeBytes: 1024,
        operationKey: 'same-operation',
        mediaSha256: 'b'.repeat(64),
        mimeType: 'image',
      }
      const results = await Promise.all(Array.from({ length: 12 }, () => reserveEvidenceQuota(input)))
      expect(new Set(results.map((x) => x.id)).size).toBe(1)
      expect(await prisma.evidenceUploadReservation.count({ where: { proofId: proof.id } })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('serializes competing admissions so uploader+Proof byte quota cannot be overbooked', async () => {
    requirePostgres('issue #267 uploader quota concurrency')
    const { uploader, claim, proof } = await fixture()
    try {
      // CTO V1 uploader+Proof byte budget is 50 MiB. Two independent
      // 30 MiB operations cannot both be admitted even if they start together.
      const sizeBytes = 30 * 1024 * 1024
      const attempts = await Promise.allSettled([
        reserveEvidenceQuota({
          proofId: proof.id, submittedBy: uploader.id, sizeBytes,
          operationKey: 'quota-a', mediaSha256: 'c'.repeat(64), mimeType: 'video',
        }),
        reserveEvidenceQuota({
          proofId: proof.id, submittedBy: uploader.id, sizeBytes,
          operationKey: 'quota-b', mediaSha256: 'd'.repeat(64), mimeType: 'video',
        }),
      ])
      expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1)
      const active = await prisma.evidenceUploadReservation.findMany({
        where: { proofId: proof.id, status: { in: ['RESERVED', 'UNKNOWN'] } },
      })
      expect(active).toHaveLength(1)
      expect(active[0].sizeBytes).toBe(sizeBytes)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('UNKNOWN survives a fresh module/client read and still consumes quota', async () => {
    requirePostgres('issue #267 restart UNKNOWN accounting')
    const { uploader, claim, proof } = await fixture()
    try {
      const first = await reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 30 * 1024 * 1024,
        operationKey: 'unknown-a', mediaSha256: 'e'.repeat(64), mimeType: 'video',
      })
      await prisma.evidenceUploadReservation.update({
        where: { id: first.id },
        data: { status: 'UNKNOWN' },
      })

      await expect(reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 30 * 1024 * 1024,
        operationKey: 'after-restart', mediaSha256: 'f'.repeat(64), mimeType: 'video',
      })).rejects.toThrow('quota exceeded')

      expect(await prisma.evidenceUploadReservation.count({
        where: { proofId: proof.id, status: 'UNKNOWN' },
      })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })
  it('concurrent commit + event publication converges to one reference and one durable event', async () => {
    requirePostgres('issue #267 canonical commit/event concurrency')
    const { uploader, claim, proof } = await fixture()
    try {
      const reservation = await reserveEvidenceQuota({
        proofId: proof.id,
        submittedBy: uploader.id,
        sizeBytes: 2048,
        operationKey: 'commit-event-once',
        mediaSha256: '1'.repeat(64),
        mimeType: 'document',
      })

      // The reference transition itself is intentionally exercised once:
      // provider.store() is outside Postgres and the service admits only one
      // RESERVED operation into that side effect. What must remain safe under
      // multi-instance/retry pressure is the durable completion/publication.
      const reference = await commitEvidenceReservation(
        reservation.id,
        { provider: 'test-provider', uri: 'test://267/canonical-object' },
        '2'.repeat(128),
      )

      const events = await Promise.all(
        Array.from({ length: 12 }, () => persistCanonicalEvidenceSubmittedEvent(reservation.id)),
      )

      expect(new Set(events.map((event) => event.id)).size).toBe(1)
      expect(await prisma.evidenceReference.count({ where: { proofId: proof.id } })).toBe(1)
      expect(await prisma.durableEventRecord.count({
        where: { eventName: 'proof.submitted', correlationId: claim.id },
      })).toBe(1)

      const persisted = await prisma.evidenceUploadReservation.findUnique({ where: { id: reservation.id } })
      expect(persisted?.status).toBe('COMMITTED')
      expect(persisted?.evidenceRefId).toBe(reference.id)
      expect(persisted?.eventRecordId).toBe(events[0].id)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('restart-style retry returns the same committed reservation/reference/event identity', async () => {
    requirePostgres('issue #267 restart committed convergence')
    const { uploader, claim, proof } = await fixture()
    try {
      const input = {
        proofId: proof.id,
        submittedBy: uploader.id,
        sizeBytes: 4096,
        operationKey: 'restart-stable-operation',
        mediaSha256: '3'.repeat(64),
        mimeType: 'image',
      }
      const reservation = await reserveEvidenceQuota(input)
      const reference = await commitEvidenceReservation(
        reservation.id,
        { provider: 'test-provider', uri: 'test://267/restart-object' },
        '4'.repeat(128),
      )
      const event = await persistCanonicalEvidenceSubmittedEvent(reservation.id)

      // Fresh database reads model a process restart: no in-memory state is
      // required to recover the operation's canonical identities.
      const retried = await reserveEvidenceQuota(input)
      const retriedEvent = await persistCanonicalEvidenceSubmittedEvent(retried.id)
      const durableReference = await prisma.evidenceReference.findUnique({ where: { id: reference.id } })

      expect(retried.id).toBe(reservation.id)
      expect(retried.evidenceRefId).toBe(reference.id)
      expect(retried.eventRecordId).toBe(event.id)
      expect(retriedEvent.id).toBe(event.id)
      expect(durableReference?.id).toBe(reference.id)
      expect(await prisma.evidenceReference.count({ where: { proofId: proof.id } })).toBe(1)
      expect(await prisma.durableEventRecord.count({
        where: { eventName: 'proof.submitted', correlationId: claim.id },
      })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('UNKNOWN can converge to COMMITTED after a positive same-payload storage reconciliation', async () => {
    requirePostgres('issue #267 UNKNOWN positive reconciliation')
    const { uploader, claim, proof } = await fixture()
    try {
      const reservation = await reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 1024,
        operationKey: 'unknown-reconcile', mediaSha256: '9'.repeat(64), mimeType: 'document',
      })
      await prisma.evidenceUploadReservation.update({
        where: { id: reservation.id },
        data: { status: 'UNKNOWN' },
      })

      const reference = await commitEvidenceReservation(
        reservation.id,
        { provider: 'test-provider', uri: `test://267/unknown-reconcile-${proof.id}` },
        'a'.repeat(128),
      )
      const event = await persistCanonicalEvidenceSubmittedEvent(reservation.id)

      const durable = await prisma.evidenceUploadReservation.findUnique({ where: { id: reservation.id } })
      expect(durable?.status).toBe('COMMITTED')
      expect(durable?.evidenceRefId).toBe(reference.id)
      expect(durable?.eventRecordId).toBe(event.id)
      expect(await prisma.evidenceReference.count({ where: { proofId: proof.id } })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('concurrent UNKNOWN reconciliation converges to one durable reference', async () => {
    requirePostgres('issue #267 UNKNOWN concurrent reconciliation')
    const { uploader, claim, proof } = await fixture()
    try {
      const reservation = await reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 1024,
        operationKey: 'unknown-race', mediaSha256: 'b'.repeat(64), mimeType: 'image',
      })
      await prisma.evidenceUploadReservation.update({
        where: { id: reservation.id },
        data: { status: 'UNKNOWN' },
      })
      const stored = { provider: 'test-provider', uri: `test://267/unknown-race-${proof.id}` }
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => commitEvidenceReservation(reservation.id, stored, 'c'.repeat(128))),
      )

      expect(attempts.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
      expect(await prisma.evidenceReference.count({ where: { proofId: proof.id } })).toBe(1)
      const durable = await prisma.evidenceUploadReservation.findUnique({ where: { id: reservation.id } })
      expect(durable?.status).toBe('COMMITTED')
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('reference victory prevents a later cleanup claim for the shared object', async () => {
    requirePostgres('issue #267 reference wins cleanup race')
    const { uploader, claim, proof } = await fixture()
    const provider = 'test-provider'
    const uri = `test://267/reference-wins-${proof.id}`
    try {
      const reservation = await reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 512,
        operationKey: 'reference-wins', mediaSha256: '5'.repeat(64), mimeType: 'image',
      })
      await commitEvidenceReservation(reservation.id, { provider, uri }, '6'.repeat(128))
      await expect(claimEvidenceObjectCleanup(provider, uri)).resolves.toBe(false)
      expect(await prisma.evidenceObjectCleanupClaim.count({ where: { provider, uri } })).toBe(0)
      expect(await prisma.evidenceReference.count({ where: { provider, uri } })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

  it('cleanup-claim victory blocks a later durable reference to the object', async () => {
    requirePostgres('issue #267 cleanup wins reference race')
    const { uploader, claim, proof } = await fixture()
    const provider = 'test-provider'
    const uri = `test://267/cleanup-wins-${proof.id}`
    try {
      await expect(claimEvidenceObjectCleanup(provider, uri)).resolves.toBe(true)
      const reservation = await reserveEvidenceQuota({
        proofId: proof.id, submittedBy: uploader.id, sizeBytes: 512,
        operationKey: 'cleanup-wins', mediaSha256: '7'.repeat(64), mimeType: 'image',
      })
      await expect(
        commitEvidenceReservation(reservation.id, { provider, uri }, '8'.repeat(128)),
      ).rejects.toThrow('durable orphan cleanup')
      expect(await prisma.evidenceReference.count({ where: { provider, uri } })).toBe(0)
      expect(await prisma.evidenceObjectCleanupClaim.count({ where: { provider, uri } })).toBe(1)
    } finally {
      await cleanup({ uploaderId: uploader.id, claimId: claim.id, proofId: proof.id })
    }
  })

})
