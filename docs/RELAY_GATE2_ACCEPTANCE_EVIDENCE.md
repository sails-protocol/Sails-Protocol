# Gate 2 — WebSocket Relay: evidence and acceptance boundary

Status: **NOT HOMOLOGATED / BLOCKED**. This document records evidence, not authorization to merge or deploy.

## Verified CI evidence

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

## Explicit acceptance gaps

1. **No DHT equivalence**: relay `joinTopic` explicitly rejects unsupported topic discovery; `broadcast` delivers to zero peers. Discovery and offer broadcast routes still require a PearNode. Relay mode must not be advertised as full Pears fallback.
2. **No fully unmocked deployment-equivalent end-to-end chain** proven here. A single CI-green integration test now covers HTTP issuance → real Redis ticket consumption → real relay provider → two TCP clients → delivery, but the Redis client is forwarded through Jest spies. This test also does not independently establish the production proxy/TLS path or all shared-budget failure cases in the same scenario (those have separate coverage).
3. **Relay readiness semantics**: selecting relay transport does not establish a client WebSocket connection; the client must obtain a single-use ticket and connect separately. The status route now reports relay `connected` using the active provider instead of misrepresenting Pears state, but no deployment-level status verification has been performed.
4. **Cross-instance delivery boundary**: the relay provider stores `participantId → WebSocket` in an in-memory map local to each server process. Redis-backed ticket and budget tests across processes do **not** prove cross-instance message routing. If Alice and Bob attach to different application instances, the local provider cannot locate Bob's socket without a routing/backplane mechanism or enforced session affinity. Gate 2 must explicitly accept single-instance/sticky-session operation or require a tested cross-instance delivery implementation.
5. **Privacy boundary**: opaque relay forwarding does not itself guarantee application-layer end-to-end encryption for every message type. Do not claim blanket E2E encryption.

## Gate decision

- **GREEN** for the specific CI-tested changes on the cited commit.
- **RED** for formal Gate 2 homologation, production rollout or merge until the responsible owner either approves a documented degraded-mode acceptance scope or requires implementation of the missing DHT-equivalent behavior, and the remaining integration evidence is resolved.
- No merge or deploy is authorized by this document.
