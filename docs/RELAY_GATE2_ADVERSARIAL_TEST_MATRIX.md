# Gate 2 — Independent adversarial test matrix (DRAFT / NO-GO)

Status: **Prepared, not executed or accepted.** This document defines isolated test cases for security reviewers and maintainers. No production route, Redis transport, or distributed process integration test is changed by this matrix.

## Evidence classification

- **Existing passing baseline:** `91a1572e75c0cdf94cd870637eb4c7d26bbf6cdd` (CI/CI Tests/CodeQL green, 197 suites / 2633 tests). This does **not** establish authenticated Redis Pub/Sub, trusted ACK provenance or server-outage recovery.
- **Pending tests:** commits `798429e`, `be68359`, `dee9e78` characterize existing ACK behavior and parser/correlation/close invariants. Their CI evidence is pending; they are not counted as acceptance.
- **Known security gap:** an attacker capable of injecting a syntactically valid ACK containing the current pending request ID may settle the request. The candidate has no authenticated ACK provenance.
- **Known reliability gap:** standard CI has emitted a forced Jest worker-exit warning; offending handle has not been attributed.

## Negative test design — isolated harness only

| Test ID | Threat | Fixture / injection | Expected result | Prerequisite |
| --- | --- | --- | --- | --- |
| SEC-ACK-01 | Forged ACK | Inject syntactically valid ACK for pending request without origin proof | Reject and leave request pending | Authenticated ACK verifier |
| SEC-ACK-02 | Wrong instance | ACK signed by a valid but non-owner instance | Reject | Instance identity and authoritative directory |
| SEC-ACK-03 | Stale lease | ACK for prior fenced lease epoch | Reject | Monotonic owner fencing |
| SEC-ACK-04 | Digest mismatch | ACK for different command payload with same request ID | Reject | Canonical command digest |
| SEC-ACK-05 | Key revocation | ACK with revoked signing/MAC key | Reject | Key lifecycle policy |
| SEC-ACK-06 | Replay | Repeat valid ACK after settlement; repeat on new request | Reject both | One-shot pending registry; authenticated binding |
| SEC-ACK-07 | Deadline | Deliver ACK after expiry/close | Reject | Bounded timeout and fail-closed lifecycle |
| SEC-ACL-01 | Channel escalation | Restricted Redis principal PUBLISH/SUBSCRIBE to other instance channel | Redis rejects | Scoped Redis ACLs |
| SEC-REDIS-01 | Redis outage | Stop dedicated disposable Redis after command issued | No false success; outstanding settles false | Dedicated isolated Redis server and fault injector |
| SEC-REDIS-02 | Redis restart | Restart Redis while old owner is stale | No implicit resubscribe/delivery; revalidate owner | Supervised recovery state machine |
| SEC-LOAD-01 | Flood | Send over-capacity commands and oversize wire payload | Bounded memory and no socket write for rejected frames | Budget instrumentation |
| SEC-PRIV-01 | Payload exposure | Inject sensitive opaque payload and force error path | No sensitive content in logs/metrics | Privacy-approved observability policy |

## Implementation order

1. Keep the existing registry/parser regression tests separate from the **future** authenticated verifier tests. Do not label current request-ID correlation as authentication.
2. Require architecture/security decision on identities, canonical encoding, MAC/signature, key rotation, lease epochs, channel ACL and error semantics.
3. Add a new isolated verifier module and tests behind a test-only boundary. Avoid editing `relay-delivery-redis.ts` or production routing until approval.
4. Exercise Redis outage/restart only on a disposable dedicated Redis instance, never the shared CI service; capture process IDs, fault timing and Redis restart evidence.
5. Record per-test SHA, command, logs, expected vs actual outcome, owner/reviewer and CI links; mark each independently accepted or rejected.
6. After evidence, resolve the Jest open-handle warning and obtain WSS/privacy/HyperDHT parity and rollout/rollback review before Gate 2 GREEN.

## Isolated evidence collection template (prepared, not executed)

Use one record **per test and exact SHA**. Do not copy a green status from another SHA, infer missing output, or mark a planned test accepted.

```text
Test ID:
Repository / branch / exact commit SHA:
Runner image / Node / Jest / Redis versions:
Isolated environment and process identities:
Command and environment variables (secrets redacted):
Fault or adversarial input and timestamp:
Expected rejection/behavior:
Observed behavior and raw log link:
Open handles / warnings / cleanup status:
Reviewer and independent approval reference:
Verdict: NOT RUN | PASS | FAIL | BLOCKED
```

**Evidence quality rules:** For Redis outage/restart capture both server shutdown and restart events and the origin/destination state before and after; client `disconnect()` alone is insufficient. For forged ACK capture the identity verification decision, not only the request-ID match. For ACL denial record the authenticated Redis principal and denial without exposing credentials. For Jest diagnostics preserve the forced-exit warning until a standard CI run confirms its disappearance.

## Acceptance ledger (not yet approved)

| Category | Planned | Accepted in this matrix |
| --- | ---: | ---: |
| Authenticated ACK cases | 7 | 0 |
| Redis ACL | 1 | 0 |
| Redis outage/restart | 2 | 0 |
| Flood/byte cap | 1 | 0 |
| Privacy/logging | 1 | 0 |
| **Total** | **12** | **0** |

These 12 planned tests are a **planning matrix**, not 12 new Gate 2 criteria. They do not change the institutional acceptance denominator: **2/5 distributed scenarios; 2/14 remaining Gate 2 criteria** until independent evidence changes those figures.

Related: `docs/RELAY_GATE2_AUTHENTICATED_ACK_CONTRACT_DRAFT.md`, `docs/RELAY_GATE2_BACKPLANE_THREAT_MODEL_DRAFT.md`, `docs/RELAY_GATE2_JEST_DIAGNOSTIC_RUNBOOK.md`.
