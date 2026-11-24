# ARCHITECTURE.md
### Sails Protocol — Broad / Reference-System Architecture

> **Authority / status:** this document owns broad/reference-system
> architecture and preserves historical implementation topology. The current
> authority for the **Pure Sails Core / Runtime / Modules / Providers** macro
> architecture is [`CORE_ARCHITECTURE.md`](CORE_ARCHITECTURE.md), with
> implementation derivation owned by
> [`CORE_IMPLEMENTATION_ARCHITECTURE.md`](CORE_IMPLEMENTATION_ARCHITECTURE.md).
> Historical uses of **Core** in this document must not be interpreted as the
> modern **Pure Sails Core** boundary.

> For the shortest current technical path, read `PROJECT_CONTEXT.md` → `SYSTEM_DESIGN.md` → `CORE_ARCHITECTURE.md`. This document remains valuable for broad/reference-system topology and historical implementation context.

---

## 1. Layered Architecture — Protocol / Application / Infrastructure / Domain

This is the mandatory separation across the entire codebase. Every file you
write must belong to exactly one of these four layers, and must not reach
into another layer's responsibilities directly — only through events or
well-defined interfaces.

```
┌─────────────────────────────────────────────────────────────────┐
│ PROTOCOL LAYER                                                   │
│ Interfaces, event contracts, type definitions. Technology-        │
│ agnostic. Lives conceptually in packages/protocol-spec.           │
│ Examples: SettlementProvider interface, IntentPrimitive type,     │
│ EventContract type map.                                           │
├─────────────────────────────────────────────────────────────────┤
│ APPLICATION LAYER                                                 │
│ Orchestration of primitives to deliver a use case. This is where  │
│ Sails OpenP2P's trade lifecycle logic lives — it calls into        │
│ cross-module services but owns none of their internals.           │
├─────────────────────────────────────────────────────────────────┤
│ DOMAIN LAYER                                                      │
│ The actual business entities and their rules: Trade, Escrow,      │
│ Offer, User/Participant, ReputationEvent. Each entity belongs to   │
│ exactly one module (see moduleId in DATABASE.md).                 │
├─────────────────────────────────────────────────────────────────┤
│ INFRASTRUCTURE LAYER                                              │
│ How bytes actually move: HyperDHT/Hyperswarm P2P transport,       │
│ PostgreSQL connection, Redis connection, HTTP server (Fastify).   │
│ Infrastructure code must never know what a "Trade" or an "Offer"  │
│ is — it moves opaque payloads.                                    │
└─────────────────────────────────────────────────────────────────┘
```

### A real example of a layer violation that was found and fixed

During the last code review pass, `escrow.service.ts` (Domain/Application,
belongs to OpenSettlement) was calling `prisma.trade.update(...)` and
`prisma.user.update(...)` directly — reaching into Trade (owned by OpenP2P)
and User/reputation stats (owned by OpenReputation). This is exactly the
kind of violation this separation exists to prevent.

**Fix applied:** `escrow.service.ts` now only emits
`settlement.escrow.*` events. A new file, `common/events/handlers.ts`,
listens for those events and performs the Trade and User updates — keeping
each write inside the module that owns that data.

Another real example: `pear.service.ts` (HyperDHT/Hyperswarm transport —
pure Infrastructure) used to live inside `modules/identity/` (Domain). It
was moved to `infrastructure/p2p/pear.service.ts`. It was also found to
accept an `Offer`-shaped object in its `broadcastOffer()` method signature —
a Domain concept leaking into Infrastructure. Fixed by making the broadcast
method accept a generic `Record<string, unknown>` payload instead.

**The rule going forward:** if you're writing Infrastructure code and you
find yourself importing a type from a Domain module (`Offer`, `Trade`,
`User`), stop — that's a violation. Either the Infrastructure code should
accept an opaque payload, or the logic belongs in the Domain/Application
layer instead.

---

## 1B. The Core — 6 Formal Components (v7.1 — Principal Engineer decision)

> **Terminology note (2026-08-29; current-state correction 2026-09-16):**
> "Core" below names this reference implementation's historical six-component
> coordination topology. It is **not** the same thing as the modern **Pure
> Sails Core** defined by `SEMANTIC_KERNEL.md` §25 and
> `docs/CORE_ARCHITECTURE.md`. At freeze time the modern Pure Core had no
> implementation and `@sails/core` had not yet been created; that temporal
> statement is now superseded by implementation reality. The internal,
> private `packages/sails-core/` workspace now exists as the TypeScript
> implementation surface for the **Pure Semantic Core** only. Runtime,
> Modules, Providers, persistence/orchestration, and application adapters
> remain outside `@sails/core`. Selected Runtime slices now invoke
> Core-authoritative semantics, but the full legacy implementation has not
> migrated to the modern Core architecture. Therefore:
> **legacy/reference-implementation “Core” ≠ modern Pure Sails Core**.
> This correction updates implementation timing only; it does not change the
> architectural decisions or provenance owned by this document.

Following the CTO architectural review and a formal test applied to every
proposed addition (see `PROTOCOL_SPECIFICATION.md` sections 1.10-1.11), the
Core is now six named components — not an implicit grab-bag of logic
scattered across `common/`:

```
Intent Engine        → routes Intents by type, never knows about modules
                        (PROTOCOL_SPECIFICATION.md section 2)
Coordination Engine   → receives Intent + Policy + Capability + Events,
                        decides, then activates modules. No module ever
                        calls another module directly — only the Core.
Event Bus             → namespaced {module}.{entity}.{action} events.
                        Exposes a per-correlationId Timeline read
                        projection (RFC-007, rfcs/RFC-007-real-world-p2p-
                        requirements.md, decision D5) — ordered events for
                        one correlationId. Corrected 2026-07-19: this used
                        to say "one intentId," matching RFC-007 D5's first
                        draft — RFC-017 corrected the key to correlationId
                        (real events carry tradeId today, no Intent-to-
                        Trade link existing yet to key by intentId), and
                        the two lines directly below already said
                        correlationId — this line just hadn't caught up.
                        Considered and rejected as a 10th primitive in
                        that RFC; it lives here instead, consistent with
                        Event itself never being a primitive
                        (PROTOCOL_SPECIFICATION.md section 1.11).
                        RFC-008 (rfcs/RFC-008-verifiable-timestamps-and-
                        chained-timeline.md) specifies hash-chain integrity.
                        Timeline projects DurableEvent hash links and
                        implements verifyChain() per correlationId.
                        Postgres is the default durable backend (RFC-008
                        D2 amendment, 2026-08-15); Redis Streams and
                        in-memory adapters also exist. IntentEvent and
                        EscrowEvent have separate integrity boundaries.
                        RFC-010 (rfcs/RFC-010-durable-event-store.md)
                        makes durability pluggable via a new EventStore
                        Adapter (protocol says "must be durable and
                        correlated," never names a backend — Redis
                        Streams/BullMQ stays a Reference Implementation
                        choice) and requires every event to carry a
                        correlationId (tradeId today, intentId once
                        Intent persistence exists; userId for
                        peer/transport events with no trade to correlate
                        to).
State Machine          → the canonical Intent lifecycle (11 states as of
                        RFC-012, rfcs/RFC-012-intent-validation-and-
                        coordination.md, which added VALIDATED/COORDINATED)
Capability Registry    → tracks which Capability (functional category,
                        e.g. trade-coordination) each moduleId implements,
                        and issues/checks CapabilityGrants (permissions) —
                        two related interfaces per RFC-005
                        (rfcs/RFC-005-capability-model.md), not one.
                        CapabilityGrant issuance/checking is real as of
                        RFC-013 (rfcs/RFC-013-capability-registry-and-
                        wallet-adapter.md, `core/capability-registry.ts`);
                        the module<->Capability mapping stays a static
                        in-code table (RFC-005's own table, verbatim),
                        not a second persisted store
Policy / Rules Engine  → FeePolicy, TrustPolicy, RoutingPolicy — consulted
                        by the Coordination Engine, never read directly
                        by a module. This is what turns PROTOCOL_ECONOMY.md's
                        prose-only fee model into an actual architectural
                        concept.
```

**Why Coordination Engine matters specifically:** today, cross-module
reactions live in `common/events/handlers.ts` (see section 5 below) — a
flat, reactive event listener. The Coordination Engine is the same idea
formalized and given real decision-making inputs (Policy + Capability, not
just the event payload) — the actual "brain" that decides what happens
next, rather than a bag of independent `eventBus.on(...)` handlers. This is
a Months 1-3 roadmap item, not something the current code fragment already
implements — see `TODO.md`.

## 1C. Four Layers (v7.1 — replaces an earlier 7-layer proposal)

```
Tether Ecosystem
    │
    ▼
Open Infrastructure Stack (WDK + Pears + QVAC)
    │
    ▼
Sails Protocol — Core Coordination Tier
    │   (Intent Engine · Coordination Engine · Event Bus ·
    │    State Machine · Capability Registry · Policy/Rules Engine)
    ▼
Capabilities (the 8 modules: OpenP2P · OpenSettlement · OpenLiquidity ·
              OpenIdentity · OpenReputation · OpenAgents · OpenFinance ·
              OpenProof — added RFC-006)
    │
    ▼
Applications (Reference Implementations + third-party integrations)
```

An earlier draft proposed seven numbered layers (Transport, Identity,
Coordination, Capabilities, Modules, SDK, Applications). This four-layer
version replaces it — simpler, and it was the CTO's own final synthesis
after reviewing the more granular version. Use this one.

## 2. The Economic Sub-Capabilities Grouping (conceptual middle layer)

Between the Protocol Layer's abstract interfaces and the concrete modules
sits a conceptual grouping of 7 sub-capabilities that any application
module draws on. **Naming note (v7.3):** this grouping was previously
called "Economic Coordination Layer" — renamed here to avoid colliding
with section 1C's "Sails Protocol — Core Coordination Tier," which is a
different thing (the whole protocol's position in the 4-tier ecosystem
view, not this 7-item internal grouping).

```
Participant Layer   — identity, trust, reputation
Discovery Layer      — find counterparties, liquidity, opportunities
Negotiation Sub-Layer — negotiate, agree, commit (chat + state machine)
Escrow Layer         — lock, protect, release funds
Settlement Layer     — on-chain execution (via WDK)
Communication Layer  — E2E channels (via Secretstream/Pears)
Intelligence Layer   — QVAC local AI (cross-cutting, not an isolated layer)
```

Note: "Intelligence Layer" (QVAC) is listed here for completeness, but it is
explicitly **not** a layer that other layers depend on. It is a
cross-cutting accelerator — any layer above can optionally call into it, but
none require it to function. This is intentional: the protocol must work
completely with human participants alone; QVAC is the natural evolution, not
the foundation. See `PROJECT_CONTEXT.md` section on the causal adoption
argument for why this distinction matters strategically as well as
technically.

**Crypto-Native Agent boundary (RFC-016):** every action QVAC/OpenAgents
takes inside this layer is on digital assets already in the user's
wallet, via WDK — never on fiat. QVAC is a **Crypto-Native Agent**, not
a "PIX Agent" or "Banking Agent"; fiat-to-crypto conversion happens
earlier, through a regulated on/off-ramp provider, outside this layer
and outside Sails Protocol's scope entirely. See
`docs/rfcs/RFC-016-qvac-crypto-native-agent-boundary.md`.

---

## 3. The 8 Official Modules

Full detail (responsibilities, interfaces, event namespaces) is in
`PROTOCOL_SPECIFICATION.md`. Summary here. The **Marketplace role** column
is the v1 Positioning Freeze framing — the one-line answer to "what does
this module do for a P2P Financial Marketplace," fixed wording, use as-is
in pitch/onboarding material. The **Responsibility** column is the
full technical detail and is unchanged.

### Cross-module services (used by any application module)

| Module | Marketplace role | Responsibility |
|---|---|---|
| **Sails OpenIdentity** | Provides portable identity for buyers, sellers, and liquidity providers. | Ed25519 keypair as sovereign identity. Every participant, regardless of which application module they're using, has exactly one OpenIdentity. Growth path: Keys → DID → Credentials → Trust Graph, plus Operational Profiles (RFC-007) — a module-level, Policy-Engine-facing role attribute (`regular_trader`, `liquidity_provider`, `merchant`, `arbitrator`, `agent`), not KYC and not part of the `Identity` primitive's core contract. |
| **Sails OpenReputation** | Manages accumulated reputation. | Portable score tied to the keypair, not to any platform. Any module can read or write reputation. Outcome-based (RFC-007): `recordOutcome()` is the sole `ReputationScore` input via an internal Outcome Engine; star ratings (`rate()`) are informational feedback only and never move the score. A cancelled-by-agreement trade always classifies Neutral, never Negative. |
| **Sails OpenSettlement** | Coordinates settlement and escrow release. | Abstract escrow via the `SettlementProvider` interface. Pluggable: Mock → Multisig 2-of-3 → Lightning HODL → Liquid Covenant. **Correction (2026-09-10, Product Truth Sweep, F6/F7):** "Lightning HODL" is implemented via the Ark/Arkade protocol (VTXO/Taproot, testnet-evidenced on Mutinynet), not plain Lightning HTLCs — real Lightning-native settlement is not yet implemented (see `docs/BACKLOG.md` item 20); `LIQUID_COVENANT` remains genuinely unbuilt. Settlement status gains `PendingBankSettlement` (RFC-007) for payment held/processing at a financial institution before it clears. Also implements Dispute, with an explicit escalation order — Policy Engine → OpenAgents → Trusted Arbitrator (via the new `ArbitrationProvider` interface) → Settlement — before falling back to human arbitration (RFC-007). |
| **Sails OpenLiquidity** | Organizes liquidity providers. | Discovery and routing of liquidity. The order book (the `Offer` entity) belongs here, not to OpenP2P — this is what lets OpenFinance reuse the same discovery mechanism in the future without duplicating it. |
| **Sails OpenProof** | Records cryptographically verifiable evidence. | Standardizes `Claim` → `Proof` → `Verification` (RFC-003) for every other module — Dispute evidence, Negotiation payment proof, future OpenFinance underwriting all consume this instead of each building their own evidence format. Added as the 8th module by RFC-006. RFC-007 adds a Proof Registry (fingerprints evidence, flags reuse across Intents), an `EvidenceProvider` adapter interface (Nostr.build/S3/R2/IPFS/Arweave — the protocol never hosts media itself), and `getEvidenceBundle(intentId)`, a read aggregate over Claims/Proofs/Verifications/Timeline/external references for one Intent. RFC-008 adds an optional `TimestampAnchor` adapter (OpenTimestamps/RFC 3161) so evidence timestamps can be proven, not just self-declared — policy-gated, not mandatory. |

### Application modules (build on the above)

| Module | Marketplace role | Responsibility | Status |
|---|---|---|---|
| **Sails OpenP2P** | Coordinates negotiation between participants. | Orchestrates the Trade Lifecycle (9 states, see `PROTOCOL_SPECIFICATION.md`) using the five cross-module services above. Owns the Secretstream chat / negotiation channel. Reconciles persisted messages against Postgres on peer reconnect (RFC-011): `Message` persistence before send and `ReconciliationService` on `peer.connected` mitigate missed real-time delivery within the reference node's available database. This is not proof of cross-operator replication, recovery after loss of that database, or shared-market availability; those require separate Day-0 evidence (ADR-001 / #105). | ✅ Proven |
| **Sails OpenAgents** | Runs automation, fraud prevention, risk analysis, and mediation assistance. | QVAC integration as a cross-cutting SDK — a **Crypto-Native Agent** (RFC-016): only ever acts on digital assets via WDK (negotiate, create/accept offers, lock/release escrow), never on fiat or banking rails. Any module can request matching, fraud detection, or risk analysis locally, without cloud dependency. **Social Engineering Agent real as of RFC-017** (`social-engineering-agent.ts`) — watches real chat messages (via the real `Timeline` read-model, RFC-007 D5/RFC-017) for two of RFC-007 D7's three named fraud-precursor patterns (off-channel migration, payment-instruction changes) using QVAC, and raises a real `RISK_WARNING` in the trade's chat — detection only, never unilateral action; the third pattern (unexpected flow deviation) and full Policy Engine integration remain future work (RFC-017's own scope note). Off by default (`config.features.socialEngineeringDetection`). | 🟡 First real capabilities |
| **Sails OpenFinance** | Stays ready for future expansion, out of scope for the MVP. | Future financial modules: `LoanIntent`, `SwapIntent`, `EarnIntent`. Reuses OpenSettlement, OpenLiquidity, OpenReputation without duplicating logic. | 📋 Aspirational |
| **Sails SDK** (MVP release: **Sails P2P Trading SDK**) | The single interface a wallet integrates to get the whole Marketplace. | `@satsails/p2p-trading-sdk` — a TypeScript wrapper (`SailsClient`) around every module's API, for integrators. Adds no new logic — pure interface encapsulation. | **Corrected (2026-09-10, Product Truth Sweep, F12):** this row previously read "📋 Aspirational (spec only, see `SDK_GUIDE.md`)" — stale. The SDK is real, versioned (`v1.0.0-rc1` per the whitepapers' own Proven-vs-Designed table), and tested; it is not spec-only. See `SDK_GUIDE.md` for real usage. |

**Why the OpenP2P/OpenLiquidity split matters:** a common mistake is putting
the `Offer` entity inside the OpenP2P module because "that's where trading
happens." This was corrected — `Offer` belongs to OpenLiquidity
(`moduleId: "openliquidity"`) precisely because OpenFinance will need offers
and liquidity discovery too, someday, without rebuilding it from scratch.

---

## 4. Actual Code Inventory (verified against the filesystem — do not assume more exists)

**Known stale below 2026-07-17 (QVAC/WDK MVP pass) — not a full rewrite in
this pass, flagged rather than silently left wrong:** the tree and the
"Still missing" note at the end of this section predate the
route-restoration, open-reputation, and chat-unification work done
earlier the same day — `modules/open-identity/`, the `open-p2p` trade/chat
routes, and `modules/open-reputation/` all exist and are real now (see
`TODO.md` §1 and `BACKLOG.md`'s P0-P2 tables, both of which were kept
current through that work). Only the additions below are guaranteed
accurate as of this note; treat the rest of the tree as a lower-confidence
snapshot until someone re-audits the whole section against the filesystem.

**New this pass (QVAC/WDK MVP, consolidated same day):**

```
src/modules/open-agents/
├── qvac-agent.provider.ts              (QvacAgentProvider — real @qvac/sdk
│                                         local LLM inference, OpenAgents'
│                                         first real capability, live-
│                                         verified; risk assessment +
│                                         structured Intent/offer generation)
├── wallet-agent.ts                     (WalletAgent base class)
├── buyer-agent.ts                      (BuyerAgent — autonomously
│                                         generates a real TradeIntentPayload
│                                         via QVAC, live-verified)
└── seller-agent.ts                     (SellerAgent — symmetric offer
                                          generation)
src/modules/open-settlement/
├── wdk-settlement.provider.ts          (WDK_USDT_EVM — real
│                                         @tetherto/wdk-wallet-evm calls,
│                                         testnet, single-seed custody —
│                                         see that file's own caveat.
│                                         buyerIndexFor() added — deterministic
│                                         per-buyer receiving-address
│                                         derivation for the auto-settle path)
└── settlement-orchestrator.ts          (executeSettlement() — real
                                          orchestration: createEscrow ->
                                          lockFunds (real signed WDK
                                          transfer) -> markPaymentSent ->
                                          emulated PIX-receipt confirmation
                                          (explicitly labeled, not a real
                                          OpenProof integration) ->
                                          releaseFunds (real signed WDK
                                          transfer). Wired to
                                          openp2p.trade.created via
                                          common/events/handlers.ts, gated
                                          behind config.features.autoSettleOnMatch
                                          — default false)
examples/demo/
├── pix-to-usdt-flow.ts                 (Intent → Negotiation (Pears) →
│                                         QVAC risk → Settlement (WDK)
│                                         end-to-end script; `main()` now
│                                         exported, guarded behind
│                                         `require.main === module`, so
│                                         demo-satsails-qvac.ts can reuse
│                                         it without double-running it)
└── demo-satsails-qvac.ts                (moved here from the repo root
                                          2026-08-09 — the discoverable
                                          "boot the whole ecosystem"
                                          entrypoint: QVAC agents → Pears
                                          P2P → Sails Protocol state
                                          machine → WDK signing. Delegates
                                          to pix-to-usdt-flow.ts's `main()`
                                          rather than duplicating it —
                                          `npm run demo:qvac`)
src/main.ts                              (server entrypoint — found
                                          genuinely missing while
                                          verifying `npm run dev`, not
                                          previously created despite
                                          `package.json` referencing it
                                          since before this pass; thin
                                          wrapper around app.ts's
                                          `startServer()`)
```

**Refreshed against the real filesystem (03-implementation_plan.md MVP
pass) — the version of this section before this pass was itself stale,
listing several files (`common/database/index.ts`, `common/errors/index.ts`,
`common/redis/index.ts`, `config/index.ts`) as "missing" that already
existed by the time RFC-007 through RFC-011 were written. This is what's
actually on disk today:**

```
src/
├── app.ts                              (Fastify bootstrap — real, but still
│                                         PARTIAL: identity/marketplace/chat/
│                                         reputation routes remain commented
│                                         out, those files still don't exist)
├── types.d.ts
├── common/
│   ├── database/index.ts               (Prisma client singleton)
│   ├── errors/index.ts                 (AppError, NotFoundError, ValidationError,
│   │                                     EscrowError, AuthError, ForbiddenError)
│   ├── redis/index.ts                  (ioredis client — cache/pub-sub, not
│   │                                     protocol-mandated, DATABASE.md §4)
│   ├── middleware/auth.ts              (real Ed25519 challenge-response,
│   │                                     RED_TEAM_REVIEW.md RT-002 — not yet
│   │                                     wired into any route)
│   ├── types/                          (intent.ts, capability.ts, trade.ts,
│   │                                     index.ts — shared TS interfaces)
│   └── events/
│       ├── event-bus.ts                (typed event map + SailsEventBus,
│       │                                 RFC-010 — delegates to EventStore)
│       ├── event-store.ts              (EventStore/DurableEvent, RFC-010 —
│       │                                 InMemoryEventStore real,
│       │                                 RedisStreamsEventStore implemented
│       │                                 and integration-tested per RFC-010
│       │                                 (2026-08-04); PostgresEventStore
│       │                                 is the wired default; in-memory
│       │                                 store non-durable. Redis delivery
│       │                                 at least once, not exactly once;
│       │                                 startup subscription race disclosed.
│       │                                 No production or cross-operator
│       │                                 recovery guarantee follows.
│       │                                 Economic replay protection is
│       │                                 separate: INV-OP-5 in
│       │                                 PROTOCOL_INVARIANTS.md defines
│       │                                 source-transition projection
│       │                                 claims, write-once settlement
│       │                                 results and reconciliation;
│       │                                 duplicate durable events may
│       │                                 exist without duplicate effects.
│       │                                 This is not a universal exactly-
│       │                                 once execution guarantee)
│       └── handlers.ts                 (Coordination Protocol — cross-module
│                                         reactions to events)
├── core/                                (6 formal Core components, §1B —
│                                         intent-engine.ts, policy-engine.ts
│                                         [partially], state-machine.ts,
│                                         coordination-engine.ts, and
│                                         capability-registry.ts now real;
│                                         only policy-engine.ts's governed-
│                                         policy interface remains a stub)
│   ├── intent-engine.ts                (real — create/cancel/transition;
│                                         create() now runs CREATED ->
│                                         VALIDATED -> COORDINATED via
│                                         RFC-012, rfcs/RFC-012-intent-
│                                         validation-and-coordination.md)
│   ├── policy-engine.ts                (validateFinancialSanity real; the
│   │                                     get/propose/activate governed-policy
│   │                                     interface is still a stub)
│   ├── state-machine.ts                (real — assertValidTransition,
│   │                                     isExpired hard-timeout check;
│   │                                     IntentStatus now imported from
│   │                                     common/types/intent.ts, single
│   │                                     source of truth per RFC-012)
│   ├── coordination-engine.ts          (real as of RFC-012 — decide()
│   │                                     resolves an Intent's targetModule;
│   │                                     does not yet consult Policy Engine
│   │                                     or Capability Registry — RFC-012's
│   │                                     own scope cut, unrevisited by
│   │                                     RFC-013)
│   └── capability-registry.ts          (real as of RFC-013,
│                                         rfcs/RFC-013-capability-registry-
│                                         and-wallet-adapter.md —
│                                         grant/check/revoke/listGrants
│                                         against a real `CapabilityGrant`
│                                         Prisma table; CAPABILITY_IMPLEMENTATIONS
│                                         is RFC-005's own module<->Capability
│                                         table, kept as a static in-code
│                                         map deliberately, not a second
│                                         table with no real write path)
├── infrastructure/
│   └── p2p/
│       ├── pear.service.ts             (PearNode + PearNodeRegistry —
│       │                                 HyperDHT/Hyperswarm transport;
│       │                                 getKeyPair()/getConnectedPeerId()
│       │                                 added for payload-crypto.ts)
│       ├── transport-provider.ts       (TransportProvider interface per
│       │                                 RFC-002, PearsTransportProvider,
│       │                                 FallbackTransportProvider — now
│       │                                 wired to POST /v1/peers/start
│       │                                 (pear.routes.ts), which returns
│       │                                 which transport actually
│       │                                 connected. Scoped: covers
│       │                                 start()/sendToPeer() degrading to
│       │                                 the relay on a Pears timeout, not
│       │                                 join-trade/broadcast-offer — a
│       │                                 relay has no DHT topic, so those
│       │                                 still require a real PearNode.
│       │                                 PearsTransportProvider.sendIntentToPeer()
│       │                                 — real, direct, encrypted,
│       │                                 server-free Intent delivery over
│       │                                 Hyperswarm/HyperDHT, a Pears-only
│       │                                 extension beyond the shared
│       │                                 interface)
│       ├── relay.routes.ts             (`/ws/relay` — gives
│       │                                 WebSocketRelayTransportProvider a
│       │                                 real socket to register against;
│       │                                 previously referenced by a class
│       │                                 comment in websocket-relay.service.ts
│       │                                 but did not exist. Same
│       │                                 `?token=` query-param auth as
│       │                                 chat.routes.ts's WS route)
│       ├── payload-crypto.ts           (real libsodium sealed-box
│       │                                 encryption for P2P payloads —
│       │                                 Ed25519→Curve25519 conversion of
│       │                                 each PearNode's real identity
│       │                                 keypair, `sodium-native`)
│       └── websocket-relay.service.ts  (WebSocketRelayTransportProvider —
│                                         relay implementation exposed via
│                                         /ws/relay; "blind" is a design
│                                         privacy boundary, not proof of
│                                         end-to-end confidentiality or
│                                         operator independence. Token auth,
│                                         payload encryption, replay defenses,
│                                         relay availability and failure
│                                         behavior require separate evidence)
└── modules/
    ├── open-settlement/
    │   ├── escrow.service.ts           (Escrow state machine, SettlementProvider)
    │   ├── arbitration-provider.ts     (ArbitrationProvider — RFC-007 D4's
    │   │                                 first real implementation;
    │   │                                 TrustedArbitratorProvider, per-app
    │   │                                 trusted-arbiter list)
    │   └── dispute.service.ts          (raiseDispute/resolveDispute — first
    │                                     persistence of the Dispute
    │                                     primitive, §1.9)
    ├── open-liquidity/
    │   └── liquidity.service.ts        (LiquidityRouter, InternalOrderBook,
    │                                     HodlHodl stub)
    └── open-p2p/
        ├── negotiation.service.ts      (HumanChatChannel, real, built on
        │                                 pearNodeRegistry)
        └── reconciliation.service.ts   (ReconciliationService, RFC-011)

packages/                                (npm workspaces — root package.json's
│                                         `workspaces` field)
├── sails-p2p-schemas/                   (@satsails/p2p-schemas — types-only
│   └── src/                               domain contracts: OfferSchema,
│       ├── offer.ts                       TradeState/deriveTradeState,
│       ├── trade.ts                       DisputeSchema. The 'contrato
│       └── dispute.ts                     social' layer any wallet
│                                         integration shares)
└── sails-sdk/                           (@satsails/p2p-trading-sdk — Sails P2P Trading
    └── src/                               SDK, SDK_GUIDE.md. v0.1 real:
        ├── client.ts                      SailsClient assembles Transport
        ├── transport.ts                   + Protocol SDK (identity/
        ├── errors.ts                      reputation/liquidity/openp2p/
        ├── intent-facade.ts                settlement/peers, each verified
        ├── encoding.ts                     against its real route) + the
        ├── types.ts                        Intent facade (createIntent/
        └── modules/                        cancelIntent real;
            (identity, reputation,          negotiate/submitProof/
             liquidity, openp2p,            releaseAsset/dispute throw
             settlement, peers)             SailsNotImplementedError —
                                            see intent-facade.ts's header)

tests/
├── intentFlow.test.ts                  (Intent Engine happy path + CISO
│                                         Byzantine/Economic rules)
├── transportFallback.test.ts           (FallbackTransportProvider,
│                                         WebSocketRelayTransportProvider)
└── disputeFlow.test.ts                 (raiseDispute/resolveDispute,
                                          deriveTradeState, toOfferSchema)
```

**Still missing** (referenced by `app.ts`'s own comments but not present):
`modules/open-identity/` (routes + service), `modules/open-p2p/`'s trade
and chat *routes* (the negotiation *service* above is real), 
`modules/open-reputation/` (routes + service), and every other
`*.routes.ts` file besides `intentRoutes.ts`.

If you're rebuilding these, follow the naming and event conventions in this
handoff exactly — do not reintroduce the old unnamespaced patterns (see
`CONTRIBUTING.md` for the specific rules and a worked example).

**On the crypto-related files named above** (`payload-crypto.ts`,
`middleware/auth.ts`, `pear.service.ts`'s keypair handling): what each
one actually guarantees — and doesn't — is consolidated in
`CRYPTOGRAPHIC_MODEL.md`, not repeated here. `TRUST_BOUNDARY.md` maps
which of these sit at a trust-boundary crossing and what crosses it.

---

## 5. Event-Driven Coordination (the "zero coupling" mechanism)

No module imports another module's service directly. Ever. The only shared
dependency between modules is the typed event bus
(`common/events/event-bus.ts`).

```
EscrowService (OpenSettlement)
   │  emits 'settlement.escrow.released'
   ▼
eventBus  ──────────────────────────────────────►  handlers.ts
                                                    (Coordination Protocol)
                                                       │
                                    reacts by updating Trade (OpenP2P)
                                    and User stats (OpenReputation)
```

This is what makes the "eliminate unnecessary coupling" requirement concrete
and checkable: grep the codebase for any module importing another module's
service class directly. If you find one, it's a bug — replace it with an
event emission + a handler.

Full event catalog with exact names is in `PROTOCOL_SPECIFICATION.md` and
mirrored in `API_REFERENCE.md` for the WebSocket-facing subset.

---

## 6. Monorepo Target Structure (where the code is going, not yet where it is)

```
sails-protocol/                    ← monorepo root (does not exist yet)
├── packages/
│   ├── protocol-spec/             ← @sails/protocol-spec (npm, technology-agnostic)
│   │   └── src/
│   │       ├── core/              (IntentPrimitive, ParticipantIdentity, types)
│   │       ├── modules/           (one interfaces.ts per module)
│   │       └── events/            (EventContract, typed per module)
│   └── sdk/                       ← @satsails/p2p-trading-sdk (npm, consumer-facing)
│       └── src/SailsClient.ts
└── apps/
    └── satsails-reference/        ← THIS is where today's code fragment lives
        └── src/... (see inventory above)
```

The current fragment lives conceptually where `apps/satsails-reference/src/`
would be — there is no monorepo tooling (no `packages/` split, no
`turbo.json`/`nx.json`) set up yet. That's a `Meses 1-3` roadmap item, not
something to invent ad hoc.

---

## 7. Diagram Reference (canonical, use exactly this shape in any deck or doc)

`PROJECT_CONTEXT.md` section 3 has two canonical diagrams, one per audience
— do not redraw either differently between documents; consistency here was
a specific, deliberate fix applied after a strategic review found the
diagram drifting between documents, and the v1 Positioning Freeze re-applied
the same rule to the newer diagram below:

- **Ecosystem diagram** (Tether → WDK+Pears+QVAC → Sails Protocol →
  8 modules → SDK → Applications → Reference Implementations) — for
  strategic, grant, and partnership context, answering "where does Sails
  sit in the Tether ecosystem."
- **Developer diagram** (Wallet → Sails P2P Trading SDK → Sails Protocol →
  8 modules → WDK/Pears/QVAC → Bitcoin·Liquid·Lightning·USDT) — for
  `README.md`, `SDK_GUIDE.md`, and onboarding material, answering "what
  does a developer actually build on." This is also the diagram used in
  `DEVELOPER_JOURNEY.md`. "Sails P2P Trading SDK" is the first named
  release under the Named-SDK Rule (`PROJECT_CONTEXT.md` section 3) —
  permanent, not an MVP placeholder that reverts to generic "Sails SDK"
  once other modules ship. Developer-facing material uses the concrete
  name; architecture/spec tables below keep the generic "Sails SDK" as
  the underlying package/interface family name only.
