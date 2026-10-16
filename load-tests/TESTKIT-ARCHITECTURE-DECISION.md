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

## Non-negotiable safety rules

Loopback-only targets and disposable services for these candidates. No production load, security-limit bypass, real credentials in logs, mock-only proof of real-service behavior, weakened assertions, or economic/escrow authority changes. Keep **NO MERGE / NO DEPLOY** while gates remain open. Never hide a material finding to report completion.

## Maintainer guidance

When a protocol contract changes, first update the real-service fixture/assertion and its positive and negative tests; then adapt the k6 scenario and compare evidence at the same commit. Preserve fail-closed behavior. Do not implement a custom scheduler to avoid a k6 limitation; record the limitation and propose a reviewed integration instead. The operational guide is `load-tests/README.md`; detailed historical evidence and remaining blockers live in `load-tests/K6-EVALUATION-CHECKLIST.md`.

## Consequences

**Benefits:** one mature load engine, protocol-specific reuse, reduced maintenance, auditable acceptance. **Trade-offs:** some Node-only setup cannot run inside k6 directly; fixtures/adapters need carefully bounded interfaces, and the legacy comparator must stay until evidence is complete.
