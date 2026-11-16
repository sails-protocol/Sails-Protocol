// tests/integration/registrationProofOfPossessionLive.test.ts
//
// Issue #302 — mission requirements J (REAL REDIS) and K (REAL POSTGRES):
// "do not prove this only with a JavaScript Map or mocked Prisma."
// tests/identityRegistrationProofOfPossession.test.ts already proves the
// full adversarial property list (A, B, D-I) against a mocked-but-real-
// Lua-semantics Redis and a mocked Prisma; this file proves the two
// properties that specifically depend on genuine server-side atomicity
// that a mock cannot manufacture:
//
//  J. The #301 atomic compare-and-consume primitive, reused unmodified
//     for the registration-challenge key namespace
//     (`identity:register-challenge:`), still provides exactly-one
//     consumption under REAL concurrent contention from independent
//     Redis connections (not a single shared client serializing
//     everything client-side).
//  K. Real concurrent `prisma.user.create()` calls against the real
//     `User.publicKey @unique` constraint — the database backstop the
//     Redis layer is explicitly NOT a replacement for (mission
//     requirement 4) — genuinely rejects every but the first, proven
//     against a real Postgres unique-constraint violation (P2002), not
//     an in-memory simulation.
//
// A third test exercises the FULL real stack together (real Redis +
// real Postgres + the real, unmocked identityService.register() and
// verifyRegistrationProof()) under genuine concurrency, confirming both
// barriers cooperate correctly end-to-end, not just independently.

import { PrismaClient, Prisma } from '@prisma/client'
import Redis from 'ioredis'
import nacl from 'tweetnacl'
import { randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// Copied verbatim from src/common/redis/atomic-consume.ts — this test
// deliberately exercises the SAME script text the real primitive runs
// (not a re-derived approximation), via independent connections, the
// same discipline tests/integration/atomicRedisConsume.test.ts already
// established for the generic primitive. Reused here specifically
// against the registration-challenge key namespace.
const ATOMIC_COMPARE_AND_CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`

const REGISTER_CHALLENGE_PREFIX = 'identity:register-challenge:'

describe('Issue #302 — registration proof-of-possession, real Redis + real Postgres', () => {
  jest.setTimeout(30_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let issueRegistrationChallenge: typeof import('../../src/common/middleware/auth').issueRegistrationChallenge
  let registrationProofMessage: typeof import('../../src/common/middleware/auth').registrationProofMessage

  let redisAvailable = false
  const redisClients: Redis[] = []

  function newRedisClient(): Redis {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true })
    redisClients.push(client)
    return client
  }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (dbAvailable) {
      ;({ prisma } = require('../../src/common/database'))
      ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
      ;({ issueRegistrationChallenge, registrationProofMessage } = require('../../src/common/middleware/auth'))
    }

    const probe = newRedisClient()
    try {
      await probe.connect()
      await probe.ping()
      redisAvailable = true
    } catch {
      redisAvailable = false
    }
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      // The application's own shared Redis singleton (loaded lazily via
      // auth.ts above) would otherwise keep Jest from exiting.
      const { redis: appRedis } = require('../../src/common/redis')
      await appRedis.quit().catch(() => {})
    }
    await Promise.all(redisClients.map((c) => (redisAvailable ? c.quit().catch(() => {}) : Promise.resolve(c.disconnect()))))
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function skipIfRedisUnavailable(name: string): boolean {
    if (!redisAvailable) {
      console.warn(`Skipping "${name}" — no Redis reachable at ${REDIS_URL}`)
      return true
    }
    return false
  }

  function newKeypair() {
    const kp = nacl.sign.keyPair()
    return { publicKey: Buffer.from(kp.publicKey).toString('hex'), secretKey: kp.secretKey }
  }

  // J — real Redis, independent connections, genuine contention on the
  // REGISTRATION-challenge key namespace specifically. Mirrors
  // atomicRedisConsume.test.ts's own generic proof, scoped to the exact
  // key prefix/usage #302 reuses.
  it('J: 10 independent Redis connections racing the SAME registration-challenge key — exactly 1 winner', async () => {
    if (skipIfRedisUnavailable('J: registration-challenge real Redis contention')) return

    const publicKey = randomUUID().replace(/-/g, '')
    const key = `${REGISTER_CHALLENGE_PREFIX}${publicKey}`
    const challengeValue = 'real-registration-challenge-value'

    const setter = newRedisClient()
    await setter.connect()
    await setter.set(key, challengeValue, 'EX', 30)

    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const client = newRedisClient()
        await client.connect()
        return client.eval(ATOMIC_COMPARE_AND_CONSUME_SCRIPT, 1, key, challengeValue)
      })
    )

    const winners = results.filter((r) => r === 1)
    const losers = results.filter((r) => r === 0)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(9)

    const finalCheck = newRedisClient()
    await finalCheck.connect()
    expect(await finalCheck.get(key)).toBeNull()
  })

  // K — real Postgres, genuine concurrent prisma.user.create() calls for
  // the SAME publicKey, bypassing the Redis layer entirely (direct
  // Prisma calls, the same "raw, direct create()" discipline
  // offerIntentIdempotencyUniqueness.test.ts's own item 1 uses for
  // Offer.intentId) — proves the database uniqueness barrier is
  // independently sufficient, not merely "assumed to also hold" because
  // the Redis layer already prevented the race upstream in the normal
  // request path.
  it('K: 10 genuine concurrent prisma.user.create() calls for the SAME publicKey — exactly 1 row, 9 real P2002 rejections', async () => {
    requirePostgres('K: real Postgres User.publicKey unique-constraint race')

    const publicKey = randomUUID().replace(/-/g, '')

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        prisma.user.create({ data: { publicKey, displayName: `Concurrent Attempt ${i}` } })
      )
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(9)

    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect((r.reason as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
    }

    const rows = await prisma.user.findMany({ where: { publicKey } })
    expect(rows).toHaveLength(1)
  })

  // Full real stack — real Redis (the actual application singleton, via
  // the real issueRegistrationChallenge/verifyRegistrationProof) + real
  // Postgres (the actual application singleton, via the real
  // identityService.register()) — the SAME valid registration proof
  // submitted 10 times concurrently must still produce exactly one
  // canonical User end-to-end, with both barriers active together
  // exactly as a real deployment runs them.
  it('full stack: 10 concurrent identical valid registration proofs against real Redis + real Postgres — exactly 1 canonical User', async () => {
    requirePostgres('full-stack registration concurrency (needs real Postgres)')
    if (skipIfRedisUnavailable('full-stack registration concurrency (needs real Redis)')) return

    const holder = newKeypair()
    const { challenge } = await issueRegistrationChallenge(holder.publicKey)
    const signature = Buffer.from(
      nacl.sign.detached(registrationProofMessage(challenge, 'Concurrent Holder'), holder.secretKey)
    ).toString('hex')

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        identityService.register({ publicKey: holder.publicKey, signature, displayName: 'Concurrent Holder' })
      )
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(9)

    const rows = await prisma.user.findMany({ where: { publicKey: holder.publicKey } })
    expect(rows).toHaveLength(1)
    expect(rows[0].displayName).toBe('Concurrent Holder')
  })
})
