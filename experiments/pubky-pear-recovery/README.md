# EXPERIMENT: one P2P recovery root for Pubky identity and Pear sessions

Status: **prototype approved against its own tests; NOT a homologated Day 0 implementation.**
Nothing here is referenced by the Sails build, CI, Core, schemas, contracts or any financial mechanism.
It is not part of any npm workspace. Mission: CTO "Pubky + Pear Unified P2P Recovery" (2026-10-26).

> **Mission 02 update (2026-10-26).** After the CTO decision on PR #543 (model **B**: native Pubky recovery + fresh Pear key +
> re-authorization; A and C are lab comparisons only), this directory also contains:
> `homeserver/` (a REAL Pubky homeserver built from the signed `v0.16.2` tag, isolated; identity recovery, external-signer
> grants, Pear key directory, revocation, outage; PASS/FAIL/UNKNOWN matrix in `homeserver/README.md`),
> `TRANSPORT-COMPARISON.md` (Pubky Noise vs Pear), `RECEIPTS-VS-CONTRACTS.md` (gaps against OpenProof/OpenReputation) and
> `ADR-PROPOSAL.md` revision 2. The statements below about "not tested: homeserver round trip" are superseded by `homeserver/README.md`.

## Question and answer in one paragraph

Can one recovery root restore the Pubky identity **and** authorize Pear sessions, with an HD-like UX, without
touching the WDK seed? **Yes, technically, with the public SDK API and no improvised crypto**:
`Keypair.fromSecret(32 bytes)` in `@synonymdev/pubky@0.16.2` is a plain Ed25519 seed (checked against libsodium),
so a secret derived by HKDF restores the same identity deterministically. The STOP gate of the mission
(Pubky cannot restore deterministically) **was not triggered**. What was **not** proven: a full Pubky homeserver
round trip (sign-up/sign-in with the restored key), because no homeserver testnet is available in this environment.

## Reproduce

```
cd experiments/pubky-pear-recovery
npm ci --ignore-scripts
npm test                  # 51 tests (core + real HyperDHT/Hyperswarm on a LOCAL testnet, loopback only)
npm run red-green         # GREEN on the real source, RED on 20 single-check mutants (see below)
npm run vectors:generate  # rewrites vectors/test-vectors.json (deterministic)
```

Runs on Node 24.22.1 (the repo pin; Linux container) and Node 26 (Windows host). No public DHT, no homeserver,
no Satsails API and no secret is used. The only root is the public test value `00..1f`.

## Design in 60 lines

```
P2P root R (32 random bytes; shown to the user as 24 words)         not the WDK seed, not derived from it
  |-- HKDF-SHA256(salt, "sails/p2p/v1/pubky/identity")                  -> Pubky secret -> Keypair.fromSecret()
  '-- HKDF-SHA256(salt, "sails/p2p/v1/pear/device/<id>/epoch/<n>")     -> HyperDHT/Hyperswarm keyPair(seed)
Pubky key signs  PearSessionAuthorization{ sub, pear key, device, scope[], iat, exp, id }
Pear key signs   a verifier challenge (audience + nonce + auth id)   = proof of possession
Pubky key signs  Revocation{ target: auth id | pear key | device id (+ iat) }
Pubky key and counterparty sign  EconomicReceipt chain (hash-linked)  = portable history
```

* `src/kdf.mjs` root, mnemonic, HKDF, Pubky restore (with an SDK drift guard), Pear key from seed.
* `src/issue.mjs` secret side (user devices). `src/verify.mjs` public side: **only public keys**, used by integrators.
* `scripts/verify-bundle.mjs` is a stand-alone integrator verifier; a test runs it in a separate process.
* Scopes are transport-only (`pear:connect`, `chat:read`, `chat:send`, `offer:negotiate`, `proof:present`);
  there is no funds scope. Lifetime cap 30 days. Revocation fails **closed** by default.
* Encoding is canonical JSON with domain-separation prefixes. A production format should be binary/versioned.

## Mission steps and what was actually done

| # | Step | Result |
|---|---|---|
| 1 | Audit real SDK versions | Done: registry + installed tree + type definitions + behaviour (matrix below). Protocol specs and Rust sources were **not** read. |
| 2 | Pubky deterministic restore | Proven for the JS SDK: 32-byte secret -> same key in every run, process and OS (Windows host, Linux container). |
| 3 | Isolated prototype, root independent of WDK | Done. A test asserts the sources read no env and import nothing from the repo. |
| 4 | Distinct keys / separation | Done, plus a documented hazard: the same raw seed gives the **same** public key in Pubky and HyperDHT. |
| 5 | Signed Pubky->Pear authorization | Done: expiry, scope, device, revocation, proof of possession, audience-bound single-use challenge. |
| 6 | Reinstall, 2nd device, recovery, cross-integrator | Done (local). Cross-integrator = separate process, public data only. |
| 7 | Negative tests | Done: wrong key, replay, revoked, data loss, compromised session, infrastructure down. |
| 8 | Compare single root vs native recovery + re-authorization | Done below, measured where marked. |

Numbers (only for what was run): **51/51 tests pass** (Node 24.22.1 Linux and Node 26 Windows); **20/20 mutants detected**.
Test counts are not a security claim: they say the checks that exist are exercised.

## Compatibility matrix (versions actually installed, 2026-10-26)

| Component | Version | Registry state | Role / finding |
|---|---|---|---|
| `@synonymdev/pubky` | 0.16.2 (MIT, WASM) | latest, 2026-10-15; 0.11 -> 0.16 in ~8 weeks | `Keypair.fromSecret/secret/createRecoveryFile/fromRecoveryFile`. **No raw sign() on Keypair**, **no mnemonic API**. Rapid 0.x churn: pin and keep the drift guard. |
| `hyperdht` | 6.34.1 (MIT) | latest, 2026-10-05 | `DHT.keyPair(seed)` takes a raw Ed25519 seed. Repo range `^6.33.2` accepts it. |
| `hyperswarm` | 4.17.2 (MIT) | latest, 2026-09-22 | Accepts the derived key as swarm identity (tested). Repo range `^4.17.0`. |
| `@hyperswarm/secret-stream` / `noise-handshake` | 6.9.2 / 4.2.0 | transitive | The connection authenticates the remote Ed25519 key: `socket.remotePublicKey` equals the derived Pear key (tested). |
| `sodium-universal` / `sodium-native` | 5.0.1 / 5.2.0 | latest | Signing and verification of all documents. Repo range `^5.1.0`. |
| `pear` (CLI) / `bare-runtime` | 3.0.0 / 1.36.0 | latest | Not exercised: the prototype uses the libraries Pear apps are built on, not the Pear runtime or Pear app packaging. |
| `@scure/bip39` | 2.4.0 | latest | 24-word encoding of the root. |
| `@synonymdev/pkarr` | 8.1.0 | latest | Not used directly (Pubky bundles its own). |

Limitations of the SDKs, as observed:

1. Pubky JS cannot sign arbitrary bytes: the authorization is signed with libsodium **using the same seed**
   (public keys are proven identical). No curve conversion was needed or done.
2. Pubky's own delegation (grants: `GrantManager.revoke`, `expiresAt`, proof of possession) exists but needs a
   homeserver; it was not exercised. Its API shape (app requests, a signer device approves) suggests an **external
   signer never hands the integrator its secret**. In that case neither single root nor any derivation from the
   Pubky secret is possible and the integrator must use grants. This is inference from the type definitions.
3. The previous Sails discovery doc listed Pubky's HD/mnemonic behaviour as UNKNOWN. Answer for the JS SDK: no
   HD tree, no mnemonic API; one 32-byte secret = one key; the secret may also be exported as a recovery file
   (salted, so not byte-deterministic) or a `SeedExportDeepLink`.
4. HyperDHT has no revocation, rotation continuity or delegation: everything lives in the Sails certificate layer.

## Single root (A) vs native recovery + re-authorization (B)

"Measured" = asserted by a test. "Analysis" = follows from the construction, not measured.

| Dimension | A: single P2P root | B: native Pubky recovery, then Pear re-authorization | Evidence |
|---|---|---|---|
| Secrets the user must keep | 1 (24 words) for identity + all Pear keys | Pubky recovery file/secret only; Pear keys are device-local and not backed up | analysis |
| Pear peer key after reinstall | **same** (re-derived) | **new** random key | measured |
| New authorization after reinstall | not required if the certificate was kept (re-issue is possible) | **required** (old certificate has no key to prove possession) | measured |
| Contacts that saved the old peer key | still reach the user | cannot, unless a Pubky-side directory of current Pear keys exists (needs homeserver) | measured / not tested |
| Past stored ciphertexts if the secret leaks | root leak exposes identity **and** every Pear key, past and future epochs | identity leak does not expose Pear keys | analysis (HKDF one-wayness assumed) |
| Lost/stolen device | revoke by auth id, device id or Pear key; short TTL bounds exposure | same | measured |
| Compromised Pear session | cannot mint authorizations, bounded by scope and expiry | same | measured |
| Rotating a Pear key | new `epoch` number; the epoch is **extra state to remember or search** | generate a new key | measured / analysis |
| Adopt a Pubky identity created elsewhere | **impossible**: HKDF output cannot equal an existing key | possible | analysis |
| Works if the user's secret stays in an external Pubky signer | no | only through grants (not tested) | inference |
| Dependency on SDK internals | `fromSecret` seed contract (guarded) | recovery-file/grant APIs | measured |
| UX | one phrase, like a wallet; two phrases next to the WDK seed | existing Pubky recovery + one re-authorization prompt per reinstall | analysis |

Observation C (not requested, tested): derive Pear keys from the **Pubky secret** instead of a separate root.
One backup, stable peer key, works for any Pubky secret the integrator holds (including one restored from a
Pubky recovery file). Costs the same blast radius as A and still cannot cover an external-signer identity.

Neither alternative recovers messages: **key recovery is not message recovery** (tested: a ciphertext blob is
readable after recovery only if the blob itself survived and the same epoch key is re-derived; the root contains
no copy of anything). History is the same: recovering the root restores the ability to sign, not the receipts.
A truncated history is invisible without a pinned head (tested), so the history needs replication plus an anchor.

## Negative tests and RED/GREEN

`npm run red-green` copies `src/` 20 times, removes exactly one check each time and runs the suite
(`test/_helpers.mjs` loads the code under test from `PPR_SRC`). All 20 mutants make at least one test fail:
no signature check, no expiry, no not-before, no lifetime cap, subject not pinned, scope not enforced, replayable
challenge, challenge not bound to audience, no proof of possession, revocation ignored, revocation **fail-open**,
revocation signature unchecked, unbounded stale cache, no domain separation, epoch ignored, history link /
signature / co-signature / head checks removed, SDK seed-contract guard removed.
Honest note: the first run detected **18/20**. Two checks (audience binding in the challenge store, the SDK
drift guard) were not covered; tests were added and the run repeated: 20/20.
A harness defect was also found by running on the pinned Node: `node --test test/` works on Node 26 but fails on
Node 24; the script now uses a glob.

## Not tested / pending

* Pubky homeserver sign-up/sign-in with the restored key, PKARR/PKDNS publication, Pubky grants and directory records.
* Publishing revocations to a real Pubky location and the staleness policy against a real outage (only simulated).
* Pear runtime / Pear app packaging, mobile (Bare) builds, background execution, QVAC interaction.
* OpenProof / OpenReputation / Paykit formats: the receipt chain is a stand-in that shows verification with public
  data only; it is **not** compatible with any of them.
* Real DHT (public mainline/HyperDHT) behaviour, NAT, relays; only a loopback testnet was used.
* Security review of: HKDF reuse of the Ed25519 seed as IKM for Pear seeds (option C), epoch storage,
  canonical JSON, clock skew, memory zeroization (best effort in JS), the BIP-39 hazard below.
* Hazard: the 24-word encoding of the root is a valid BIP-39 phrase. A user can paste it into a Bitcoin wallet
  (empty wallet) or paste the wallet phrase here (reuse of the funds seed). UX decision for the CTO.
* Test vectors are derived from the public test root `00..1f`; they are not secrets and must never be used for a real identity.
