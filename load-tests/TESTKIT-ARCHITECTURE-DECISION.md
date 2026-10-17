# Architecture decision: k6 + Sails TestKit (ADR, proposed)

- Date: 2026-10-16
- Status: **Accepted direction; implementation and migration acceptance OPEN**
- Scope: test-only tooling; no production contract, custody or economic-authority changes
- Tracking: PR #472; `load-tests/K6-EVALUATION-CHECKLIST.md`

## Context

The repository has k6 load scenarios, legacy Artillery HTTP/WS comparators, and a native Node candidate with its own `runPhases` scheduler. Maintaining multiple load engines creates duplicated concurrency logic, ambiguous benchmarks, and a long-term ownership burden. Protocol-specific setup and fail-closed assertions must remain reusable without making a proprietary performance engine.

## Decision

1. **k6 is the sole target load/performance execution engine.** It owns VUs, arrival rates, concurrency, scheduling, thresholds, operation timing, metrics, and reports.
2. **Sails TestKit is a small, test-only protocol helper layer.** It may provide Ed25519 proof-of-possession identity/auth fixtures, one-time WebSocket ticket setup, real-service Intent/settlement fixtures, and fail-closed protocol assertions or adapters for existing functional/integration runners. Prefer direct k6 implementation where safe and maintainable. Do not assume Node helpers are directly importable in k6.
3. **No proprietary second load engine.** TestKit must not contain `runPhases`, VU scheduling, arrival-rate control, percentile aggregation, dashboards, always-on services, or independent performance acceptance criteria.
4. **Artillery remains installed as a transitional comparator** until parity is proven and independently reviewed. Its current WS comparator sends PING but does not assert application PONG, so WS parity is OPEN.
5. **The native Node harness is protocol-only smoke.** Its duplicate scheduler was removed in PR #472; k6 owns load scheduling. Do not treat this as proof of performance parity.
6. **No performance fallback claim.** When k6 is unavailable, TestKit-backed functional/integration tests may continue, but the load/performance gate remains BLOCKED.

## Acceptance gates (all required)

- [x] Extract and test initial protocol-only TestKit helpers with positive and negative cases (`loopback-target.cjs`, `ws-protocol.cjs`, `protocol-assertions.cjs`); exact-HEAD CI green at `a9fbc2926ad5c9b39369d5b0527e1a694f5c2bc3`. This closes only the initial helper gate, not complete TestKit distribution or protocol parity.
- [ ] Run authenticated Intent create/cancel and application WebSocket PING/PONG against disposable real PostgreSQL/Redis services, including a deliberate no-PONG negative fixture.
- [ ] Demonstrate comparable Artillery/k6 HTTP and WS assertions and fixture/setup cost; fix the Artillery WS application-PONG assertion gap before claiming parity.
- [ ] Collect repeated, matched bounded profiles: requested and achieved arrivals, dropped iterations, per-operation p50/p95/p99, error classification, concurrent connections, backend CPU/RSS and generator CPU/RSS; fail closed on missing data.
- [ ] Pin and review k6/tooling provenance, hashes and security updates; sanitize all artifacts and prevent credentials or ticket URLs from leaking.
- [x] Validate exact-HEAD CI after removal of native `runPhases` and `bench-small`; authenticated smoke remains, while bounded k6 Intent/WS checks remain in CI. Both workflows green at `6b5a949da30e5b2361c5f47359d94552ce265c76` (CI Tests run `38965370007`; Native load harness candidate verification run `38965370104`). This does not establish sustained benchmark parity.
- [ ] Retire Artillery dependency, scripts and lockfile entries only after a reviewed parity decision; verify no orphaned workflows or references remain.
- [ ] Document installation, local execution, CI troubleshooting, fixture lifecycle, rate-limit policy, maintenance ownership and handoff.
- [ ] Obtain exact-HEAD CI green, independent security/architecture review and explicit authorization before merge or deploy.

## Latest bounded WS evidence (2026-10-16)

- Exact HEAD `4159680f9afad637bdeb609cc4874db972dc322e`: CI Tests run `38969307438` and Native load harness candidate verification run `38969307291` both passed. This validates the expanded shared PONG classifier negative cases; it does **not** establish Artillery WS receive parity.
- The installed Artillery version observed in native CI is `2.0.34`. Its `ws` dependency resolves under `node_modules/artillery/node_modules/ws`; the separate `@artilleryio/engine-ws` and `artillery-engine-ws` packages were not directly resolvable. A source-path diagnostic returned no candidate receive hooks in the searched locations; absence in that diagnostic is **not** proof no supported hook exists.
- Next investigation: inspect the actual bundled Artillery 2.0.34 WS engine source/API and verify a supported receive/assertion hook. Require real disposable-backend positive PONG and deliberate no-PONG negative runs before changing the bounded comparator's non-parity label. If no supported integration exists, document the limitation and keep the Artillery WS comparator as a non-parity baseline rather than inventing an adapter or weakening assertions.

## WS comparator investigation update (2026-10-17)

- Exact HEAD `378f18db82aac5102ff32fa9ee752e509f88f4ce`: CI Tests `38994548349` and Native load harness `38994548339` both SUCCESS. This is a functional/helper validation, **not** WS performance or PONG parity certification.
- Artillery 2.0.34 bundled implementation resolved at `node_modules/artillery/dist/lib/core/engine_ws.js`. Bounded inspection traversed 123 compiled JavaScript files and found socket handlers at lines 194/198. Engine uses `_deps.WebSocket` and an application `onmessage` handler, but the inspected engine has no explicit `pong` event assertion.
- `assertPongFromSocket` has simulated socket positive/negative tests covering valid PONG, ERROR, wrong message, malformed JSON, timeout, premature close, transport error and listener cleanup. These tests do **not** prove that Artillery exposes the live socket to the processor or that a real application PONG is observed.
- **Decision:** do not monkeypatch Artillery internals or promote the existing send+think scenario to a parity gate. The observed mutable `_deps` seam is an implementation detail, not yet a reviewed supported extension interface. Prefer a supported receive/assertion hook proven by real disposable-backend positive and no-PONG negative runs; otherwise retain a clearly labeled non-parity comparator.
- Next acceptance evidence: real-socket PONG and no-PONG tests, matched Artillery/k6 metrics and resource profiles, security review, and exact-HEAD CI. Artillery retirement remains blocked.

## Disposable real-WebSocket transport proof (2026-10-17)

- Exact HEAD `edafcea30de959c861a010fe44d3577c1a516480`: CI Tests `38997427037` and Native load harness `38997426980` both SUCCESS.
- `load-tests/artillery/ws-real-transport.test.cjs` starts a real disposable loopback `ws` server and calls `provePongOverRealSocket`. CI demonstrates successful application PONG, rejection of NOT_PONG, application ERROR and silence/timeouts; remote targets are refused.
- This closes the **standalone real transport probe** only. It is not a run through the Artillery engine, does not exercise authenticated production chat or prove matched Artillery/k6 arrival profiles. The existing Artillery WS comparator continues to be explicitly labeled `PONG not asserted`.
- Follow-up: use a reviewed supported Artillery receive/assertion integration against disposable authenticated services, or formally retain non-parity and proceed with k6 as the authoritative load engine. No Artillery retirement or merge based on this probe.

## Parity decision gate — explicit reviewer checklist

A green standalone `ws` transport probe does not change the Artillery WS comparator's assertion contract. The reviewer must observe **both** outcomes through the **same Artillery engine path**, not only the shared Node helper: (1) authenticated disposable chat PING followed by application PONG passes; (2) disposable no-PONG fixture fails the comparator with a nonzero exit or explicit failed assertion. Preserve one-time WS tickets, loopback-only targets, redacted URLs, and normal rate limits. If the engine has no supported receive/assertion hook, mark this parity gate **BLOCKED** rather than patching bundled Artillery internals.

For HTTP/load comparison, do not compare unmatched completed arrivals or overall k6 HTTP latency (which includes PoP setup) to Artillery endpoint latency. Require at least two isolated repeated runs per tool under the same fixture, profile, actual arrivals and measurement window, and capture requested/achieved rate, dropped iterations, create/cancel median/p95/p99, errors, backend and generator CPU/RSS, and WebSocket concurrent connections. Missing values or inconsistent accounting must fail closed. No sustained-throughput claim from a two-arrival rehearsal.

**Current disposition:** Artillery retained as transitional non-parity comparator; k6 remains the target exclusive scheduler. Retirement, merge and deploy remain blocked pending independent review and acceptance evidence.

## Non-negotiable safety rules

Loopback-only targets and disposable services for these candidates. No production load, security-limit bypass, real credentials in logs, mock-only proof of real-service behavior, weakened assertions, or economic/escrow authority changes. Keep **NO MERGE / NO DEPLOY** while gates remain open. Never hide a material finding to report completion.

## Maintainer guidance

When a protocol contract changes, first update the real-service fixture/assertion and its positive and negative tests; then adapt the k6 scenario and compare evidence at the same commit. Preserve fail-closed behavior. Do not implement a custom scheduler to avoid a k6 limitation; record the limitation and propose a reviewed integration instead. The operational guide is `load-tests/README.md`; detailed historical evidence and remaining blockers live in `load-tests/K6-EVALUATION-CHECKLIST.md`.

## Consequences

**Benefits:** one mature load engine, protocol-specific reuse, reduced maintenance, auditable acceptance. **Trade-offs:** some Node-only setup cannot run inside k6 directly; fixtures/adapters need carefully bounded interfaces, and the legacy comparator must stay until evidence is complete.
