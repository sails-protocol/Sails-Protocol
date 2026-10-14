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

## Low-intensity real-service correctness gate

Run `node load-tests/native/run.js smoke` against a **fresh isolated local backend** with PostgreSQL and Redis. It creates one Ed25519 identity using the current registration PoP challenge, authenticates, creates and cancels one intent, obtains a fresh single-use WS ticket and requires a PONG. It reuses the same session across HTTP and WS, so it normally consumes only **four** shared auth-tier calls instead of creating a second user. It still may encounter other rate limits or domain constraints; never mask failures. This is a functional smoke test, **not a throughput benchmark** and does not yet prove Artillery replacement parity.

## Parity audit after real-service smoke (2026-10-14)

Evidence: PR #472 exact HEAD `493d67be57847d5c02ccb3df4f6f7e09331b044b`, workflow **Native load harness candidate verification** run **38605416486**, job **candidate**, step **Real-service smoke with disposable PostgreSQL and Redis**: SUCCESS. The independent **CI Tests** run **38605416603** also succeeded. This proves one real backend identity, intent create/delete and WebSocket PING/PONG with disposable PostgreSQL/Redis, not a throughput or sustained-load claim.

| Original Artillery coverage | Native candidate | Gate |
| --- | --- | --- |
| HTTP warm-up 20 s × 5 arrivals/s, sustained 30 s × 20/s | `intent` has matching phases | Shape configured; sustained run not executed |
| Fresh Ed25519 challenge-response identity per HTTP arrival | `authenticate()` signs registration and login challenges | One identity verified in smoke; bulk auth rate limit blocks default load |
| POST /v1/intents 201 and DELETE /v1/intents/:id 200 | `intent()` asserts status and returned ID | Verified in smoke |
| WS warm-up 20 s × 5/s, sustained 30 s × 15/s | `ws` has matching phases | Shape configured; sustained run not executed |
| Pre-authenticated WS pool and PING | `prep` creates real sessions; `websocket()` uses one-time ticket and requires PONG | Single connection verified; pool and concurrency unverified |
| Artillery HTTP/WS engine reports | Native counts, p50/p95/p99, bounded in-flight | Not statistically compared on equivalent runs |

**Explicit blocker:** `RATE_LIMIT_AUTH_MAX=10` / 60 s is a shared Redis-backed limit. The 5/s and 20/s fresh-identity phases cannot be considered application throughput at default security settings. Do not bypass or silently raise limits. For a future dedicated, disposable load benchmark, CTO must explicitly approve the isolated test policy, target capacity, run budget, and treatment of expected HTTP 429 responses. Run the original Artillery and native candidate under equivalent approved conditions; collect request and connection success rates, errors, latency percentiles, arrival throughput, CPU/memory, and Redis/Postgres telemetry. Compare actual results and failure modes before any package removal. Keep the independent k6 suite unchanged.

**Security guard:** native targets must remain loopback. Never commit `load-tests/native/users.json` (contains bearer tokens), upload it as a CI artifact, or log session tokens. The smoke CI does not run `prep` and does not create that file. The candidate does not replace Artillery until sustained parity is demonstrated.

## Exact-head gate update (2026-10-14)

PR #472 HEAD `636e7b4e03519dcf02fe394f9ffa58c176db3108` passed both independent workflows: **Native load harness candidate verification** run `38616526024` and **CI Tests** run `38616526259` (conclusion: success). This includes the real-service smoke and the session-pool permission, schema and symlink guards. The harness also now counts rejected overload arrivals in `issued` and enforces `issued === scheduled arrivals` and `succeeded + failed === issued` before publishing phase metrics. These checks validate accounting logic, **not** a sustained benchmark.

**Benchmark decision gate (not yet authorized):** record in the issue/PR an explicit approval naming (1) disposable isolated environment and local target, (2) permissible request/connection budget and duration, (3) auth/WS ticket rate-limit policy without weakening production, (4) equivalent Artillery/native configurations, (5) pass/fail thresholds for success, 429 classification, p50/p95/p99, throughput and resource use, and (6) evidence retention/redaction for bearer sessions. Until then, do not run sustained phases, remove Artillery, or claim parity. A 429 from an intentional security limit is classified as a protection event, not automatically a performance defect.

## CTO-approved bounded rehearsal evidence (2026-10-14)

Exact HEAD `6bf6158865caa4f9ec84b1aff5dc538267af84b5`, workflow run `38622816063`, job `116054358932`: **success**; independent CI Tests run `38622816429`: **success**. The disposable PostgreSQL 16 / Redis 7 job ran real-service smoke and `bench-small` without modifying the production security policy.

| Scenario | Issued | Success | Failed | p50 | p95 | p99 | Max in-flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Isolated HTTP intent create/delete | 2 | 2 | 0 | 27.2 ms | 31.5 ms | 31.5 ms | 1 |
| Isolated WS ticket/PING/PONG | 2 | 2 | 0 | 4.1 ms | 17.6 ms | 17.6 ms | 1 |

These are **two observations per scenario**, not statistically meaningful percentiles or a sustained parity result. They do not measure Artillery performance, production capacity or scalability. No Artillery dependency was removed. Next: perform equivalent, explicitly bounded comparisons in the disposable environment while preserving security limits and documenting intentional HTTP 429 behavior. Never silently widen rate limits or interpret this 4/4 rehearsal as throughput certification.
