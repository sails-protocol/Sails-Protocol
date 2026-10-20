# Gate 2 — WebSocket Relay: evidence and acceptance boundary

Status: **NOT HOMOLOGATED / BLOCKED**. This document records evidence, not authorization to merge or deploy.

## Verified CI evidence

Commit `31182b7ea036862ff0faf08c842d8dcecb68011b`:
- CI run 39360572901 — success.
- CI Tests run 39360572929 — success.
- CodeQL run 39360572904 — success.

## Tested capabilities and limitations

- `tests/relayProviderLiveDelivery.test.ts`: real relay provider, two real TCP WebSocket clients, opaque Alice-to-Bob delivery and disconnect handling; ticket resolver and Redis budget **mocked**.
- `tests/relayLiveWebSocket.test.ts`: real TCP route with **mocked** provider, including frame boundaries and reconnect behavior.
- `tests/relayRedisIntegration.test.ts`: real Redis-backed single-use ticket resolution, concurrent/replayed ticket races and shared budget, including multi-process and multiple listener cases; **not** one unmocked issuance-to-delivery scenario.
- `tests/pearRoutes.test.ts`: verifies `POST /v1/peers/start` reports Pears versus WebSocket relay capabilities. Auth and transport selection are mocked for this route-level test.

## Explicit acceptance gaps

1. **No DHT equivalence**: relay `joinTopic` is a no-op; `broadcast` delivers to zero peers. Discovery and offer broadcast routes still require a PearNode. Relay mode must not be advertised as full Pears fallback.
2. **No single fully unmocked end-to-end chain** proven here: HTTP ticket issuance → real Redis ticket consumption and shared budget → real relay provider → two real WebSocket clients → delivery.
3. **Relay readiness semantics**: selecting relay transport does not establish a client WebSocket connection; the client must obtain a single-use ticket and connect separately.
4. **Privacy boundary**: opaque relay forwarding does not itself guarantee application-layer end-to-end encryption for every message type. Do not claim blanket E2E encryption.

## Gate decision

- **GREEN** for the specific CI-tested changes on the cited commit.
- **RED** for formal Gate 2 homologation, production rollout or merge until the responsible owner either approves a documented degraded-mode acceptance scope or requires implementation of the missing DHT-equivalent behavior, and the remaining integration evidence is resolved.
- No merge or deploy is authorized by this document.
