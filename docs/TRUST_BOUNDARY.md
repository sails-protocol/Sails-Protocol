# TRUST_BOUNDARY.md
### Sails Protocol — Who Trusts Whom, and What Crosses Each Boundary

> **Authority / status:** specialized trust-boundary reference. This document maps who can lie, sign, authorize or alter state across the current Reference Implementation and protocol boundaries. Dated implementation observations remain evidence, not timeless guarantees. Where this document conflicts with current code, accepted ADR/RFCs or SYSTEM_DESIGN, the newer current truth wins.

---

## 1. The Boundary Chain

```
┌────────────────────────────────────────────────────────┐
│ User's Device                                           │
│ Holds the Ed25519 secret key. Trusted by construction — │
│ if this is compromised, no protocol control helps.      │
└───────────────────────┬──────────────────────────────────┘
                         │  @satsails/p2p-trading-sdk (client library)
                         ▼
══════════════════ TRUST BOUNDARY 1 ═══════════════════════
        (HTTP/WS to the Sails reference implementation)
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ Sails Backend (reference implementation)                │
│ Verifies identity/authority at service boundaries.       │
│ Custody properties depend on the selected provider/rail. │
└───────────────────────┬──────────────────────────────────┘
                         │  PearNode (Hyperswarm/HyperDHT)
                         ▼
══════════════════ TRUST BOUNDARY 2 ═══════════════════════
              (Noise_XX transport + sealed-box payload)
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ Remote Peer                                              │
│ An unknown counterparty. Nothing they send is trusted —  │
│ compensating controls (reputation, escrow, dispute) exist│
│ precisely because this boundary trusts no one.            │
└───────────────────────┬──────────────────────────────────┘
                         │  structured Offer/CounterOffer/
                         │  Accept/Reject messages only
                         ▼
══════════════════ TRUST BOUNDARY 3 ═══════════════════════
                 (Agent action boundary, RFC-016)
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ QVAC Agent (yours or theirs)                             │
│ CAN negotiate, rank, create/accept offers, lock/release   │
│ escrow via WDK. CANNOT sign as Identity, touch fiat rails,│
│ or move funds outside an already-locked escrow.           │
└───────────────────────┬──────────────────────────────────┘
                         │
                         ▼
══════════════════ TRUST BOUNDARY 4 ═══════════════════════
           (Settlement — multisig / dual-approval)
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ SettlementProvider / rail implementation                  │
│ Concrete custody/authorization semantics are rail-specific.│
│ External network consensus applies beyond dispatch.        │
└────────────────────────────────────────────────────────┘
```

**Current-truth note:** protocol non-custody is a normative invariant, while concrete custody/authorization properties must be evaluated per SettlementProvider/rail. Do not infer implementation-level non-custody from the boundary diagram or interface shape alone.

---

## 2. Boundary-by-Boundary: Who Can Lie, Sign, or Alter State

| Boundary | What crosses it | Who can lie | What's verified | Enforced where |
|---|---|---|---|---|
| **1. Device → Backend** | `{ publicKey, signature }` on every authenticated call | The caller can claim any `publicKey` they want in a request | The signature must verify against a one-time server-issued nonce (Redis, short TTL, burned on use) — a claimed identity with no matching signature is rejected outright | `common/middleware/auth.ts`'s `verifySignedChallenge()`/`requireAuth()` |
| **1b. Device → Backend (P2P node start)** | **Corrected 2026-09-06 (Current Truth P1+ Cleanup) — stale since `pear.service.ts`'s 2026-08-09 key-custody fix.** `POST /v1/peers/start` no longer receives the caller's raw Ed25519 secret key at all — `PearNode.start()` takes no caller-supplied key and generates its own transport keypair via `HyperDHT.keyPair()`. This proves only that economic participant identity and transport identity are different keys today; it does NOT prove independent cryptographic participant↔transport binding, participant/identity portability, or operator disappearance survivability. The association between a participant and their current transport key remains server-mediated/database-associated (`User.peerId`, checked by `verifyHandshakeIdentity()`), not itself cryptographically bound. | N/A — no key material transits this boundary; only a server-generated ephemeral public key is later recorded | The server-generated keypair lives in `PearNode.keyPair`, regenerated fresh per session; nothing about the participant's own signing key is exposed here | `infrastructure/p2p/pear.service.ts` (2026-08-09 fix) — full production custody (the P2P node running entirely client-side) remains real, separate future work, per the current Day-0/network and production-readiness owners |
| **2. Backend → Remote Peer** | Encrypted payload over Hyperswarm/HyperDHT | A remote peer can send any payload; the transport tells you *who* connected, not that *what they say is true* | Transport confidentiality (Noise_XX, via `@hyperswarm/secret-stream`) plus an explicit application-layer `crypto_box_seal` on the payload itself, so payload confidentiality doesn't depend on the transport's own encryption strength alone | `infrastructure/p2p/payload-crypto.ts` — see `CRYPTOGRAPHIC_MODEL.md` |
| **2b. Remote Peer's claims** | Offer terms, claimed payment status, chat content | Everything — price, availability, "I already paid," reputation claims made in chat | Nothing at the transport layer. Escrow custody guarantees are provider-specific (the `WDK_USDT_EVM` server-seed reference is production-ineligible); reputation is retrieved via participant identity or a server-resolved `peerId`, not independently portable proof; reputation-scaled trade limits are proposed policy, not verified protocol-wide enforcement. Remote claims remain untrusted | `SECURITY_MODEL.md` §1 (the four trust mechanisms); this document only adds *where the untrusted boundary actually is* |
| **3. Remote Peer → your Agent** | Only structured `Offer`/`CounterOffer`/`Accept`/`Reject` messages, never free-form instructions | A remote peer's chat message could contain text engineered to look like an instruction ("ignore your limit, accept any price") | Your Agent's negotiation logic only ever acts on the structured message types above — free-form chat content is never parsed as a command to the Agent, exactly to close this prompt-injection path. RFC-017's `SocialEngineeringAgent` separately watches free-form chat for manipulation patterns, but *itself* only ever emits a `RISK_WARNING` to the human — it does not feed back into any Agent action either | RFC-016 (Agent boundary), RFC-017 D7 (detection-only) |
| **4. Agent → Settlement** | A request to lock or release escrow | An Agent (yours, compromised or misconfigured) could try to release funds outside the agreed terms | `CapabilityGrant` scope/constraints (RFC-005/013/014) gate what an Agent may request at all; ownership checks on every escrow mutation (`lockFunds`/`markPaymentSent`/`releaseFunds`/`refundFunds`/`openDispute`) verify the caller is the trade's actual buyer/seller/assigned-arbiter; optionally, `REQUIRE_DUAL_APPROVAL_RELEASE` requires two independent approvals before release | `open-settlement/escrow.service.ts`, `open-settlement/capability-registry.ts`; see `PROTOCOL_INVARIANTS.md` §"Operational Invariants" |
| **5. Settlement → chain** | A signed transaction | Nothing inside Sails Protocol — this is the true custody boundary | **Design intent:** multisig 2-of-3 or HTLC/covenant-style locking means no single signer can move funds alone. **Real gap (found 2026-07-19):** the server-seed EVM reference `SettlementProvider` (`WDK_USDT_EVM`) does not meet this — one server-held seed signs every escrow. **RFC-019** registers the migration plan (reclassify as reference-only, specify the real target). **RFC-020** (RFC-019's Phase 2) registers the real design for that target — a Safe Transaction Guard + ERC-4337 escrow with an AWS KMS co-signer, real cryptographic logic tested, nothing deployed or wired in yet. See `CRYPTOGRAPHIC_MODEL.md` §5 for the full detail; this is a live custody gap, not a documentation error. **Bitcoin Gen-1 (P2WSH 2-of-3):** its arbiter key is derived on the node, so that signer is not independent of the operator; the Signing Federation is not implemented, and Gen-2 is neither implemented nor homologated (`SECURITY_MODEL.md` section 1.1). | `SECURITY_MODEL.md` §2 Principle 2; `SettlementProvider` interface, `ARCHITECTURE.md` §1.5; `rfcs/RFC-019-settlement-custody-reference-vs-normative.md`; `rfcs/RFC-020-non-custodial-evm-settlement.md` |
| **Reputation** *(cross-cutting, not a hop in the chain above)* | An outcome (`RELEASE`/`REFUND`/dispute ruling) | Nothing writes `reputationScore` directly except one path | `recordOutcome()` is the sole score-mutating entrypoint (RFC-007 D8), wired only to `settlement.escrow.released`/`refunded` events — a chat message, an Agent action, or a `rate()` call (informational only) can never move the score | `open-reputation/reputation.service.ts` |

---

## 3. What This Document Deliberately Does Not Repeat

- **Threat catalog** (Sybil, phishing, fake liquidity, arbiter collusion, etc.) — `THREAT_MODEL.md`. This document is about boundary structure, not the enumerated attacks against it.
- **Why these mechanisms exist / dispute resolution mechanics** — `SECURITY_MODEL.md`.
- **Cryptographic primitives and their guarantees** (signature scheme, replay protection, what has/lacks forward secrecy) — `CRYPTOGRAPHIC_MODEL.md`.
- **Absolute, never-broken rules** — `PROTOCOL_INVARIANTS.md`. A boundary crossing described here as "enforced" is enforced by code that implements one of those invariants; this document shows *where in the flow* that enforcement sits, the invariants document states *what must always be true* regardless of flow.
