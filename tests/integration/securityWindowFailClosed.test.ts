// tests/integration/securityWindowFailClosed.test.ts
//
// Master Backlog R6: a security window configured <= 0 (or malformed) must not silently turn its
// protection off. Every limiter and detector below counts in a window: the shared Redis tier
// (INCR, then PEXPIRE on the first hit) and the in-memory FixedWindowCounter tiers (WS messages,
// escrow circuit breaker, suspicious-activity detection). With a window <= 0 the counter restarts on
// every hit, so the limit is never reached: Redis deletes a key given a non-positive PEXPIRE, and
// FixedWindowCounter's window already lies in the past when it is created. Suspicious-activity
// detection fires only when count === max, and count starts at 1, so a max <= 0 never fires either.
//
// Each case boots a fresh module graph with the variable under test set, then drives the REAL
// consumer: the shared preHandler against real Redis, the real in-memory limiter, breaker and
// detector. Real Redis (the CI service / local dev Redis); no database.

const RESTORE: Record<string, string | undefined> = {}

function withEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    if (!(key in RESTORE)) RESTORE[key] = process.env[key]
    process.env[key] = value
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete RESTORE[key]
  }
})

/** Loads a fresh config graph under `env` and returns `load()`'s result, or the boot error. */
function boot<T>(env: Record<string, string>, load: () => T): T {
  withEnv(env)
  let out!: T
  jest.isolateModules(() => {
    jest.doMock('../../src/common/events/event-bus', () => ({ eventBus: { emit: jest.fn().mockResolvedValue(undefined) } }))
    out = load()
  })
  return out
}

const fakeLog = () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }) as any

// ─── shared Redis tier (auth + critical) ─────────────────────────────────────────────────────────────

async function hitsBeforeLimited(windowVar: 'RATE_LIMIT_AUTH_WINDOW_MS' | 'RATE_LIMIT_CRITICAL_WINDOW_MS', windowValue: string, attempts: number) {
  const { createSharedRateLimit, redis, windowMs } = boot({ [windowVar]: windowValue }, () => {
    const cfg = require('../../src/config').config
    return {
      createSharedRateLimit: require('../../src/common/middleware/redis-rate-limit').createSharedRateLimit,
      redis: require('../../src/common/redis').redis,
      windowMs: windowVar === 'RATE_LIMIT_AUTH_WINDOW_MS' ? cfg.rateLimit.authWindowMs : cfg.rateLimit.criticalWindowMs,
    }
  })
  const keyPrefix = `r6-${windowVar}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const preHandler = createSharedRateLimit({ max: 3, windowMs, keyPrefix })
  const req = { routeOptions: { url: '/r6' }, url: '/r6', ip: '203.0.113.7', log: fakeLog() } as any
  let allowed = 0
  try {
    for (let i = 0; i < attempts; i++) {
      try {
        await preHandler(req)
        allowed++
      } catch (err: any) {
        if (err?.constructor?.name !== 'RateLimitExceededError') throw err
      }
    }
  } finally {
    await redis.del(`ratelimit:${keyPrefix}:/r6:203.0.113.7`)
    await redis.quit()
  }
  return allowed
}

describe('R6 — security windows fail closed (real Redis, real consumers)', () => {
  jest.setTimeout(60_000)

  describe.each(['RATE_LIMIT_AUTH_WINDOW_MS', 'RATE_LIMIT_CRITICAL_WINDOW_MS'] as const)('%s (shared Redis tier)', (windowVar) => {
    it('T1/T9/T10: a valid window enforces max=3 — the 4th..10th hits are refused', async () => {
      expect(await hitsBeforeLimited(windowVar, '60000', 10)).toBe(3)
    })

    it.each(['0', '-1', '-60000'])('T2/T3/T15: window %p refuses to boot instead of letting every hit through', (value) => {
      expect(() => boot({ [windowVar]: value }, () => require('../../src/config'))).toThrow(new RegExp(`${windowVar} must be a positive integer`))
    })

    it.each(['1.5', '60000abc', '1e3', 'abc', '', '9007199254740993'])('T4/T5/T7: malformed window %p is rejected, not truncated or defaulted', (value) => {
      expect(() => boot({ [windowVar]: value }, () => require('../../src/config'))).toThrow(new RegExp(`${windowVar} must be a positive integer`))
    })
  })

  // ─── in-memory tiers ───────────────────────────────────────────────────────────────────────────────

  describe('RATE_LIMIT_WS_MESSAGE_WINDOW_MS (in-memory WS message tier)', () => {
    const allowedOf = (env: Record<string, string>, sends: number) => boot(env, () => {
      const { checkWsMessageRateLimit } = require('../../src/modules/open-p2p/ws-message-rate-limiter')
      let allowed = 0
      for (let i = 0; i < sends; i++) if (checkWsMessageRateLimit('participant-r6')) allowed++
      return allowed
    })

    it('T1: a valid window enforces the max', () => {
      expect(allowedOf({ RATE_LIMIT_WS_MESSAGE_MAX: '3', RATE_LIMIT_WS_MESSAGE_WINDOW_MS: '10000' }, 50)).toBe(3)
    })

    it.each(['0', '-1', '1.5', 'abc'])('T2-T5/T15: window %p refuses to boot instead of allowing unlimited messages', (value) => {
      expect(() => allowedOf({ RATE_LIMIT_WS_MESSAGE_MAX: '3', RATE_LIMIT_WS_MESSAGE_WINDOW_MS: value }, 50)).toThrow(/RATE_LIMIT_WS_MESSAGE_WINDOW_MS must be a positive integer/)
    })
  })

  describe('ESCROW_BREAKER_WINDOW_MS / ESCROW_BREAKER_COOLDOWN_MS (escrow circuit breaker)', () => {
    const tripsAfterConflicts = (env: Record<string, string>) => boot(env, () => {
      const breaker = require('../../src/modules/open-settlement/escrow-circuit-breaker')
      for (let i = 0; i < 20; i++) breaker.recordEscrowConflict('escrow-r6')
      try {
        breaker.assertCircuitClosed('escrow-r6')
        return false
      } catch {
        return true
      }
    })

    it('T1: valid window/cooldown — repeated conflicts open the circuit', () => {
      expect(tripsAfterConflicts({ ESCROW_BREAKER_FAILURE_THRESHOLD: '5', ESCROW_BREAKER_WINDOW_MS: '30000', ESCROW_BREAKER_COOLDOWN_MS: '120000' })).toBe(true)
    })

    it.each([
      ['ESCROW_BREAKER_WINDOW_MS', '0'],
      ['ESCROW_BREAKER_WINDOW_MS', '-1'],
      ['ESCROW_BREAKER_COOLDOWN_MS', '0'],
      ['ESCROW_BREAKER_COOLDOWN_MS', '-1'],
      ['ESCROW_BREAKER_COOLDOWN_MS', '1.5'],
    ])('T2-T5/T15: %s=%p refuses to boot instead of leaving the breaker unable to open', (name, value) => {
      const env = { ESCROW_BREAKER_FAILURE_THRESHOLD: '5', ESCROW_BREAKER_WINDOW_MS: '30000', ESCROW_BREAKER_COOLDOWN_MS: '120000', [name]: value }
      expect(() => tripsAfterConflicts(env)).toThrow(new RegExp(`${name} must be a positive integer`))
    })
  })

  describe('SUSPICIOUS_* (suspicious-activity detection)', () => {
    const detects = (env: Record<string, string>) => boot(env, () => {
      const { recordSuspiciousActivity } = require('../../src/common/security/suspicious-activity')
      const log = fakeLog()
      for (let i = 0; i < 50; i++) recordSuspiciousActivity('AUTH_FAILURE', 'ip-r6', log)
      return log.warn.mock.calls.length > 0
    })

    it('T1: valid threshold and window — a burst is detected', () => {
      expect(detects({ SUSPICIOUS_AUTH_FAILURE_MAX: '8', SUSPICIOUS_AUTH_FAILURE_WINDOW_MS: '300000' })).toBe(true)
    })

    it.each([
      ['SUSPICIOUS_AUTH_FAILURE_WINDOW_MS', '0'],
      ['SUSPICIOUS_AUTH_FAILURE_WINDOW_MS', '-1'],
      ['SUSPICIOUS_NOT_FOUND_WINDOW_MS', '0'],
      ['SUSPICIOUS_RATE_LIMITED_WINDOW_MS', '0'],
      ['SUSPICIOUS_AUTH_FAILURE_MAX', '0'],
      ['SUSPICIOUS_AUTH_FAILURE_MAX', '-3'],
      ['SUSPICIOUS_NOT_FOUND_MAX', '0'],
      ['SUSPICIOUS_RATE_LIMITED_MAX', '0'],
      ['SUSPICIOUS_AUTH_FAILURE_MAX', '8.5'],
    ])('T2-T5/T15: %s=%p refuses to boot instead of silently disabling detection', (name, value) => {
      const env = { SUSPICIOUS_AUTH_FAILURE_MAX: '8', SUSPICIOUS_AUTH_FAILURE_WINDOW_MS: '300000', [name]: value }
      expect(() => detects(env)).toThrow(new RegExp(`${name} must be a positive integer`))
    })
  })

  // ─── T6/T13/T14: missing values keep the documented, security-preserving defaults ──────────────────

  it('T6/T13: unset windows keep their documented positive defaults, in production too', () => {
    const names = [
      'RATE_LIMIT_AUTH_WINDOW_MS', 'RATE_LIMIT_CRITICAL_WINDOW_MS', 'RATE_LIMIT_WS_MESSAGE_WINDOW_MS',
      'ESCROW_BREAKER_WINDOW_MS', 'ESCROW_BREAKER_COOLDOWN_MS',
      'SUSPICIOUS_AUTH_FAILURE_MAX', 'SUSPICIOUS_AUTH_FAILURE_WINDOW_MS', 'SUSPICIOUS_NOT_FOUND_MAX',
      'SUSPICIOUS_NOT_FOUND_WINDOW_MS', 'SUSPICIOUS_RATE_LIMITED_MAX', 'SUSPICIOUS_RATE_LIMITED_WINDOW_MS',
    ]
    const saved = names.map((n) => [n, process.env[n]] as const)
    for (const n of names) delete process.env[n]
    try {
      const cfg = boot({}, () => require('../../src/config').config)
      expect(cfg.rateLimit.authWindowMs).toBe(60000)
      expect(cfg.rateLimit.criticalWindowMs).toBe(60000)
      expect(cfg.rateLimit.wsMessageWindowMs).toBe(10000)
      expect(cfg.escrowCircuitBreaker).toEqual({ failureThreshold: 5, windowMs: 30000, cooldownMs: 120000 })
      expect(cfg.suspiciousActivity).toEqual({
        authFailureMax: 8, authFailureWindowMs: 300000, notFoundClusterMax: 15,
        notFoundClusterWindowMs: 300000, rateLimitedMax: 3, rateLimitedWindowMs: 300000,
      })
    } finally {
      for (const [n, v] of saved) if (v !== undefined) process.env[n] = v
    }
  })
})
