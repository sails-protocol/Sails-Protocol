# Mission 04: identity, revocation and portability closure (results)

Draft experiment on #543/#545. **No Day 0 GO.** No Core, Prisma, production contract or financial mechanism changed. Numbers are author-reported until the Gatekeeper reruns them.

## 1. Upstream inquiry

Published (CTO-approved): https://github.com/pubky/pubky-homeserver/issues/743 (revocation status for third parties, signer-side lifetime, service-specific consent, SDK deadlines). Responses: **none yet**; the lab does not wait for them.

## 2. Revocation with N = 300 s (experimental window, NOT a Day 0 policy)

Vocabulary: **immediate** = refused at the next read after the user's action (needs a cooperating signer that deletes the record AND an honest homeserver);
**limited exposure** = refused when the signed statement is N old; **not bounded** = relies on a component that can lie. The undocumented HTTP error-order probe is NOT part of the decision in any row below.

| # | Scenario (suite) | Result | False-accept window |
|---|---|---|---|
| 1 | Grant revoked, record still inside the window, honest homeserver, real time (07 W1) | the revoked grant's record was accepted for **291 s** (run A) and **300 s** (run B) after revocation, first refusal at **301 s** / **310 s** (polling every 10 s); the revoked integrator could not refresh | up to N |
| 2 | User revokes AND a cooperating signer deletes the record (07 W2) | refused at the next read | ~0 (needs signer cooperation) |
| 3 | Hostile homeserver replays the record after revoke + delete (07 W5, 05 S3) | accepted until the signed statement is N old, then refused | up to N |
| 4 | Forged `Last-Modified` or "old" metadata (05 S4, S11; 07 W6) | forged freshness adds nothing; an "old" report is refused | none beyond N |
| 5 | Rollback to an older version after the verifier restarted (07 W3) | in-memory guard: accepted inside N (**FAIL**); persisted guard: refused; first contact pre-pinned by a witness value: refused | N without persistence |
| 6 | Compromised integrator, before revocation (07 W7, 05 S7) | keeps publishing valid records; after revocation cannot publish; the last accepted record is at most N old; the SDK still lets it MINT statements offline, but they cannot be published and out-of-band ones lack provenance | up to N |
| 7 | Hostile homeserver that ignores revocation + revoked integrator (05 S8) | **accepted** | **not bounded** (the homeserver is the revocation authority) |
| 8 | No connectivity (07 W4, 04 O2) | refused (fail closed); nothing cached authorizes | n/a |
| 9 | Reinstall and recovery (01 R2, 05 S13, 08 X2) | same Pubky id; new Pear key; old key refused after revocation | n/a |
| 10 | Verifier clock L seconds behind (07 W6) | a record N + 100 s old is accepted with a 150 s lag | N + L |
| 11 | Future-dated statement by a compromised integrator (05 S12) | refused | none |
| 12 | Stolen Pear device key (05 S9) | accepted until revoke AND removal / staleness | up to N after revocation |

Independent time witnesses, background/mobile reachability of the re-publishing integrator, and network delay beyond the poll interval are **UNKNOWN** (not testable in the lab; listed in `REAL-DEVICE-TESTS.md`).
Conclusion: **revocation with limited exposure is demonstrated under explicit assumptions (honest homeserver, correct verifier clock, persisted guard); immediate third-party revocation is not demonstrated and stays BLOCKED** without a documented upstream mechanism.

## 3. Real devices (Ring, phones)

Prepared, **not executed** (cannot be done by the assistant): `REAL-DEVICE-TESTS.md`, kit `field/` (integrator, verifier, Pear probe, mailbox), self-tested against the lab with the SDK signer standing in for Ring. All real-device rows are **UNKNOWN**.

## 4. Portable identity and reputation (lab, gaps 1, 3, 4)

`portable/SPEC.md`, three agreeing implementations, 35 vectors, 23 verifier mutants (see `CONTRACT-RECONCILIATION.md`). Lab `08` uses REAL Pubky SDK grants and custom PoPs on the real homeserver: recovery of the same identity in a second app, an independent verifier that reads only public storage, rejection of copied chains, deleted facts, delegated-only bindings, revoked bindings.

## 5. Pear integration review

`PEAR-TRANSPORT-PROPOSAL.md`: three modules bypass `TransportProvider`; four additive steps; verifiable criteria. Nothing implemented.

## 6. Gatekeeper and CI

Gatekeeper review requested on #545 (scope list in the comment); verdict **not received**. CI: see the report (the PR #545 base is a feature branch, so the `CI` workflow for `main` does not run on it; "CI Tests" does). `hypercore@11.39.3`: `HYPERCORE-PROVENANCE.md`.

## 7. Criteria of this mission (completion count, not maturity and not GO)

| # | Criterion | Done |
|---|---|---|
| 1 | Upstream inquiry published | yes |
| 2 | Link recorded | yes |
| 3 | Upstream response received | **no** |
| 4 | The four upstream questions investigated against sources | yes |
| 5 | Revoked grant with record inside the window quantified | yes |
| 6 | Hostile/stale homeserver | yes |
| 7 | Replay, rollback, verifier restart | yes |
| 8 | Compromised device | yes |
| 9 | No connectivity | yes |
| 10 | Reinstall and identity recovery (lab) | yes |
| 11 | Forged clock/metadata | yes |
| 12 | Immediate vs limited exposure distinguished | yes |
| 13 | HTTP error order not used as authorization | yes |
| 14 | Ring grant | **no** |
| 15 | Recovery on another real device | **no** |
| 16 | Ring revoke and re-authorize | **no** |
| 17 | Pear on Android/iOS | **no** |
| 18 | Real communication across networks | **no** |
| 19 | Real NAT/relay/reconnect | **no** |
| 20 | Real offline delivery | **no** |
| 21 | Resource use / background | **no** |
| 22 | Real-device kit prepared and self-tested | yes |
| 23 | Verifiable Pubky-Participant binding with authority distinction | yes |
| 24 | Deterministic, versioned canonical form with vectors | yes |
| 25 | Third-party-verifiable signatures, independent verifier | yes |
| 26 | Same identity recovered in another app (lab) | yes |
| 27 | Presented facts verified | yes |
| 28 | Reputation computed from authenticated facts | yes |
| 29 | Forged, duplicated, revoked, tampered records refused | yes |
| 30 | Selecting favourable receipts does not fabricate reputation (limits written) | yes |
| 31 | Private information not published unnecessarily | yes |
| 32 | Pear coupling inspected | yes |
| 33 | Minimal OpenP2P/TransportProvider proposal | yes |
| 34 | Gatekeeper review requested | yes |
| 35 | Gatekeeper verdict obtained | **no** |
| 36 | Real CI state verified | yes |
| 37 | `hypercore` attestation error investigated separately | yes |

**27 of 37 criteria done (73%).** The ten open ones are the real-device group (8), the upstream answer and the Gatekeeper verdict. This percentage is about this mission's checklist only.
