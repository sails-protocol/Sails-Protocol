# Gate 2 — Authenticated ACK contract (DRAFT / DECISION REQUIRED)

Status: **Design-only, not implemented or approved.** The current `RelayDeliveryAck` is exactly `{requestId, accepted}` and `RelayDeliveryPendingRegistry.acknowledge()` correlates by request ID and syntax alone. That behavior is covered by the characterization test in `tests/relayDeliveryPending.test.ts`. No production route is wired.

## Security invariant

An ACK MUST NOT settle an origin delivery as accepted unless the origin can verify **all** of the following: authenticated destination instance, exact pending request ID, expected destination participant and current lease epoch, integrity of the original command, bounded validity interval, and one-shot settlement. A valid Redis publication, known channel name, UUID, or successful local socket write alone does not authenticate the ACK or prove client receipt.

## Proposed envelope — subject to architecture review

```text
version: 1
requestId: UUID
accepted: boolean
destinationInstanceId: authenticated identity
destinationParticipantId: opaque participant identifier
destinationLeaseEpoch: monotonic fenced epoch (not a reusable random lease alone)
commandDigest: digest of canonical request fields and opaque payload
issuedAtMs: integer timestamp
expiresAtMs: integer timestamp
keyId: active instance verification key reference
authenticator: MAC or signature over canonical envelope and bound request context
```

The canonical serialization, cryptographic primitive, key distribution/rotation, replay store, clock-skew budget, maximum TTL, destination identity issuer and Redis ACL strategy are **open decisions**. Do not treat the illustrative envelope as an approved schema.

## Fail-closed acceptance sequence

1. Parse a bounded, strictly versioned envelope; reject unknown fields and oversized values.
2. Resolve an authenticated destination identity and validate `keyId` against the authorized key set.
3. Verify the authenticator over a domain-separated canonical envelope and original command digest.
4. Look up the pending request; compare the expected destination instance, participant and fenced lease epoch.
5. Reject expired, future-dated, duplicated, replayed or post-close ACKs; require one-shot settlement.
6. Only then settle `accepted`; a positive ACK means destination **local send accepted**, not client delivery.

## Negative tests to implement before approval

| ID | Input | Required result |
| --- | --- | --- |
| A1 | Syntactically valid ACK without authenticator | Reject |
| A2 | Correct request ID with wrong instance identity | Reject |
| A3 | Correct request ID with stale lease epoch | Reject |
| A4 | Correct request ID with mismatched command digest | Reject |
| A5 | Correct request ID with invalid MAC/signature | Reject |
| A6 | Duplicate ACK after successful settlement | Reject |
| A7 | Delayed ACK beyond request expiry | Reject |
| A8 | ACK from revoked or rotated key | Reject |
| A9 | ACK with unknown envelope field or excessive bytes | Reject |
| A10 | ACK on a different reply channel / wrong origin context | Reject |

**Current-state warning:** A1–A5 and A8–A10 are **not** established security properties of the existing Redis candidate. Some request-correlation/replay/timeout cases have transport-neutral tests, but do not imply authenticated provenance. These are future acceptance tests, not passing claims.

## Isolated parser-hardening evidence (pending CI)

- Commit `be68359bb48cbb0e39a6518ff195db69197b79b4` adds a registry-level regression test for malformed, ambiguous, unknown-field and mismatched-request ACKs. It asserts the pending request remains unresolved until an explicit valid negative ACK arrives.
- This is **parser and correlation hardening only**. It does not establish cryptographic provenance, authenticated destination identity, Redis channel ACLs, or any of the A1–A10 authenticated-ACK acceptance guarantees. Do not count it toward Gate 2 acceptance before CI and independent review.
- Existing characterization explicitly demonstrates that a syntactically valid positive ACK with a known pending request ID is accepted by the current unauthenticated registry. Production wiring remains prohibited.

## Decision and evidence gates

- Architecture/security reviewers must choose the identity, canonical encoding, authenticator, key lifecycle and authoritative lease directory before implementation.
- Implement a separately tested verifier and an authenticated transport adapter in an isolated candidate; never silently reinterpret the legacy two-field ACK as authenticated.
- Run negative tests, two-process real Redis adversarial tests, outage/restart tests and privacy review, with CI logs tied to a SHA.
- Require explicit independent sign-off for Gate 2 and a separate rollout/rollback authorization. Until then **NO-GO**.

Related: `docs/RELAY_GATE2_BACKPLANE_THREAT_MODEL_DRAFT.md` and `docs/RELAY_GATE2_ACCEPTANCE_EVIDENCE.md`.
