# Mission 03: Pubky security closure (results)

Draft experiment. **No Day 0 GO.** Nothing here changes Core, schemas, financial mechanisms or production contracts.
Builds on #543 and #545. Decisions applied from the CTO review of #545: undocumented revocation probe is diagnostic only; two-year grants are an
upstream constraint for the experiment; Pear stays the Day 0 candidate; Pubky Noise not implemented; contracts reconciled without parallel contracts.

## 1. Documented third-party grant status, and configurable validity (upstream sources)

Read: `docs/AUTH.md`, `docs/CUSTOM_POP.md`, `docs/grant-session-lifecycle.md`, `README` of `@synonymdev/pubky@0.16.2`, homeserver route table
(`client_server/auth/router.rs`, `grant/routes.rs`), PRs #373 (grant auth) and #680 (custom proofs), at tag `v0.16.2` (`f60e502f`) and `main` (`fd24bf0c`, 80 commits fetched; no
grant-status or lifetime change after the tag).

| Question | Finding | Result |
|---|---|---|
| Documented way for a third party to read the CURRENT state of a grant | **None.** Routes: `GET /auth/grant/session(s)` and `DELETE .../{gid}` need the grant's own bearer or a root session; `POST /auth/grant/session` needs the PoP key. `CUSTOM_POP.md`: "Verification does not contact the homeserver or check revocation." | **FAIL** (no mechanism) |
| Signed revocation feed or public status endpoint | None in docs, routes, PRs or issues searched (`grant status`, `revocation`, `ttl`, `lifetime`, `custom pop revocation`). Open upstream PR #681 (session agent) does not address it | **FAIL** |
| Status through error ordering of `POST /auth/grant/session` | Works (`401 Grant has been revoked`; revocation is checked before the PoP, `service.rs verify_grant_and_pop`), but is **undocumented** | **diagnostic only**, not a security contract (CTO) |
| Configurable validity at PROTOCOL level | **Yes.** `exp` is a signed claim; the homeserver has no maximum for normal grants, caps the bearer at `exp`, refuses writes and new bearers after `exp`; the SDK verifier rejects after `exp`. Tested with a 25 s grant from a lab signer (suite 06) | **PASS (protocol)** |
| Configurable validity through the official signer API / deep link | **No.** `DEFAULT_GRANT_LIFETIME_SECS = 2 * 365 * 24 * 3600`, used in `signer/auth.rs`; no parameter in the JS signer or in the `pubkyauth://` request | **FAIL (SDK)** |
| What Ring (the real signer app) does | Ring `fac51afa` depends on `@synonymdev/react-native-pubky 0.15.0`, has grant list, expiry display and revoke screens (`AuthorizedGrantScreen`, `RevokeGrantSheet`). Lifetime control: not seen | **UNKNOWN** |

Draft question for upstream (not posted): `UPSTREAM-INQUIRY.md`.

## 2. Real signer application

Pubky Ring is a React Native app (iOS/Android). It cannot run in this environment (no device or emulator; downloading and running a
mobile build would also be an unverified binary). The full grant flow, narrowing, revocation, reinstall and re-authorization was therefore run
with the SDK's own `Signer` in a separate process that is the only holder of the secret, using the same `pubkyauth://signin_grant` deep link and relay that Ring consumes.
**Real signer app: UNKNOWN / BLOCKED by environment.** Required to close: run the same suites with Ring on a phone (list in the ADR blockers).

| Step | Result |
|---|---|
| Grant with the secret staying in the signer process; integrator holds no secret (hex/base64/base64url absent from bearer export and grant) | PASS (process level) |
| Restricting capabilities (signer approves less than requested) | PASS |
| Revocation by the signer | PASS |
| Reinstall: recovery file + passphrase in a fresh process, same identity | PASS |
| Re-authorization after reinstall: new grant, new Pear key, previous record removed or expired | PASS |

## 3. Adversarial scenarios (suite 05, real homeserver, hostile proxy in front of it)

| # | Scenario | Result |
|---|---|---|
| S1 | Tampered directory record (binding, PoP, grant) | **PASS** (refused) |
| S2 | Homeserver withholds the record | **PASS** (refused, fail closed; availability is lost) |
| S3 | Stale replay after revoke + delete | **PASS-bounded**: a hostile homeserver can replay for up to `maxAgeSec`; refused after |
| S4 | Forged "fresh" headers on an old record | **PASS** (the signed statement age decides) |
| S5 | Rollback to an older version | **PASS** (sequence guard) |
| S6 | Another account's valid record served under the victim's name | **PASS** (identity pinned) |
| S7 | Stolen integrator device after revocation: mints statements offline | **GAP**: still possible (the SDK makes no network call). Cannot publish (401); a verifier requiring directory provenance + freshness refuses it. **PASS with an honest homeserver** |
| S8 | Same attacker + hostile homeserver that ignores revocation | **FAIL by construction**: accepted. The user's homeserver is the revocation authority |
| S9 | Stolen Pear device key | accepted until revoke AND record removal / staleness; then refused |
| S10 | Reuse of a captured challenge answer (other verifier, second use) | **PASS** |
| S11 | Homeserver reports the record as old | **PASS** (refused) |
| S12 | Future-dated statement | **PASS** (refused) |

## 4. Revocation conclusion (STOP rule)

* Immediate third-party-verifiable revocation: **BLOCKED**. There is no documented status mechanism; the only working probe is undocumented.
* **Auditable alternative defined and tested (not a GO):** authorization for anything NEW is accepted only for a record that (a) verifies end to end,
  (b) was fetched from the identity's own directory, (c) carries a signed statement younger than N, (d) is reported by the homeserver as modified within N,
  (e) is not older than a sequence already seen. The integrator must re-publish before N; a revoked integrator cannot (homeserver refuses the write), so revocation
  takes effect within N (CTO suggests 5-15 min after a threat model; the default here is 900 s and is a parameter). If the status source is unreachable: refuse.
* Its explicit trust assumption: the user's homeserver is trusted for freshness and revocation, never for authenticity. A homeserver that ignores revocation defeats it (S8).
* Its operational cost: a periodic write per device from a live integrator (mobile background behaviour **UNKNOWN**).
* If a signer implementation issued short-lived grants (protocol-supported, SDK-unsupported) revocation would reduce to expiry; that needs upstream or a Sails-owned signer.
* Therefore: **no GO**. Day 0 requires either a documented upstream status mechanism or an independently reviewed acceptance of the bounded model above.

## 5. Other items

Pear viability (NAT, relay, Bare, offline delivery): `PEAR-VIABILITY.md`. Receipts and contracts: `CONTRACT-RECONCILIATION.md`.
Transport recommendation unchanged: keep Pear as Day 0 candidate, Pubky Noise remains a future evaluation.
