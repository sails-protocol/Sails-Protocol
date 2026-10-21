/**
 * Auth-tier rate limiting — verifies the tier is actually wired in and
 * enforcing (not just that config fields exist). Since Missão 08B Fase 9
 * this is a Redis-shared custom preHandler (redis-rate-limit.ts), not
 * @fastify/rate-limit's own per-route local store — the mock `redis`
 * below implements real INCR/PEXPIRE/PTTL semantics against an in-memory
 * Map so the limiter's actual counting logic runs for real, only its
 * storage backend is faked. Own isolated `buildApp()` instance (not
 * shared with routes.test.ts) so this file's deliberately-exceeded
 * limits never pollute that file's shared counters.
 *
 * Env vars are set before any src/ import so config/index.ts (a
 * module-level singleton, computed once on first import) picks up these
 * low, fast-to-hit values instead of the real defaults.
 *
 * RATE_LIMIT_MAX (global) is deliberately well above this suite's total
 * request count, not artificially tight like the auth tier below — since
 * Missão 08B, a route with no @fastify/rate-limit `config.rateLimit`
 * override (true of /challenge and /authenticate now — they moved to the
 * Redis-shared preHandler instead) still counts against the global
 * per-instance ceiling underneath, same as any other route. Before, the
 * per-route override excluded a route from the global counter entirely;
 * that exclusion is gone, so this suite must not let the global ceiling
 * trip as a side effect of exercising the auth tier.
 */
process.env.RATE_LIMIT_MAX = '20'
process.env.RATE_LIMIT_WINDOW = '1 minute'
process.env.RATE_LIMIT_AUTH_MAX = '2'
process.env.RATE_LIMIT_AUTH_WINDOW_MS = '60000'

import type { FastifyInstance } from 'fastify'

jest.mock('../src/common/database', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  },
}))

const redisStore = new Map<string, string>()
jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value)
      return Promise.resolve('OK')
    }),
    del: jest.fn((key: string) => {
      redisStore.delete(key)
      return Promise.resolve(1)
    }),
    eval: jest.fn((_script: string, _keys: number, key: string, windowMs: number) => {
      const next = (parseInt(redisStore.get(key) ?? '0', 10) || 0) + 1
      redisStore.set(key, String(next))
      // The mock models the atomic increment/expiry contract; no wall-clock
      // expiry is required for this bounded same-window suite.
      void windowMs
      return Promise.resolve(next)
    }),
    incr: jest.fn((key: string) => {
      const next = (parseInt(redisStore.get(key) ?? '0', 10) || 0) + 1
      redisStore.set(key, String(next))
      return Promise.resolve(next)
    }),
    pexpire: jest.fn(() => Promise.resolve(1)),
    pttl: jest.fn(() => Promise.resolve(60000)),
  },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: { start: jest.fn(), stop: jest.fn(), get: jest.fn(), getStatus: jest.fn() },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

// @arkade-os/sdk's CJS build still transitively requires @scure/btc-signer,
// which ships pure ESM (no CJS build) — same "Unexpected token 'export'"
// problem as @tetherto/wdk-wallet-evm above, same fix. None of these tests
// exercise lightning-hodl.provider.ts's real Arkade calls.
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))

// lightning-hodl.provider.ts's Phase 2 addition imports @scure/btc-signer
// directly (pure ESM, same reason @arkade-os/sdk itself is mocked above)
// — this test never reaches those code paths, a bare stub is enough.
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildApp } = require('../src/app')

describe('Rate limiting (@fastify/rate-limit, RATE_LIMIT_MAX=5, RATE_LIMIT_AUTH_MAX=2 for this suite)', () => {
  jest.setTimeout(30_000) // defensive margin retained; this suite no longer registers @fastify/swagger-ui (Technical Debt #57 bounded remediation)

  let app: FastifyInstance

  beforeAll(async () => {
    // Technical Debt #57 bounded remediation — rate-limit behavior only, never /docs.
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('allows requests under the auth-specific limit on /v1/identity/challenge', async () => {
    const res1 = await app.inject({ method: 'POST', url: '/v1/identity/challenge', payload: { publicKey: 'a'.repeat(64) } })
    expect(res1.statusCode).toBe(200)
  })

  it('returns a real 429 (not a flattened 500) once the auth-specific limit (2/window) is exceeded', async () => {
    // redis-rate-limit.ts's shared preHandler keys by route pattern + IP
    // (not just tier + IP) — it does not pool /challenge and
    // /authenticate into one shared budget, same independent-per-route
    // tracking the old @fastify/rate-limit local-store config had before
    // Missão 08B moved this tier to Redis. So this exercises /challenge's
    // own counter: the previous test already used 1 of its 2 allowed
    // requests; one more should still succeed, the third should be
    // rejected with the app's own error shape, not a generic 500 (a
    // real bug found and fixed in app.ts's error handler while writing
    // this test — it previously flattened every non-ZodError/non-AppError
    // to 500 regardless of the underlying error's own statusCode).
    const res2 = await app.inject({ method: 'POST', url: '/v1/identity/challenge', payload: { publicKey: 'b'.repeat(64) } })
    expect(res2.statusCode).toBe(200)

    const res3 = await app.inject({ method: 'POST', url: '/v1/identity/challenge', payload: { publicKey: 'c'.repeat(64) } })
    expect(res3.statusCode).toBe(429)
    const body = JSON.parse(res3.body)
    expect(body.success).toBe(false)
    expect(body.error).toBe('RATE_LIMIT_EXCEEDED')
    expect(body.message).toMatch(/rate limit/i)
  })

  it('/v1/identity/authenticate has its own independent 2-request budget, unaffected by /challenge being exhausted', async () => {
    const res1 = await app.inject({ method: 'POST', url: '/v1/identity/authenticate', payload: { publicKey: 'd'.repeat(64), signature: 'x' } })
    expect(res1.statusCode).toBe(401) // real auth failure, not rate-limited — /challenge's exhaustion above doesn't leak here

    const res2 = await app.inject({ method: 'POST', url: '/v1/identity/authenticate', payload: { publicKey: 'e'.repeat(64), signature: 'x' } })
    expect(res2.statusCode).toBe(401)

    const res3 = await app.inject({ method: 'POST', url: '/v1/identity/authenticate', payload: { publicKey: 'f'.repeat(64), signature: 'x' } })
    expect(res3.statusCode).toBe(429) // now its own 2-request budget is exhausted
  })

  it('uses a single atomic Redis EVAL per auth request instead of INCR followed by PEXPIRE', async () => {
    const { redis } = require('../src/common/redis')
    const evalSpy = redis.eval as jest.Mock
    const incrSpy = redis.incr as jest.Mock
    const expireSpy = redis.pexpire as jest.Mock
    const before = evalSpy.mock.calls.length
    await app.inject({ method: 'POST', url: '/v1/identity/challenge', payload: { publicKey: 'z'.repeat(64) } })
    expect(evalSpy.mock.calls.length).toBe(before + 1)
    const [script, numKeys, key, windowMs] = evalSpy.mock.calls[before]
    expect(script).toContain("redis.call('INCR', KEYS[1])")
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])")
    expect(numKeys).toBe(1)
    expect(key).toContain('ratelimit:')
    expect(windowMs).toBe(60000)
    expect(incrSpy).not.toHaveBeenCalled()
    expect(expireSpy).not.toHaveBeenCalled()
  })

  it('leaves a non-auth route on the more permissive global limit, unaffected by the auth tier being exhausted', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })
})
