/** Real Redis proof of shared HTTP auth/critical counter semantics. No mocks. */
import { randomBytes } from 'crypto'
import Redis from 'ioredis'
import { SHARED_RATE_LIMIT_SCRIPT } from '../../src/common/middleware/redis-rate-limit'

jest.setTimeout(30_000)

describe('shared rate limit — real Redis atomicity and expiry', () => {
  let redis: Redis
  const keys: string[] = []
  const run = async (key: string, windowMs: number): Promise<number> =>
    Number(await redis.eval(SHARED_RATE_LIMIT_SCRIPT, 1, key, windowMs))

  beforeAll(async () => {
    // Only connect to a dedicated, explicitly authorized integration Redis.
    if (process.env.SAILS_INTEGRATION_TEST_REDIS_CONFIRMED !== 'yes-i-am-sure') {
      throw new Error('Real Redis integration requires SAILS_INTEGRATION_TEST_REDIS_CONFIRMED=yes-i-am-sure')
    }
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL must be explicitly configured for integration tests')
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\\[|\\]$/g, '').toLowerCase()
    const allowed = new Set(['localhost', '127.0.0.1', '::1', ...(process.env.SAILS_TEST_REDIS_EXTRA_HOSTS ?? '').split(',').map(x => x.trim()).filter(Boolean)])
    if (!allowed.has(host)) throw new Error('Redis integration host is not allowlisted')
    redis = new Redis(url, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1 })
    await redis.connect()
    await redis.ping()
  })

  afterAll(async () => {
    if (redis) {
      if (keys.length) await redis.del(...keys)
      redis.disconnect()
    }
  })

  const key = (suffix: string): string => {
    const value = 'test:ratelimit:atomic:' + randomBytes(16).toString('hex') + ':' + suffix
    keys.push(value)
    return value
  }

  it('enforces one shared count across concurrent Redis clients', async () => {
    const k = key('parallel')
    const second = redis.duplicate({ lazyConnect: true })
    try {
      await second.connect()
      const operations = Array.from({ length: 120 }, (_, i) =>
        (i % 2 === 0 ? redis : second).eval(SHARED_RATE_LIMIT_SCRIPT, 1, k, 2000).then(Number),
      )
      const results = await Promise.all(operations)
      expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
      const ttl = await redis.pttl(k)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(2000)
    } finally {
      second.disconnect()
    }
  })

  it('repairs a legacy non-expiring counter without resetting its count', async () => {
    const k = key('legacy')
    await redis.set(k, '4')
    expect(await redis.pttl(k)).toBe(-1)
    expect(await run(k, 2000)).toBe(5)
    expect(await redis.pttl(k)).toBeGreaterThan(0)
  })

  it('does not extend a live fixed window on subsequent requests', async () => {
    const k = key('fixed-window')
    expect(await run(k, 2000)).toBe(1)
    const firstTtl = await redis.pttl(k)
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(await run(k, 2000)).toBe(2)
    const nextTtl = await redis.pttl(k)
    expect(nextTtl).toBeGreaterThan(0)
    expect(nextTtl).toBeLessThan(firstTtl - 90)
  })

  it('isolates distinct keys and does not pool independent route budgets', async () => {
    const a = key('challenge')
    const b = key('authenticate')
    expect(await run(a, 2000)).toBe(1)
    expect(await run(a, 2000)).toBe(2)
    expect(await run(b, 2000)).toBe(1)
    expect(await redis.get(a)).toBe('2')
    expect(await redis.get(b)).toBe('1')
  })

  it('rejects a poisoned non-integer counter without silently resetting the key', async () => {
    const k = key('poisoned')
    await redis.set(k, 'invalid', 'PX', 2000)
    await expect(run(k, 2000)).rejects.toThrow()
    expect(await redis.get(k)).toBe('invalid')
    expect(await redis.pttl(k)).toBeGreaterThan(0)
  })

  it('rejects a Redis counter containing a fractional value without changing its value or TTL', async () => {
    const k = key('fractional-poison')
    await redis.set(k, '1.5', 'PX', 2000)
    const ttlBefore = await redis.pttl(k)
    await expect(run(k, 2000)).rejects.toThrow()
    expect(await redis.get(k)).toBe('1.5')
    const ttlAfter = await redis.pttl(k)
    expect(ttlAfter).toBeGreaterThan(0)
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore)
  })

  it('rejects a Redis counter containing a nonnumeric string without creating a fresh window', async () => {
    const k = key('poison-no-ttl')
    await redis.set(k, 'not-a-counter')
    await expect(run(k, 2000)).rejects.toThrow()
    expect(await redis.get(k)).toBe('not-a-counter')
    expect(await redis.pttl(k)).toBe(-1)
  })

  it('keeps the original window after concurrent requests and rejects a later overflow', async () => {
    const k = key('overflow')
    const values = await Promise.all(Array.from({ length: 20 }, () => run(k, 2000)))
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await run(k, 2000)).toBe(21)
    const ttl = await redis.pttl(k)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(2000)
  })

  it('fails closed at the signed Redis integer boundary without wrapping the counter', async () => {
    const k = key('integer-overflow')
    const maxSigned64 = '9223372036854775807'
    await redis.set(k, maxSigned64, 'PX', 2000)
    await expect(redis.eval(SHARED_RATE_LIMIT_SCRIPT, 1, k, 2000)).rejects.toThrow()
    expect(await redis.get(k)).toBe(maxSigned64)
    expect(await redis.pttl(k)).toBeGreaterThan(0)
  })

  it('expires the fixed window and starts a new count', async () => {
    const k = key('expiry')
    expect(await run(k, 120)).toBe(1)
    expect(await run(k, 120)).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await run(k, 120)).toBe(1)
  })
})
