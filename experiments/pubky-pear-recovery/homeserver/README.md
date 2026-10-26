# Mission 02: real Pubky homeserver, native recovery, grants, Pear directory

Status: **experiment. Prototype results, not a Day 0 GO.** Nothing here touches Core, schemas, seeds, contracts or CI.
Decision applied (CTO comment on PR #543): model **B**, native Pubky recovery + fresh Pear key + re-authorization.
No Sails-owned seed, no Pear key derived from the Pubky secret.

## Reproduce

```
# 1. build the upstream testnet image from the signed tag (needs Docker; ~11 min, ~5 GB of build cache)
git clone --depth 1 --branch v0.16.2 https://github.com/pubky/pubky-homeserver.git pubky-src
git -C pubky-src rev-parse HEAD        # must print f60e502fb4fc6fc74ebf7dd14c95cfd86b10aea3
docker build --build-arg BUILD_TARGET=testnet -t ppr-pubky-testnet:v0.16.2 pubky-src
# 2. runner + whole experiment
docker build -f homeserver/Dockerfile.runner -t ppr-runner:dev .
node homeserver/orchestrate.mjs up       # internal network, PostgreSQL 18, testnet; waits for the PKARR publish
node homeserver/orchestrate.mjs all      # suites 01..04 (04 freezes and thaws the homeserver)
node homeserver/red-green.mjs            # 12 policy mutants against the real homeserver
node homeserver/orchestrate.mjs down
```

Isolation: docker network `--internal` (no egress: `fetch('https://example.com')` fails with `EAI_AGAIN`), no published
ports, throwaway PostgreSQL password, test passphrases only, no wallet seed, no personal data. The runner shares the
testnet's network namespace so `localhost` reaches it. Every "device" is a separate OS process or container.

## Provenance of what ran

| Item | Value | How verified |
|---|---|---|
| Source | `pubky/pubky-homeserver` tag `v0.16.2`, commit `f60e502fb4fc6fc74ebf7dd14c95cfd86b10aea3`, tree `836e0b7b7be09f84b6430779a58c6829a4767456` (`source-provenance.txt`) | tag is annotated and **GitHub-verified signature** (`verification.verified=true`); clone HEAD equals the API commit; working tree clean |
| Same commit elsewhere | `@synonymdev/pubky@0.16.2` on npm has `gitHead` = that commit and an SLSA provenance attestation | `npm view`; `npm audit signatures`: 67 packages with verified registry signatures, 30 with verified attestations |
| Build recipe | upstream `Dockerfile`, `BUILD_TARGET=testnet`, `cargo build --release` with the committed `Cargo.lock` (sha256 `5c953dc5...`) | file hashes in `source-provenance.txt` |
| Base images | `rust:1.89.0-alpine3.20` = `rust@sha256:8476b180...ba527`; `alpine:3.20` = `alpine@sha256:d9e853e8...b6bc`; `postgres:18` = `postgres@sha256:edb0c08d...ddb6` | digests recorded after pull; image **signatures were not verified** (Docker Official Images) |
| Result | image `sha256:ea623e19...bf9e`, 39 MB; binary `/usr/local/bin/homeserver` sha256 `01a6b45e564b8438...cd06fb` | `artifact-binary.txt`, `running-image.txt` |
| Not done | build not compared bit-for-bit with the upstream release tarball (assets have only GitHub-computed digests; no checksum file, no GitHub attestation: `attestations` API returned 404) | stated limit: this is "source-built from a signed tag", not "verified upstream binary" |

STOP rule respected: the binary was built from verified source; nothing unverified was executed.

## Results matrix (PASS / FAIL / UNKNOWN)

Counts: 22 homeserver tests + 12/12 policy mutants + 51 earlier lab tests + 5 contract-gap tests, all on the real artifacts above.
A PASS is a property of THIS prototype in THIS environment, not of production.

| # | Item | Result | Evidence / limit |
|---|---|---|---|
| 1 | Real homeserver from verified source, isolated | **PASS** | provenance table; egress proof |
| 2 | Identity creation (signup, root signin, write, stranger public read) | **PASS** | R1 |
| 3 | Login after **native** recovery (recovery file + passphrase, fresh process) | **PASS** | R2; same pk, old data visible |
| 4 | Recovery negatives: wrong passphrase, flipped byte, truncated | **PASS** | R3 |
| 5 | Recovery by mnemonic / Ring / seed deep link | **UNKNOWN** | JS SDK 0.16.2 has no mnemonic API; Ring not available here |
| 6 | Grants with an external signer; integrator never holds the secret | **PASS (process level)** | G1: separate process, minimal env, secret absent (hex/base64/base64url) from bearer export and grant bundle; `cnf` key differs from identity. A real signer app (Ring) was not used: **UNKNOWN** |
| 7 | Scope enforced by homeserver; signer can narrow; revoke cuts only that integrator | **PASS** | G2, G3, G5 |
| 8 | Grant lifetime chosen by the signer | **FAIL (limitation)** | every grant is 63 072 000 s (2 years); the signer API has no TTL parameter (G4) |
| 9 | Publish + discover Pear key directory, verified by a second integrator with no grant | **PASS** | P1; `publicStorage.list/getJson` |
| 10 | Directory integrity against a malicious/stale homeserver | **UNKNOWN** | trusted-homeserver assumption; not tested |
| 11 | Pear authorization without exporting the Pubky private key | **PASS** | chain: Pubky root signs grant (cnf = integrator PoP key) -> PoP key signs statement (`createCustomPop`) -> Pear key signs binding |
| 12 | Delegation-chain attacks: read-only grant, foreign identity, forged binding, tamper, wrong audience/client, over-long TTL, undeclared scope | **PASS** | P3, P4, P8 |
| 13 | Transport scopes decided by the user, not the integrator | **PASS (by design choice)** | scopes are mapped to approved storage capabilities (P8); without that the integrator would self-declare them |
| 14 | Expiry: statement-level | **PASS** | P7 (3 s statement lapses) |
| 15 | Expiry: grant-level, offline SDK verifier | **PASS** | P7 (clock shifted past 2 years -> `Grant has expired`) |
| 16 | Expiry: grant-level enforced by the homeserver | **UNKNOWN** | not waitable (2 years) |
| 17 | Revocation takes effect at the homeserver | **PASS** | G5, P5a |
| 18 | Revocation discovered by another integrator: **offline** verification | **FAIL** | `verifyCustomGrantPop` succeeds after revoke (documented upstream: "does not check revocation") |
| 19 | Revocation discovered by another integrator: online | **PASS, undocumented** | `POST /auth/grant/session` with the public grant and a wrong PoP answers `401 Grant has been revoked` because the server checks revocation before the PoP (source: `service.rs` pipeline). Behavioural, not a contract |
| 20 | Revocation by signer-side delete of the directory record | **PASS** | P5d; only works if the signer app deletes it, an unrelated signer will not |
| 21 | Second device + second integrator; revoke one device only | **PASS** | P6 |
| 22 | Homeserver unavailable: new authorization refused (fail closed) | **PASS** | O2 (probe deadline 8 s) |
| 23 | Homeserver unavailable: SDK deadlines | **PARTIAL** | signin and restore fail by themselves after ~5 s (PKARR timeout); public `list` never returned: only the caller's deadline stopped it (O3) |
| 24 | Recovery after outage: record verifies, saved bearer works, signer signs in | **PASS** | O4 |
| 25 | RED/GREEN | **PASS** | 12/12 mutants detected on the first run; none survived (no iteration needed) |
| 26 | Pear runtime, mobile, public-DHT NAT/relay, Pubky Noise runtime | **UNKNOWN** | not run in this mission |

Exit criterion of the mission: native recovery **PASS**; new communication device authorized without exposing the
private key **PASS**; revocation and discovery by another integrator **PASS only with an online probe or a directory
delete, FAIL with offline verification alone**. Therefore: criterion met for the prototype, with one documented
dependency (online revocation status) that rests on undocumented homeserver behaviour.

## Findings that change the design

1. **Native grants + `createCustomPop` already are the delegation primitive.** A Sails "transport certificate" is
   not needed as a parallel policy: the grant is the authority, the PoP-signed statement binds the Pear key.
   Bound lifetime of any service session by the verified grant `exp` (upstream guidance) *and* by a short statement `exp`.
2. **The user only approves storage capabilities.** The JS signer cannot sign a service-specific claim. To avoid the
   integrator choosing transport scopes, each scope is expressed as a capability path (`.../scopes/chat-send/`); the
   signer's narrowing then decides the scopes (P8). Rust Paykit has `approve_auth_with_companion_claim`; no JS equivalent in 0.16.2.
3. **2-year grants + no third-party revocation API.** Short statements (<= 1 h here) and re-attestation by the integrator
   bound the damage window; immediate revocation needs an online status probe (undocumented) or a signer-side directory delete.
   Ask Pubky for a documented grant-status endpoint (or a signed revocation feed) before Day 0.
4. **Readiness race:** the homeserver is resolvable only after its PKARR packet is published (a few seconds after
   the relay answers). The first full run failed 3 suites for that reason; the harness now waits for it.
5. **Deadlines:** callers must set their own for storage listing; PKARR resolution is bounded (~5 s).
6. **Test-environment facts:** the testnet stores files in memory; PostgreSQL 18 is required; grant default lifetime is 2 years.

## Not tested / pending

Real signer app, mnemonic/seed export recovery, directory authenticity vs a hostile homeserver, homeserver-side grant
expiry, GCS/production storage backend, mainnet PKARR/DHT, rate limits, multi-homeserver, Pear runtime/mobile,
Pubky Noise runtime, key rotation, privacy of a public directory (device list is public).
