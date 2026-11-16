# Sails Protocol — System Design

> **Status:** Draft / CTO-owned consolidation.  
> **Purpose:** This document is the technical entry point to the current Sails system. It summarizes the architecture and routes readers to the canonical normative and specialized documents. It does **not** replace ADRs, RFCs, the Semantic Kernel, the protocol specification, or implementation evidence.

---

## 1. What this document is

Sails has accumulated substantial architecture, implementation, security, lifecycle, authority, provider, SDK and institutional documentation. The problem is no longer lack of technical material; it is that a new engineer must currently reconstruct the system across many documents and historical handoffs.

This document provides one coherent system-level view.

Use it to answer:

- what Sails is;
- where protocol truth lives;
- how the software layers relate;
- how a P2P economic interaction flows end to end;
- where authority, evidence, settlement and recovery boundaries live;
- which parts are protocol semantics versus Reference Implementation choices;
- which deeper document owns each topic.

### Source-of-truth rule

When this document summarizes a deeper normative source, the deeper source wins.

In particular:

- semantic identity → [SEMANTIC_KERNEL.md](SEMANTIC_KERNEL.md)
- Pure Core architecture → [CORE_ARCHITECTURE.md](CORE_ARCHITECTURE.md)
- implementation derivation → [CORE_IMPLEMENTATION_ARCHITECTURE.md](CORE_IMPLEMENTATION_ARCHITECTURE.md)
- protocol primitives/conformance → [PROTOCOL_SPECIFICATION.md](PROTOCOL_SPECIFICATION.md)
- protocol invariants → [PROTOCOL_INVARIANTS.md](PROTOCOL_INVARIANTS.md)
- architectural decisions → [adr/](adr/)
- accepted design decisions / detailed mechanisms → [rfcs/](rfcs/)
- current engineering obligations → [BACKLOG.md](BACKLOG.md)
- release / future sequencing → [ROADMAP.md](ROADMAP.md)

---

## 2. System identity

**Current category:** Sails Protocol is an **Economic Coordination Protocol**.

**V1 focus:** open infrastructure for building interoperable P2P Financial Marketplaces.

**First concrete developer product:** **Sails P2P Trading SDK**.

The shortest useful mental model remains:

```text
User → Intent → Coordination → Settlement → Completion
```

Sails does not require one wallet stack, one settlement network, one transport, one database, one application, or one operator to define economic meaning.

The protocol coordinates shared semantics while implementations remain replaceable.

---

## 3. Architecture at a glance

The current software macro-architecture is:

```text
Semantic Kernel
      ↓
Pure Core
      ↓
Runtime
      ↓
Modules
      ↓
Providers / Adapters
      ↓
Applications / Interfaces
```

### 3.0 Quick architecture map

> **Diagram ≠ protocol truth.** This is a reading aid for the current architecture. If the diagram conflicts with the Semantic Kernel, Protocol Invariants, Protocol Specification, accepted ADR/RFCs or current implementation evidence, the governing source wins.

```mermaid
flowchart TB
    A["Applications / Interfaces<br/>Sails Market · Satsails Wallet · Third-party wallets/apps"]
    SDK["SDK / Integration Surface<br/>P2P Trading SDK · API · Wallet Adapter contract"]

    subgraph SAILS["Sails Protocol / Reference Runtime"]
      SK["Semantic Kernel"]
      CORE["Pure Core"]
      RT["Runtime"]
      MOD["Modules<br/>OpenP2P · OpenSettlement · OpenProof · OpenIdentity<br/>OpenReputation · OpenLiquidity · OpenAgents"]
    end

    subgraph EDGES["Replaceable execution edges"]
      WA["Wallet Adapters"]
      SP["Settlement Providers"]
      EP["Evidence Providers"]
      TP["Transport Providers"]
      AP["Arbitration / Liquidity Providers"]
    end

    subgraph EXT["External networks / infrastructure"]
      BTC["Bitcoin"]
      SPARK["Spark / Lightning"]
      ARK["Arkade"]
      LIQ["Liquid"]
      EVM["EVM rails"]
      OTH["Solana · TRON · TON · other rails"]
    end

    A --> SDK
    SDK --> SK
    SK --> CORE
    CORE --> RT
    RT --> MOD

    MOD --> WA
    MOD --> SP
    MOD --> EP
    MOD --> TP
    MOD --> AP

    SP --> BTC
    SP --> SPARK
    SP --> ARK
    SP --> LIQ
    SP --> EVM
    SP --> OTH

    RT -. "node/runtime instances" .-> NODE2["Other conformant Sails node/operator"]
    NODE2 -. "shared market / transport / coordination<br/>where current architecture permits" .-> RT
```

Fast reading:

- **top:** products and integrators consume Sails;
- **center:** semantic meaning flows from Kernel → Core → Runtime → Modules;
- **edges:** adapters/providers translate Sails semantics into external mechanisms;
- **bottom:** chains, rails and infrastructure execute outside Sails protocol truth;
- **side:** multiple node/runtime operators may participate without redefining economic semantics.

### 3.1 Semantic Kernel

The Semantic Kernel defines the minimum properties that must remain true for an interaction to still be recognizably governed by Sails.

It is **not a package** and is not identical to `@sails/core`.

Canonical owner: [SEMANTIC_KERNEL.md](SEMANTIC_KERNEL.md).

### 3.2 Pure Core

The Pure Core materializes Sails' economic semantics without owning infrastructure, persistence, transport, provider implementation or application concerns.

The current TypeScript implementation surface is the internal/private `packages/sails-core/` workspace.

Canonical owners:

- [CORE_ARCHITECTURE.md](CORE_ARCHITECTURE.md)
- [CORE_IMPLEMENTATION_ARCHITECTURE.md](CORE_IMPLEMENTATION_ARCHITECTURE.md)

### 3.3 Runtime

Runtime turns pure semantics into executable system behavior. It owns orchestration concerns such as persistence boundaries, event processing, transactions, recovery coordination and invocation of Pure Core semantics.

Runtime is not protocol truth by itself.

### 3.4 Modules

Current responsibilities are organized into modules such as:

- OpenP2P
- OpenSettlement
- OpenIdentity
- OpenReputation
- OpenProof
- OpenLiquidity
- OpenAgents
- OpenFinance where roadmap scope applies

Modules coordinate domain responsibilities; they do not redefine the Semantic Kernel.

### 3.5 Providers and adapters

Providers translate stable Sails semantics into replaceable external mechanisms.

Examples include:

- wallet adapters;
- settlement providers;
- transport providers;
- evidence providers;
- arbitration providers;
- liquidity providers.

A provider may change how something executes. It may not change what the authorized economic outcome means.

### 3.6 Applications and interfaces

Applications consume Sails without owning protocol semantics.

Important first-party surfaces include:

- **Sails Market** — first-party/reference commercial web marketplace surface;
- **Satsails Wallet** — first-party wallet/reference integration and validation surface;
- third-party wallets, services and professional liquidity providers.

Reference application control does not imply protocol control.

---

## 4. Protocol versus Reference Implementation

This distinction is mandatory.

### Protocol / specification

Technology-independent rules, interfaces, semantics, invariants and conformance behavior.

The protocol does not inherently depend on:

- TypeScript;
- PostgreSQL;
- Redis;
- Prisma;
- Fastify;
- Pears/HyperDHT;
- a particular blockchain;
- Satsails infrastructure.

### TypeScript Reference Implementation

The current repository contains a concrete implementation using technologies including TypeScript and a PostgreSQL/Prisma-based persistence stack.

Those technologies prove and exercise the protocol. They are not themselves protocol requirements.

A conformant independent implementation in another language or persistence stack must be able to preserve the same economic meaning.

---

## 5. End-to-end P2P economic flow

At system level, the intended journey is approximately:

```text
Participant
  ↓
Intent
  ↓
Discovery / Offer
  ↓
Negotiation
  ↓
Agreed economic terms
  ↓
Trade
  ↓
Settlement / Escrow
  ↓
Payment / Evidence
  ↓
Release | Refund | Dispute
  ↓
Economic Outcome
  ↓
Reputation / Accounting / Completion projections
```

### 5.1 Quick economic coordination flow

```mermaid
flowchart LR
    P["Participant"] --> I["Intent"]
    I --> O["Discovery / Offer"]
    O --> N["Negotiation"]
    N --> T["Trade / Agreed Terms"]
    T --> S["Settlement / Escrow"]

    S --> PAY["Payment / Funding"]
    S --> EV["Evidence / OpenProof"]

    PAY --> DEC{"Authorized economic disposition"}
    EV --> DEC

    DEC --> REL["Release"]
    DEC --> REF["Refund"]
    DEC --> DIS["Dispute / Arbitration"]

    DIS --> OUT["Economic Outcome"]
    REL --> OUT
    REF --> OUT

    OUT --> PROJ["Reputation · Accounting · Completion projections"]

    SP["Settlement Provider / Rail"] -. "executes" .-> S
    EP["Evidence Provider"] -. "stores bytes; does not define truth" .-> EV
    WA["Wallet Adapter"] -. "signing / wallet capability" .-> S
```

Read the diagram with these constraints:

```text
Intent ≠ Trade ≠ Settlement ≠ Evidence ≠ Outcome
Storage provider ≠ evidence truth
Settlement provider ≠ economic authority
Wallet adapter ≠ settlement provider
Unknown outcome ≠ failed outcome
```

This is an architectural orientation, not a replacement for the concrete state machines or route/API documentation.

Relevant deeper sources:

- protocol primitives → [PROTOCOL_SPECIFICATION.md](PROTOCOL_SPECIFICATION.md)
- application-facing APIs → [API_REFERENCE.md](API_REFERENCE.md)
- frozen SDK contract → [API_STABLE.md](API_STABLE.md)
- current lifecycle obligations → [BACKLOG.md](BACKLOG.md)

---

## 6. State, lifecycle and economic truth

Sails distinguishes:

```text
state snapshot ≠ complete economic truth
```

and:

```text
economic state ≠ transport/event arrival order
```

State transitions must respect canonical lifecycle rules and authority at the moment that matters economically.

Important cross-cutting rules include:

- delayed or reordered events must not regress newer economic state;
- retry permission does not create new authority;
- UNKNOWN must not be collapsed into FAILED;
- historical authority must not silently remain executable after supersession;
- external provider acceptance is not automatically final economic truth.

Detailed state/lifecycle findings and accepted remediations belong to their dedicated discovery documents, ADRs and issues rather than being redefined here.

---

## 7. Authority model

Sails deliberately separates several concepts that are commonly conflated:

```text
Authentication ≠ Authorization
Identity ≠ Authority
Recommendation ≠ Authority
Execution Authority ≠ Economic Disposition Authority
Economic Disposition Authority ≠ Destination Authority
Past Authority ≠ Current Authority
```

Authority must be checked at the correct economic boundary, not merely at an outer HTTP route or earlier step.

Key current architecture:

- authenticated identity establishes who is calling;
- role/economic-scope checks establish whether that actor may perform a specific action;
- capability grants do not create economic consent;
- disputed economic disposition is generation-bound;
- settlement execution must not silently survive a superseding ruling;
- destination authority remains beneficiary-controlled where required.

Detailed authority architecture is owned by the authority discovery material and relevant ADRs.

---

## 8. Evidence and OpenProof

Evidence is a protocol input and provenance surface, not automatic truth.

Preserve:

```text
Evidence bytes ≠ Evidence truth
Evidence availability ≠ Evidence integrity
Authentication ≠ Evidence Authorization
Valid signature ≠ authority to attach evidence anywhere
```

Current direction:

- OpenProof is the integrity-bound path for real media/file evidence;
- lightweight external/non-file dispute references may remain separate;
- production evidence storage must be durable, private, multi-instance-safe and provider-neutral;
- storage-provider choice must not become protocol semantics.

Canonical architecture owner for the active production-hardening work is Issue #234 and its bounded implementation owners.

---

## 9. Settlement architecture

Sails expresses the destination of an economic settlement using:

```text
Asset + SettlementRail
```

These are separate product dimensions.

Examples of settlement mechanisms vary by rail:

- Bitcoin L1 may use script/multisig-style mechanisms;
- Spark uses Spark-specific primitives;
- Arkade uses Ark/vTXO-specific mechanisms;
- EVM-family rails use contract/account-abstraction mechanisms;
- Solana, TRON, TON and Liquid require rail-specific implementations.

The protocol defines settlement capability and economic semantics, not one universal escrow mechanism.

Preserve:

```text
Asset ≠ SettlementRail ≠ Wallet Adapter ≠ Settlement Provider
Implementation exists ≠ Production eligible
```

Canonical decision: ADR-002 and the relevant provider documentation.

---

## 10. Wallet adapter architecture

Wallet integrations are replaceable edges.

Sails defines a stable wallet-adapter contract rather than defining protocol support as a list of SDK brands.

Preserve:

```text
WalletAdapter ≠ SettlementProvider ≠ External Wallet Connector
```

A wallet adapter exposes capabilities needed by Sails while the wallet retains custody, key ownership and signing responsibility.

Satsails Wallet is an important first-party/reference integration, not the definition of the protocol.

---

## 11. Events, durability and projections

Sails uses event-driven module coordination to reduce cross-module ownership violations.

However:

```text
event persisted ≠ all downstream projections completed
notification ≠ protocol state
```

Durable event history, delivery/fanout and durable projection completion are distinct concerns.

The reference runtime must recover safely across:

- crash after durable event persistence;
- partial projection application;
- duplicate delivery;
- process restart;
- multi-instance execution.

Current production-hardening work tracks these properties explicitly rather than assuming that an emitted event proves convergence.

---

## 12. Persistence and reference runtime

The current TypeScript Reference Implementation uses PostgreSQL with Prisma for durable application/runtime persistence, with Redis used in selected runtime/distribution roles.

This is implementation architecture, not protocol truth.

The system must preserve the distinction:

```text
database state ≠ protocol definition
runtime persistence ≠ semantic authority
```

Recovery and consistency requirements must remain expressible independently of the chosen storage technology.

---

## 13. Multi-node / network topology

Day-0 must not collapse into one mandatory Satsails-controlled backend.

Required direction:

- multiple independent Sails node/runtime operators;
- shared economic network rather than isolated liquidity islands;
- node selection should be service-level choice, not market membership;
- bootstrap/discovery infrastructure must not become protocol authority;
- a wallet/integrator may use its own node, a partner/operator node, a public/community node, or a configured default/fallback node.

Core property:

```text
Node choice must not define market membership.
Liquidity should be network-level; node operation should be service-level.
```

A Sails Node is a runtime/service boundary, not protocol truth. Different operators may compete on uptime, privacy, policy, support, latency or integrations without redefining the meaning of Intent, Trade, Settlement, Evidence or Outcome.

The current reference implementation is not yet the completed Day-0 multi-operator topology. Today, significant economic state remains node-local. Pears/HyperDHT provides real peer transport, but current Pears usage must not be mistaken for complete cross-node liquidity, identity or state portability.

Canonical architecture owner: ADR-001 and Issue #105 for completion/evidence. Current discovery evidence: [DAY0_MULTI_OPERATOR_NETWORK_ARCHITECTURE_DISCOVERY.md](DAY0_MULTI_OPERATOR_NETWORK_ARCHITECTURE_DISCOVERY.md).

### 13.1 Open and private market contexts

Sails must be able to support more than one market-access model without creating different protocol semantics.

**Open/public market context**
- multiple conformant operators participate in a shared economic market universe;
- node choice alone must not partition market membership;
- bounded propagation delay or operator-specific filters do not by themselves imply fragmentation.

**Private / closed / permissioned context**
- a business, OTC desk, community or known group may restrict who can discover or participate in its market/rooms;
- admission policy belongs to that market/application context;
- the same Sails economic semantics still govern Intent, Trade, Settlement, Evidence and Outcome;
- private membership does not make the operator protocol authority;
- privacy does not require publishing all identities or liquidity into the public market.

Therefore:

```text
Market admission policy ≠ protocol truth
Private market ≠ different economic semantics
Private visibility ≠ public identity requirement
```

The exact implementation mechanism for private groups/rooms and how they interoperate with public/shared discovery remains a product/network design decision where not already frozen. Do not infer a mandatory federation, relay, Nostr, Pears or database topology from this section.

---

## 14. Identity, transport and reputation

Sails coordinates economic participants; it does not require one universal public identity provider.

Preserve these distinctions:

```text
Funds Authority ≠ Economic Identity ≠ Transport/Communication Identity
Identity ≠ Authority
Same recovery root ≠ same private key across protocols
```

### 14.1 Sails Participant / economic identity

The Sails Participant represents the economic participant in Sails semantics. In the
current TypeScript Reference Implementation this is backed by a client-controlled public
key / participant record. The abstraction remains the model for Sails participation;
external identity integrations do not replace it (see
[RFC-001](rfcs/RFC-001-participant-model.md)).

A participant identity must not be confused with:
- a Sails Node account;
- a Pears peer identifier;
- a wallet spending key;
- a Nostr identity;
- a Pubky identity.

### 14.2 Pears / HyperDHT

Pears/HyperDHT is the selected transport/communication implementation for the Reference
Implementation. This is an implementation choice, not a protocol dependency; the
`TransportProvider` boundary and future adapters remain as defined in
[RFC-002](rfcs/RFC-002-transport-provider.md).

Current implementation truth is important: Pears transport identity is separate from the
participant/economic identity and is currently generated as an ephemeral transport identity
in the active implementation. Transport keys also remain separate from wallet/funds-
authority keys; this choice specifies no shared key, derivation or recovery scheme.

Therefore:

```text
Pears identity ≠ Sails Participant
Transport reachability ≠ economic authority
Pears implementation ≠ protocol dependency
```

### 14.3 Nostr / Pubky and external identity ecosystems

Pubky is the prioritized external provider for identity, discovery and compatible
authorizations in the Reference Implementation. This is an integration priority only: it
does not replace the abstract Sails Participant, define or change authorization semantics,
mandate Pubky for protocol-conformant implementations, or claim completed integration or
homologation. Prototype and lab results are evidence only; they do not establish
homologation.

Nostr is not a mandatory Day-0 dependency and remains optional as an interoperability
ecosystem. External identity integrations remain replaceable edges, and Sails must not
silently convert an external identity into economic authority or require one external
network to define Sails participation. Future adapters remain possible.

No universal replacement "Sails ID" is implied here. The protocol coordinates the participant's economic meaning while external identities remain optional, replaceable edges.

The exact recovery-root, rotation, revocation, multi-device and cross-protocol binding model remains subject to its dedicated identity architecture work where not already frozen.

Current evidence owner: [IDENTITY_ARCHITECTURE_DISCOVERY.md](IDENTITY_ARCHITECTURE_DISCOVERY.md).

### 14.4 Reputation portability

Reputation must remain evidence/provenance-based and portable enough not to become trapped by a single node or application.

A node-local computed score is not automatically portable protocol truth. Cross-node reputation claims require independently verifiable provenance/evidence rather than trusting an operator-local number by assertion.

---

## 15. AI / agent boundary

AI may assist Sails engineering and runtime behavior, but:

```text
Intelligence ≠ Authority
Inference ≠ Evidence
Model confidence ≠ protocol truth
Agent access ≠ Agent authority
```

QVAC or any other model may recommend, classify, reason or propose only within explicit capabilities and authority boundaries.

A model change must not redefine economic semantics.

Canonical owner for this architectural boundary: Issue #155 and the relevant OpenAgents/QVAC documents.

---

## 16. Security and production-readiness model

**Current status:** the reference implementation is still inside Day-0 / production-readiness hardening and must not be described as production-open yet. Production eligibility remains a governed gate, not a property inferred from code existence or green CI.

Sails treats implementation, evidence and production eligibility as separate claims.

Examples:

```text
Protocol-representable ≠ Runtime-registered ≠ Deployment-eligible
Provider implementation ≠ Provider maturity ≠ Production eligibility
CI green ≠ architecture correct
Internal test success ≠ external reality proof
```

Production gates require explicit evidence for:

- authorization boundaries;
- crash/restart recovery;
- concurrency;
- provider ambiguity / UNKNOWN;
- multi-instance behavior;
- storage durability;
- rail-specific recovery;
- real partner integration;
- multi-operator network behavior;
- Red Team/security validation;
- external/live provider evidence where claimed.

---

## 17. Product and UI boundary

Protocol truth is upstream of product presentation.

Preserve:

```text
Protocol defines truth. UI represents truth.
Economic State Before Interface State.
Recommendation ≠ decision.
Ruling ≠ Settlement.
Unknown ≠ Failure.
```

The design-system/UI work is intentionally governed separately and must consume current protocol/SDK truth rather than invent lifecycle or authority semantics.

---

## 18. Documentation authority tiers

The repository intentionally preserves both current truth and the evidence/history that produced it. They are not the same class of document.

### Tier A — primary technical path

`README → PROJECT_CONTEXT → SYSTEM_DESIGN → Semantic Kernel/Core → Protocol Specification/Invariants → ADR/RFC → API/SDK → Backlog/Roadmap`

### Tier B — specialized current references

Examples include database, deployment, node architecture, trust boundary, cryptographic model, security/threat model, protocol economy and provider/rail-specific safety documents.

### Tier C — discovery / audit / evidence records

Discovery, cold-sweep, conformance, cross-layer and technical-debt reports preserve evidence and decision provenance. They do not automatically remain the owner of current architecture after their findings are consumed by canonical architecture, ADRs or RFCs.

### Tier D — historical / handoff / limited-authority material

Historical handoffs, superseded sections and resolved operational inventories remain traceable but should not sit in the primary reader path.

This classification is about **authority and navigation**, not deleting history.

---

## 19. Current technical reading path

For a new engineer:

1. [../README.md](../README.md) — repository/product orientation
2. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — institutional/product context
3. **SYSTEM_DESIGN.md** — system-level technical map
4. [SEMANTIC_KERNEL.md](SEMANTIC_KERNEL.md) — semantic identity
5. [CORE_ARCHITECTURE.md](CORE_ARCHITECTURE.md) — modern Core boundary
6. [CORE_IMPLEMENTATION_ARCHITECTURE.md](CORE_IMPLEMENTATION_ARCHITECTURE.md) — implementation derivation
7. [PROTOCOL_SPECIFICATION.md](PROTOCOL_SPECIFICATION.md) — primitives and conformance
8. [adr/](adr/) and [../rfcs/](rfcs/) — decisions and detailed mechanisms
9. [API_STABLE.md](API_STABLE.md), [SDK_GUIDE.md](SDK_GUIDE.md), [API_REFERENCE.md](API_REFERENCE.md) — integration surface
10. [BACKLOG.md](BACKLOG.md) and [ROADMAP.md](ROADMAP.md) — current obligations and sequencing

---

## 20. Documentation architecture cleanup

The repository still contains substantial historical "Engineering Handoff · Document X of 20" framing.

That material contains valuable provenance, but it should not remain the primary navigation model.

The target information architecture is:

```text
README
  ↓
PROJECT_CONTEXT
  ↓
SYSTEM_DESIGN
  ├── Semantic Kernel / Core
  ├── Protocol Specification
  ├── ADRs / RFCs
  ├── Specialized architecture/security/recovery docs
  └── API / SDK docs
```

Historical and superseded documents should remain traceable but be clearly labeled and moved out of the primary mental path where appropriate.

---

## 21. Status of this draft

This first version intentionally consolidates already-established repository truth.

It does **not** freeze new architecture.

Before merge it still requires:

- full documentation inventory;
- contradiction/staleness sweep;
- verification of every deep link;
- reconciliation with current ADR/RFC index;
- confirmation against active Day-0 hardening owners;
- explicit CTO Gate.
