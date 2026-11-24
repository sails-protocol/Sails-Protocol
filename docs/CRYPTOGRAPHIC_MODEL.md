# CRYPTOGRAPHIC_MODEL.md
### Sails Protocol — Cryptographic Mechanics, Consolidated

> Not numbered in `00-INDEX.md`'s canonical 20 — added the same way
> `TRANSACTION_WALKTHROUGH.md`/`TRUST_BOUNDARY.md` were. Requested
> directly by the project owner, relaying a CTO-role architectural
> review: cryptographic mechanics existed in this codebase (identity
> signing, payload encryption, hash-chained event logs) but only as
> scattered file-level doc comments — `ARCHITECTURE.md` names three of
> them in passing in its module tree, `NODE_ARCHITECTURE.md` names none,
> `SECURITY_MODEL.md` mentions "Ed25519 keypair" and "E2E via
> Secretstream" without mechanics. Nothing tied them together with what
> each one actually guarantees — and, as importantly, what it doesn't.
>
> **Every claim below was checked against the actual code at the time
> this was written (2026-07-19).** Where a real cryptographic property
> (e.g. forward secrecy) is absent, that's stated as an open gap, not
> implied to exist because "the system uses encryption."

---

## 1. Identity and Transport Keys

Every `Participant` (RFC-001) is identified economically by a client-controlled Ed25519 public key used for signing/authentication.

The current Pears/HyperDHT transport identity is **separate** from that economic identity.

Current truth:

- **Economic identity** = `User.publicKey` — stable participant/authentication key.
- **Transport identity** = a separate, ephemeral Ed25519 keypair represented by `User.peerId`.
- `PearNode.start()` takes no caller-supplied participant key and calls `HyperDHT.keyPair()` without a seed, generating a fresh transport keypair for the current start/session.
- The association between economic identity and transport identity is server-mediated through runtime/database state; it is not a cryptographic identity equivalence.

Preserve:

```text
Funds Authority ≠ Economic Identity ≠ Transport/Communication Identity
Pears identity ≠ Sails Participant
Transport reachability ≠ economic authority
```

The historical pre-2026-08-09 implementation used the participant key as transport identity. That historical topology remains visible in repository history and dated discovery records, but it is not current cryptographic truth.
- Today, the Pears transport key is **not cryptographically bound to
  participant identity** — this is one real primitive, not the "one
  primitive, not two" this section originally claimed.

This is a documentation-accuracy correction only — it does not change
any code, does not resolve the underlying gap (a future direction is
tracked separately in `docs/BACKLOG.md`'s "Identity Root &
Multi-Protocol Identity UX" entry and
`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`), and preserves the original
2026-07-19 text above verbatim rather than silently editing it.

---

## 2. Authentication: Challenge-Response (Replay Protection)

**Guarantee: an attacker who observes a past signed request cannot
replay it to authenticate as that participant.**

Flow (`common/middleware/auth.ts`):

1. Client requests a challenge for their claimed `publicKey`
   (`POST /v1/identity/challenge`).
2. Server generates a random 32-byte nonce (`crypto.randomBytes`),
   stores it in Redis keyed by `publicKey` with a short TTL
   (`config.auth.challengeTtlSeconds`).
3. Client signs the nonce with their Ed25519 secret key, client-side.
4. Client sends `{ publicKey, signature }`.
5. Server verifies the signature against the stored nonce
   (`nacl.sign.detached.verify`) — **then immediately deletes the
   challenge from Redis**, before checking anything else. A captured
   `{publicKey, signature}` pair cannot be reused, because the nonce it
   was computed over no longer exists server-side after first use.
6. On success, the server issues a short-lived opaque session token
   (also random, also Redis-backed with its own TTL —
   `config.auth.sessionTtlSeconds`) — every subsequent request in that
   window authenticates via the session token (`Authorization: Bearer
   ...`), not by re-signing per request.

**What this does not protect against:** a compromised secret key. Like
any signature scheme, whoever holds the secret key can always
authenticate as that identity — there is no second factor.

---

## 3. Payload Confidentiality: Sealed-Box Encryption Over Pears

**Guarantee: a payload sent peer-to-peer is unreadable by anyone except
the intended recipient, even if the underlying transport's own
encryption is weak, absent, or a future `TransportProvider` (RFC-002)
implementation doesn't provide any.**

`infrastructure/p2p/payload-crypto.ts` — built specifically because
Hyperswarm's own Noise_XX handshake (via `@hyperswarm/secret-stream`,
transitive through `hyperdht`) only encrypts the *wire transport*
between two already-connected peers; nothing encrypted a *payload*
itself before this file existed. This is an explicit application-layer
step, not a redundant one.

Mechanics:

- `PearNode`'s identity keypair is Ed25519 (**signing** curve), but
  `crypto_box_seal` (the sealed-box primitive used) needs a Curve25519
  (**encryption** curve) key. Every public key is converted via
  libsodium's standard, deterministic, lossless
  `crypto_sign_ed25519_*_to_curve25519` birational map before use —
  verified byte-for-byte round-trip against a real generated HyperDHT
  keypair before this file was written (`payloadCrypto.ts`'s own header
  comment; unit-verified for real in `tests/payloadCrypto.test.ts`).
- **Anonymous sealed boxes** (`crypto_box_seal`), not authenticated
  `crypto_box_easy` with a persistent nonce — deliberate: a sealed box
  needs only the recipient's public key to encrypt, matching
  `sendToPeer(targetParticipantId, payload)`'s existing shape (the
  sender already knows who they're sending to; no separate nonce
  management or key announcement needed).
- **Sender identity is transport-scoped, not end-to-end payload proof.**
  The Hyperswarm handshake can authenticate the connected transport key,
  but that key is distinct from the economic participant key and their
  association is currently server-mediated (`TRUST_BOUNDARY.md` boundary
  1b). Anonymous sealed boxes do not authenticate the sender or prevent
  replay of an otherwise valid application message. The WebSocket relay
  fallback also must not inherit Hyperswarm handshake guarantees by
  implication. This layer protects payload confidentiality, not sender
  attribution, message freshness, or traffic metadata.

**What this does not protect against — stated explicitly, per this
document's own discipline:**

- **No forward secrecy.** `crypto_box_seal` uses the recipient's
  long-term identity key directly. If a participant's secret key is
  ever compromised, every sealed-box payload ever sent to them,
  historically, becomes decryptable — there is no per-session ephemeral
  key rotation. A production hardening pass should evaluate whether a
  ratcheting scheme (e.g. Noise-based, similar to Signal's Double
  Ratchet) is warranted once real financial-detail payloads flow
  through this path at scale.
- **No non-repudiation for payload content.** Sealed boxes prove *only*
  that the sender knew the recipient's public key — not who sent it. As
  noted above, sender identity is established at the transport layer,
  not by this encryption step, and that's a deliberate scope split, not
  an oversight — but it means this specific primitive gives you
  confidentiality only, never authenticity of the payload's contents on
  its own.

---

## 4. Integrity: Hash-Chained Event Logs

**Guarantee (where implemented): a past event cannot be silently edited
or deleted without the tamper being detectable.**

Several related but *not identical* mechanisms exist under this name — worth
being precise about, since conflating them would misstate what's
actually protected:

### 4.1 `IntentEvent` — real, implemented today

`core/intent-engine.ts`'s `transitionIntent()` computes, for every
state-transition write:

```
entryHash = sha256(fromStatus | toStatus | triggeredBy | prevHash)
```

`prevHash` is the previous `IntentEvent`'s `entryHash` for that same
`intentId` (`'genesis'` for the first). Each hash is computed once, at
write time, and persisted — never recomputed on read, which is what
makes tampering detectable at all (RFC-008's own point: a live-computed
hash on every read would just re-derive an internally-consistent hash
after a rewrite, defeating the purpose).

### 4.2 Cross-module `Timeline` — implemented over `DurableEvent`

`core/timeline.ts` projects events from the EventStore, exposes
`entryHash`/`prevHash`, and implements `verifyChain()` by recomputing
stored event hashes and checking links from `GENESIS_HASH` per
`correlationId`. `SailsEventBus` defaults to `PostgresEventStore`, not
`InMemoryEventStore`. The Postgres implementation persists `DurableEvent`
records and serializes writers per correlation using transaction-scoped
advisory locks. RFC-008 D2's 2026-08-15 amendment records live Postgres
integration tests of concurrency, rollback and chain verification.
Redis Streams is another implemented adapter; in-memory storage is
non-durable. These mechanisms are distinct from the `IntentEvent` and
`EscrowEvent` chains. Hash verification does not itself deduplicate
business operations or establish independent cross-operator recovery,
external anchoring, or production homologation.

### 4.3 What hash-chaining does and doesn't give you

A hash chain proves *internal consistency* — that entry N's hash
correctly derives from entry N-1's — not that entry N-1 itself was ever
true, and not that the chain hasn't been silently truncated (only the
remaining entries re-verify; a deleted prefix is undetectable from the
chain alone). RFC-008's own D1 (`TimestampAnchor`, third-party-anchored
proof of a hash's existence at a point in time) is the mechanism that
closes the truncation/backdating gap — **that anchoring mechanism is
designed (RFC-008 D1) but not implemented**; no code path calls an
`anchor()` today. Treat the current hash chain as tamper-evidence for
the entries you can see, not as a trustless timestamping guarantee.

---

## 5. Settlement Custody: What `WDK_USDT_EVM` Actually Signs With

*(Added 2026-07-19 — a real custody gap found by a CTO-directed
fidelity audit, "does the implementation respect the model the spec
describes," not by a design review. Documented here rather than only in
`SECURITY_MODEL.md` because the mechanics belong with the other
signing/key-material sections above.)*

**Guarantee the protocol's design calls for: the user's own key signs
every fund-moving action; the server never holds a key capable of
moving user funds (`PROTOCOL_INVARIANTS.md` Constitutional Invariant 2,
`SECURITY_MODEL.md` Principle 2).**

**What the server-seed EVM reference `SettlementProvider` — `WdkSettlementProvider`
(`wdk-settlement.provider.ts`) — actually does: it does not meet that
guarantee.** `getWallet()` constructs a `WalletManagerEvm` from a single
seed phrase (`config.wdk.seedPhrase`, env var `WDK_SEED_PHRASE`) that
the server holds. Every escrow's signing sub-account is derived
deterministically from that one seed (`escrowIndexFor(tradeId)`, a
`sha256(tradeId)`-derived index) — not from anything the buyer or
seller supplies. `releaseFunds(escrow, toAddress)` needs no
caller-provided signature or credential at all; it calls
`escrowAcct.transfer(...)` directly using the server-derived key. The
file's own header comment is explicit about this, unprompted: *"a
single-seed, two-hop escrow, not a trustless multisig ... the same key
that can lock funds can also move them anywhere."*

**What this means concretely:**
- The server (or whoever controls `WDK_SEED_PHRASE`) can move funds
  from *any* escrow this provider created, at any time, without any
  counterparty's cooperation or signature.
- This is the opposite of the `TRUST_BOUNDARY.md` boundary-5 claim ("no
  single party unilaterally moves funds") for this specific provider —
  that claim describes the protocol's multisig design (§1.5,
  `SettlementProvider` interface) and the `MOCK` provider's intent, not
  `WDK_USDT_EVM`'s current reality.
- It is disclosed at the code level, not hidden — but until this audit,
  no document above the code comment itself said so plainly. It is
  explicitly testnet-only in every place it's invoked
  (`config.wdk.*` test defaults, `demo/pix-to-usdt-flow.ts`).

**Not fixed here.** Closing this gap means building a real multisig or
threshold-signature `SettlementProvider` for EVM (or restricting
`WDK_USDT_EVM` to demo/testnet use only, never production, until one
exists) — real engineering work, not a documentation correction. **RFC-019**
(`rfcs/RFC-019-settlement-custody-reference-vs-normative.md`) is the
accepted, registered plan: reclassifies this implementation as
reference-only, specifies the non-custodial target architecture, and
lays out an incremental migration without committing to a build date.
Also tracked as a blocking production-readiness item in `TODO.md`.

### 5.1 RFC-020's real (but unwired) target: ERC-4337 UserOperation hashing + MuSig2

*(Added 2026-07-28. RFC-020 is RFC-019's own Phase 2 — the real design
this section's "Not fixed here" gap has been waiting for. None of this
is called from `WdkSettlementProvider` or any live route; it is real,
independently-tested cryptographic logic in new `@satsails/p2p-trading-sdk` custody
modules, verified structurally and via `packages/sails-sdk/tests/custody-*.test.ts`,
not exercised against live infrastructure.)*

**EVM — `ERC4337CustodyProvider`'s `userOpHash`**
(`packages/sails-sdk/src/custody/evm-4337.ts`). Transcribed
field-for-field from `UserOperationLib.sol`'s real `encode()`/`hash()`
and `EntryPoint.sol`'s real `getUserOpHash()` — every field the
struct-hash ABI-encodes is already a fixed 32-byte word or a
pre-hashed dynamic field, so this is genuine 32-byte-word
concatenation, not a full ABI codec:

```
structHash  = keccak256(abi.encode(PACKED_USEROP_TYPEHASH, sender, nonce,
                keccak256(initCode), keccak256(callData), accountGasLimits,
                preVerificationGas, gasFees, keccak256(paymasterAndData)))
domainSep   = keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH,
                keccak256("ERC4337"), keccak256("1"), chainId, entryPoint))
userOpHash  = keccak256(0x1901 || domainSep || structHash)
```

`entryPointAddress`/`chainId` are required constructor parameters,
never hardcoded defaults, since the domain separator is bound to a
specific deployed `EntryPoint` on a specific chain. Signing this hash
(via `SailsSignerService`, below) and bundler submission are
real-API-shaped but throw `SailsNotImplementedError` — no live AWS
credentials or bundler endpoint exist in this sandbox.

The one key the server still legitimately holds under this design —
the arbiter-equivalent 2-of-3 co-signer on the `SailsEscrowSafe` Safe —
moves from a raw seed phrase into AWS KMS via `SailsSignerService`
(`packages/sails-sdk/src/custody/kms-signer.ts`): the service holds
only a `KeyId`, never raw key material, and a KMS asymmetric signing
key is provably non-exportable.

**Bitcoin — `BitcoinCustodyProvider`'s MuSig2 primitive**
(`packages/sails-sdk/src/custody/bitcoin-taproot.ts`), a documented
Taproot upgrade path for the already-shipped P2WSH `MultisigProvider`,
not a replacement of it. Each of `MultisigProvider`'s three real
signing pairs (buyer+seller cooperative, arbiter+buyer disputed-release,
arbiter+seller disputed-refund) becomes its own MuSig2-aggregated
2-of-2 x-only pubkey, usable as one Taproot script-tree leaf spent with
a single Schnorr signature instead of P2WSH's revealed 3-of-3 script.
Key/nonce aggregation, the partial-signature round, and combination use
`@scure/btc-signer`'s real `musig2.js` — verified end-to-end (2-of-2
aggregate → nonce exchange → partial-sign → combine →
`schnorr.verify()`) against a real secp256k1 keypair before being
written. Deriving the real bech32m Taproot address and broadcasting a
finalized transaction need a live network target and throw
`SailsNotImplementedError`, the same boundary `MultisigProvider`'s own
`fetchUtxos()`/`broadcast()` already has against testnet.

> Note: Gen-2 Taproot/MuSig2 is a candidate, not homologated; Gen-1 P2WSH is the only real Bitcoin rail. See RFC-024 and `docs/architecture/SAILS_SIGNING_FEDERATION/`.

Full detail, including the Solidity `Guard` these hashes and signatures
feed into and the Threat Matrix, is in
`rfcs/RFC-020-non-custodial-evm-settlement.md`.

---

## 6. Key-at-Rest: `sails-ui`'s Passphrase-Derived Encryption

*(Added 2026-08-14 — a real security gap flagged live in the reference
UI, not a design review. `packages/sails-ui/src/lib/keyEncryption.ts`.)*

**Guarantee: a private key sitting in the browser's `localStorage`
cannot be read as plaintext by anything that only has passive read
access to the browser profile** — another script, a malicious
extension, or offline access to the profile directory. This is
distinct from every guarantee above: sections 1-5 are protocol-level
primitives; this one is specific to `sails-ui`, the reference web
client, and only covers two concrete secrets it persists client-side:
`AuthContext.tsx`'s Ed25519 identity key and `useEscrowKey.ts`'s
secp256k1 escrow signing key.

Mechanics:

- A user-supplied passphrase is stretched via **PBKDF2-SHA256, 210,000
  iterations** (OWASP's 2023 minimum) into a **non-extractable
  AES-256-GCM** `CryptoKey` — `deriveKey()`'s `extractable` flag is
  `false`, so the raw key material never becomes readable JS bytes; it
  is only ever usable indirectly via `SubtleCrypto` calls.
- The PBKDF2 salt is random per browser profile (`crypto.getRandomValues`,
  16 bytes), generated once and stored alongside the ciphertext
  (`sails_ui_kdf_salt` in `localStorage`) — salts aren't secret, this
  only ensures two users with the same passphrase don't derive the same
  key.
- Each encryption uses a fresh random 12-byte IV (`encryptBytes()`),
  packed as `<iv-hex>:<ciphertext-hex>` — AES-GCM requires a unique IV
  per encryption under the same key; reusing one would break the
  scheme's confidentiality guarantee.
- **AES-GCM is authenticated**, so `decryptBytes()` distinguishes two
  failure modes rather than silently producing garbage: `corrupt`
  (malformed packed string — pre-encryption legacy plaintext-hex data,
  or truly corrupted storage; safe to treat as "no key stored") vs.
  `wrong-passphrase` (well-formed ciphertext, auth tag didn't verify).
  The distinction matters because collapsing `wrong-passphrase` into
  "no key stored" would silently regenerate a new identity/escrow key,
  orphaning whatever the old one controlled — an escrow key controls
  real funds, and even the identity key would strand existing on-chain
  reputation tied to the old public key.

**What this does not protect against — same explicit-gap discipline as
every section above:**

- **Active-session exfiltration.** The derived key and any decrypted
  key material still exist in JS memory while a session is unlocked. A
  script running *during* that window (a live XSS, not a passive
  reader) can still read a key straight out of memory. This scheme
  closes passive-at-rest exposure only; it does not turn `sails-ui`
  into a real external wallet. Both `AuthContext.tsx` and
  `useEscrowKey.ts` disclose this in their own header comments as a
  demo-only shortcut, not production key custody — consistent with
  `TRUST_BOUNDARY.md`'s framing of this reference UI generally.
- **No re-authenticate-on-mount.** A page refresh requires re-entering
  the passphrase — there is no way to re-derive the AES key without it,
  by design (a silent re-derivation path would mean the passphrase, or
  something equivalent to it, is recoverable without the user, which
  defeats the point). This is a real, visible behavior change from the
  prior plain-hex storage, not an incidental side effect.
- **The passphrase itself is not rate-limited or strength-checked
  client-side.** A weak passphrase narrows PBKDF2's cost advantage
  against offline brute-force. Out of scope for this pass — flagged
  here rather than silently assumed away.

---

## 7. What This Document Deliberately Does Not Repeat

- **Who is on the other side of an encrypted channel, and whether
  they're trusted** — `TRUST_BOUNDARY.md`. This document is about what
  the cryptography guarantees; that one is about who's on each side of
  a boundary and what they can lie about regardless of encryption.
- **The attacks these mechanisms mitigate, and which threats remain
  open** — `THREAT_MODEL.md`.
- **Reputation being tied to a keypair, trust limits scaling with
  reputation, dispute resolution** — `SECURITY_MODEL.md`. This document
  only covers the cryptographic primitives those mechanisms are built
  on, not the trust policy built on top of them.
