# ADR proposal (not accepted): P2P recovery root for Pubky identity and Pear sessions

Status: **PROPOSED, for CTO decision.** Number and location are the CTO's to assign. Not in `docs/` on purpose:
this branch changes no canonical documentation. Evidence: this directory, `README.md`.

## Context

Day 0 is Pubky-first identity, Pear for private communication, portable OpenProof/OpenReputation history, Paykit
for payment coordination (PR #542). Sails already separates Funds Authority, Economic Identity and Transport
identity (`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`, `docs/CRYPTOGRAPHIC_MODEL.md`); today the Pear key is
ephemeral and has no cryptographic link to any identity. Users need a recovery story across reinstall and devices
that does not reuse the WDK funds seed.

## Facts established by the prototype

1. `@synonymdev/pubky@0.16.2` restores an identity from a 32-byte secret through its public API; the secret is a
   standard Ed25519 seed. HyperDHT takes the same kind of seed. Same bytes give the same public key in both, so
   separation must come from key derivation, not from the libraries.
2. A Pubky-signed, scoped, expiring, revocable authorization bound to a Pear key, plus proof of possession,
   verifies with public data only, across integrators, and over a real HyperDHT connection.
3. Recovering keys does not recover messages or history.
4. Not established: Pubky homeserver round trip, grants, external-signer behaviour, Pear runtime, mobile.

## Decision options

**A. Single P2P root (new Sails-owned root).** One phrase restores identity and Pear keys; stable peer key.
Cannot adopt an existing Pubky identity; leak of the root exposes everything; adds a second phrase to the
user's life; epoch becomes recoverable state.

**B. Native Pubky recovery, then Pear re-authorization.** Smallest new crypto surface; compatible with identities
created elsewhere; Pear key changes at reinstall, so a directory of current Pear keys is needed for contacts to
find the user; needs a re-authorization step.

**C. (observation) Pear keys derived from the Pubky secret.** One backup, stable peer key; only where the
integrator holds the Pubky secret.

## Recommendation (engineering view, for the CTO to confirm or reject)

Make the **authorization certificate** the contract (Pubky key authorizes Pear key; scope, expiry, device,
revocation, proof of possession), since it is needed in A, B and C and is independently verifiable. Decide the
key-recovery mode separately: prefer **B**, with **C** for identities that Sails itself creates and holds, and
adopt **A** only if the product requires a Sails-owned phrase and accepts that existing Pubky identities cannot join.
Do not derive anything from the WDK seed in any option.

## Required before this can become Day 0

* Homeserver round trip and revocation/directory publication on a real or testnet Pubky homeserver.
* Decision on Pubky grants versus the custom certificate where the secret lives in an external signer.
* Security review (item list in README) and a binary versioned encoding; test vectors frozen.
* UX decision on the BIP-39 hazard; decision on whether revocation fails closed or bounded-stale by default.
* Integration design for `PearNode.start()` (today it takes no key material): out of scope here.
* No Core, schema, contract or financial change is proposed by this ADR.
