# Sails Protocol Documentation Router

This file is the navigation layer for the repository documentation.

It does **not** define protocol truth, architecture truth, product truth, or implementation status. Its job is to route readers to the document that owns the question they are trying to answer.

Sails does not use one universal linear documentation hierarchy. Different documents govern different questions.

## I am a new developer, AI agent, reviewer, or CTO session

Start with the root [`AGENTS.md`](../AGENTS.md) and the [timeless contributor and AI session onboarding guide](engineering/AI_SESSION_ONBOARDING.md). They define the reading path, live-state reconciliation and role-specific readiness checks, without superseding the canonical documents linked below.

## I want to understand Sails

Start here if you are new to the project and want the shortest path to the core idea before reading implementation detail.

1. [`../README.md`](../README.md) — repository homepage, current positioning, repository map, developer entry points.
2. [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) — institutional project context, positioning history, v1 focus, product relationships, current project framing.
3. [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) — consolidated current system-level technical map and routing surface; summarizes current architecture without replacing deeper governing owners.
4. [`whitepapers/SAILS_PROTOCOL_WHITEPAPER.md`](whitepapers/SAILS_PROTOCOL_WHITEPAPER.md) — broad explanatory paper covering the coordination problem, thesis, architecture, ecosystem, economics and long-term direction.
5. [`PHILOSOPHY.md`](PHILOSOPHY.md) — why the protocol is designed around coordination, sovereignty, intent and replaceable execution edges.
6. [`PRINCIPLES.md`](PRINCIPLES.md) — the standing rules used to evaluate architectural decisions.

Current positioning layers are intentionally distinct:

- **Current category:** Economic Coordination Protocol.
- **Architectural description:** Economic Coordination Layer.
- **V1 focus:** open infrastructure for building interoperable P2P Financial Marketplaces.
- **First concrete developer product:** Sails P2P Trading SDK.
- **Long-term mental model:** Economic Coordination Operating System — vision only, not the current normative category.

## I want to integrate the SDK

Use this path if you are a wallet, application or integrator trying to build with the real public developer surface.

1. [`GETTING_STARTED.md`](GETTING_STARTED.md) — zero to first real operation; includes the npm install command.
2. [`../examples/simple-wallet/`](../examples/simple-wallet/) — continuously verified golden-path example.
3. [`SDK_GUIDE.md`](SDK_GUIDE.md) — integration guidance for building a real application.
4. [`API_REFERENCE.md`](API_REFERENCE.md) — detailed route and API reference.
5. [`API_STABLE.md`](API_STABLE.md) — frozen public SDK contract and compatibility surface.
6. [`TRANSACTION_WALKTHROUGH.md`](TRANSACTION_WALKTHROUGH.md) — one P2P trade traced through the system end to end.
7. [`whitepapers/SAILS_P2P_TRADING_SDK_PAPER.md`](whitepapers/SAILS_P2P_TRADING_SDK_PAPER.md) — product/integration explanation and responsibility boundaries.

Install the first developer product:

```bash
npm install @satsails/p2p-trading-sdk
```

The generic phrase **Sails SDK** names a family. Concrete developer products use specific names. The first is the **Sails P2P Trading SDK**.

## I want to understand protocol semantics

Use these documents when the question is what must remain true, what a conforming implementation must respect, or which rules are protocol-level rather than implementation-level.

- [`SEMANTIC_KERNEL.md`](SEMANTIC_KERNEL.md) — semantic identity: K1 Valid Transition, K2 Attributed Discretion, K3 Semantic Settlement Independence, plus the Assertion rule.
- [`PROTOCOL_INVARIANTS.md`](PROTOCOL_INVARIANTS.md) — protocol invariants / technical constitution.
- [`PROTOCOL_SPECIFICATION.md`](PROTOCOL_SPECIFICATION.md) — normative protocol contract and primitive-level requirements.
- [`rfcs/00-INDEX.md`](rfcs/00-INDEX.md) — RFC navigation and accepted design decisions.
- [`GOVERNANCE.md`](GOVERNANCE.md) — protocol governance and RFC process.

These documents answer different semantic questions. Do not infer one universal linear authority chain from their ordering here.

## I want to inspect architecture

Use this path for software boundaries, implementation structure and visual architecture.

- [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) — current system-level technical synthesis and the shortest route across architecture, lifecycle, authority, settlement, evidence, runtime, network and product boundaries.
- [`SAILS_PROTOCOL_ANATOMY.md`](SAILS_PROTOCOL_ANATOMY.md) — consolidated anatomy map: what composes Sails, where each part belongs, how the parts relate, and which canonical source governs each concept. It is a router/consolidator, not a competing architecture or protocol authority.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — broad/reference-system architecture and historical implementation topology; useful context, but not the current authority for the modern Pure Core macro-architecture.
- [`CORE_ARCHITECTURE.md`](CORE_ARCHITECTURE.md) — canonical architecture for Pure Sails Core + Runtime + Modules + Providers, derived from the Semantic Kernel.
- [`CORE_IMPLEMENTATION_ARCHITECTURE.md`](CORE_IMPLEMENTATION_ARCHITECTURE.md) — implementation derivation, boundary mechanics and migration design.
- [`NODE_ARCHITECTURE.md`](NODE_ARCHITECTURE.md) — node / P2P transport architecture.
- [`DATABASE.md`](DATABASE.md) — schema and persistence model.
- [`TRUST_BOUNDARY.md`](TRUST_BOUNDARY.md) — structural trust boundaries from user device to settlement chain.
- [`CRYPTOGRAPHIC_MODEL.md`](CRYPTOGRAPHIC_MODEL.md) — identity, signatures, encryption and hash-chain mechanics.
- [`architecture/`](architecture/) — canonical visual representations. Diagrams represent architecture; they do not define it.
- [`whitepapers/SAILS_TECHNICAL_PAPER.md`](whitepapers/SAILS_TECHNICAL_PAPER.md) — technical explanatory companion for the architecture.

If a visual diagram conflicts with a governing architecture document, the document governs.

## I want current engineering reality

Use these sources when the question is what is actually real now, what remains open, and what work is operationally active.

- [`GITHUB_PROJECT.md`](GITHUB_PROJECT.md) — documented Project configuration/governance model and operational structure. Use the live GitHub Project for current operational state.
- GitHub Project **Sails Protocol — Development** — live operational state.
- GitHub Issues — executable work units, decisions and validation gates.
- [`BACKLOG.md`](BACKLOG.md) — institutional unresolved inventory, dependencies and context ledger.
- [`TODO.md`](TODO.md) — audited implementation-gap inventory; currently retained with limited authority.
- [`HANDOFF.md`](HANDOFF.md) — historical engineering handoff / dated context; **not** current execution state.
- [`GETTING_STARTED.md`](GETTING_STARTED.md) — fastest way to test what can actually run.
- [`API_STABLE.md`](API_STABLE.md) — real frozen public API surface.

Do not infer current implementation reality from vision documents, whitepapers, roadmap language, provider registrations or enum existence alone.

## I want to inspect decisions, RFCs and evidence

Use this path when you need to understand what was decided, how it was governed, and which evidence supports or challenges a claim.

- [`rfcs/00-INDEX.md`](rfcs/00-INDEX.md) — RFC navigation and accepted protocol decisions.
- [`GOVERNANCE.md`](GOVERNANCE.md) — decision/governance process and publication discipline.
- Relevant ADRs under [`adr/`](adr/) — scoped architectural decisions.
- Discovery, validation and proof documents — evidence and institutional findings.
- [`BACKLOG.md`](BACKLOG.md) — unresolved findings, dependency context and supersession links.

**Decision ≠ Evidence ≠ Implementation ≠ Claim.** An implementation, test result, discovery finding or evidence record does not automatically redefine protocol truth.

## I want governance / contribution guidance

Use these documents before proposing or implementing changes.

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution rules, architecture boundaries and RFC triggers.
- [`CODE_STYLE.md`](CODE_STYLE.md) — code/comment/error/testing conventions.
- [`ENGINEERING_GOVERNANCE.md`](ENGINEERING_GOVERNANCE.md) — consequence-weighted engineering method, STOP gates, evidence discipline, Definition of Ready/Done and Human + AI contributor model.
- [`SDK_FAMILY_RELEASE_GOVERNANCE.md`](SDK_FAMILY_RELEASE_GOVERNANCE.md) — npm artifact packaging decisions, package-family dependency order, Trusted Publishing, release gates and recovery for Sails SDK families.
- [`GOVERNANCE.md`](GOVERNANCE.md) — RFC process, module registration and publication discipline.
- [`PRINCIPLES.md`](PRINCIPLES.md) — architectural principles.
- [`PROTOCOL_INVARIANTS.md`](PROTOCOL_INVARIANTS.md) — invariants that are stricter than general principles.
- [`rfcs/00-INDEX.md`](rfcs/00-INDEX.md) — RFC index.

Repository changes should preserve the distinction between product decisions, architecture decisions, implementation work, evidence and institutional history.

## I want public papers

The canonical explanatory paper set has its own router:

[`whitepapers/README.md`](whitepapers/README.md)

It distinguishes:

- [`whitepapers/SAILS_PROTOCOL_WHITEPAPER.md`](whitepapers/SAILS_PROTOCOL_WHITEPAPER.md) — broad protocol paper.
- [`whitepapers/SAILS_TECHNICAL_PAPER.md`](whitepapers/SAILS_TECHNICAL_PAPER.md) — technical architecture paper.
- [`whitepapers/SAILS_P2P_TRADING_SDK_PAPER.md`](whitepapers/SAILS_P2P_TRADING_SDK_PAPER.md) — developer product / integration paper.

The papers explain Institutional Truth; they do not override the Semantic Kernel, Protocol Invariants, Protocol Specification, frozen architecture documents, accepted ADRs or accepted RFCs.

## I want historical / discovery evidence

Sails intentionally preserves evidence of how decisions were reached, including findings later corrected or superseded.

Useful discovery and audit surfaces include:

- [`FOUNDATIONAL_RULES_STANDARDS_INVENTORY.md`](FOUNDATIONAL_RULES_STANDARDS_INVENTORY.md)
- [`BUSINESS_RULES_DISCOVERY.md`](BUSINESS_RULES_DISCOVERY.md)
- [`STATE_LIFECYCLE_DISCOVERY.md`](STATE_LIFECYCLE_DISCOVERY.md)
- [`AUTHORITY_MODEL_DISCOVERY.md`](AUTHORITY_MODEL_DISCOVERY.md)
- [`POLICY_ELIGIBILITY_RISK_DISCOVERY.md`](POLICY_ELIGIBILITY_RISK_DISCOVERY.md)
- [`SYSTEM_COHERENCE_INTEGRATION_AUDIT.md`](SYSTEM_COHERENCE_INTEGRATION_AUDIT.md)
- [`DAY0_COMPLETENESS_COLD_SWEEP.md`](DAY0_COMPLETENESS_COLD_SWEEP.md)
- [`BACKLOG.md`](BACKLOG.md) — institutional ledger for unresolved findings and supersession links.

A historical finding may later be superseded by stronger evidence. Freeze preserves institutional history; it does not make every factual conclusion immutable.

Some strategic evaluation, red-team, due-diligence and internal coordination records are intentionally not published in this repository. See [`GOVERNANCE.md`](GOVERNANCE.md) §6C, Publication Discipline. A historical citation that does not resolve to a public file may therefore be intentional rather than a broken link.

## Specialized reference map

The router above is the preferred entry surface. Use this map when you already know the domain you need.

| Domain | Documents |
|---|---|
| Positioning / project context | [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md), [`REFERENCE_IMPLEMENTATIONS.md`](REFERENCE_IMPLEMENTATIONS.md), [`ECOSYSTEM_INTEGRATIONS.md`](ECOSYSTEM_INTEGRATIONS.md) |
| Protocol semantics | [`SEMANTIC_KERNEL.md`](SEMANTIC_KERNEL.md), [`PROTOCOL_INVARIANTS.md`](PROTOCOL_INVARIANTS.md), [`PROTOCOL_SPECIFICATION.md`](PROTOCOL_SPECIFICATION.md), [`rfcs/00-INDEX.md`](rfcs/00-INDEX.md) |
| Architecture | [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md), [`SAILS_PROTOCOL_ANATOMY.md`](SAILS_PROTOCOL_ANATOMY.md) *(consolidated anatomy/router; non-normative)*, [`CORE_ARCHITECTURE.md`](CORE_ARCHITECTURE.md), [`CORE_IMPLEMENTATION_ARCHITECTURE.md`](CORE_IMPLEMENTATION_ARCHITECTURE.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) *(broad/reference + historical topology)*, [`NODE_ARCHITECTURE.md`](NODE_ARCHITECTURE.md), [`architecture/`](architecture/) |
| Data / APIs | [`DATABASE.md`](DATABASE.md), [`API_REFERENCE.md`](API_REFERENCE.md), [`API_STABLE.md`](API_STABLE.md) |
| SDK / developer journey | [`GETTING_STARTED.md`](GETTING_STARTED.md), [`SDK_GUIDE.md`](SDK_GUIDE.md), [`DEVELOPER_JOURNEY.md`](DEVELOPER_JOURNEY.md), [`TRANSACTION_WALKTHROUGH.md`](TRANSACTION_WALKTHROUGH.md), [`SDK_usecases.md`](SDK_usecases.md), [`SDK_FAMILY_RELEASE_GOVERNANCE.md`](SDK_FAMILY_RELEASE_GOVERNANCE.md), [`SDK_RELEASE.md`](SDK_RELEASE.md), [`SCHEMAS_RELEASE.md`](SCHEMAS_RELEASE.md) |
| Security / trust / crypto | [`THREAT_MODEL.md`](THREAT_MODEL.md), [`SECURITY_MODEL.md`](SECURITY_MODEL.md), [`TRUST_BOUNDARY.md`](TRUST_BOUNDARY.md), [`CRYPTOGRAPHIC_MODEL.md`](CRYPTOGRAPHIC_MODEL.md), [`security/`](security/) |
| Governance / engineering method | [`GOVERNANCE.md`](GOVERNANCE.md), [`ENGINEERING_GOVERNANCE.md`](ENGINEERING_GOVERNANCE.md), [`SDK_FAMILY_RELEASE_GOVERNANCE.md`](SDK_FAMILY_RELEASE_GOVERNANCE.md), [`PRINCIPLES.md`](PRINCIPLES.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`CODE_STYLE.md`](CODE_STYLE.md) |
| Planning / current work | [`ROADMAP.md`](ROADMAP.md), [`GITHUB_PROJECT.md`](GITHUB_PROJECT.md), [`BACKLOG.md`](BACKLOG.md), [`TODO.md`](TODO.md), [`HANDOFF.md`](HANDOFF.md) *(historical handoff)* |
| Economics | [`PROTOCOL_ECONOMY.md`](PROTOCOL_ECONOMY.md) |
| Public explanatory papers | [`whitepapers/README.md`](whitepapers/README.md) |

## Navigation rules

- This file is a router, not a new source of truth.
- Do not infer authority from the order of links in this file.
- Do not duplicate normative definitions here when a governing document already owns them.
- Do not treat README, whitepapers, examples, diagrams or reference implementations as owners of protocol semantics.
- No interface or reference implementation owns protocol semantics.
- Prefer progressive disclosure: orient first, then route to the document that owns the detail.
- When a document is historical, evidentiary, derived or non-canonical, preserve that classification instead of silently promoting it.