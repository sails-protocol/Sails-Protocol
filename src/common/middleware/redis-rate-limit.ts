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
 * `RedisStore`'s atomic pattern (INCR, then PEXPIRE only on the first
 * hit in a window) — not a general rate-limit framework, just the two
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

export function createSharedRateLimit(opts: SharedRateLimitOptions) {
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
    const route = req.routeOptions.url ?? req.url
    const key = `ratelimit:${opts.keyPrefix}:${route}:${req.ip}`

    let count: number
    try {
      count = await redis.incr(key)
      // Only the request that creates the key sets its expiry — every
      // later INCR within the window just increments the same counter,
      // same one-PEXPIRE-per-window shape as @fastify/rate-limit's own
      // internal RedisStore.js.
      if (count === 1) {
        await redis.pexpire(key, opts.windowMs)
      }
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


/**
 * Atomically consumes several shared budgets for one authenticated
 * operation. All keys are incremented in one Lua execution so concurrent
 * app instances cannot split an attempt across the uploader+Proof and
 * uploader-transversal budgets.
 *
 * An attempt counts against every supplied budget even when one of them
 * crosses its limit. This matches #267 Policy V1's "attempts" semantics:
 * rejected abuse must not become free traffic on the other dimension.
 */
export async function consumeSharedRateLimitKeys(
  req: FastifyRequest,
  budgets: Array<{ key: string; max: number; windowMs: number }>
): Promise<void> {
  if (budgets.length === 0) return

  const script = `
    local exceeded = 0
    local retry_after = 0
    for i = 1, #KEYS do
      local count = redis.call('INCR', KEYS[i])
      if count == 1 then
        redis.call('PEXPIRE', KEYS[i], ARGV[(i - 1) * 2 + 2])
      end
      local max = tonumber(ARGV[(i - 1) * 2 + 1])
      if count > max then
        exceeded = 1
        local ttl = redis.call('PTTL', KEYS[i])
        if ttl > retry_after then retry_after = ttl end
      end
    end
    return { exceeded, retry_after }
  `

  let result: unknown
  try {
    const keys = budgets.map((b) => b.key)
    const args = budgets.flatMap((b) => [String(b.max), String(b.windowMs)])
    result = await redis.eval(script, keys.length, ...keys, ...args)
  } catch (err) {
    req.log.error({
      msg: 'Shared Redis multi-budget rate limiter unreachable — failing closed',
      err: err instanceof Error ? err.message : String(err),
    })
    throw new RateLimitUnavailableError()
  }

  const tuple = result as [number, number]
  if (Number(tuple[0]) === 1) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Number(tuple[1]) / 1000))
    throw new RateLimitExceededError(retryAfterSeconds)
  }
}
