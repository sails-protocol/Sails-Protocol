// tests/integration/capabilityOnboardingConcurrency.test.ts
//
// Issue #303 delta - canonical onboarding must be idempotent and
// concurrency-safe at the SERVER / PERSISTENCE boundary (real PostgreSQL),
// not merely in an SDK instance: many SDK instances, processes or nodes may
// race the same participant. Every caller here is an independent SDK module
// (own transport) answered by the REAL Postgres-backed registry - the same
// semantics as POST /v1/capabilities/register (grantedTo = issuedBy = caller).
//
// "Live" = revokedAt IS NULL and not past constraints.expiresAt (the exact
// definition the registry's check()/Gate A/Gate B use).

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const TRADE = 'trade-coordination'
const SETTLEMENT = 'settlement'

describe('Issue #303 delta - canonical onboarding idempotency/concurrency (real PostgreSQL)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let capabilityRegistry: typeof import('../../src/core/capability-registry').capabilityRegistry
  let SailsCapabilitiesModule: typeof import('../../packages/sails-sdk/src/modules/capabilities').SailsCapabilitiesModule
  let SailsTransport: typeof import('../../packages/sails-sdk/src/transport').SailsTransport

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ capabilityRegistry } = require('../../src/core/capability-registry'))
    ;({ SailsCapabilitiesModule } = require('../../packages/sails-sdk/src/modules/capabilities'))
    ;({ SailsTransport } = require('../../packages/sails-sdk/src/transport'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // One INDEPENDENT SDK instance per call: separate transport, no shared
  // in-process state, so no SDK-local mutex could possibly help.
  function newSdkFor(participantId: string) {
    const fetchImpl = async (url: string, init: any) => {
      const respond = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => ({ success: status < 300, data }) })
      if (String(url).endsWith('/v1/capabilities/register')) {
        const body = JSON.parse(init.body)
        return respond(201, await capabilityRegistry.grant({ grantedTo: participantId, issuedBy: participantId, ...body }))
      }
      return respond(200, await capabilityRegistry.listGrants(participantId))
    }
    const transport = new SailsTransport({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken('s')
    return new SailsCapabilitiesModule(transport)
  }

  async function rows(participantId: string, capabilityName?: string) {
    return prisma.capabilityGrant.findMany({
      where: { grantedTo: participantId, ...(capabilityName ? { capabilityName } : {}) },
      orderBy: { createdAt: 'asc' },
    })
  }

  function isLive(row: { revokedAt: Date | null; constraints: unknown }): boolean {
    if (row.revokedAt) return false
    const expiresAt = (row.constraints as { expiresAt?: string } | null)?.expiresAt
    return !(typeof expiresAt === 'string' && new Date(expiresAt) <= new Date())
  }

  async function liveCount(participantId: string, capabilityName: string): Promise<number> {
    return (await rows(participantId, capabilityName)).filter(isLive).length
  }

  it('1. SEQUENTIAL idempotency: repeated onboarding leaves exactly one live grant per canonical capability', async () => {
    requirePostgres('sequential idempotency')
    const p = `cap303-seq-${randomUUID()}`
    for (let i = 0; i < 5; i++) await newSdkFor(p).ensureCanonicalGrants(p)

    expect(await liveCount(p, TRADE)).toBe(1)
    expect(await liveCount(p, SETTLEMENT)).toBe(1)
    expect((await rows(p)).length).toBe(2) // nothing accumulated, not even historical duplicates
  })

  it('2. CONCURRENT onboarding: 10 independent SDK callers for the SAME participant converge to exactly one live grant per canonical capability', async () => {
    requirePostgres('x10 concurrent onboarding')
    const p = `cap303-conc-${randomUUID()}`

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => newSdkFor(p).ensureCanonicalGrants(p)))

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0) // deterministic success, no error/retry needed
    expect(await liveCount(p, TRADE)).toBe(1)
    expect(await liveCount(p, SETTLEMENT)).toBe(1)
    expect((await rows(p)).length).toBe(2)
    // every caller observed the SAME effective grants
    const ids = results.map((r) => (r as PromiseFulfilledResult<any[]>).value.map((g) => g.grantId).sort().join(','))
    expect(new Set(ids).size).toBe(1)
  })

  it('2b. the server boundary itself: 10 concurrent registry.grant() of the same canonical grant create ONE row', async () => {
    requirePostgres('x10 concurrent registry.grant')
    const p = `cap303-raw-${randomUUID()}`
    const input = { grantedTo: p, issuedBy: p, capabilityName: SETTLEMENT, scope: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'] }

    const grants = await Promise.all(Array.from({ length: 10 }, () => capabilityRegistry.grant(input)))

    expect(new Set(grants.map((g) => g.grantId)).size).toBe(1) // all callers got the same grant back
    expect((await rows(p, SETTLEMENT)).length).toBe(1)
  })

  it('3. REVOCATION -> reissue: exactly one NEW live grant; the revoked record stays historical', async () => {
    requirePostgres('revoke then reissue')
    const p = `cap303-rev-${randomUUID()}`
    await newSdkFor(p).ensureCanonicalGrants(p)
    const [original] = await rows(p, SETTLEMENT)
    await capabilityRegistry.revoke(original.id, p)

    await newSdkFor(p).ensureCanonicalGrants(p)

    const all = await rows(p, SETTLEMENT)
    expect(all).toHaveLength(2)
    expect(all.filter(isLive)).toHaveLength(1)
    const historical = all.find((r) => r.id === original.id)!
    expect(historical.revokedAt).not.toBeNull() // untouched history
    expect(all.find(isLive)!.id).not.toBe(original.id)
    expect(await liveCount(p, TRADE)).toBe(1) // the unrelated capability was not reissued
  })

  it('3b. concurrent onboarding right after a revocation still yields exactly ONE new live grant', async () => {
    requirePostgres('concurrent reissue after revoke')
    const p = `cap303-rev-conc-${randomUUID()}`
    await newSdkFor(p).ensureCanonicalGrants(p)
    const [original] = await rows(p, SETTLEMENT)
    await capabilityRegistry.revoke(original.id, p)

    await Promise.all(Array.from({ length: 10 }, () => newSdkFor(p).ensureCanonicalGrants(p)))

    const all = await rows(p, SETTLEMENT)
    expect(all).toHaveLength(2)
    expect(all.filter(isLive)).toHaveLength(1)
  })

  it('4. EXPIRY -> reissue: exactly one NEW live grant; the expired record stays historical', async () => {
    requirePostgres('expire then reissue')
    const p = `cap303-exp-${randomUUID()}`
    await newSdkFor(p).ensureCanonicalGrants(p)
    const [original] = await rows(p, SETTLEMENT)
    await prisma.capabilityGrant.update({ where: { id: original.id }, data: { constraints: { expiresAt: new Date(Date.now() - 60_000).toISOString() } } })
    expect(isLive((await rows(p, SETTLEMENT))[0])).toBe(false)

    await Promise.all(Array.from({ length: 10 }, () => newSdkFor(p).ensureCanonicalGrants(p)))

    const all = await rows(p, SETTLEMENT)
    expect(all).toHaveLength(2)
    expect(all.filter(isLive)).toHaveLength(1)
    const historical = all.find((r) => r.id === original.id)!
    expect((historical.constraints as any).expiresAt).toBeDefined() // the expired record is preserved as-is
    expect(all.find(isLive)!.id).not.toBe(original.id)
  })

  it('5a. a genuinely DIFFERENT grant (different constraints) is not "equivalent" - it is still allowed, not collapsed', async () => {
    requirePostgres('non-equivalent grants coexist')
    const p = `cap303-diff-${randomUUID()}`
    const base = { grantedTo: p, issuedBy: p, capabilityName: SETTLEMENT, scope: ['settlement.escrow.released'] }
    const a = await capabilityRegistry.grant(base)
    const b = await capabilityRegistry.grant({ ...base, constraints: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })
    expect(a.grantId).not.toBe(b.grantId)
    expect(await liveCount(p, SETTLEMENT)).toBe(2)
  })

  it('5b. MULTI-participant concurrency: many participants onboard at once, each ends with exactly one live grant per capability', async () => {
    requirePostgres('many participants concurrently')
    const ids = Array.from({ length: 8 }, () => `cap303-multi-${randomUUID()}`)

    await Promise.all(ids.flatMap((p) => Array.from({ length: 4 }, () => newSdkFor(p).ensureCanonicalGrants(p))))

    for (const p of ids) {
      expect(await liveCount(p, TRADE)).toBe(1)
      expect(await liveCount(p, SETTLEMENT)).toBe(1)
    }
  })

  it('5c. the lock is NARROW: while one participant\'s (actor, capability) lock is held, another participant - and the same participant\'s OTHER capability - are NOT blocked; the held one waits and then converges', async () => {
    requirePostgres('narrow lock')
    const a = `cap303-lock-a-${randomUUID()}`
    const b = `cap303-lock-b-${randomUUID()}`
    const settlementScopes = ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split']
    const tradeScopes = ['intent.created', 'intent.discovering']
    // Timer is cleared as soon as the race settles: a dangling timer would keep Jest alive.
    const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<{ done: true; v: T } | { done: false }> => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          p.then((v) => ({ done: true as const, v })),
          new Promise<{ done: false }>((r) => { timer = setTimeout(() => r({ done: false }), ms) }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => { locked = r })
    // Hold participant A's SETTLEMENT lock (the same key markRevoked()/Gate B use) inside an open transaction.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capability:${a}:${SETTLEMENT}`})::bigint)`
      locked()
      await held
    }, { timeout: 30_000 })
    await isLocked

    const otherParticipant = await withTimeout(capabilityRegistry.grant({ grantedTo: b, issuedBy: b, capabilityName: SETTLEMENT, scope: settlementScopes }), 3000)
    const sameActorOtherCapability = await withTimeout(capabilityRegistry.grant({ grantedTo: a, issuedBy: a, capabilityName: TRADE, scope: tradeScopes }), 3000)
    const blockedSame = capabilityRegistry.grant({ grantedTo: a, issuedBy: a, capabilityName: SETTLEMENT, scope: settlementScopes })
    const blockedProbe = await withTimeout(blockedSame, 1000)

    expect(otherParticipant.done).toBe(true) // different participant: unaffected
    expect(sameActorOtherCapability.done).toBe(true) // same participant, different capability: unaffected
    expect(blockedProbe.done).toBe(false) // the exact contended key waits

    release()
    await holder
    await blockedSame // completes once the lock is released
    expect(await liveCount(a, SETTLEMENT)).toBe(1)
  })
})
