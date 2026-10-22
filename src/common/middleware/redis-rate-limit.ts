/**
 * Shared (cross-instance) rate limiting — Missão 08B Fase 9.
 *
 * `@fastify/rate-limit` (registered globally in app.ts) only ever counts
 * within the process it's running in — fine for the global ceiling (an
 * abuse-volume signal, not a hard security boundary), but wrong for the
 * auth tier (credential-stuffing defense, RED_TEAM_REVIEW.md RT-002) and
 * the critical tier (dispute/arbitration/capability-revoke spam,
 * CTO_DUE_DILIGENCE_REPORT.md A-SEC-05): with N instances behind a load
 * balancer, an attacker gets N times the real budget for free, one
 * instance at a time.
 *
 * `@fastify/rate-limit`'s own `redis`/`store` options only exist at
 * plugin-registration scope, not per-route (confirmed by reading its
 * type definitions) — and an empirical probe registering the plugin
 * twice (once globally local, once scoped with a Redis store) showed the
 * second registration never isolates cleanly: the scoped route was
 * immediately 429'd on its first request and no Redis keys were ever
 * created, because `fastify-plugin`'s `fp()` wrapping the whole plugin
 * breaks the encapsulation a second registration would need. So this is
 * a small, purpose-built preHandler mirroring the plugin's own internal
 * `RedisStore`'s fixed-window semantics, but in one atomic Lua operation
 * so a crash between INCR and PEXPIRE cannot strand a non-expiring key.
 * This is not a general rate-limit framework, just the two
 * tiers that are an actual security boundary.
 *
 * Fail-closed on Redis errors (Fase 8's own route matrix): both tiers
 * this is applied to already hard-depend on Redis independent of rate
 * limiting (challenge/session lookups in common/middleware/auth.ts), so
 * rejecting here on a Redis outage introduces no new single point of
 * failure — those routes are already down in that scenario regardless.
 */
import type { FastifyRequest } from 'fastify'
import { redis } from '../redis'
import { RateLimitExceededError, RateLimitUnavailableError } from '../errors'

export interface SharedRateLimitOptions {
  max: number
  windowMs: number
  // Distinguishes the auth/critical counters from each other and from
  // anything else that might ever share this Redis instance.
  keyPrefix: string
}

export const SHARED_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`

export function createSharedRateLimit(opts: SharedRateLimitOptions) {
  if (!Number.isSafeInteger(opts.max) || opts.max < 1 ||
      !Number.isSafeInteger(opts.windowMs) || opts.windowMs < 1 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(opts.keyPrefix)) {
    throw new Error('Invalid shared rate limit configuration')
  }
  return async function sharedRateLimitPreHandler(req: FastifyRequest): Promise<void> {
    // Each route keeps its own independent budget, same as the
    // @fastify/rate-limit per-route `config.rateLimit` override this
    // replaces (app.ts's original comment: "/challenge and /authenticate
    // do NOT share one pooled counter, a deliberate simplification") —
    // the route *pattern* (not the interpolated URL, same anti-unbounded-
    // cardinality reasoning app.ts's own metrics hook already uses) is
    // part of the key, so one `createSharedRateLimit()` instance can
    // still be reused across several routes in the same tier (settlement/
    // capability/agent routes all share one `criticalRateLimit` const)
    // without pooling their budgets together.
    // Redis keys use the canonical route pattern, not URL parameters.
    // Reject a missing route pattern instead of falling back to req.url:
    // that fallback can include attacker-controlled query strings, causing
    // unbounded Redis key cardinality and bypassing the intended shared quota.
    if (!req.routeOptions.url) {
      req.log.error({ msg: 'Shared rate limiter missing canonical route pattern', keyPrefix: opts.keyPrefix })
      throw new RateLimitUnavailableError()
    }
    const key = `ratelimit:${opts.keyPrefix}:${req.routeOptions.url}:${req.ip}`

    let count: number
    try {
      count = Number(await redis.eval(SHARED_RATE_LIMIT_SCRIPT, 1, key, opts.windowMs))
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid Redis rate limit result')
    } catch (err) {
      req.log.error({
        msg: 'Shared Redis rate limiter unreachable — failing closed (Missão 08B Fase 8 route matrix decision)',
        keyPrefix: opts.keyPrefix,
        err: err instanceof Error ? err.message : String(err),
      })
      throw new RateLimitUnavailableError()
    }

    if (count > opts.max) {
      let retryAfterSeconds = Math.ceil(opts.windowMs / 1000)
      try {
        const ttlMs = await redis.pttl(key)
        if (ttlMs > 0) retryAfterSeconds = Math.ceil(ttlMs / 1000)
      } catch {
        // Best-effort only — the exceeded-limit rejection below doesn't
        // depend on knowing the exact retry-after value.
      }
      throw new RateLimitExceededError(retryAfterSeconds)
    }
  }
}
