# Sails Protocol — RFCs

Suggested reading index. Each RFC follows a common structure: Summary, Motivation, Alternatives Considered, Decision, Primitives Used or Extended, Principle Alignment, Specification, Backward Compatibility, and Reference Implementation Plan.

**🔷 Core RFC** (`GOVERNANCE.md` §6A): changes the lifecycle wiring of an existing primitive or a trust/custody model protected by `PROTOCOL_INVARIANTS.md`. Core classification does **not** renumber the permanent RFC sequence (`GOVERNANCE.md` §5). Core RFCs also require explicit Motivation, Decision, and Implementation Impact sections.

| RFC | Title | Scope / Decision |
|---|---|---|
| RFC-001 | Participant Model | Abstract `Participant` is independent of `Identity`; `Wallet` and `Agent` are not direct implementations. |
| RFC-002 | Transport Provider Abstraction | Use a `TransportProvider` interface; Pears/HyperDHT is an implementation, not a mandatory dependency. |
| RFC-003 | Proof Primitive | Replace `confirmFiat()` with generic `submitProof()`; keep `claimType` open-ended. |
| RFC-004 | Negotiation State Machine | Use structured `NegotiationEvent`; chat is one possible communication channel. |
| RFC-005 | Capability Model | Distinguish functional `Capability` from access-control `CapabilityGrant`. |
| RFC-006 | OpenProof Module & Packages | Assign `Proof` to OpenProof; use `Package` to group modules without conflating it with `Capability`. |
| RFC-007 | Real-World P2P Requirements | Consolidates 11 P2P operator requirements within existing modules; `EvidenceBundle` and `Timeline` are not new primitives. |
| RFC-008 | Verifiable Timestamps and a Hash-Chained Timeline | Adds optional policy-gated `TimestampAnchor` and hash-linked timeline entries (`entryHash`/`prevHash`); no blockchain or new primitive required. |
| RFC-009 | Decimal Precision for Financial Fields | Replaces floating-point financial values with `Decimal` storage and decimal strings across TypeScript/JSON boundaries. |
| RFC-010 | Durable Event Store and Mandatory correlationId | Requires durable `EventStore` and event `correlationId`; in-memory adapter works, Redis Streams adapter is not production-ready. |
| RFC-011 | P2P Reconciliation on Peer Reconnect | Reconciles missed Pears notifications against authoritative PostgreSQL on reconnect; negotiation status persistence remains unresolved. |
| RFC-012 | Intent Validation and Coordination States | Adds `VALIDATED` and `COORDINATED` intent states before discovery and consolidates `IntentStatus` definitions. |
| RFC-013 | Capability Registry Implementation, WalletAdapter Pattern, and Portable Identity via peerId | Implements Capability Registry, SDK `WalletAdapter`, Pears `peerId` portability, and `minReputationRating`; reputation remains Sails-owned, not Pears/QVAC. `kycRequired` was removed. |
| RFC-014 | Capability Registry Enforcement | Enforces capability checks on intent creation and fund release; `enforceCapabilities` defaults to `false`. |
| RFC-015 | Two-Person Control for Escrow Release | Adds application-layer buyer/seller approval for normal escrow release, not on-chain multisig; disputed releases bypass this approval. Feature defaults to `false`; single-seed custody risk remains. |
| RFC-016 | QVAC as a Crypto-Native Agent — the Fiat/Crypto Boundary | Restricts QVAC agents to crypto-native actions; fiat/PIX conversion stays with external providers. No runtime change. |
| RFC-017 | Real Timeline Read-Model and Social Engineering Agent | Adds correlation-based timeline and QVAC social-engineering warnings; Redis adapter and `unexpected_flow_deviation` remain incomplete. Feature defaults to `false`. |
| RFC-018 🔷 | Intent as the Canonical Entry Point for Every Trade | **Architecture target, not implemented in this RFC.** Link `Intent` to `Offer`/`Trade` via `intentId` and lifecycle transitions; three-phase migration proposed. |
| RFC-019 🔷 | Settlement Custody — Reference Implementation vs. Normative Protocol | **Production blocker for real-value custodial reference path.** Server-seed `WdkSettlementProvider` is not normative non-custodial settlement; user-side signing migration remains required. |
| RFC-020 🔷 | Non-Custodial EVM Settlement via ERC-4337 Safe Guard + KMS Co-Signer | **Reference design, not deployed.** Proposes Safe/Guard 2-of-3 and KMS co-signing; real KMS, bundler, deployed contract, and security validation remain absent. No production authorization implied. |
| RFC-021 🔷 | Market-Based Arbitration — Reputation Collateral and Payment-Account Trust | **Proposed, not formally accepted.** Permissionless arbiter eligibility combines collateral and reputation; implementation phases recorded except deferred D7. Sybil and payment-account risks remain. |
| RFC-022 🔷 | Arbiterless Reputation on a Lightning Substrate | **Draft; not accepted or implemented.** Proposes Lightning-based reputation, signed trade receipts, and observer-relative max-flow trust; no runtime/schema change. |
| RFC-023 | QVAC Negotiated Trade Proposal (price/reputation-bounded discovery) | Bounded QVAC discovery/proposals with decimal price limits and reputation filters; **human approval remains mandatory** before trade creation or escrow/settlement. |
| RFC-024 | Generation-2 Bitcoin Settlement (candidate) | **Architecture candidate only.** Gen-2 Taproot/MuSig2 is not implemented or homologated; Gen-1 P2WSH 2-of-3 remains the implemented Bitcoin rail. See RFC-024 and the Signing Federation design for gates. |

**Provenance:** RFC-001–006 originated in the Protocol Quality Review; each RFC records its considered and rejected alternatives. RFC-007 came from operator interviews and was accepted by CTO direction rather than the usual discussion window (`GOVERNANCE.md` §5). RFC-008 addresses timestamp and timeline gaps identified while reviewing RFC-007. See each RFC for its decision record.
