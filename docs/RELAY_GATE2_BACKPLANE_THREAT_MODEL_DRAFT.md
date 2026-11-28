# Gate 2 — Redis relay backplane threat model (DRAFT / NOT APPROVED)

Status: **Design review only. No production authorization, no routing or WSS activation.**

## Scope and trust boundaries

The isolated `RedisRelayDeliveryTransport` exchanges delivery commands and ACKs over Redis Pub/Sub. The caller supplies channel names. The origin tracks pending requests; the destination checks the local socket owner token. Redis accepts publications but does not attest the identity of the publisher or the delivery of the message. A channel-name regex limits syntax only.

Trust boundaries: (1) client WSS ingress to authenticated server instance, (2) server instance to Redis ACL principal, (3) Redis channel to subscribing destination instance, (4) destination socket owner to origin ACK, (5) control-plane participant-to-instance directory to data-plane delivery. **None of these is authorized for production by this document.**

## Threats, required controls and falsifiable evidence

| ID | Threat | Required decision/control | Independent rejection test |
| --- | --- | --- | --- |
| T1 | Unauthorized instance publishes to another instance's channel | Per-instance Redis credentials and least-privilege channel publish/subscribe ACL; explicit identity binding | Unauthorized principal cannot PUBLISH or SUBSCRIBE to protected channels |
| T2 | Forged positive ACK causes false delivered status | Authenticated ACK origin, binding request ID, destination identity, owner lease/epoch, command digest, expiry | Spoofed ACK with correct request ID is rejected without authenticated provenance |
| T3 | Replayed or delayed ACK satisfies a newer command | One-shot request nonce and bounded validity, monotonic fencing and dedupe | Replay and post-deadline ACK cannot settle another or expired request |
| T4 | Stale instance continues sending after owner migration | Authoritative directory with atomic lease takeover and epoch fencing | Old instance fails after takeover even if its local socket/token remains valid |
| T5 | Redis partition/restart silently resumes stale subscriptions | Fail-closed transition, explicit supervised resubscribe and directory revalidation | Redis outage and restart cannot produce a false ACK or implicit reopening |
| T6 | Pub/Sub flood, large payloads or slow ACKs exhaust resources | Hard byte caps, bounded inbound work, bounded pending origin requests and deadline budget | Oversize, concurrency saturation and late ACKs are rejected with bounded memory |
| T7 | WSS or Redis path leaks chat/negotiation metadata or payload | Privacy review, minimum necessary payload, retention and logging controls | Logs/traces expose no prohibited payload or secrets under error paths |
| T8 | HyperDHT and WSS behavior diverge | Document explicit parity and fallback policy; avoid silent transport downgrade | Contract tests compare auth, lease fencing, ACK semantics and failure behavior |

## Explicitly unresolved architectural decisions

- Which service owns the authoritative participant-to-instance directory, how leases are issued and fenced, and what happens during network partition?
- How are instance identities issued/rotated and enforced by Redis ACLs, including credentials for test/staging/prod?
- Which cryptographic or transport-level binding authenticates ACK provenance, and what is the exact canonical digest format?
- What is the supervised recovery state machine after Redis restart, and how does it prevent replay or old owner reuse?
- What is the privacy policy for WSS chat/negotiation payloads and the HyperDHT fallback decision?

## Acceptance and change control

A reviewer must attach evidence from independent process/Redis fault-injection runs, negative security tests and a specific SHA. The security owner, architecture owner and privacy owner must approve the resulting RFC/ADR. Do not infer any acceptance from green CI alone.

Related evidence ledger: `docs/RELAY_GATE2_ACCEPTANCE_EVIDENCE.md`. The active Redis candidate is isolated from production routes.
