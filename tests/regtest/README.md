# tests/regtest: disposable Bitcoin regtest environment for CI (P51)

TEST INFRASTRUCTURE ONLY. Nothing here is imported by `src/`, nothing here is a gate, nothing here is production. It is **not a homologation**, it
**enables no rail**, and a green run only lets someone *request* homologation evidence. Files here are named `*.check.mjs` / `*.check.ts` on purpose:
the root Jest run only matches `**/tests/**/*.test.ts`, so none of this is picked up by `npm test`.

## Trigger
`on: push` **only** to branches `tmp/regtest-**` (one temporary remote branch, no pull request). The filter is exact, there is no
`pull_request` / `pull_request_target` / `workflow_run` / `workflow_dispatch` trigger, and the job repeats `startsWith(github.ref, 'refs/heads/tmp/regtest-')`.
The other workflows of this repository trigger only on push to `main` and on pull requests to `main`, so a push to a `tmp/regtest-*` branch starts this
workflow only. **Not tested in this repository: the first execution validates the trigger.** Fallback if the push does not trigger: a temporary Draft
pull request whose base is not `main` (it would also start `ci-tests.yml`, whose run is cancelled after confirming branch, SHA and PR with `gh api`).

## What runs (workflow `tmp-regtest-p51.yml`)
1. **Pins verified, fail closed** (`scripts/verify-pins.sh`): any value still marked `PIN_REQUIRED_*`, or malformed, stops the job before anything is downloaded.
1b. **Two self-tests with no network, before any download** (real `gpg`, throw-away keys): `scripts/gpg-count.check.sh` (the signature counter) and
   `scripts/gpg-keys.check.sh` (the vendored keys against the pins). Their sources are the very files the provenance step uses.
2. **Bitcoin Core v32.1 from the official tarball** (`scripts/provenance-bitcoin-core.sh`): sha256 vs the official `SHA256SUMS`; the sha256 pinned in the
   workflow (independent of the download of the day; both are mandatory); at least **3** valid GPG signatures by **distinct pinned primary
   fingerprints** (13 builders listed explicitly). The builder keys are **vendored** in `keys/bitcoin-core-builders/` (byte-for-byte the files of
   `bitcoin-core/guix.sigs` at a pinned commit; the sha256 of each is pinned; never a keyserver); the keyring is asserted to hold exactly the 13 pinned
   fingerprints. The `gpg` exit code is **not** used (it is non-zero whenever an unknown key also signed). Each `VALIDSIG` line is a PAIR: the signing key
   (3rd field, a subkey for builders that sign by subkey) and the **primary fingerprint (last field)**, which is the one compared with the pins. A signature
   whose **signing key** is reported revoked or expired (`REVKEYSIG`/`EXPKEYSIG`/`EXPSIG` carry the signing key's id) is **not counted**: matching that id
   against the end of the *primary* fingerprint would let a revoked subkey's signature count, which the self-test demonstrates with real gpg output.
   The installed binary reports exactly the pinned version. (There is no official Docker image of Bitcoin Core.)
3. **electrs (Esplora REST) built from a pinned commit** with `cargo build --locked`; `Cargo.lock` sha256 pinned (`scripts/build-electrs.sh`).
4. **Front proxy** (`esplora-front/server.mjs`): forwards the 7 Esplora routes the provider uses, 1:1; adds the one missing route
   `GET /v1/fees/recommended` with a **fixed, declared** rate. Own tests: `esplora-front/proxy.check.mjs`.
5. **Two full runs on fresh chains** (`scripts/run-once.sh 1`, `2`): blocks generated from zero, ephemeral RPC credentials, P2P off.
   Each run executes the **blocking fidelity test** of the 7 routes against the real bitcoind (`first-flow/fidelity.check.mjs`), the **fee negative
   case** against the real provider (`first-flow/fee-negative.check.ts`), and the scenario drivers if present (`first-flow/scenarios/`).
6. **Structural comparison** of the two runs (`first-flow/structural-compare.mjs`).
7. **Evidence**: manifest, summary, a **scan that fails the job** on any key/seed/cookie/xprv/RPC password **and on the literal value of any ephemeral secret of the
   run** (the values are written by `run-once.sh` to a directory OUTSIDE `evidence/`; the scan reads ALL the values files and FAILS if there is none at all or if a run
   directory has no values file: it never skips silently; `scripts/scan-evidence.check.sh` plants every kind of secret and proves the scan refuses it),
   then the upload (the scan gates it). A job that dies before any run has no values, so its scan fails and nothing is uploaded; the job log and the step
   summary still carry the diagnosis.

## The fee route is a declared INPUT, not market data
`FIXED_FEE_SAT_PER_VB` (workflow `env:`, currently `10`) is a constant for every tier, in the mempool.space shape. It is policy, not chain state.
It must be (a) >= the regtest node's `minrelaytxfee`, **proved by real acceptance** (`testmempoolaccept`, then a real broadcast through `POST /tx`),
and (b) <= the provider ceiling `MULTISIG_MAX_FEE_RATE_SATS_PER_VBYTE` (default 200). Negative case: the proxy answering `500` or `{}` makes the
provider **refuse** (`EscrowError`, "refusing to guess") and **zero** `POST /tx` reach the node. The evidence states that this rate does **not**
reflect the market and that the economic adequacy of the fee is **outside** this demonstration.

## Structural equality (what "the 2nd run gives the same verdict" means; written down)
Compared, key by key, in every `structure-*.json` (same file names in both runs): **states**, **refusal codes**, **values in sats**, **number of outputs**,
**output (address) types** (`p2wpkh`/`p2wsh`/`p2tr`), **number of broadcasts**, which checks passed, response field names.
Excluded **and enforced** (the comparison *fails* if a structure file contains them): **txids and any 64-hex value, block hashes, heights, block times,
timestamps, wallet addresses**. They change on every regtest run, so they can never be part of the verdict. Full txids and raw transactions live in the
audit files (`fidelity.json`), which are not compared.

## Isolation (the 8 criteria + the GK additions)
Regtest only (the job refuses any other chain); bitcoind RPC on `127.0.0.1` with **ephemeral** credentials generated per run, P2P off
(`-listen=0 -dnsseed=0 -discover=0 -networkactive=0`); the explorer must be a loopback URL (checked) and no public explorer may appear in the
environment; no secrets used (`permissions: contents: read`, 0 `secrets.*`, no `pull_request_target`, `persist-credentials: false`); `MULTISIG_SEED` and
party keys generated in the job; the datadir (wallet, cookie) is wiped on exit and **never** copied to the evidence; no `actions/cache`.

## Pins: who supplies what (nothing here is invented)
| Pin | Value / status | Supplied by, and how it was obtained |
|---|---|---|
| `BITCOIN_CORE_VERSION` | `32.1` | GK decision |
| `BITCOIN_CORE_TARBALL_SHA256` | `61545c17…4963` | GK: 13 builders attest this hash in `guix.sigs` |
| `GUIX_SIGS_COMMIT` | `a171559775c54949da8017714ddf9b5305071f73` | GK, read via `gh api`; the vendored builder keys are the files at this commit |
| `BITCOIN_CORE_BUILDER_FINGERPRINTS` | 13 primary fingerprints, threshold >= 3 distinct | GK, conferred against `guix.sigs` at the pinned commit |
| `BUILDER_KEY_SHA256S` | 13 `name sha256` lines | GK; the author re-read the 13 files from `guix.sigs` at the commit: 13/13 equal in sha256 and in primary fingerprint (same source, so this checks the transcription, not an independent trust anchor) |
| `ELECTRS_REPO_URL`, `ELECTRS_COMMIT` | `Blockstream/electrs`, `76836e20e512598634b17bb5d38c565788ca12ef` (branch `new-index`, 2026-10-26) | GK decision (not `v0.4.1`: a 2018 tag, 956 commits behind) |
| `ELECTRS_CARGO_LOCK_SHA256`, `RUST_TOOLCHAIN` | `7f2a870c…e934`, `1.92.0` | GK: the blob of that `Cargo.lock` equals GitHub's; the toolchain is the commit's own `rust-toolchain.toml` |
| Postgres / Redis `@sha256:` digests (in `services:`) | filled | the multi-arch index digest of `postgres:16-alpine` and `redis:7-alpine`, read from the Docker Hub registry API (manifest HEAD) on 2026-11-19T14:56:52Z; tags move, so this pins them as of that moment |
| `EXPECTED_SHA` | `46d93df77f1d0223262fd52a699628df5fc3e68b` | GK: for the first run (infrastructure only) main at `46d93df7` is enough |
| `EXPECTED_INFRA_TREE` | **placeholder** | the GK pins it on the final branch: `git rev-parse <infra-commit>:tests/regtest` (a tree hash is not circular: it covers `tests/regtest`, not the workflow file); it changes whenever a file under `tests/regtest` changes |
| `FIXED_FEE_SAT_PER_VB` | `10` | declared by the author, CONFIRMED by the GK |

## What the first demonstration covers, and what it does not
It covers the infrastructure, the fidelity of the 7 routes, the fixed-fee acceptance, and the fee-route negative case, and **the scenarios D7-D12 only
if their drivers are present** (`first-flow/scenarios/`, contract in `first-flow/SCENARIOS.md`). `scenarios-status.txt` says so in every run and in the
summary. **D1-D6 are NOT covered**: they depend on #235, F3 and F4, which do not exist yet. Anything not listed as `PASS` is "not demonstrated".

## Known declared surfaces (not hidden)
`apt-get install build-essential clang cmake pkg-config` on the runner is **not pinned** (Ubuntu archive). Crates come from crates.io, pinned by `Cargo.lock`.
The electrs flag set in `run-once.sh` is conventional for the Esplora fork and is **checked against `electrs-help.txt`** (written into the evidence) by the
GK before the first run. The packet is statically checked only: **nothing here has run on a real runner yet**.
