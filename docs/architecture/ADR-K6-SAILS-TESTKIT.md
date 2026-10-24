# ADR: k6 execution with Sails TestKit protocol helpers

- Status: **Accepted architectural direction; migration implementation IN PROGRESS**
- Decision date: 2026-10-15
- Scope: Sails Protocol load testing, protocol fixtures and verification
- Tracking: PR #472; `load-tests/README.md`; `load-tests/K6-EVALUATION-CHECKLIST.md`

## Context

The repository has k6 workloads, legacy Artillery comparators and a temporary
Node-native load harness (`load-tests/native/run.js`, including `runPhases`).
Maintaining several independent arrival schedulers would duplicate work,
increase operational risk and leave future maintainers with unclear ownership.
The Day 0 standard requires real protocol behavior and fail-closed evidence,
not mock-only assertions or optimistic CI summaries.

## Decision

1. **k6 owns load execution**: arrival rates, VUs, concurrency, load profiles,
   thresholds, performance metrics and reports.
2. **Sails TestKit owns only protocol-specific helpers**, where direct k6 code
   cannot safely or simply express them: PoP identity and signed
   challenge-response fixtures, authenticated one-time WS tickets, reusable
   protocol assertions and integration-test adapters. TestKit is a target
   architecture, **not yet a completed product or separate engine**.
3. Existing unit/integration runners may reuse TestKit for functional
   regressions. **They are not a performance fallback** when k6 is down.
   Missing load evidence blocks the load gate.
4. Artillery remains a comparator until independently reviewed parity is
   demonstrated. The native `runPhases` scheduler is temporary and must
   be removed rather than migrated into TestKit.
5. No TestKit scheduler, load generator, percentile engine, persistent
   service, benchmark dashboard or separate infrastructure.
6. All candidates run on loopback with disposable PostgreSQL/Redis and
   real security boundaries. Do not weaken production rate limits,
   authentication, economic authority, ticket consumption or secret handling.

## Acceptance criteria before migration closure

- [ ] Real authenticated Intent create/cancel correctness and negative
      assertions run under the proposed k6 path.
- [ ] Authenticated application-level WS PING/PONG correctness and specific
      missing-PONG negative control; Artillery WS parity gaps addressed.
- [ ] Repeated comparable profiles with explicit fixture/setup accounting,
      requested and achieved arrival rates, operation-level p50/p95/p99,
      errors, dropped arrivals, peak connections and generator/backend CPU/RSS.
- [ ] k6 provenance and dependency/security review recorded with exact HEAD.
- [ ] Minimal TestKit helpers implemented and covered by positive/negative
      unit/integration tests; no parallel scheduling engine.
- [ ] Temporary native scheduler removed, or a documented reviewed exception
      approved before claiming closure.
- [ ] Artillery and related dependencies removed **only after** comparison
      gates pass and explicit authorization; lockfile and CI cleaned.
- [ ] Maintainer runbook includes local reproduction, CI/artifact locations,
      version pinning, troubleshooting and security boundaries.
- [ ] Independent final review finds no untracked material issues; all
      evidence references exact commit SHAs and CI run IDs.

These boxes represent **acceptance requirements, not claims of completion**.
The checklist is the living evidence ledger. A green smoke run is necessary
but not sufficient for benchmark parity or migration closure.

## Rejected alternatives

- Build a proprietary all-in-one load engine: unnecessary scheduling and
  measurement maintenance burden.
- Treat TestKit as a drop-in k6 performance fallback: misleading performance
  assurance and duplicate complexity.
- Remove Artillery after basic smoke tests: insufficient comparable evidence.

## Maintenance and handoff

Future developers should modify protocol-specific fixtures/assertions only
when protocol contracts or security rules change; k6 scenarios and thresholds
remain in k6. Every behavior change requires positive and negative tests,
exact-HEAD CI and sanitized evidence. No credentials, private keys, signed
proofs or ticket-bearing URLs in artifacts. Escalate any material finding;
do not mark a blocked gate complete merely to ship.

**Release guardrail:** PR #472 stays DRAFT; NO MERGE / NO DEPLOY without
independent acceptance and explicit authorization.
