import type { FastifyRequest } from 'fastify'
import { createSharedRateLimit, SHARED_RATE_LIMIT_SCRIPT } from '../src/common/middleware/redis-rate-limit'
import { RateLimitExceededError, RateLimitUnavailableError } from '../src/common/errors'

const evalMock = jest.fn()
const pttlMock = jest.fn()
jest.mock('../src/common/redis', () => ({
  redis: { eval: (...args: unknown[]) => evalMock(...args), pttl: (...args: unknown[]) => pttlMock(...args) },
}))

const limiter = createSharedRateLimit({ max: 2, windowMs: 60000, keyPrefix: 'auth' })
const request = () => ({
  routeOptions: { url: '/v1/identity/challenge' },
  url: '/v1/identity/challenge',
  ip: '127.0.0.1',
  log: { error: jest.fn() },
}) as unknown as FastifyRequest

describe('shared rate limit — Redis failure and rejection contract', () => {
  beforeEach(() => { evalMock.mockReset(); pttlMock.mockReset() })

  it.each([
    { max: 0, windowMs: 60000, keyPrefix: 'auth' },
    { max: 1.5, windowMs: 60000, keyPrefix: 'auth' },
    { max: 2, windowMs: 0, keyPrefix: 'auth' },
    { max: 2, windowMs: NaN, keyPrefix: 'auth' },
    { max: 2, windowMs: 60000, keyPrefix: '' },
    { max: 2, windowMs: 60000, keyPrefix: 'auth:other' },
  ])('rejects invalid shared limiter configuration %p before serving traffic', opts => {
    expect(() => createSharedRateLimit(opts)).toThrow('Invalid shared rate limit configuration')
  })

  it('fails closed without creating unbounded keys when the canonical route is missing', async () => {
    const req = request()
    ;(req.routeOptions as { url?: string }).url = undefined
    await expect(limiter(req)).rejects.toBeInstanceOf(RateLimitUnavailableError)
    expect(evalMock).not.toHaveBeenCalled()
  })

  it('uses the canonical route rather than attacker-controlled query strings for the Redis key', async () => {
    evalMock.mockResolvedValue(1)
    const req = request()
    Object.defineProperty(req, 'url', { value: '/v1/identity/challenge?nonce=attacker-controlled' })
    await expect(limiter(req)).resolves.toBeUndefined()
    expect(evalMock).toHaveBeenCalledWith(
      SHARED_RATE_LIMIT_SCRIPT, 1, 'ratelimit:auth:/v1/identity/challenge:127.0.0.1', 60000,
    )
  })

  it('fails closed with 503 when atomic Redis operation rejects', async () => {
    evalMock.mockRejectedValueOnce(new Error('Redis disconnected'))
    await expect(limiter(request())).rejects.toBeInstanceOf(RateLimitUnavailableError)
    expect(evalMock).toHaveBeenCalledWith(SHARED_RATE_LIMIT_SCRIPT, 1, 'ratelimit:auth:/v1/identity/challenge:127.0.0.1', 60000)
  })

  it.each([NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('fails closed for invalid counter %s', async value => {
    evalMock.mockResolvedValueOnce(value)
    await expect(limiter(request())).rejects.toBeInstanceOf(RateLimitUnavailableError)
  })

  it('isolates distinct canonical routes even when the client IP is the same', async () => {
    evalMock.mockResolvedValue(1)
    const challenge = request()
    const authenticate = request()
    ;(authenticate.routeOptions as { url?: string }).url = '/v1/identity/authenticate'
    await expect(limiter(challenge)).resolves.toBeUndefined()
    await expect(limiter(authenticate)).resolves.toBeUndefined()
    expect(evalMock).toHaveBeenNthCalledWith(1, SHARED_RATE_LIMIT_SCRIPT, 1,
      'ratelimit:auth:/v1/identity/challenge:127.0.0.1', 60000)
    expect(evalMock).toHaveBeenNthCalledWith(2, SHARED_RATE_LIMIT_SCRIPT, 1,
      'ratelimit:auth:/v1/identity/authenticate:127.0.0.1', 60000)
  })

  it('isolates auth and critical namespaces for the same route and IP', async () => {
    evalMock.mockResolvedValue(1)
    const critical = createSharedRateLimit({ max: 2, windowMs: 60000, keyPrefix: 'critical' })
    await expect(limiter(request())).resolves.toBeUndefined()
    await expect(critical(request())).resolves.toBeUndefined()
    expect(evalMock).toHaveBeenNthCalledWith(2, SHARED_RATE_LIMIT_SCRIPT, 1,
      'ratelimit:critical:/v1/identity/challenge:127.0.0.1', 60000)
  })

  it('allows the limit and rejects the next request with 429', async () => {
    evalMock.mockResolvedValueOnce(2).mockResolvedValueOnce(3)
    pttlMock.mockResolvedValueOnce(1500)
    await expect(limiter(request())).resolves.toBeUndefined()
    await expect(limiter(request())).rejects.toBeInstanceOf(RateLimitExceededError)
    expect(pttlMock).toHaveBeenCalledTimes(1)
  })

  it('still rejects above the limit if the TTL lookup fails', async () => {
    evalMock.mockResolvedValueOnce(3)
    pttlMock.mockRejectedValueOnce(new Error('Redis PTTL unavailable'))
    await expect(limiter(request())).rejects.toBeInstanceOf(RateLimitExceededError)
  })
})
