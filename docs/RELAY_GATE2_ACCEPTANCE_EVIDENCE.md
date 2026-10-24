# Gate 2 — WebSocket Relay: evidence and acceptance boundary

Status: **NOT HOMOLOGATED / BLOCKED**. This document records evidence, not authorization to merge or deploy.

## Current CI restoration (2026-10-23)

Commit `34e1290b3f12f1c3f99f847b05e7b4ae16bcd597`:
- CI run 39956617699 — success.
- CI Tests run 39956617662 — success.
- CodeQL run 39956617843 — success.
- Previous `b2fc2c8` failed the two test-bearing workflows: 1 failed test in `tests/relayRedisIntegration.test.ts`, Redis Lua `attempt to compare nil with number` in the presence fencing test.
- `6591c93` made both claim and renew scripts reject missing/malformed deadline arguments without mutating the Redis lease; `34e1290` added a real Redis regression for both paths.
- This is CI restoration evidence, **not** Gate 2 homologation, proof of production WSS ingress, or cross-instance delivery.
- Jest also reported a worker teardown warning in the prior failed run; do not silently treat that warning as independently remediated by the lease fix.

## Verified CI evidence

Commit `bcef9979e0b5c7404879641acf8b7674945a19d6` (WSS through local TLS-terminating reverse proxy; HTTP upgrade CRLF fix):
- CI run 39777714112 — success.
- CI Tests run 39777714135 — success.
- CodeQL run 39777714138 — success.
- Test terminates TLS at a local HTTPS proxy, forwards the HTTP WebSocket upgrade over TCP to Fastify, and establishes an authenticated relay socket using a test-specific trusted self-signed certificate.
- Previous commit `aa5a1cd08b60a9392332a4cf68d4dbefcba91a9a` failed CI and CI Tests (HTTP 400 from incorrectly encoded CRLF in test proxy); `bcef997` corrects that defect. **The passing test does not validate the deployed reverse proxy, its configuration, public certificate chain, or production ingress path.**


Commit `8a7016e22775752100581d06c1c6bca7bb4c9704` (authenticated WSS/TLS integration test):
- CI run 39714388152 — success.
- CI Tests run 39714388072 — success.
- CodeQL run 39714388097 — success.
- Test opens a real `wss://` connection to a Fastify HTTPS listener with an ephemeral self-signed certificate and a mocked ticket resolver. Client certificate verification is disabled only in this test. **This is not reverse-proxy, public CA, or production deployment evidence.**

Commit `caaab99661c9803ec370a9c2068f2a28741d54c1` (invalid ticket rejection):
- CI run 39710444369 — success.
- CI Tests run 39710444361 — success.
- CodeQL run 39710444362 — success.


Commit `d88c8f242d1a2e4670f042536d648c867c263b6d` (Docker CI evidence):
- CI run 39542349709 — success.
- CI Tests run 39542349739 — success.
- CodeQL run 39542349831 — success.


Commit `b5b21da896e3be25cc85945c6c43affe0935ecea` (cross-instance acceptance evidence):
- CI run 39537273466 — success, including Docker integration stage.
- CI Tests run 39537273539 — success.
- CodeQL run 39537273564 — success.


Commit `8dd8b43b59ce2d10c06df1d1cd58642f26c33b35` (two isolated provider instances regression):
- CI run 39535744403 — success.
- CI Tests run 39535744397 — success.
- CodeQL run 39535744400 — success.
- Test proves a socket owned by provider B cannot be reached from provider A, and A reports failed delivery instead of false success. **This is negative evidence, not a distributed delivery implementation.**

Commit `d228e4d16289647b9ffdff2a46d6647a069d869d` (process-local routing boundary comments):
- CI run 39532326558 — success.
- CI Tests run 39532326486 — success.
- CodeQL run 39532326546 — success.

Commit `12a5a8165317abe1e78aee4042f85b8cebba5db6` (acceptance evidence refresh):
- CI run 39528609433 — success.
- CI Tests run 39528609487 — success.
- CodeQL run 39528609403 — success.

Commit `b7cd3009c52fb0bed1a56440b0c18c869a2dbc41` (unsupported DHT regression test):
- CI run 39526515698 — success.
- CI Tests run 39526515717 — success.
- CodeQL run 39526515699 — success.


Commit `f50dceab07b7b58e10dafa3a0f32d6d9382584e8` (relay status and test isolation):
- CI run 39419686876 — success.
- CI Tests run 39419686823 — success.
- CodeQL run 39419686796 — success.


Commit `677997e519e336069868756c718635054a2ffab9`:
- CI run 39412585711 — success.
- CI Tests run 39412585739 — success.
- CodeQL run 39412585764 — success.

Previous integration baseline: commit `152bfed9a93c7635364187e5b566a5ea19d547be` passed CI 39409292107, CI Tests 39409292139, and CodeQL 39409292202.

Earlier baseline: commit `31182b7ea036862ff0faf08c842d8dcecb68011b` passed CI 39360572901, CI Tests 39360572929, and CodeQL 39360572904.

## Tested capabilities and limitations

- `tests/relayProviderLiveDelivery.test.ts`: real relay provider, two real TCP WebSocket clients, opaque Alice-to-Bob delivery and disconnect handling; ticket resolver and Redis budget **mocked**. Regression test asserts unsupported relay `joinTopic()` rejects explicitly and `broadcast()` returns zero.
- `tests/relayLiveWebSocket.test.ts`: real TCP route with **mocked** provider, including frame boundaries and reconnect behavior.
- `tests/relayRedisIntegration.test.ts`: real Redis-backed single-use ticket resolution, concurrent/replayed ticket races and shared budget, including multi-process and multiple listener cases. The latest integration test exercises production `identityRoutes` HTTP ticket issuance with production `requireAuth` for two authenticated participants, real Redis ticket storage/consumption, two real TCP WebSocket clients, and opaque provider delivery from Alice to Bob **in one test**. Redis calls are forwarded to a disposable integration Redis client via Jest spies; the test is therefore instrumented, not a fully unmocked deployment-equivalent E2E scenario.
- `tests/pearRoutes.test.ts`: verifies `POST /v1/peers/start` reports Pears versus WebSocket relay capabilities and `GET /v1/peers/status` reports connected/disconnected relay states without reading Pears registry state. Auth, transport selection and connection state are mocked for these route-level tests. A previous CI failure caused by a mock transport state leaking between tests was fixed by resetting the mock in `beforeEach`; commit `f50dcea` is green.

## Isolated Redis Pub/Sub candidate — evidence boundary (2026-10-23)

The candidate branch now contains `relay-delivery-command.ts`, `relay-delivery-destination.ts`,
`relay-delivery-ack.ts`, `relay-delivery-pending.ts`, `relay-delivery-origin.ts`, and
`relay-delivery-redis.ts`. These implement a bounded request/ACK protocol and an
**isolated, not route-wired** Redis Pub/Sub adapter. This is implementation evidence,
not a completed cross-instance capability.

- Exact commit `097f827296b9f15f4cc1c4855b9b7aef4ad81558`:
  CI `40036921690`, CI Tests `40036921669`, CodeQL `40036921670` all succeeded.
- `tests/relayDeliveryRedis.test.ts` uses an in-memory RedisBus mock with separate
  provider instances. It does **not** prove Redis networking or process isolation.
- `tests/relayDeliveryRedis.integration.test.ts` uses four independent ioredis TCP
  connections **only when** `RELAY_REDIS_INTEGRATION_URL` is set. Without it,
  Jest skips this suite. Passing the default CI therefore does **not** prove
  the real-Redis integration ran. This suite still runs in one OS process.
- The current presence value stores a connection lease token, not a server
  instance/channel identifier. No authoritative, atomic owner-channel lookup
  connects presence to the adapter.
- Pub/Sub channel naming is validated syntactically but sender authorization,
  channel ACLs and authenticated reply provenance are not established. A
  valid-looking channel name is not a trust boundary.
- The adapter has no production lifecycle wiring and no two-process Redis
  acceptance evidence. A positive ACK means only that the destination
  attempted an OPEN local socket send without a synchronous exception;
  it is not proof of client receipt.
- The implementation's `start()` / `close()` races, subscription reconnect
  semantics, forged ACKs, duplicate commands and backpressure require
  adversarial review and real-boundary tests before enabling it.

**Decision frontier / STOP:** Do not enable this adapter in `relay.routes.ts`
or advertise distributed delivery until the responsible architecture owner
defines the trusted instance identity, channel authorization and presence
routing contract. Record the chosen topology and acceptance tests through
the existing governance process. This STOP does not invalidate isolated
prototype work, but prohibits silently treating it as production routing.

## Cross-instance delivery acceptance contract (not yet satisfied)

A Redis presence lease is a routing hint only. An ACK for publishing to Redis, an enqueue result, or a presence lookup **must not** be reported as successful delivery. The current provider's `sendToPeer()` returns `false` for remote sockets.

Required implementation invariants before enabling cross-instance delivery:
1. Give each server process an unpredictable instance ID and each authenticated socket a fencing token. The destination must compare its **current local socket owner** with the addressed token before any send.
2. Send an opaque payload through a bounded, authenticated inter-instance channel with a unique request ID, absolute deadline, byte cap and bounded outstanding requests. Never inspect or log message bodies.
3. The destination responds positively only after confirming that it owns an OPEN socket and its synchronous `socket.send()` invocation did not throw. This is a **local send-accepted** acknowledgment, not proof the remote application processed the message. If stronger delivery semantics are required, add an explicit client acknowledgment protocol.
4. On missing destination, expired deadline, Redis disconnect, malformed reply, owner replacement, timeout or process crash, the origin must return `false` (or propagate a clearly typed failure) and never synthesize success.
5. Validate isolation using **two distinct server processes** and real Redis: Alice on A, Bob on B, successful forwarding; Bob disconnect/reconnect race; old-owner fencing; Redis outage; duplicate and delayed responses; backpressure and payload limits. One-process/mocked-provider tests are insufficient.
6. Preserve the documented degraded-mode choice: either implement and validate this backplane or formally restrict Gate 2 to a verified affinity/single-instance topology. DHT discovery/broadcast parity is a separate acceptance decision.

No distributed delivery is claimed by this contract. Production WSS/TLS ingress and privacy limitations remain independent gates.

## Explicit acceptance gaps

1. **No DHT equivalence**: relay `joinTopic` explicitly rejects unsupported topic discovery; `broadcast` delivers to zero peers. Discovery and offer broadcast routes still require a PearNode. Relay mode must not be advertised as full Pears fallback.
2. **No fully unmocked deployment-equivalent end-to-end chain** proven here. A single CI-green integration test now covers HTTP issuance → real Redis ticket consumption → real relay provider → two TCP clients → delivery, but the Redis client is forwarded through Jest spies. This test also does not independently establish the production proxy/TLS path or all shared-budget failure cases in the same scenario (those have separate coverage).
3. **Relay readiness semantics**: selecting relay transport does not establish a client WebSocket connection; the client must obtain a single-use ticket and connect separately. The status route now reports relay `connected` using the active provider instead of misrepresenting Pears state, but no deployment-level status verification has been performed.
4. **Cross-instance delivery boundary**: the relay provider stores `participantId → WebSocket` in an in-memory map local to each server process. Redis-backed ticket and budget tests across processes do **not** prove cross-instance message routing. If Alice and Bob attach to different application instances, the local provider cannot locate Bob's socket without a routing/backplane mechanism or enforced session affinity. Gate 2 must explicitly accept single-instance/sticky-session operation or require a tested cross-instance delivery implementation.
5. **Privacy boundary**: opaque relay forwarding does not itself guarantee application-layer end-to-end encryption for every message type. Do not claim blanket E2E encryption.

## Proxy/TLS evidence boundary

- `/ws/relay` is a WebSocket upgrade endpoint and accepts a single-use ticket in the URL query. The route itself does not terminate TLS or establish an HTTPS/WSS reverse-proxy configuration.
- TCP `ws://127.0.0.1` integration tests verify the application protocol and ticket path. A separate green `wss://` integration test now verifies TLS directly at the Fastify listener with a self-signed certificate and mocked ticket resolver. **Neither proves** reverse-proxy upgrade forwarding, public certificate validity, production security headers, or the actual deployed network path.
- Acceptance requires evidence from a representative TLS-terminating proxy with a real WSS upgrade and an authenticated client, including rejection/failure cases. Do not infer that a green Docker integration test proves this.

## Gate decision

- **GREEN** for the specific CI-tested changes on the cited commit.
- **RED** for formal Gate 2 homologation, production rollout or merge until the responsible owner either approves a documented degraded-mode acceptance scope or requires implementation of the missing DHT-equivalent behavior, and the remaining integration evidence is resolved.
- No merge or deploy is authorized by this document.
