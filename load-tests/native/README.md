# Native load harness: candidate only (PR #472)

This harness is **not approved for production use** and does not replace Artillery yet. The Artillery package and scripts remain unchanged. Never point load tests at public production endpoints.

## Exact security contracts

- Registration: `POST /v1/identity/register-challenge`, sign UTF-8 bytes of `sails-registration-proof-of-possession:v1:<challenge>:<displayName>`, then `POST /v1/identity/participants` with signature. This matches `registrationProofMessage()` in `src/common/middleware/auth.ts`.
- Login: sign UTF-8 challenge text from `/v1/identity/challenge`, authenticate, use Bearer session token for HTTP.
- WebSocket: exchange Bearer session for short-lived single-use ticket at `POST /v1/identity/ws-ticket`; connect to `/v1/openp2p/chat?ticket=...`, send `PING`, require `PONG`. Do not put raw session tokens in URLs.
- Each HTTP intent iteration registers and authenticates, creates a TradeIntent and cancels it; response codes and returned ID are asserted. WS pool is pre-authenticated, with a **fresh** ticket per connection.
- Expected arrivals: HTTP 20s × 5/s then 30s × 20/s; WS 20s × 5/s then 30s × 15/s. The cap `SAILS_LOAD_MAX_INFLIGHT` is a safety ceiling and counts overload as failure.

## Safe execution (dedicated disposable environment only)

1. Provision disposable isolated Postgres and Redis, with the exact target backend build. Confirm this is **not production**. The harness now **rejects non-loopback HTTP and WebSocket targets before issuing requests**; use a locally bound isolated service, not public staging or production URLs.
2. Verify registration rate limits are compatible with the requested arrival rates. **Never disable security controls to make a benchmark pass**; if limits are intentionally triggered, record the result and adjust the benchmark design with explicit CTO review.
3. Set `SAILS_LOAD_HTTP_TARGET` and `SAILS_LOAD_WS_TARGET` to the isolated backend. Run `node load-tests/native/run.js intent`, then `node load-tests/native/run.js prep 50`, then `node load-tests/native/run.js ws`. Pre-generated `users.json` contains bearer tokens: keep it out of Git, artifacts and logs, delete it after test.
4. Capture success/error counts, p50/p95/p99, throughput and service logs. Test negative paths: invalid registration proof, replayed WS ticket, expired session, server disconnect, invalid JSON, and overload.
5. Validate parity with original load scripts and run full unsuppressed `npm audit` at exact HEAD **after** a reviewed Artillery removal and lockfile regeneration. The #471 ephemeral audit reduction (34 → 30) is not evidence of functional parity or an approved fix.

**Known risk:** existing per-IP and shared identity rate limits may intentionally reject bulk identity registration; the native harness currently does not model these rate limits or isolate test users by independent network identities. A green syntax/build CI is not an end-to-end load-test pass. Do not merge or remove Artillery until the runtime gate passes.

## Confirmed rate-limit blocker (source-verified)

`src/config/index.ts` sets `RATE_LIMIT_AUTH_MAX=10` and `RATE_LIMIT_AUTH_WINDOW_MS=60000` by default. Registration challenge, registration, login challenge and authentication all use `authRateLimit`, a shared Redis-backed tier. Each fresh virtual user therefore consumes multiple auth-tier requests. The inherited Artillery arrival schedules (5/s then 20/s) will trigger the default security limit, even with a healthy backend. **Do not disable or bypass rate limiting to get a green benchmark.**

The current harness is a **functional candidate, not a validated load-test replacement**. To validate safely, first run a low-volume correctness rehearsal that respects the configured auth budget, then obtain an explicit, documented decision for a dedicated benchmark environment and its rate-limit policy. The sustained throughput test must not claim success under the default auth limit. WS sessions can be pre-generated gradually within the limit and then exercised using single-use WS tickets; ticket minting itself has its own security and operational limits to validate. A run returning 429 is a meaningful protection result, not evidence that the load generator is broken.
