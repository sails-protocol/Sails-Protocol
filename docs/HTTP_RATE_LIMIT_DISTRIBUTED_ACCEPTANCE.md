# HTTP rate limiting — distributed acceptance gate (#307)

Status: **RED for multi-instance production acceptance** (2026-10-21). This document records a verified implementation boundary; it is not a claim that edge or deployment controls exist.

## Verified from source

- `src/app.ts` registers `@fastify/rate-limit` with `global: true`, `max: config.rateLimit.max`, `timeWindow: config.rateLimit.timeWindow`, and **no Redis/shared store**. Its default counter is local to each Node.js process. A request stream balanced across N instances can consume independent per-instance budgets. A 3/3 CI-green result does not change that behavior.
- `src/common/middleware/redis-rate-limit.ts` separately protects auth/critical preHandlers using a Redis Lua `EVAL` with `INCR` and conditional `PEXPIRE`. It fails closed on Redis errors and has real-Redis concurrency/TTL tests. **This is not the global limiter.**
- `Fastify({ ... })` in `src/app.ts` does not configure `trustProxy`. Behind a reverse proxy, `request.ip` may be the proxy address. Enabling `trustProxy: true` without a trusted hop/CIDR policy would allow client-supplied forwarding headers to influence the rate-limit key.

## Production gate — required evidence (not yet satisfied)

1. **Trusted client-IP chain:** document actual LB/reverse-proxy topology, the only trusted hop(s)/CIDRs, header sanitization, and whether direct access to application instances is blocked. Prove spoofed `X-Forwarded-For` from an untrusted client does not change `request.ip` or the effective quota. Test IPv4, IPv6 and multi-hop forwarding.
2. **Aggregate HTTP quota:** choose and implement one explicit policy: a Redis-backed global Fastify store **or** a verified shared edge rate limiter. Define the aggregation key, per-route exclusions, window semantics, failure mode, and how it composes with auth/critical Redis limits. Do not silently change the current API limits.
3. **Two-instance proof:** run two independent app processes behind the intended proxy, distribute requests across both, and show the aggregate ceiling is enforced. Include burst/concurrency, retry/expiry, Redis/edge outage, and IP-spoof cases. A unit test with one Fastify instance is insufficient.
4. **Operational acceptance:** record production-equivalent TLS/proxy behavior, observability, limits, rollback plan and an explicit security-owner sign-off. Do not infer these from CI or local Redis tests.

## Decision boundary

No generic `trustProxy: true` patch, no pretend-global quota, and no production authorization without the topology and evidence above. Until then: **global multi-instance HTTP rate limiting RED; Gate 2 RED**. The draft PR remains unmerged.
