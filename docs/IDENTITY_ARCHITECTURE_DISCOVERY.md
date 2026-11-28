# Identity Architecture Discovery — Recovery Root & Multi-Protocol Identity

**Type:** Architecture Discovery (OpenIdentity / Protocol UX / Privacy).
**Status:** evidence-gathering only. **No implementation, no ADR, no
derivation scheme, no schema change authorized by this document.**
**Origin:** CTO mission, 2026-09-08, follow-on to the backlog obligation
registered in `docs/BACKLOG.md` ("Identity Root & Multi-Protocol
Identity UX", merged via PR #91). That entry registered *that* the
obligation exists; this document investigates *what is actually true*
about each protocol involved, so a future ADR has real evidence instead
of assumption.

**CTO Correction Pass (2026-09-08).** The original pass of this
document overstated NIP-06's standing — describing it as an "official,
merged NIP" and "correlation-resistant by design" without checking its
own status tags. Directly re-verified against
`nostr-protocol/nips/06.md`, `26.md`, and `46.md`: **NIP-06 and NIP-26
are both `draft`/`unrecommended`/`optional`** (NIP-06 explicitly warns
"prefer a single nsec"; NIP-26 warns "adds unnecessary burden for
little gain"); **NIP-46 carries no such marker** (verified active,
non-deprecated). Every affected passage below (§3.4, §4's matrix, §5's
model comparison and assessment table, §5.1's Breez addendum, §6-§7,
§13, §15) has been corrected in place, preserving the underlying
technical facts (the derivation scheme is real and technically sound)
while removing the overclaimed endorsement/correlation-resistance
language. This does not change the document's B/STOP verdict.

---

## 1. Scope

**Central question:** how can Satsails/Sails offer a simple backup/
recovery experience — potentially based on a single recovery root —
while preserving independent keys, trust domains, privacy, and
lifecycle per protocol?

Preserved throughout this investigation, per the CTO's own framing and
this repository's existing `CRYPTOGRAPHIC_MODEL.md`/`TRUST_BOUNDARY.md`
discipline:

- **Funds Authority ≠ Economic Identity ≠ Transport/Communication
  Identity.**
- **Same recovery root ≠ same private key across protocols.**
- **Deterministic recoverability must not imply publicly correlatable
  identities across protocols.**

This document does not choose a KDF, a derivation path, a schema, or a
primitive. It answers: what does each candidate protocol actually
support today, and what does that imply for four candidate recovery
models.

---

## 2. Existing Sails identity model — as it actually is today

Verified directly against the code (`docs/CRYPTOGRAPHIC_MODEL.md`,
`prisma/schema.prisma`, `identity.service.ts`, `pear.service.ts`,
`wdk-settlement.provider.ts`), not assumed:

- **Economic/participant identity** (`User.publicKey`) — a single
  Ed25519 keypair, client-generated, registered via
  `POST /v1/identity/register`. This is the identity `ParticipantIdentity`
  (RFC-001) refers to; authentication is challenge-response
  (`common/middleware/auth.ts`), not password-based.
- **Transport identity** (`User.peerId`, Pears/HyperDHT) — **a real,
  live documentation-drift finding, confirmed while writing this
  document, not previously flagged anywhere:**
  `docs/CRYPTOGRAPHIC_MODEL.md` §1 (written 2026-07-19) still states
  "the same keypair *is* the node's HyperDHT/Hyperswarm identity...
  There is no separate 'network key' — this is one primitive, not two,
  confirmed by grep." **This is no longer true.** `pear.service.ts`'s
  2026-08-09 key-custody fix (already correctly disclosed in
  `docs/TRUST_BOUNDARY.md` Boundary 1b and `docs/BACKLOG.md`'s
  2026-09-06 entry) changed `PearNode.start()` to take **zero**
  caller-supplied key material — it calls `HyperDHT.keyPair()` with no
  seed, generating a **fresh, ephemeral, unpersisted** keypair every
  session (confirmed directly:
  `src/infrastructure/p2p/pear.service.ts:119-123`, `async start():
  Promise<string>` takes no arguments at all). `User.peerId` is
  therefore: (a) unrelated cryptographically to `User.publicKey`, and
  (b) not even stable across sessions in the current implementation —
  it is regenerated per `start()` call, not a persistent per-participant
  transport identity today. **Not fixed here** (out of this document's
  discovery-only scope) — flagged for the CTO in the return, since
  `CRYPTOGRAPHIC_MODEL.md` making a false "one primitive, not two" claim
  is exactly the kind of stale-claim risk this repository's own
  discipline (`docs/BACKLOG.md`'s "Current Truth" entries) exists to
  catch.
- **Funds authority** (WDK_USDT_EVM) — a third, separate secp256k1 key
  domain: one server-held `WDK_SEED_PHRASE` deterministically derives a
  treasury account and per-trade escrow sub-accounts (tradeId-salted
  index, `wdk-settlement.provider.ts`). This is a real, already-shipped
  example, inside this codebase, of "one seed → many deterministically
  derived, domain-separated child keys" — but *within one protocol*
  (EVM/WDK), not across protocols. Cited here as an internal precedent
  for Model A/B's derivation pattern, not as evidence those models are
  already implemented cross-protocol.
- **Reputation** (`User.reputationScore` et al.) is anchored to the
  economic identity row (`User.id`/`publicKey`), not to `peerId` or any
  external protocol key.

**Net:** three real, already-distinct key domains exist today
(Ed25519 economic identity, ephemeral Ed25519 Pears session identity,
secp256k1 WDK funds authority), with **zero** cryptographic binding
between any of them — the association is entirely server-mediated
(a database row), confirmed, not new. No protocol beyond Pears has any
representation in the current implementation at all.

---

## 3. Protocol-by-protocol research

Each entry cites its evidence class per the mission's own scale:
**OFFICIAL SPEC**, **OFFICIAL IMPLEMENTATION**, **OBSERVED
IMPLEMENTATION**, **INFERENCE**, **UNKNOWN**.

### 3.1 Bitcoin / wallet seed

- **Key type:** secp256k1 (ECDSA, or Schnorr for Taproot). **OFFICIAL
  SPEC** (BIP-340/341 for Taproot/Schnorr).
- **Seed/mnemonic:** BIP-39 mnemonic → BIP-32 seed. **OFFICIAL SPEC.**
- **Deterministic derivation:** yes — BIP-32 HD tree, BIP-44/49/84/86
  standardize purpose-specific derivation paths
  (`m/purpose'/coin_type'/account'/change/index`). **OFFICIAL SPEC.**
- **HD derivation support:** native, the origin of the concept.
- **Identity stability:** addresses are meant to be single-use/rotating
  by convention; the *root* (xprv) is long-lived. Bitcoin has no notion
  of "identity" beyond key ownership.
- **Device-specific keys:** not native — a seed is typically shared
  across a user's devices via the same mnemonic, or per-device via
  separate accounts/paths (wallet-software convention, not a BIP).
- **Multi-device:** via watch-only xpubs (public derivation) for
  balance-viewing without secret exposure; spending requires the
  secret on at least one device. **OFFICIAL SPEC** (BIP-32 public
  derivation).
- **Rotation:** address rotation is native and routine; *root key*
  rotation is not a protocol concept — compromise of the root requires
  moving all funds to a new seed (a migration, not a protocol-level
  rotation).
- **Revocation:** no native concept.
- **Delegation:** not native (multisig/PSBT co-signing is a related but
  distinct mechanism, not delegation of a single identity).
- **Public key = identity?** No general notion of "identity" at the
  protocol level; an address is a spending target, not an identity.
- **Accepts external root?** N/A — BIP-32 *is* the "external root →
  derived children" mechanism other protocols (including NIP-06 below)
  explicitly reuse.
- **Official spec existing?** Yes (BIP-32/39/44/etc.), extremely mature.
- **Derivation-incompatibility risk:** low for BIP-32-compatible
  protocols (Nostr already reuses it); zero compatibility with non-HD
  protocols (Pears/Iroh's raw `keyPair(seed)`, Pubky's model — see
  below) without a bridging KDF, which this document does not choose.
- **Import/export of secret:** mnemonic export is the standard, expected
  UX across the entire wallet industry.
- **Recovery on another device:** mnemonic re-entry — the best-understood
  recovery UX in this entire investigation, by a wide margin.
- **Dependency on external metadata:** none — fully self-contained given
  the mnemonic (plus optional passphrase).
- **Effect of key loss:** total, irreversible loss of funds at that
  address tree (absent a separate backup).
- **Effect of key compromise:** total loss of funds reachable from the
  compromised derivation depth downward.
- **Relation to reputation/history:** none at the protocol level (no
  reputation primitive exists in Bitcoin itself).

### 3.2 Sails participant/economic identity

Already detailed in §2. Summary for the matrix: Ed25519, no native seed
phrase of its own (client-generated keypair, `publicKey` registered
directly — see `identity.service.ts:register()`), no HD derivation
scheme defined by the protocol itself (`docs/PROTOCOL_SPECIFICATION.md`
§1.1 is explicitly technology-neutral on how a Reference Implementation
satisfies the "Portable Identity Layer" above Level-0 keys). Stable,
long-lived by convention (one `User` row per registered `publicKey`
forever). Rotation/revocation/delegation: **not specified anywhere in
the protocol** — `docs/PROTOCOL_SPECIFICATION.md` §1.1's growth path
(Keys → DID → Credentials → Trust Graph) is additive but silent on what
happens if Level-0 keys themselves need to rotate. **REPOSITORY
OBSERVED**, not **OFFICIAL SPEC** — there is no RFC or spec section
addressing identity-key rotation for `ParticipantIdentity` at all
(confirmed by search: no hits for "key rotation" combined with
`ParticipantIdentity`/`User.publicKey` anywhere in `docs/` or `rfcs/`).
This is itself a real, disclosed gap this document surfaces, not
overclaimed as "handled."

### 3.3 Pears / HyperDHT

- **Key type:** Ed25519 (`HyperDHT.keyPair()`). **OFFICIAL
  IMPLEMENTATION** (holepunchto/hyperdht README, confirmed via direct
  fetch).
- **Seed/mnemonic native to the protocol?** No BIP-39-style mnemonic —
  `DHT.keyPair([seed])` accepts an optional raw seed argument (a
  32-byte buffer, by convention with libsodium-family Ed25519
  generation), but the README does not document its exact byte
  format/length requirement or provide a companion mnemonic-encoding
  standard. **OFFICIAL IMPLEMENTATION for "accepts a seed input";
  UNKNOWN for exact byte-level contract** (not fabricated from
  reading source not fetched in this pass).
- **Deterministic derivation:** one seed → one fixed keypair
  (`keyPair(seed)`); **no HD tree, no official multi-child derivation
  standard** documented anywhere in the fetched material. **OBSERVED
  IMPLEMENTATION.**
- **HD derivation support:** not natively — a caller would have to
  build their own KDF on top of a single seed input, same class of gap
  Iroh/Pubky share below.
- **Identity stability:** **ephemeral in Sails' current usage**
  (§2 finding) — `PearNode.start()` never passes a seed at all, so
  every session gets a brand-new, unpersisted keypair. This is a Sails
  implementation choice, not a HyperDHT protocol limitation — HyperDHT
  itself supports a persisted `keyPair`/`seed` perfectly well; Sails
  simply doesn't use that capability today.
- **Device-specific keys:** not modeled by HyperDHT itself; whatever the
  integrator does with the `seed` parameter.
- **Multi-device:** no native concept; would be entirely
  integrator-built on top of the seed parameter.
- **Rotation:** trivial mechanically (generate a new keypair), but
  **no protocol-level announcement/continuity mechanism** — a rotated
  `peerId` is, from the DHT's point of view, simply a different node
  with no relationship to the old one, unless the application layer
  (Sails) records that relationship itself (which it does not today —
  confirmed, `User.peerId` has no history/rotation table).
- **Revocation:** no native concept (consistent with no rotation
  continuity mechanism).
- **Delegation:** not documented.
- **Public key = identity?** Yes, directly — "peers are identified by a
  public key, not by an IP address" (HyperDHT README).
- **Accepts external root?** Yes, mechanically (`seed` parameter) —
  but with the byte-contract caveat above.
- **Official spec existing?** No formal spec document found (this is a
  software project's own README/source, not a standards-track
  specification) — **OFFICIAL IMPLEMENTATION**, not **OFFICIAL SPEC**.
- **Derivation-incompatibility risk:** low mechanically (accepts any
  32-byte-shaped input), but zero standardization — any Sails-chosen
  derivation path is a Sails convention, not an interoperable standard
  another Pears-based application would recognize.
- **Import/export of secret:** whatever the integrating application
  chooses to build; HyperDHT itself has no export/import UX.
- **Recovery on another device:** possible only if Sails itself starts
  persisting and re-deriving the seed (not done today).
- **Dependency on external metadata:** none at the DHT layer.
- **Effect of key loss:** loses reachability at that `peerId` — no
  funds/economic consequence directly (transport only), but see §9 for
  reputation-continuity implications if `peerId` were ever bound to
  reputation (it is not, today — confirmed §2).
- **Effect of key compromise:** an attacker can impersonate that
  transport identity to other peers (MITM/social-engineering risk at
  the P2P layer) — mitigated at the application layer today by
  `payload-crypto.ts`'s sealed-box scheme and structured-message-only
  parsing (RFC-016), not by any Pears-native revocation.
- **Relation to reputation/history:** none — confirmed §2, reputation
  anchors to `User.id`/`publicKey`, never to `peerId`.

### 3.4 Nostr

- **Key type:** secp256k1 (Schnorr signatures, same curve family as
  Bitcoin/Taproot). **OFFICIAL SPEC** (NIP-01).
- **Seed/mnemonic native?** Not required by the core protocol (a bare
  32-byte secp256k1 key suffices). **NIP-06 defines a deterministic
  BIP-39/BIP-32 derivation scheme for Nostr** (path
  `m/44'/1237'/<account>'/0/0`, coin type `1237` registered in SLIP-44)
  — **but NIP-06 is currently marked, in its own document header,
  `draft` `unrecommended` `optional`, with an explicit warning:
  "unrecommended: prefer a single nsec."** Confirmed by direct fetch of
  `nostr-protocol/nips/06.md` (2026-09-08 correction — the original
  pass of this document cited NIP-06 as simply "official, merged NIP"
  without checking its status tags, an error corrected here). NIP-06
  remains real, technically valid, and still describes an actual
  deterministic scheme some wallets do implement (e.g. the Breez
  precedent in §5.1) — but it is not the Nostr project's own
  recommended path today, and this document must not present it as
  such.
- **Deterministic derivation:** the scheme exists and is technically
  sound (a distinct, SLIP-44-registered coin-type branch, safely
  isolable from a Bitcoin-derived root by BIP-32 hardened derivation) —
  but **it is the Nostr project's own currently-unrecommended
  mechanism**, not an endorsed standard. Treat as: a real, demonstrated,
  implementable pattern (evidence for "this kind of derivation is
  technically possible and shipped"), not evidence that Nostr
  recommends composing identities this way.
- **HD derivation support:** yes, mechanically, via NIP-06's own path
  (multiple accounts via the `<account>'` index) — same status caveat
  as above.
- **Identity stability:** an `npub` is meant to be long-lived
  (analogous to an email address in Nostr's own framing), not
  session-ephemeral — independent of the NIP-06 status question, which
  concerns *how* the key is generated, not whether the resulting
  identity is meant to persist.
- **Device-specific keys:** not addressed by NIP-06 (nor would it be,
  given its own unrecommended status) — a user typically uses the
  *same* Nostr secret key across devices (via `NIP-46`/remote signers
  or manual key copy), which is a real **privacy/security tension**, not
  a solved problem — copying one hot key to every device is the common
  current practice, explicitly *not* recommended security hygiene.
- **Multi-device:** `NIP-46` ("Nostr Remote Signing") allows a remote
  signer to hold the secret key while multiple client devices request
  signatures from it. **Directly verified in this correction pass**
  (2026-09-08, fetched `nostr-protocol/nips/46.md` directly): NIP-46
  carries **no `unrecommended`/`deprecated` status marker** — unlike
  NIP-06/NIP-26, it appears to be an active, maintained NIP. Upgraded
  from this document's original **INFERENCE** classification to
  **OFFICIAL SPEC** for "the mechanism exists and is not deprecated."
  Kept **contextual, not load-bearing** for this document's model
  comparison either way — it informs the multi-device discussion (§8)
  but does not change §5/§13's model ranking, which does not depend on
  NIP-46's status.
- **Rotation:** no formal, protocol-enforced key-rotation mechanism in
  NIP-01, and NIP-06 (were it recommended) would not provide one either
  — the informal convention is "publish a note from the old key
  pointing to the new key," social-convention-based, not
  cryptographically enforced. **OBSERVED IMPLEMENTATION norm, not
  OFFICIAL SPEC guarantee.**
- **Revocation:** same informal-convention caveat — no native
  revocation primitive.
- **Delegation:** `NIP-26` ("Delegated Event Signing") exists by name
  for this exact purpose. **Directly verified in this correction pass**
  (fetched `nostr-protocol/nips/26.md`): also carries status tags
  `draft` `unrecommended` `optional` `relay`, with its own explicit
  warning — "unrecommended: adds unnecessary burden for little gain."
  Corrected from this document's original "UNKNOWN, not independently
  verified" to: **verified, and itself unrecommended by the Nostr
  project** — not a primitive this document should treat as a
  recommended delegation mechanism for any future design.
- **Public key = identity?** Yes, directly (`npub`).
- **Accepts external root?** Mechanically yes, via NIP-06's scheme —
  with the status caveat above: this is a real, implementable pattern,
  not a currently-endorsed one.
- **Official spec existing?** NIP-01 (core) is a stable, foundational
  spec. NIP-06 and NIP-26 are real, merged NIPs — but both are
  currently `draft`/`unrecommended`/`optional`, not endorsed defaults.
  NIP-46 is a real, non-deprecated, actively-specified NIP.
- **Derivation-incompatibility risk:** low *if* NIP-06 were adopted (its
  design intent is safe coexistence with a Bitcoin-derived root via a
  dedicated, registered coin-type branch) — but this document must not
  present that low-risk property as evidence Nostr currently recommends
  this path; it recommends the opposite (a single `nsec`).
- **Import/export of secret:** `nsec` export is standard practice
  across Nostr clients — this is, per the NIP-06 warning itself, the
  Nostr project's own preferred approach over mnemonic derivation.
- **Recovery on another device:** mnemonic (if NIP-06 was used to
  generate the key, despite its unrecommended status) or raw `nsec`
  re-entry (the Nostr project's own preferred path).
- **Dependency on external metadata:** relays are needed to actually
  *use* a Nostr identity (publish/discover), but the key itself has no
  metadata dependency.
- **Effect of key loss:** loses the identity permanently unless the
  mnemonic (if NIP-06-derived) or raw `nsec` was backed up separately.
- **Effect of key compromise:** total impersonation of that Nostr
  identity; no native revocation to signal the compromise
  protocol-wide (informal "moved to new key" notes only).
- **Relation to reputation/history:** Nostr itself has no protocol-level
  reputation primitive; any reputation is entirely client/relay-side
  convention, external to the protocol.

### 3.5 Pubky

- **Key type:** Ed25519. **OFFICIAL IMPLEMENTATION** (Pkarr/Pubky docs,
  confirmed via search + fetch).
- **Seed/mnemonic native?** Yes — the `pubky` core library supports
  creating a signer "from a recovery file with an optional passphrase,
  **or from a 12-word BIP39 mnemonic** with optional passphrase and
  language" (confirmed via search of `pubky`/`pubky-backup` crate
  documentation). **OFFICIAL IMPLEMENTATION.**
- **Deterministic derivation:** a BIP-39 mnemonic is supported as an
  *input*, but **whether it feeds a BIP-32 HD tree (multiple derivable
  child keys) or directly seeds a single fixed Ed25519 keypair (no
  tree) was not confirmed in this pass** — the fetched material
  describes the mnemonic as an alternative input to the same "recover a
  signer" operation as the encrypted `.pkarr` recovery-file path, which
  reads more like "one mnemonic → one key," not an HD tree, but this is
  **UNKNOWN, not asserted**, pending direct confirmation against
  Pubky's actual key-derivation source before any design depends on it.
- **HD derivation support:** **UNKNOWN** (see above) — not confirmed
  either way.
- **Identity stability:** an identity *is* the Ed25519 public key,
  serving directly as a top-level-domain-equivalent name (z-base32
  encoded, 52 characters) — clearly intended as long-lived, not
  session-ephemeral.
- **Device-specific keys:** not addressed in the fetched material.
  **UNKNOWN.**
- **Multi-device:** not addressed in the fetched material. **UNKNOWN.**
- **Rotation:** not addressed in the fetched material. **UNKNOWN.**
- **Revocation:** not addressed in the fetched material. **UNKNOWN.**
- **Delegation:** not addressed in the fetched material. **UNKNOWN.**
- **Public key = identity?** Yes, explicitly and directly — "your
  identity is an Ed25519 public key... this key becomes your top-level
  domain" (Pkarr docs).
- **Accepts external root?** Partially confirmed — the BIP-39-mnemonic
  recovery path suggests yes at the "recovery input" level, but not
  confirmed as a general "derive from any externally-supplied seed"
  capability at the API level. **INFERENCE**, not confirmed.
- **Official spec existing?** PKARR (the DNS-over-DHT layer beneath
  Pubky identity) has design documents in its own repository
  (`pubky/pkarr/design/*.md`), but these were not independently fetched
  in this pass — the identity/z-base32/BEP44 facts above come from
  search-result summaries, not a directly-verified primary spec
  document. Classified **OBSERVED IMPLEMENTATION**, one level below
  **OFFICIAL SPEC**, until a primary document is directly read.
- **Derivation-incompatibility risk:** **UNKNOWN**, pending the HD-tree
  question above.
- **Import/export of secret:** yes — an encrypted `.pkarr` recovery-file
  format exists specifically for this (confirmed).
- **Recovery on another device:** via the recovery file (with
  passphrase) or the 12-word mnemonic — both confirmed to exist.
- **Dependency on external metadata:** PKARR records are published to
  the Mainline DHT (BitTorrent's DHT, confirmed, 15+ years running,
  ~10M nodes) — a real, external, already-battle-tested network
  dependency, distinct from Nostr's relay model or HyperDHT's own DHT.
- **Effect of key loss:** loses the identity/domain permanently absent
  the recovery file/mnemonic.
- **Effect of key compromise:** total impersonation (it *is* the
  identity — no separable "identity vs. signing key" distinction was
  found).
- **Relation to reputation/history:** not addressed in the fetched
  material. **UNKNOWN** — Pubky Core's own homeserver/data-storage model
  (data stored per public key) suggests reputation-equivalent data
  would also be keyed to this same identity, but this is **INFERENCE**,
  not confirmed.

### 3.6 PKARR

PKARR is the DHT-publication layer Pubky identity is built on, not a
separate identity system — investigated together with §3.5 above where
overlapping, with PKARR-specific facts here:

- **Key type:** Ed25519 — same identity key as Pubky (PKARR *is* "turn
  an Ed25519 public key into a domain name"). **OFFICIAL
  IMPLEMENTATION.**
- **Seed/mnemonic, HD derivation, rotation, revocation, delegation,
  multi-device:** identical open questions to §3.5 — PKARR does not
  introduce a separate identity/key model of its own; it is the
  DNS-record-publication mechanism *for* the Ed25519 key that already is
  the Pubky identity. Not duplicated as separate matrix questions;
  see §3.5.
- **Distinct, PKARR-specific facts confirmed:** records are self-signed
  DNS-record sets (A/AAAA/TXT/CNAME/HTTPS), published as BEP44 mutable
  items on the Mainline DHT, with a 64-octet Ed25519 signature over the
  encoded packet plus an 8-octet microsecond timestamp
  (`pkarr/design/relays.md`, confirmed via search summary — not
  independently fetched as a primary document, so classified
  **OBSERVED IMPLEMENTATION**). This means: **losing the Ed25519 key
  loses the ability to publish new records under that name at all** —
  the DNS-equivalent identity and the signing key are the same single
  point of failure, with no separate "record-signing key vs. identity
  key" split found.
- **Official spec existing?** No formal standards-track spec found
  (this is an independent open-source project's own design documents,
  not an IETF/W3C-style specification) — **OBSERVED IMPLEMENTATION.**

### 3.7 Iroh

- **Key type:** Ed25519 (`EndpointID` = the public half of an Ed25519
  keypair). **OFFICIAL IMPLEMENTATION** (iroh.computer docs, confirmed
  via search).
- **Seed/mnemonic native?** No BIP-39-style mnemonic found — "an
  endpoint ID is an ed25519 keypair, which can be generated from just
  32 bytes of random data." No dedicated mnemonic-encoding standard
  confirmed. **OFFICIAL IMPLEMENTATION for "32-byte seed generates the
  key"; UNKNOWN for any official mnemonic/recovery-phrase layer on top.**
- **Deterministic derivation:** one 32-byte seed → one fixed keypair,
  same class as HyperDHT/Pears — **no HD tree found or claimed
  anywhere** in the fetched material.
- **HD derivation support:** not natively; not found.
- **Identity stability:** explicitly designed to be **stable and
  long-lived** — "if you want the same EndpointID to persist across
  restarts... store the endpoint's SecretKey and load it on every
  launch," and "the public key becomes that device's EndpointID, which
  remains stable as the device moves between networks." This is a
  materially different design intent than Sails' current Pears usage
  (§3.3) — Iroh's own docs frame persistence as the *expected* pattern,
  where Sails' Pears integration today discards the keypair every
  session.
- **Device-specific keys:** implicitly yes — the wording above ("that
  device's EndpointID") frames the EndpointID as tied to a device by
  default, not a portable user identity.
- **Multi-device:** **explicitly investigated by the Iroh team, but
  experimental, not production** — a blog post ("Lose your device, but
  keep your keys") describes a FROST (threshold Ed25519 signatures)
  prototype splitting the private key into shares across an active
  device, a co-sign server, and offline storage, so a public key
  (EndpointID) can survive device loss without changing. Confirmed
  directly via fetch: "This remains an **experimental exploration**
  rather than production functionality... a little command line tool
  built as a proof-of-concept." **OBSERVED IMPLEMENTATION (prototype),
  not OFFICIAL SPEC, not production.**
- **Rotation:** the FROST prototype's entire point is *avoiding*
  rotation (device loss without changing the public key) rather than
  performing rotation — so "rotation" in the traditional sense (new key,
  same identity, provable transition) is **not addressed** by Iroh; the
  FROST approach is a different strategy (never need to rotate) than
  the "signed rotation statement" concept named in the mission brief
  for §9.
- **Revocation:** the FROST prototype's "disable publishing to the key
  by stopping the co-sign server" is the closest concept found to
  revocation — but it's a threshold-signing-availability mechanism, not
  a protocol-level revocation primitive, and is experimental.
- **Delegation:** not found.
- **Public key = identity?** Yes, directly — Iroh explicitly frames its
  whole model as "replacing IP addresses... with Ed25519 public keys."
- **Accepts external root?** Mechanically yes (any 32-byte seed works),
  same caveat as HyperDHT — no official derivation-path standard from
  an external root confirmed.
- **Official spec existing?** No standards-track spec found — Iroh is
  an independent Rust project (n0-computer) with its own documentation
  site, not a spec body. **OFFICIAL IMPLEMENTATION.**
- **Derivation-incompatibility risk:** low mechanically (raw 32-byte
  seed), zero standardization for cross-root derivation.
- **Import/export of secret:** `SecretKey` persistence is explicitly
  documented and expected for stable identity; no dedicated mnemonic
  export format found.
- **Recovery on another device:** requires the raw `SecretKey` (no
  mnemonic layer confirmed) unless the experimental FROST scheme is
  used.
- **Dependency on external metadata:** Iroh has its own node-discovery
  service (mentioned in search results: "Iroh global node discovery")
  — not independently investigated in this pass beyond its existence.
  **UNKNOWN** for exact metadata dependency shape.
- **Effect of key loss:** loses the EndpointID/reachability permanently,
  absent a backed-up `SecretKey` or the experimental FROST recovery
  path.
- **Effect of key compromise:** full impersonation of that endpoint;
  the FROST prototype is the only mitigation direction found, and it is
  explicitly experimental.
- **Relation to reputation/history:** none found — Iroh is a
  networking/transport library with no reputation concept of its own.

---

## 4. Key/recovery matrix

Populated only where evidence supports it — `UNKNOWN` cells are
disclosed, not guessed.

| Capability | Root/Seed Model | Key Type | Deterministic Recovery | User Key | Device Key | Rotation | Revocation | Multi-device | Public Correlation Risk | Exportable | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Bitcoin/Wallet** | BIP-39 mnemonic → BIP-32 HD tree | secp256k1 | Yes (OFFICIAL SPEC) | Root xprv | Via separate accounts/paths (convention) | Address rotation native; root rotation = migration | None native | Watch-only xpub (OFFICIAL SPEC) | Low if paths not reused/linked publicly | Yes (mnemonic, standard UX) | The interoperability anchor other protocols (Nostr) explicitly build on |
| **Sails Identity** | None native — client-generated Ed25519 keypair | Ed25519 | No (no protocol-level derivation scheme) | `publicKey` | N/A (not modeled) | Not specified anywhere in the protocol (real gap, confirmed by search) | Not specified | Not specified | Low (no external protocol reuses this key today) | Not specified/UX-defined by Reference Implementation | `docs/PROTOCOL_SPECIFICATION.md` §1.1 is deliberately technology-neutral here |
| **Pears** | Optional raw seed (`HyperDHT.keyPair([seed])`); Sails passes none today | Ed25519 | Mechanically yes; **Sails' own usage is ephemeral, not derived** (confirmed, §3.3) | N/A today (session-only) | N/A today | Trivial mechanically; no continuity/announcement mechanism | None native | Not modeled by HyperDHT | Unknown byte-contract for seed makes cross-tool correlation unclear either way | Not applicable (no persisted key today) | **Sails' current implementation discards this key every session — the biggest gap between "what Pears could do" and "what Sails does with it"** |
| **Nostr** | BIP-39 mnemonic → NIP-06's own reserved BIP-32 path (`m/44'/1237'/…`) — **NIP-06 itself is `draft`/`unrecommended`/`optional`, warns to prefer a single `nsec`** | secp256k1 | Mechanically yes, via NIP-06's scheme, but that scheme is not the Nostr project's recommended path | `nsec` (the Nostr project's own preferred approach) | Not addressed by NIP-06 (shared-key-across-devices is common practice, a real weakness) | Informal convention only (no enforced continuity) | None native (informal only) | NIP-46 (verified active/non-deprecated this pass; contextual, not load-bearing for the model comparison) | Hardened, domain-separated derivation reduces direct private-key reuse, but this alone does not prove broader unlinkability or metadata-correlation resistance | Yes (`nsec`, standard) | **The strongest same-root derivation *pattern* found in this investigation (technically), but not currently the Nostr project's own recommended mechanism** |
| **Pubky** | BIP-39 mnemonic (confirmed) OR encrypted `.pkarr` recovery file | Ed25519 | Confirmed as an input; HD-tree-vs-single-key **UNKNOWN** | The public key itself (identity = key) | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN (identity=key means any correlation is maximal by construction if the same key is reused) | Yes (recovery file, and/or mnemonic) | Identity and naming are the same object — no separable "signing key vs. identity" layer found |
| **PKARR** | Same as Pubky (§3.5/§3.6 — not a separate identity layer) | Ed25519 | Same as Pubky | Same key as Pubky identity | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | Same as Pubky | Same as Pubky | Losing the key loses DNS-record-publication ability too — single point of failure for both identity and naming |
| **Iroh** | Raw 32-byte seed; no mnemonic layer confirmed | Ed25519 | Mechanically yes (seed→key); no HD tree found | `SecretKey` | Implied device-scoped by default framing | Not addressed (FROST avoids rather than performs rotation) | Closest analog: FROST co-sign-server shutdown (experimental) | **FROST threshold-signature prototype exists, explicitly experimental/non-production** | Low mechanically (raw seed), unknown standardization | `SecretKey` persistence documented; no mnemonic format found | Design intent is persistent, device-tied identity — opposite of Sails' current ephemeral Pears usage |

---

## 5. Comparing the four models

> **Naming note (2026-11-22).** "Model B" in this section means "Wallet Seed to Sails Identity Root" and is a discovery candidate only. It is not the identity direction chosen on 2026-10-26 (PR #543), which is also called "Model B" in later records: native Pubky recovery, a fresh Pear transport key and re-authorization, with wallet seeds always separate. Diagrams of the chosen direction: [SYSTEM_DESIGN.md §14.5](SYSTEM_DESIGN.md#145-portable-identity-pears-and-social-recovery-diagrams).

### Model A — One Seed, Direct Derivation

```
wallet seed
├── BTC
├── Nostr
├── Pears
├── Pubky
└── ...
```

**What the evidence says:** only **one** of the four non-Bitcoin
protocols investigated (Nostr, via NIP-06) has a *published,
technically standardized* answer for "derive me from the same BIP-39
root, safely domain-separated" — but **NIP-06 is itself currently
`draft`/`unrecommended`/`optional` in the Nostr project's own NIP
index, which explicitly recommends a single `nsec` instead.** This
weakens, without eliminating, Model A's strongest evidence point: the
derivation *mechanism* is real, technically sound, and demonstrably
implementable (confirmed independently by the Breez precedent, §5.1),
but it is not a mechanism the Nostr project itself currently endorses
using. Pears and Iroh accept *a* seed but define no standard derivation
path from an external root at all — Sails would have to invent and own
that convention entirely, with zero portability to any other
Pears/Iroh-based application that didn't adopt the identical scheme.
Pubky's HD-tree capability is unconfirmed (**UNKNOWN**). This means
Model A, taken literally as "derive everything from one seed today,"
is achievable for at most 2 of 7 matrix rows (Bitcoin, Nostr) — and
even the Nostr row rests on a mechanism its own protocol currently
marks unrecommended, not a clean, endorsed standard.

### Model B — Wallet Seed → Sails Identity Root

```
wallet seed
    ↓
Sails Identity Root
    ├── Nostr
    ├── Pears
    ├── Pubky
    └── ...
```

**What the evidence says:** this adds one indirection layer (a
Sails-specific intermediate root) between the wallet seed and each
protocol identity, which does not change the underlying per-protocol
derivation-standard gap Model A has — Pears/Iroh/Pubky still have no
standardized external-derivation convention (endorsed or otherwise)
regardless of what sits one level above them in the tree, and Nostr's
own NIP-06 mechanism, even one layer removed, remains a currently
unrecommended path per the Nostr project itself (§3.4). What it *does* change: it isolates a
wallet-seed compromise from directly exposing the derivation path to
every protocol identity in one step, and it gives Sails one place
(`Sails Identity Root`) to own protocol-specific derivation conventions
explicitly, rather than mixing that concern directly into "the wallet's
own BIP-32 tree." This is a real, structurally meaningful difference
even though it does not resolve the missing-standard gap by itself.

### Model C — Independent Seeds, Unified Backup UX

```
wallet seed
nostr seed
pears seed
pubky seed
        ↓
encrypted recovery bundle / UX abstraction
```

**What the evidence says:** this is the only model that requires **zero**
new cross-protocol derivation standardization — each protocol keeps
using exactly the recovery mechanism it already, natively supports
(Bitcoin mnemonic, NIP-06 mnemonic or raw `nsec`, Pears/Iroh raw seed
persistence, Pubky mnemonic or `.pkarr` file). The cost moves entirely
to the "encrypted recovery bundle" — a Sails-built container that must
itself be backed up as one artifact, which is exactly the kind of
"recovery UI / cloud backup / key escrow" surface this document is
explicitly not authorized to design (§15 of the mission, unchanged
here).

### Model D — Hybrid

Some identities derived from the root (where a published, technically
standardized derivation scheme exists — Nostr's NIP-06 today, despite
its own unrecommended status), others kept independent (where no
derivation scheme of any kind exists — Pears, Pubky, Iroh, until/unless
one is published, or until Sails deliberately builds and documents its
own convention for them).

**What the evidence says:** this is the model the *evidence itself*,
not a preference, points toward — because the four protocols
investigated do not have uniform derivation capability today, and even
the one that does (Nostr) offers it through a mechanism its own project
does not currently recommend. Treating them uniformly (Model A or a
naive Model B) would mean either (a) overclaiming derivation support
that isn't standardized for Pears/Iroh/Pubky, or presenting Nostr's
NIP-06 as more endorsed than it currently is, or (b) inventing
Sails-only conventions for the unstandardized protocols anyway, which
is what Model D does explicitly and disclosed, rather than implicitly.

### Assessment table

| Criterion | A | B | C | D |
|---|---|---|---|---|
| Security | Medium — one compromise point, but well-trodden BIP-32 hardened-derivation isolation for the protocols that support it | Medium-High — same isolation, plus one extra indirection layer before any protocol-specific path is reachable | High — protocol-level compromises are naturally isolated (fully independent seeds) | High for the independently-seeded arms; Medium for the derived arm (same as A/B there) |
| Self-custody | High (all) | High (all) | High (all) | High (all) — none of the four models require a third party to hold key material |
| Blast radius of root compromise | High (every derivable identity) | High, but one step removed from the wallet seed itself | Low (compromising one seed doesn't expose the others) | Bounded to whichever arm (derived vs. independent) is actually compromised |
| Compromise isolation | Weak for non-standardized protocols (Sails would own an ad hoc path) | Same weakness, contained to the Sails Identity Root layer | Strong, by construction | Strong for independent arms; same as A/B for the derived arm |
| Recovery UX | Best (one phrase) | Best (one phrase) | Worst without the bundle abstraction; bundle itself becomes a new single point of recovery | Middle — one phrase covers some identities, others still need separate backup unless bundled |
| Device migration | Simple if the derivation convention is well-documented | Same | Requires restoring/decrypting the bundle, or each seed individually | Mixed, matching the recovery-UX row |
| Protocol compatibility | Best where a published derivation scheme exists (Nostr, though currently unrecommended by the Nostr project itself); weakest where none does at all (Pears/Iroh/Pubky) | Same underlying compatibility ceiling as A | Best — never depends on any protocol supporting external derivation | Matches evidence exactly: good where a derivation scheme exists (with Nostr's status caveat noted), independent where none does |
| Correlation risk | Depends entirely on each protocol's own domain separation once derived — hardened, domain-separated paths reduce direct private-key reuse (Nostr's NIP-06 branch is built this way), but this does not by itself prove broader unlinkability/metadata-correlation resistance; Pears/Iroh: unconfirmed | Same, one layer removed | Lowest — independent seeds have no mathematical relationship to correlate | Same as A/B for the derived arm; same as C for the independent arm |
| Backup complexity | Lowest (one phrase) | Lowest (one phrase) | Highest without a bundle; the bundle itself must still be backed up as one artifact | Medium — fewer independent backups than full-C, but not zero either |
| Rotation/revocation | Inherits each protocol's own (in)ability — none of the seven rows has a real revocation primitive | Same | Same per-protocol ceiling; independence doesn't grant a revocation capability that doesn't exist upstream | Same per-protocol ceiling |
| Forward compatibility | Weak — adding a protocol with no derivation standard means Sails invents one anyway, undermining "just derive it" | Same, contained to the Sails Identity Root's own registry of conventions | Strong — a new protocol just adds one more independent seed to back up | Strong — this is explicitly what Model D already expects to do for new protocols |
| Dependency coupling | High — every derived identity's security assumptions become entangled with the wallet-seed KDF choice | Medium — Sails Identity Root is the only thing coupled to the wallet seed; per-protocol conventions couple to *that*, not directly to the wallet | Low — no protocol depends on another's derivation | Low for independent arms, Medium for the derived arm |
| Vendor/protocol lock-in | Low (BIP-32 is an open standard) | Low, same reasoning | Low — nothing here is protocol-specific | Low |

### 5.1 External precedent — Breez `passkey-login` spec (addendum, 2026-09-08)

**Source directly fetched and verified** (not taken on the CTO's summary
alone, per this repository's own discipline of checking pasted claims
against the primary source before building on them):
[`github.com/breez/passkey-login/blob/main/spec.md`](https://github.com/breez/passkey-login/blob/main/spec.md).
**OFFICIAL SPEC** — a real, published specification document, not a
blog post or inferred behavior.

**Confirmed architecture, quoted from the spec:**

```
account_master = PRF(passkey, 0x4e594f415354525453414f594e)
nostr_account  = Nostr keys derived from account_master at account 55,
                  BIP39/BIP32/NIP-06 path (m/44'/1237'/55'/0/0)

root_key = PRF(passkey, salt_string)
mnemonic = BIP39(root_key)
wallet/app keys = BIP32/BIP44(mnemonic)
```

- `account_master` comes from a WebAuthn **PRF extension** (not a
  BIP-39 mnemonic itself) evaluated against the passkey, using a fixed
  challenge (the hex encoding of a chosen "magic string", explicitly
  picked "to prevent collision with any salt values") — user
  verification required at the authenticator.
- The Nostr account is derived via **exactly NIP-06's own published
  derivation path** (this spec doesn't invent a new Nostr derivation, it
  reuses the existing one, at a dedicated account index `55'`) — **not
  evidence that NIP-06 is currently the Nostr project's preferred
  recovery standard** (§3.4's correction: NIP-06 itself is
  `draft`/`unrecommended`/`optional`). Breez adopting it is evidence the
  *deterministic derivation pattern* is implementable and shipped in a
  real spec, independent of whether the Nostr project itself currently
  endorses that specific mechanism.
- For each `salt_string`, a separate `root_key` → BIP-39 `mnemonic` →
  BIP-32/44 wallet/app keys chain is produced. The spec states this
  explicitly enables reuse beyond one wallet: *"BIP39/BIP32 is applied
  to create... deterministic key hierarchies that can be used in
  wallets and compatible apps."*
- **Nostr's role in this spec is salt/metadata discovery, not wallet
  authority** — confirmed directly: salts are published as ordinary
  kind-1 Nostr events for recoverability, while "the passkey and PRF
  remain the sole cryptographic trust anchor. Relay compromise has no
  effect on key security." This is a real, concrete, spec-level example
  of the property named in §7 of this document: **recovery
  metadata/discovery ≠ wallet authority.**

**What this is evidence of, precisely (interpretation, not overclaim):**

1. **A wallet-level recovery root (here, a passkey via WebAuthn PRF, not
   a BIP-39 mnemonic itself) can deterministically reconstruct more than
   one cryptographic domain** — both a NIP-06-standard Nostr identity
   and arbitrary BIP-32/44 wallet/app key hierarchies, from the same
   underlying secret, via distinct, salted derivation contexts. This is
   real, shipped, spec-level design — the strongest concrete precedent
   for "one root, several domains" found in this entire investigation,
   stronger than NIP-06 alone because it demonstrates the pattern
   composed across *two* different derivation stages (PRF → per-salt
   root → BIP-39 → BIP-32/44), not just one HD tree.
2. **This does not make Passkey or Breez a Sails Protocol dependency.**
   Nothing in this document proposes adopting WebAuthn/passkeys as a
   Sails requirement — it is cited purely as evidence that the
   architectural *pattern* (root → multiple salted/derived domains) is
   real and shipping elsewhere, independent of whether Sails ever
   adopts this specific mechanism.
3. **This does not prove every chain/wallet stack supports identical
   BIP-32/44 derivation semantics.** The spec's own "wallets and
   compatible apps" wording is exactly that — compatible ones. It says
   nothing about Pears, Iroh, or Pubky, none of which use a BIP-32/44
   derivation scheme at all today (confirmed §3.3/§3.5/§3.7) — this
   evidence does not close those gaps.
4. **Wallet recovery mechanism vs. Sails identity architecture, kept
   separate:** this spec is about how *a wallet* recovers its own key
   material (Breez/Spark's own concern); it says nothing about how a
   `ParticipantIdentity` should be structured, bound, or recovered at
   the Sails protocol level. Cited as external precedent for the
   *pattern*, not as a design Sails should inherit wholesale.

**Effect on Models A/B/D:** this is real, additional, spec-grade
evidence that the *general shape* of Models A and B (one root
deterministically producing several domain-separated identities) is
achievable in production, not merely theoretical — strengthening the
*plausibility* of A/B's mechanism specifically for domains that already
have (or could adopt) a published derivation scheme. **Breez using
NIP-06-like derivation is evidence that the deterministic pattern is
implementable, not evidence that NIP-06 is currently the preferred
Nostr recovery standard** — that remains a single `nsec`, per the Nostr
project's own NIP-06 warning (§3.4). It does **not** change this
document's Model D-leaning, B/STOP recommendation (§13/§15): Breez's
spec is one more confirmed example of the *pattern* working where a
domain has a real, published derivation scheme (here: WebAuthn PRF +
NIP-06 for Nostr, plus arbitrary BIP-32/44 for wallet keys) — it does
not resolve the still-open, load-bearing unknowns for Pears, Iroh, or
Pubky (§14), which is what actually blocks a confident A/B-over-D
choice today, and it does not upgrade NIP-06's own unrecommended status
within the Nostr project. One additional implementation demonstrating
the pattern for protocols that already support it does not, by itself,
justify extending the same treatment to protocols that don't yet.

**Preserved throughout:** same recovery root ≠ same private key across
domains (confirmed again here — `account_master`, each salted
`root_key`, and the Nostr key are all distinct values, never the same
secret reused); recovery relationship ≠ public identity relationship
(salts are Nostr-published, deliberately deterministic and
non-random, but this is metadata *for finding* the recovery material,
not a claim that the derived wallet keys themselves become publicly
correlatable to each other through that metadata).

---

## 6. Domain separation

**What must be true for compromising one derived identity to not
expose sibling identities or funds**, based on the evidence gathered
(not a KDF choice — a property list):

1. **The derivation path/context for each domain must be
   cryptographically distinct and non-reversible into siblings.**
   NIP-06's own approach (a distinct, SLIP-44-registered coin-type
   branch, `1237'`, separate from Bitcoin's `0'`) is the one
   evidence-backed example of this in this investigation — hardened
   derivation at that branch point means knowing a Nostr child key does
   not reveal the Bitcoin-branch children or the root, by BIP-32's own
   hardened-derivation guarantee.
2. **A leaf/domain compromise must not reveal the parent.** This is
   BIP-32 hardened derivation's own guarantee for any branch derived
   with a hardened index — true for Nostr's NIP-06 path today; **not
   established for Pears/Iroh/Pubky**, since none of them has a
   confirmed HD scheme to inherit this property from at all (a single
   `seed → keyPair` mapping, as HyperDHT/Iroh both use, has no "parent
   vs. child" relationship to protect in the first place — the seed
   *is* the key, one level, not a tree).
3. **Sibling domains must not share a derivation index or context by
   accident.** This is a design-discipline requirement, not something
   any protocol enforces automatically — worth naming explicitly as a
   requirement for any future ADR, not resolved by this document.
4. **A domain with no official derivation standard (Pears, Iroh, Pubky
   pending confirmation) cannot inherit BIP-32's isolation guarantees
   at all unless Sails itself builds an equivalent, documented
   construction** — this is exactly the gap Model D discloses rather
   than papers over.

---

## 7. Privacy / correlation

**Property to preserve:** *recovery relationship must not automatically
become public identity relationship.*

Findings:

- **Nostr's NIP-06 branch is the clearest evidence-backed example, in
  this investigation, of hardened, domain-separated derivation applied
  to let the same mnemonic seed both a Bitcoin wallet and a Nostr
  identity.** Corrected 2026-09-08: the original pass of this document
  claimed this made NIP-06 "correlation-resistant by design," without a
  formally demonstrated property to back that broader claim. The
  narrower, evidence-backed statement is: **hardened, domain-separated
  derivation paths reduce direct private-key reuse between the Bitcoin
  and Nostr branches (neither child key reveals the other, nor the
  shared parent, per BIP-32's own hardened-derivation guarantee) — but
  this alone does not prove broader unlinkability or resistance to
  metadata-level correlation** (e.g. timing, usage-pattern, or
  out-of-band correlation are untouched by the derivation math itself).
  This is also, independently, not the Nostr project's currently
  recommended mechanism (§3.4).
- **Pubky's identity-is-the-key design is the opposite extreme** — since
  the public key *is* the identity/domain name directly (no separable
  signing-vs-identity layer found), any reuse of that exact key anywhere
  else is trivially, publicly correlatable by construction. This is not
  a flaw in Pubky (it's the whole point — a self-sovereign, verifiable
  domain), but it means Pubky identities must never share key material
  with any other domain if correlation resistance matters, reinforcing
  the domain-separation requirement in §6.
- **Fingerprints/metadata leakage** — not independently investigated for
  Pears/Iroh/Pubky beyond what's already noted (Iroh's own node-discovery
  service, Pubky/PKARR's DHT publication) — flagged as an open question
  for a future, dedicated privacy-architecture pass (Norte macrofront
  19), not resolved here.
- **Derivation paths as fingerprints:** a Sails-invented, non-standard
  derivation convention for Pears/Iroh (§5's Model A/B gap) would itself
  become a fingerprint if ever reverse-engineered or leaked — a real,
  disclosed argument in favor of keeping those specific domains
  independent (Model C/D's arms) rather than forcing them into a
  Sails-only derivation scheme that provides no compensating standard
  benefit.
- **Selective disclosure / reputation continuity without automatic
  public binding:** see §9 — no protocol investigated here has a native
  "prove I control both identity X and identity Y without revealing the
  derivation relationship publicly" primitive (that's the shape of a
  zero-knowledge proof, already named-only in `docs/GITHUB_PROJECT.md`
  §D as "ZK / anonymous credentials," out of this document's scope).

---

## 8. Multi-device

**Root identity ≠ device identity** — evidence per protocol:

- **Bitcoin:** solved, mature (watch-only xpubs; spending requires the
  secret on at least one device; BIP-32 public derivation is the
  standard mechanism).
- **Nostr:** partially solved — `NIP-46` remote-signer pattern exists by
  name (not independently verified this pass) to avoid copying the same
  `nsec` to every device; **the common current practice is still
  copying the hot key**, a real, disclosed weakness, not a solved
  problem.
- **Pears (Sails' own usage):** trivially "solved" today only because
  identity is ephemeral per session — there is no persistent
  cross-device identity to reconcile in the first place (§3.3/§2).
  This is not a multi-device solution; it's the absence of the problem
  because there's no persistent identity yet.
- **Pubky:** **UNKNOWN** — no multi-device mechanism found in the
  fetched material.
- **PKARR:** same as Pubky — **UNKNOWN.**
- **Iroh:** the FROST threshold-signature prototype (§3.7) is the one
  concrete, evidence-backed multi-device *design direction* found
  anywhere in this investigation — explicitly experimental, not
  production, and explicitly aimed at "keep the same public key across
  devices" rather than "each device has its own key under one root."

**On the specific sub-questions asked:**
- *Adding/removing a device, revoking a lost device, restoring on a new
  device, maintaining identity continuity, avoiding copying the same
  hot key everywhere:* only Bitcoin (via watch-only/multi-key patterns)
  and, experimentally, Iroh (via FROST) have any evidence-backed
  mechanism found in this investigation that avoids the "copy the same
  secret to every device" anti-pattern. Nostr's `NIP-46` is named as an
  answer but not independently verified here. Pears (as used by Sails),
  Sails' own participant identity, Pubky, and PKARR have **no
  evidence-backed multi-device mechanism at all** today.

---

## 9. Reputation continuity

Answering the mission's specific questions, with evidence, not
invention:

- **If a Nostr key changes, should Sails reputation survive?** Today,
  **N/A** — Sails reputation is anchored to `User.id`/`publicKey`
  (Sails' own economic identity), never to any external Nostr key
  (confirmed: no Nostr integration exists in this codebase at all,
  per PR #91's own investigation). This question only becomes live once
  a Nostr binding is built, which is not authorized here.
- **If Pears identity changes, does `peerId` change?** Yes, trivially —
  confirmed today `peerId` changes on *every* session already (§2/§3.3),
  since it's never persisted. Reputation is unaffected because it was
  never bound to `peerId` in the first place (confirmed, §2).
- **If a device key changes, does participant identity change?** No —
  today there is exactly one identity key (`User.publicKey`) and no
  device-key concept at all layered under it. This question is only
  meaningful once a multi-device model (§8) exists.
- **Which identity anchors reputation?** `User.publicKey` (the economic
  identity), exclusively, today — confirmed directly against the
  schema and `reputation.service.ts`'s own lookup keys.
- **Can a transport key be a binding/capability of a higher identity?**
  Conceptually yes (this is exactly what `CapabilityGrant`, RFC-005,
  already models for *other* kinds of delegated authority in this
  protocol) — but no such binding exists for `peerId` today (it's a
  bare database column, not a `CapabilityGrant`). This is a real,
  evidence-backed *possible* future direction (reusing an existing Core
  primitive rather than inventing one) worth naming for a future ADR,
  not a recommendation to build it now.
- **How would rotation be proven? Are signed rotation statements
  needed?** No protocol investigated in §3 has a native, verifiable
  rotation-proof primitive (Nostr's is informal/social convention only;
  Iroh's FROST avoids rotation rather than proving it). A "signed
  rotation statement" (old key signs a statement pointing to the new
  key) is a common, generic cryptographic pattern (used informally by
  Nostr's community convention) but **not something any protocol here
  formalizes or verifies automatically** — if Sails ever wants provable
  rotation, it would have to build and verify this itself; no existing
  protocol hands it a ready-made mechanism.
- **Core, OpenIdentity, or reference wallet?** Not decided here (out of
  scope) — but the evidence suggests: the *decision* of which
  identities to trust/bind belongs at the protocol level (OpenIdentity,
  since it's about what `ParticipantIdentity` accepts as valid
  evidence), while *device-specific key management/UX* (generating,
  storing, backing up per-device keys) is squarely reference-wallet
  territory, mirroring the existing `SettlementProvider`/`WalletAdapter`
  split this codebase already uses elsewhere (protocol defines the
  contract, Reference Implementation supplies the mechanism).

---

## 10. Wallet migration / recovery

Modeled flow and where it breaks per protocol, based on the evidence in
§3-§9 (not new invention):

```
new device
→ restore recovery material
→ wallet authority restored          [Bitcoin: solved, mature]
→ Sails identity restored            [breaks: no rotation/recovery
                                       scheme exists for User.publicKey
                                       itself — losing the raw keypair
                                       loses the identity outright,
                                       same as any bare-keypair system,
                                       confirmed §3.2]
→ protocol identities restored/      [Nostr: solved via NIP-06 mnemonic
   re-associated                      if that path was used; Pears:
                                       N/A, ephemeral by Sails' own
                                       design (§3.3), nothing to
                                       restore; Pubky: solved via
                                       mnemonic or recovery file;
                                       Iroh: requires the raw SecretKey,
                                       no mnemonic layer confirmed]
→ device identities provisioned      [breaks everywhere except
                                       Bitcoin's watch-only pattern and
                                       Iroh's experimental FROST — no
                                       protocol here has a mature,
                                       evidence-backed "per-device key
                                       under one identity" mechanism]
→ reputation/history continuity      [holds trivially today, only
   checked                            because reputation is anchored
                                       to the one identity that IS
                                       recoverable (User.publicKey) —
                                       this would need real design work
                                       the moment any external protocol
                                       identity becomes reputation-
                                       relevant, per §9]
```

**Where this flow breaks today, concretely:** step 3 (Sails identity
restoration) has no recovery mechanism of its own beyond "don't lose
the raw keypair" — there is no mnemonic, no HD derivation, no backup
convention specified anywhere in the protocol for
`ParticipantIdentity`'s own Level-0 key. This is arguably the most
foundational gap surfaced by this whole investigation: before asking
how to *also* recover Nostr/Pears/Pubky/Iroh identities from one root,
Sails' own economic identity has no recovery story of its own today.

---

## 11. Threat model

For each threat: authority affected, blast radius, detection, recovery,
residual — grounded in the protocol facts from §3, not invented
generically.

| Threat | Authority affected | Blast radius | Detection | Recovery | Residual |
|---|---|---|---|---|---|
| Recovery seed compromise | Every identity derived from that seed (model-dependent — see §5) | Model A/B: all derived identities + funds. Model C/D: only the arm(s) sharing that seed | None native to any protocol investigated — depends entirely on Sails-built monitoring | Move funds/identities to a new root (all models); for Nostr, the informal "moved to new key" note convention | No protocol here has a formal, enforced compromise-notification mechanism |
| Derived key compromise (one domain only) | That domain only, **if** hardened derivation was used (confirmed only for Nostr's NIP-06 path) | Low, if hardened derivation properly isolates siblings; **unknown/possibly total** for Pears/Iroh/Pubky (no confirmed HD isolation) | Same as above | Domain-specific (e.g., Nostr's informal key-rotation note) | Same gap as above, narrower scope |
| Stolen device | Whatever key(s) live unencrypted on that device | Device-scoped if device-specific keys exist (only Bitcoin/watch-only and experimental Iroh FROST have this); **total, if the same hot key is shared across devices** (the common Nostr practice, §8) | User-driven (noticing the device is missing) | Depends entirely on whether a multi-device/revocation scheme exists — confirmed absent for Pears/Pubky/PKARR, experimental-only for Iroh | Real, current, unmitigated risk for any protocol used in "same key on every device" mode |
| Malicious device | Any key ever entered on it | Same as stolen device, potentially worse (active exfiltration, not just physical loss) | None native | Same as above | Same gap |
| Protocol-key leak (one protocol's secret exposed, e.g. via a bug in a client) | That protocol's identity only, if domain separation held (§6); otherwise, potentially the shared root | Model-dependent, same as "derived key compromise" row | Depends on the leaking application, not the protocol | Domain-specific | Confirms §6's requirement that domain separation must actually be verified, not assumed |
| Correlation attack (linking identities across protocols via key/derivation-path analysis) | Privacy, not funds directly — but can deanonymize a user across contexts | Every protocol identity derivable from the same observable root, if derivation isn't properly hardened/separated | Passive, hard to detect (an outside analyst correlating public keys) | Not "recoverable" — once correlated, the link is public knowledge | Nostr's NIP-06 branch is the only mechanism here with hardened, domain-separated derivation reducing direct private-key-reuse risk (not a formally demonstrated broader correlation-resistance guarantee, §7); the rest are unconfirmed or (Pubky) inherently correlatable if key material is ever reused |
| Backup exfiltration (recovery bundle/mnemonic stolen, not the live device) | Everything the bundle/mnemonic can derive or recover | Full, for whatever that bundle covers (Model C's "encrypted recovery bundle" concentrates this risk into one artifact) | None native — depends on Sails-built bundle design (out of scope here) | None once exfiltrated and decrypted | Direct argument for why Model C's bundle-encryption design (not addressed in this document) matters as much as the derivation model itself |
| Malicious recovery app | Whatever the app has access to during "recovery" | Total, for a user who trusts a malicious recovery tool with their seed/mnemonic | None native to any protocol | Move everything reachable to a new root | A generic wallet-industry risk, not specific to any protocol investigated here |
| Derivation downgrade (tricking a user/client into a weaker derivation path) | Whatever domain uses the downgraded path | Domain-scoped, but could re-expose correlation risk (§7) if the downgrade removes hardened-derivation protection | Requires explicit path verification by the client — not investigated as implemented anywhere in this codebase | Re-derive correctly and migrate | Real risk category for any future Sails-built derivation scheme; not yet applicable since none exists today |
| Key substitution | The identity being substituted into | Depends on where verification happens (registration-time check, per `identity.service.ts`'s existing uniqueness constraint on `publicKey`) | Sails already has one relevant mitigation: `publicKey` uniqueness enforced at registration (`identity.service.ts:53-56`) | N/A — rejected at registration if the key is already claimed | Confirmed existing mitigation, cited as evidence this isn't a fully unaddressed threat class |
| Fake rotation (someone claims a rotation happened when it didn't, or claims the wrong new key) | Whichever identity the fake rotation claims to update | Depends entirely on whether Sails ever builds a rotation-verification mechanism — none exists today (§9) | None — no rotation mechanism exists to be faked yet | N/A | This threat is currently moot only because rotation itself doesn't exist yet as a feature; becomes real the moment §9's "signed rotation statement" idea is built |
| Replayed binding/rotation proof | Same as fake rotation | Same | Would require nonce/timestamp discipline in any future binding mechanism (same pattern `common/middleware/auth.ts`'s existing challenge-response already uses for a different purpose — a real, reusable precedent) | Same | Same "currently moot, real once built" caveat |
| Server-mediated binding compromise | The Sails backend's own database association (`User.peerId` today) | Whatever that server-mediated binding controls — today, just P2P discovery convenience, since reputation/funds don't depend on `peerId` (§2/§9) | Depends on Sails' own database security posture, not this document's scope | Standard incident-response, not protocol-specific | **This is the exact class of risk `docs/TRUST_BOUNDARY.md` Boundary 1b already discloses for the current Pears binding** — cited here as confirmation the threat model isn't hypothetical, it's already partially disclosed elsewhere in this repository |

---

## 12. UX target — investigated, not assumed as final

The proposed flow:

```
Create Wallet → one backup experience → protocol identities provisioned transparently
Restore Wallet → one recovery experience → identities restored/re-associated → device-specific material regenerated
```

**What the evidence supports and doesn't:**

- **"One backup experience" is achievable today only for the protocols
  with a published external-derivation mechanism** — in this
  investigation, that's Bitcoin (fully standardized and recommended)
  and Nostr (NIP-06 exists and is technically sound, but is currently
  `draft`/`unrecommended`/`optional` per the Nostr project itself,
  which recommends a single `nsec` instead). Pears, Iroh, and Pubky
  (pending its HD-tree confirmation) have no derivation mechanism of
  any kind, standardized or otherwise, today. This means "one backup
  phrase transparently provisions all of them" is **not yet achievable
  as literally stated**, and even the Nostr piece of it would mean
  building on a currently-unrecommended mechanism, not an endorsed one
  — without either Sails building non-standard derivation for
  Pears/Iroh/Pubky (Model A/D's known gap) or those protocols
  publishing/endorsing their own standard later.
- **"Device-specific material regenerated" on restore** is well-precedented
  only for Bitcoin (watch-only/multi-account patterns) and, if used,
  experimentally for Iroh (FROST). It has no evidence-backed mechanism
  for Sails' own participant identity, Pears (as currently used), Pubky,
  or PKARR.
- **The mission's own caution is directly supported by the evidence:
  "não assumir que uma seed literal para tudo é obrigatoriamente o
  modelo final"** — confirmed correct. A literal single seed does not,
  today, transparently cover 5 of 7 matrix rows without Sails inventing
  conventions those protocols don't yet standardize.

---

## 13. Decision criteria — ranking A/B/C/D

Per §5's assessment table, ranked by criterion (1 = strongest):

| Criterion | Ranking (strongest → weakest) |
|---|---|
| Security | C ≥ D > B > A |
| Self-custody | A = B = C = D (tie — none require a third party) |
| Privacy/correlation resistance | C > D > B > A |
| Recovery UX (today, as literally "one phrase") | A = B (tie) > D > C |
| Protocol compatibility (with what exists *today*) | C > D > B > A |
| Multi-device | Tie — **no model resolves this**; it depends on facts entirely external to the derivation model (§8), except that Model C/D allow adopting Iroh's experimental FROST per-domain without forcing it onto every identity |
| Rotation/revocation | Tie — **no model resolves this** either; same reasoning as multi-device |
| Implementation complexity (today) | C (simplest — no new derivation logic needed) > D > B > A |
| Future extensibility | D > C > B > A |
| Architectural coupling (lower is better) | C > D > B > A |

**Does the evidence support a preferred model?**

**Yes, conditionally: Model D is the model the evidence itself points
to** — not because it scores highest on every single criterion (Model C
is simpler and more private today), but because Models A and B both
require *treating protocols uniformly that are not, in fact, uniform*:
only Bitcoin has a fully standardized, currently-recommended external
derivation mechanism today; Nostr has a *published, technically sound*
one (NIP-06) that reduces direct private-key reuse via hardened,
domain-separated derivation, but is itself currently unrecommended by
the Nostr project, and that narrower derivation property does not by
itself establish broader correlation resistance (§7). Pears (as Sails
uses it), Iroh, Pubky, and PKARR have no derivation mechanism of any
kind. Model D is simply the honest name for "derive where a published
scheme exists (Nostr, with its status caveat noted), keep independent
where none does yet (Pears/Iroh/Pubky), revisit per-protocol as each
one's own capability matures" — which is what the evidence in §3-§4
actually supports, not a preference imposed on top of it.

This is **not** a recommendation to build Model D now. Per the CTO's own
instruction, if evidence doesn't cleanly support a single final choice,
the correct answer is **B/STOP**, not invention — and there is a real,
disclosed reason to land on STOP rather than a confident "build D":
three of seven matrix rows (Pubky's HD-tree question, Pears/Iroh's exact
seed byte-contract, several device/rotation/revocation cells) are
**UNKNOWN**, not merely "leaning D." A future ADR needs those UNKNOWNs
resolved first (§15).

---

## 14. Unresolved unknowns

Every `UNKNOWN` cell above, consolidated:

1. Pubky: does the BIP-39 mnemonic feed an HD tree (multiple derivable
   children) or a single fixed keypair? (§3.5, §4)
2. Pubky/PKARR: device-specific keys, multi-device, rotation,
   revocation, delegation — none confirmed either way.
3. HyperDHT/`Pears`: exact byte-length/format contract for the `seed`
   parameter to `keyPair(seed)` — confirmed to exist, not confirmed in
   detail.
4. Iroh: exact node-discovery-service metadata dependency shape.
5. ~~Nostr `NIP-46` (remote signer) and `NIP-26` (delegated signing) —
   named as existing NIPs, not independently fetched/verified in this
   pass.~~ **Resolved 2026-09-08 (CTO correction pass):** both directly
   fetched and verified. `NIP-46` carries no unrecommended/deprecated
   marker (active, non-deprecated). `NIP-26` carries the same
   `draft`/`unrecommended`/`optional` status as `NIP-06`, with its own
   explicit warning ("adds unnecessary burden for little gain") — see
   §3.4. No longer an open unknown.
6. Whether any of Pears/Iroh/Pubky's raw `seed → key` mapping could
   safely support hardened, BIP-32-style derivation if Sails built one
   — mechanically plausible (they accept arbitrary seed bytes) but not
   confirmed as officially supported or endorsed by those projects.
7. Fingerprinting/metadata-leakage specifics beyond what's already
   noted for each protocol's own discovery/publication layer (DHT
   presence, relay visibility) — flagged for a dedicated Privacy
   Architecture pass (Norte macrofront 19), not resolved here.

---

## 15. Recommendation

**B/STOP — evidence does not yet cleanly support committing to a single
final model.** The evidence leans toward Model D's *shape* (derive where
a published derivation scheme exists — Nostr today, with its own
unrecommended-status caveat noted — keep independent where none exists
at all — Pears/Iroh/Pubky), but §14's unresolved unknowns (especially
Pubky's HD-tree question, which materially changes whether Pubky
belongs in the "can derive" or "must stay independent" bucket) mean a
confident final ADR should not be written from this evidence alone.
NIP-06 itself being merely published-but-unrecommended, rather than
Nostr-endorsed, is a real reason for additional caution before treating
"Nostr today" as a settled anchor for any model, not just a technical
footnote.

**What would need to happen before an ADR is ready** (§16, restated
directly per the mission's own required structure):

1. Directly verify Pubky's exact key-derivation source (not
   search-summary-inferred) to resolve the HD-tree question.
2. ~~Directly verify NIP-46/NIP-26~~ **Done in this correction pass**
   (§3.4/§14) — both verified directly against the official
   `nostr-protocol/nips` repository. Remaining open question, if
   NIP-06/NIP-26 ever become load-bearing for a design: whether Sails
   would adopt a currently-unrecommended NIP anyway, and if so, why —
   a product/security decision, not a further verification task.
3. Decide, as a genuinely separate product/security question (not
   something this discovery document should pre-empt): does Sails want
   to be in the business of inventing a non-standard derivation
   convention for protocols that don't have one (Pears/Iroh, possibly
   Pubky), or does it prefer Model C/D's independent-seed approach for
   exactly those protocols, accepting the worse "one phrase" UX in
   exchange for not owning a bespoke cryptographic convention no other
   Pears/Iroh integrator would recognize?
4. Resolve, separately, the already-flagged
   `docs/CRYPTOGRAPHIC_MODEL.md` §1 documentation drift (§2 of this
   document) — not because it blocks this ADR technically, but because
   it is a live, false claim in a document explicitly created to state
   cryptographic mechanics accurately, and should not sit uncorrected
   indefinitely once discovered.
5. Decide whether Sails' own participant identity (`User.publicKey`)
   needs its *own* recovery mechanism as a prerequisite — §10 found this
   is currently the most foundational unaddressed gap of all, upstream
   of the multi-protocol question entirely.

**Whether a new Core primitive appears necessary:** **not established by
this evidence.** The one existing, reusable primitive this investigation
found relevant is `CapabilityGrant` (RFC-005) as a possible *later*
mechanism for binding a transport/device key to a higher identity (§9)
— but using an existing primitive differently is not the same as a new
primitive being necessary, and this document does not recommend building
that binding now either.

**Whether `OpenIdentity` needs to change:** **not established.** Its
current Core contract (`docs/PROTOCOL_SPECIFICATION.md` §1.1) is already
additive and technology-neutral in a way that doesn't contradict any
model in §5 — the gap found is a missing capability (no rotation/
recovery scheme for Level-0 keys, §3.2/§10), not a conflicting one.
