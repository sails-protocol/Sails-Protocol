# Pubky Noise vs Pear (HyperDHT/Hyperswarm) for Day 0 chat

Scope: investigation from source, registries and docs read on 2026-10-26. **Pubky Noise was not built or run**; its
rows are reading, not measurement. The Pear rows marked "tested" come from PR #543 (local testnet, loopback).
No promotion or removal is proposed on inference alone (CTO gate).

## Does Paykit use Noise? Yes

`pubky/paykit-rs` README (default branch): "private messages are exchanged through `pubky-noise`". Paykit minimum
homeserver is **0.16.2**, and Pubky-backed shared-state recovery requires **GCS storage on every serving instance**;
unverified user-selected homeservers are not supported for it. Paykit also ships Swift/Kotlin bindings (UniFFI).

## What Pubky Noise is

Rust crate `pubky-noise` 0.1.0 (published 2026-10-16; repo created 2026-03). Noise (`snow`, XX/NN, ChaCha20-Poly1305,
SHA-256) where each peer writes ciphertext slots to **its own homeserver** and reads from the other's (outbox model).
Per-pair storage paths come from an X25519 DH of the two Ed25519 identities. Session snapshots can be encrypted and
stored on the homeserver for restore. Identity binding: the Ed25519 PKARR key signs the Noise static key.

## Comparison

| Criterion | Pear: HyperDHT/Hyperswarm | Pubky Noise (via homeserver) |
|---|---|---|
| Delivery | live, connection-oriented; both peers online. Offline delivery needs another layer (hypercore/autobase/blind-peering, not tested) | **store-and-forward by design**: sender writes, receiver polls later. Needs both homeservers up |
| Privacy of content | Noise-authenticated stream to the peer's Ed25519 key (tested: `socket.remotePublicKey` equals the authorized key). Stored data needs app-layer encryption | Noise AEAD end to end; homeserver sees ciphertext only |
| Metadata | DHT lookups reveal topic/public key activity; peers learn each other's IPs | homeserver operators see who writes/reads which slot, sizes and timing (paths hide the pair from third parties, not from the operator); no direct IP exposure between peers |
| Identity binding | none native; Sails certificate layer (tested) | native: Ed25519 PKARR key signs the Noise static key |
| Key custody | per-device random key fits model B (tested) | `PubkyNoiseConfig` takes a 32-byte **root Ed25519 secret** (identity binding signature, DH path derivation, optional snapshot key). Paykit's answer is a derived "Paykit secret" that an authorizer hands to delegated apps = the construct the CTO did not adopt for Pear keys. A pure external-signer integrator cannot run it unless the signer does signing/DH for it (not offered) |
| Revocation | none native; grant revocation + directory (this mission) | grant revocation at the homeserver; Paykit rotates a key generation and resets link state |
| Device portability | key = identity; multi-device not native | identity-level keys and shared encrypted state on the homeserver; needs the secret or a delegated key on every device |
| Language / integration for Sails (TypeScript/Node) | native JS/TS today (Sails already uses `hyperdht ^6.33.2`, `hyperswarm ^4.17.0`; `TransportProvider` interface exists) | **Rust only**; no npm package; Swift/Kotlin via Paykit FFI. Node would need a Rust binding, a sidecar or a port |
| Mobile | Bare runtime active (`bare-runtime` 1.36.0); mobile behaviour not tested here | Paykit has iOS/Android bindings; `pubky-noise` itself is a plain Rust crate; not tested here |
| Maturity | hyperdht repo 2018, hypercore 2015, hyperswarm 2018; pushed within the last 5 weeks; MIT/Apache | `pubky-noise` v0.1.0 ten days old, 4 stars, 17 open issues, 6 contributors, ~2.5k crate downloads; `paykit` 0.1.0 on crates.io (~50 downloads) after 77+ release candidates on GitHub (rc49 on 2026-08-28 to v0.1.1-rc1 on 2026-10-20). **No LICENSE file** in the `pubky-noise` repo (GitHub reports none; Cargo says MIT) |
| Security review | none known to me for either; Pear's Noise stack is widely used (not verified here) | none found; library is explicit that deadlines, retries and persistence are the caller's job |
| Operational complexity | no server needed (public bootstrap, or self-host); hole punching/relay behaviour untested here | needs a reliable homeserver per user, GCS-backed for Paykit recovery; polling; deadlines to set (README notes Pubky 0.16.2 disables native HTTP timeouts by default) |
| Coupling | independent of Pubky; a Pubky outage does not stop live chat | chat availability = homeserver availability |

## Recommendation (for the CTO to accept or reject)

**Composition, minimal: keep Pear for live negotiation chat on Day 0; use the Pubky identity, grants and the public
Pear-key directory (this mission) for identity and authorization; do not adopt Pubky Noise for Day 0 chat.**
Reasons: (1) no JS/TS implementation and a 10-day-old v0.1.0 without a licence file; (2) it needs the Ed25519 root
secret or a derived delegated secret, which collides with the "no export / no C" decision for external signers;
(3) its main advantage, offline delivery, is not a Day 0 chat requirement that Pear cannot approach with an extra
layer, and that layer is untested either way.
Keep a **decision point, not a rejection**: when Sails needs offline payment coordination or Paykit interoperability,
evaluate Pubky Noise behind `TransportProvider` (`src/infrastructure/p2p/transport-provider.ts`), after (a) a licence,
(b) a JS/WASM or FFI route, (c) a delegated-key model that does not give the integrator the root secret.
This does **not** remove Pear's own open gaps: offline delivery, mobile, NAT/relay in production, revocation (all UNKNOWN here).

## Evidence

`p2-evidence/pp2/transport-audit.txt` (crates.io, npm, GitHub metadata), `pear-ecosystem-audit.txt`; README and source
of `pubky/pubky-noise` and `pubky/paykit-rs` read through the GitHub API on 2026-10-26.
