# Sails Pulse: k6 evaluation checklist

Status: EVALUATION ONLY. This is not approval to install a binary or change the default CI.

## First controlled experiment

- Select an explicit k6 release, pin the artifact SHA-256 and document its official origin, license and maintenance/security advisories.
- Run in an isolated disposable runner with no external network access to protocol targets; enforce an allowlist and bounded duration/VUs.
- Implement HTTP PoP registration, signed challenge authentication, create/cancel intent with full response assertions. Use k6-compatible crypto or a reviewed setup fixture; do not assume Node.js crypto or npm packages work in k6.
- Implement WebSocket one-time ticket minting and verify application PONG; reject URL bearer tokens.
- Capture requested and achieved arrival rates, error classification, p50/p95/p99, connection counts, resource consumption and generator saturation.
- Compare against a protocol-equivalent native run and corrected Artillery comparator, each with equivalent setup cost, assertions, rate policies and load profile.
- Preserve auth rate-limit policy. If the 10/min default conflicts with workload generation, stop and request a separate security review instead of bypassing it.
- Fail if metrics, assertions or reports are missing. Never publish credentials, signed proofs, ticket URLs or private keys in CI artifacts.

## Acceptance

The hybrid option must have no security regressions, meet required protocol coverage, generate reproducible and trustworthy measurements, reduce maintenance burden, and not introduce unjustified supply-chain exposure. Performance wins alone do not override failed security gates.

## Current status

- Native real-service smoke and tiny rehearsal: previously passed.
- Native workflow and general CI: passed at 9846c5b3f666f4c16ddc025f355c78dbccc2ca51.
- k6 binary provenance, scenario implementation, WS assertion and comparative benchmark: NOT YET VERIFIED.
- No decision to uninstall Artillery, merge, deploy or change rate limits.

## CTO transition evidence — 2026-10-15 (PR #472)

- Candidate HEAD observed: `9f4b6338d2fb9ea02e2e2052ddbbf0a03e3f2373`. This is an observation, not an acceptance SHA.
- CI Tests run 38740919931 and Native load harness run 38740919937 were **in progress** at the CTO review; do not infer PASS or FAIL from pending jobs.
- In the native load run, dependency-free syntax and safety guard checks **PASSED** on that HEAD. The older syntax failure (run 38732929803, job 116414916066, chat-ws-bounded.js line 31) predates this HEAD and must not be treated as a current failure.
- Source inspection confirms bounded k6 Intent and WS candidates, an explicit application PONG assertion, a negative no-PONG fixture, and disposable PostgreSQL/Redis workflow configuration. These are **implementation observations**, not runtime acceptance.
- `load-tests/native/run.js` still implements its own `runPhases` scheduler. This is transitional only; k6 remains the sole approved load executor, while Sails TestKit may provide protocol-specific fixtures and checks.
- **Gate: BLOCKED until exact-HEAD jobs complete and positive Intent/WS, specific negative no-PONG, security and comparator evidence are inspected.** Artillery remains installed. No merge, deploy, production rate-limit change, or economic/escrow modification authorized.
- Claude's read-only scalability/event-architecture mission is tracked in #473 with #253 and #269; Kafka/Redpanda adoption remains undecided.

### CTO continuation procedure

1. Check both run conclusions and job logs on the exact PR HEAD; do not fix historical failures blindly.
2. For any red gate, record job, step, error and SHA, then apply the minimal safe fix and rerun.
3. Require positive real-service k6 Intent and WS PONG plus a negative fixture that fails specifically for missing PONG.
4. Review authentication limits, secret-safe artifacts and Artillery comparison before any removal proposal.
5. After acceptance, simplify the temporary native scheduler into protocol-only TestKit utilities; seek explicit authorization for merge/deploy.


## Evidence reconciliation — 2026-10-15, completed runs

The previously pending jobs finished **successfully**: CI Tests run `38740919931` and Native load harness candidate run `38740919937`, both on implementation HEAD `9f4b6338d2fb9ea02e2e2052ddbbf0a03e3f2373`. This does not assert a rerun on the later documentation-only HEAD.

Inspection of `.github/workflows/native-load-harness-candidate.yml` confirms the successful candidate job includes: real disposable PostgreSQL/Redis service, bounded Artillery HTTP and WS comparator runs, a deliberately failing k6 non-PONG fixture whose failure classification is asserted, and bounded k6 real-service Intent and authenticated WS PONG runs. The Artillery WS comparator **does not** assert PONG and is deliberately labeled non-parity. Do not infer sustained throughput equivalence from bounded one-iteration k6 smoke checks.

**Residual gate:** the workflow currently uses `grafana/setup-k6-action@v1` without an explicitly pinned action commit or k6 artifact digest in the workflow. The supply-chain/provenance acceptance item above remains OPEN. Also OPEN: comparable sustained load shapes, p50/p95/p99, arrival rates, saturation and resource measurements, review of the duplicate native `runPhases` scheduler, and authorized dependency removal. No merge/deploy/production-limit change.

