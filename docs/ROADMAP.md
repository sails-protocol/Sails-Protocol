# ROADMAP.md
### Sails Protocol — Product / Engineering Roadmap

> Dates are expressed **relative to launch** (Months 1-12), not as fixed
> calendar quarters. This is a deliberate choice — a roadmap with fixed
> calendar dates goes stale the moment execution slips, and that staleness
> reads as a red flag to any technical evaluator. If you need calendar
> dates for a specific deck, calculate them from the actual launch date at
> the time you're presenting — never hardcode them back into this source
> document.

---

## Current production-open status

> **Current truth (2026-09-19): Sails is not yet production-open.** The roadmap describes target sequencing and commitments; it is not a production-readiness certificate.
>
> Production-open remains gated by the Day-0 / Partner Beta completion program and unresolved MUST-FIX owners, including current work on evidence durability/authorization, economic-limit enforcement, temporal ordering, authority liveness, accounting crash consistency and durable downstream projection completion.
>
> Canonical operational owners: GitHub Issue #105 (Day-0 completion gate), #220 (Production Surface Audit / remediation program), and their bounded child/related issues. Do not infer Production Eligibility from implementation existence, passing unit tests, provider registration, or roadmap placement.
>
> **Dated note, 2026-10-26 — release steps (Founder/CTO decision; text above preserved).** "Day 0" is the target set of capabilities and obligations, not a production certificate. Release is organized in three steps. **Partner Beta**: shared staging with no external real funds; a single operator is allowed before the network gates C–F, with no claim of decentralization, shared liquidity or multi-operator homologation. **Controlled Beta**: limited, authorized real value; requires an external audit and explicit authorization before any external participant's funds (self-funded internal rehearsals are a separate category). **Public Production**: only homologated capabilities; "GO Day 0" means a governed authorization to open public production with those capabilities only and is not equivalent to all 25 lines being finished. Eligibility per line is recorded in Issue #105 Gate B with evidence in Issue #165, independent review and CTO authorization; a disabled line does not count as delivered capability. Paykit remains outside the mandatory Day-0 scope. The Protocol Fee is 0.40% from the first operation of any line enabled for real funds (see `docs/PROTOCOL_ECONOMY.md` and the 2026-10-26 entry of `docs/BACKLOG.md`).

---

## Status Legend (used throughout this document and every other doc in this handoff)

- **✅ Proven** — implemented and functional in a reference implementation
- **🏗️ Specified** — interface/contract defined, implementation partial or stubbed
- **📋 Aspirational** — on the roadmap, spec not yet written

---

## Standing Network-Effect Commitment — Wallet Kits + Settlement Rails

The Sails P2P Trading SDK should ship with first-party integration paths for
the major wallet development kits and the major settlement-capable networks
relevant to P2P markets. The objective is not to make every integrator adopt
the Reference Wallet's stack; it is to let existing wallets join the Sails
network with minimal replacement cost.

Initial **planned** first-party adapter targets:

- `@sails/adapter-bdk`
- `@sails/adapter-wdk`
- `@sails/adapter-breez`
- `@sails/adapter-spark`
- `@sails/adapter-ldk`
- `@sails/adapter-ethers` — EVM family, including BNB Smart Chain
- `@sails/adapter-tron`
- `@sails/adapter-solana`
- `@sails/adapter-ton`

These package names are roadmap targets, not published/support claims yet.
Additional adapters are added by ecosystem relevance and integrator demand.
Settlement-network expansion remains property-gated: a network is eligible
because its primitives can satisfy the required Sails settlement semantics,
not merely because an SDK or smart-contract platform exists.

**Full Reference Wallet Day-0 Capability Target (added 2026-09-10,
Product Direction freeze — Gate B; existing product/reference-wallet
truth previously missing from this document's own network list, not new
scope invented on this date).** `@sails/adapter-ethers`'s "EVM family,
including BNB Smart Chain" line above named the family generically but
never enumerated it — the Satsails Wallet V2 reference target requires
USDT and/or USDC settlement across each of these individually-tracked
EVM networks: **Ethereum, Base, Optimism, Polygon, Avalanche, Arbitrum,
BNB Chain** — each with its own independent maturity/evidence/
eligibility state (shared implementation, if one is chosen, does not
imply shared maturity — see the architecture note in `docs/BACKLOG.md`
Cold Sweep Loop 5, item 20). USDT additionally targets Solana, Tron, TON,
and Liquid; USDC targets the six EVM networks above only (no Solana/Tron/
TON/Liquid claim for USDC at this time). BTC's Day-0 target spans five
distinct product capabilities — on-chain, Spark, Lightning, Arkade, and
Liquid/L-BTC — never collapsed into one another by shared implementation
(today's `LIGHTNING_HODL` provider is Ark-based; this does not make
Lightning and Arkade the same capability). DePix targets both Liquid and
Spark. XAUT (Tether Gold) targets Ethereum. None of this authorizes an
`AssetType` change, a new provider, or a settlement-architecture
decision — see `docs/BACKLOG.md`'s canonical matrix for the full,
authoritative, current version of this target.

## Months 1-3 — Foundation (Commitment)

- `@sails/protocol-spec` v0.1 published to npm (interfaces + event contracts only)
- API namespacing `/v1/{module}/` implemented across all restored/rebuilt routes
- Event namespacing `{module}.{entity}.{action}` fully applied (done in the
  reference implementation's event bus already — see `ARCHITECTURE.md`)
- `moduleId` + `protocolVersion` fields in the database schema (done — see
  `DATABASE.md`)
- WDK real integration replacing the mock keypair flow
- Ed25519 auth middleware
- Lightning HODL escrow + Liquid covenant escrow (real implementations,
  replacing the `MockSettlementProvider`)

## Months 4-6 — Developer Adoption (Commitment)

- `@satsails/p2p-trading-sdk` v1.0 public — a real implementation of the `SailsClient`
  interface in `SDK_GUIDE.md`
- All 8 modules documented (spec + integration guide)
- Public sandbox testnet, no signup required
- First 10 wallet integrations using the SDK
- First-party adapter program underway for BDK, WDK, Breez SDK, Spark SDK,
  LDK, major EVM wallet-development stacks (including BNB Smart Chain), TRON,
  Solana, and TON; each adapter must be backed by real integration evidence
  before it is labeled supported
- Third-party security audit, scoped to Sails OpenP2P + Sails OpenSettlement
  (the two modules with real code as of this handoff)
- Sails OpenP2P module spec reaches v1.0 stability

## Months 7-9 — Intelligence Layer (Target)

- Sails OpenAgents: spec finalized + real QVAC SDK integration
- `AgentIntent` support — any module can receive delegated agent actions
- Sails OpenReputation made fully cross-module portable (usable outside
  OpenP2P)
- Sails OpenLiquidity network extended across multiple reference
  implementations (not just Satsails)
- Stacks + RSK escrow support added to Sails OpenSettlement

## Months 10-12 — Open Ecosystem (Aspirational)

- Sails OpenFinance: first module spec published (`LoanIntent`,
  `EarnIntent`, `SwapIntent`)
- Pears Runtime deployment — zero central server, fully P2P app
  distribution
- Hyperbee-based distributed order book (replacing today's centralized
  `InternalOrderBook`)
- 50+ wallet integrations
- Protocol governance layer v1
- Monorepo (`packages/protocol-spec`, `packages/sdk`,
  `apps/satsails-reference`) fully published
- `SDK_usecases.md` — the "family of named SDKs" (Trading, Settlement,
  Liquidity, Reputation, Policy, Agent — Breez-style, `PROJECT_CONTEXT.md`
  §3's Named-SDK Rule) this phase would actually justify shipping.
  Written down now as a vision document, not built now — see that file
  for exactly what's real today vs. what this phase would need to build
  first (the Policy Engine's governed-rule system, most notably).
- **Third-Party Sails Modules & Developer Extension Ecosystem** —
  inspired by WDK Building Blocks and `create-wdk-module`
  (`PROJECT_CONTEXT.md`'s own "External Design Reference — WDK Building
  Blocks" section), Sails should eventually provide tooling for third
  parties to build Sails-compatible wallet adapters, settlement providers,
  and economic modules without requiring those technologies to become
  Core dependencies. Conceptually, not yet planned in implementation
  detail: `create-sails-adapter`, `create-sails-module`, scaffolding, a
  conformance harness, module templates, capability manifests,
  documentation templates, third-party wallet adapters, third-party
  settlement providers, and future third-party economic modules.
  **Package existence does not imply Sails support; conformance and
  evidence determine maturity** — the same discipline this document's own
  coverage matrix and First-Party Supported Criteria already apply to
  Sails' own first-party adapters (`README.md`). Named here as a future
  direction only — no scaffolding, registry, manifest schema, or tooling
  code exists yet, and none is authorized by this entry.

  **Cross-reference added 2026-09-14 (Post-Mission-4 Roadmap/Backlog
  Reconciliation) — this entry's own Aspirational/Months-10-12 status
  and content are otherwise unchanged.** This paragraph independently
  anticipated a shape now studied and frozen in detail elsewhere: Mission
  4 (`docs/ADAPTIVE_EXECUTION_CAPABILITY_ROUTING.md` §19.2) froze the
  eight-stage extension contract `External Capability → Public Contract →
  Capability Declaration → Constraints → Conformance → Evidence →
  Eligibility → Runtime Participation`; the External Extensibility
  Blind-Spot & Precedent Consolidation (`docs/EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md`)
  independently studied WDK (this section's own inspiration) against real
  external-precedent evidence and reconciled it with Issue #152. Neither
  changes this entry's own Months-10-12/Aspirational placement or
  authorizes any implementation now — see `docs/BACKLOG.md` item 41 for
  the full reconciliation.
- **Third-Party Liquidity & Economic Modules** — a future track built on
  top of the extension ecosystem above, not a separate mechanism. External
  providers may contribute liquidity, RFQ, OTC, lending, swap, bridge,
  routing, and pricing capabilities through Sails-compatible modules.
  **Sails remains the coordination layer, does not own underlying capital
  or inventory, and may collect protocol fees from confirmed economic
  outcomes** subject to published policy and conformance — never from a
  module's mere existence or registration. `Sails OpenLiquidity` is a
  natural candidate for the first multi-provider third-party economic
  module ecosystem, since it already separates the coordination layer
  (`LiquidityProvider` interface, `InternalOrderBook`) from any specific
  liquidity source. **Integration should remain open. Economic
  coordination may be monetized. Module existence alone does not imply
  Sails support or production readiness** — the same
  package/module-existence ≠ supported ≠ production-ready rule the
  extension-ecosystem entry above and this document's own coverage matrix
  (`README.md`) already apply everywhere else. Named here as a future
  direction only — no module, provider registry, fee-collection mechanism,
  or conformance rule for third-party economic modules exists yet, and
  none is authorized by this entry.

---

## External Funding

Specific funding discussions, amounts, and counterparties are intentionally
not disclosed in this public document — internal only, and not finalized.
The Months 1-3/4-6/7-9/10-12 phases above stand on their own regardless of
external funding outcomes: `PROTOCOL_ECONOMY.md` §3 (**revised 2026-08-11**)
has the Protocol Fee active from launch, independent of whether any
external funding is secured, so the roadmap does not depend on a specific
grant landing to fund engineering, security, SDK work, or operations.

---

## Success Metrics (12 months post-launch)

| Category | Metrics |
|---|---|
| **Developer Adoption** | ≥1,000 `@satsails/p2p-trading-sdk` npm downloads/month · ≥10 wallet integrations |
| **Protocol Activity** | ≥5,000 TradeIntents created · ≥$1M USD equivalent coordinated |
| **Security** | Third-party audit complete · zero critical vulnerabilities in production |
| **Ecosystem Health** | ≥100 active reputation profiles · <2% dispute rate |

---

## What Is Already Done vs. What Remains

Do not present the roadmap above as starting from zero. As of this handoff:

- Sails OpenP2P core logic (Trade lifecycle, escrow state machine, liquidity
  routing) already exists as real code — see `ARCHITECTURE.md` section 4
- Event bus namespacing is already fixed (`{module}.{entity}.{action}`)
- Database schema already has `moduleId`/`protocolVersion`
- The P2P transport layer already correctly supports multiple concurrent
  users (`PearNode`/`PearNodeRegistry` — see `NODE_ARCHITECTURE.md`)

For current unresolved engineering obligations, use `BACKLOG.md` and the live GitHub Issues/Project as the primary operational sources. `TODO.md` is retained as an audited historical/category-oriented implementation-gap inventory with limited authority and may contain resolved or superseded material. Do not infer current remaining work from this roadmap or `TODO.md` alone.


---

## Future / Optional Infrastructure — Sails-operated OTS Aggregator / Calendar

**Status: OPTIONAL / FUTURE — not a Day-0 dependency.**

Day 0 uses OpenTimestamps behind the Sails-owned `TimestampAnchor` abstraction with multiple public/free OpenTimestamps calendars for availability redundancy. No individual calendar is Protocol Truth, Economic Authority, or a required dependency for Sails economic-state progression.

If operational evidence later justifies it, Sails may operate an OpenTimestamps-compatible aggregator/calendar as one additional availability option within the same open ecosystem. Such infrastructure MUST NOT become the mandatory calendar, a central timestamp authority, an interoperability gate, or a prerequisite for OpenProof/Sails economic availability.

This roadmap item does not replace the Day-0 multi-calendar requirement in `docs/BACKLOG.md`; it deliberately keeps Sails-operated timestamp infrastructure outside the Day-0 critical path.


## Future interoperability research — Paykit / Pubky payment discovery (2026-10-24)

**Status: proposed / research only; not a Day-0, P1, P3, P4 or production gate.**

Evaluate an **optional** Synonym Paykit / Pubky adapter for discovery of public or private payment endpoints and supplemental encrypted receipts. Bitkit includes Paykit integration, while the upstream Paykit protocol still declares itself work-in-progress and not production-ready; release maturity must be independently re-evaluated before implementation.

The adapter MUST NOT replace Sails Participant identity, require Pubky to use Sails, select or execute settlement, confer Destination Authority or Economic Disposition Authority, or change an authorized destination without Sails validation. Existing SettlementRail / SettlementProvider and escrow invariants remain authoritative. Prefer opt-in privacy, fail-safe degradation and explicit endpoint-to-trade binding.

**Next step:** review and approve the research RFC `docs/rfcs/RFC-DRAFT-paykit-pubky-payment-discovery.md` through normal governance before any code, dependency, migration or deployment. No implementation date is committed.
