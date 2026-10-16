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
5. **The native Node harness is transitional only.** Its scheduler must be removed or retired rather than rebranded as TestKit. No unreviewed replacement of a passing test gate with a weaker gate.
6. **No performance fallback claim.** When k6 is unavailable, TestKit-backed functional/integration tests may continue, but the load/performance gate remains BLOCKED.

## Acceptance gates (all required)

- [ ] Extract and test the minimum protocol-only TestKit helpers, with positive and negative cases and explicit ownership; avoid creating unused abstractions.
- [ ] Run authenticated Intent create/cancel and application WebSocket PING/PONG against disposable real PostgreSQL/Redis services, including a deliberate no-PONG negative fixture.
- [ ] Demonstrate comparable Artillery/k6 HTTP and WS assertions and fixture/setup cost; fix the Artillery WS application-PONG assertion gap before claiming parity.
- [ ] Collect repeated, matched bounded profiles: requested and achieved arrivals, dropped iterations, per-operation p50/p95/p99, error classification, concurrent connections, backend CPU/RSS and generator CPU/RSS; fail closed on missing data.
- [ ] Pin and review k6/tooling provenance, hashes and security updates; sanitize all artifacts and prevent credentials or ticket URLs from leaking.
- [ ] Eliminate the duplicate native `runPhases` load scheduler without reducing regression coverage.
- [ ] Retire Artillery dependency, scripts and lockfile entries only after a reviewed parity decision; verify no orphaned workflows or references remain.
- [ ] Document installation, local execution, CI troubleshooting, fixture lifecycle, rate-limit policy, maintenance ownership and handoff.
- [ ] Obtain exact-HEAD CI green, independent security/architecture review and explicit authorization before merge or deploy.

## Non-negotiable safety rules

Loopback-only targets and disposable services for these candidates. No production load, security-limit bypass, real credentials in logs, mock-only proof of real-service behavior, weakened assertions, or economic/escrow authority changes. Keep **NO MERGE / NO DEPLOY** while gates remain open. Never hide a material finding to report completion.

## Maintainer guidance

When a protocol contract changes, first update the real-service fixture/assertion and its positive and negative tests; then adapt the k6 scenario and compare evidence at the same commit. Preserve fail-closed behavior. Do not implement a custom scheduler to avoid a k6 limitation; record the limitation and propose a reviewed integration instead. The operational guide is `load-tests/README.md`; detailed historical evidence and remaining blockers live in `load-tests/K6-EVALUATION-CHECKLIST.md`.

## Consequences

**Benefits:** one mature load engine, protocol-specific reuse, reduced maintenance, auditable acceptance. **Trade-offs:** some Node-only setup cannot run inside k6 directly; fixtures/adapters need carefully bounded interfaces, and the legacy comparator must stay until evidence is complete.
