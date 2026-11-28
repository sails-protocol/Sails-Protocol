# Foundational Rules & Standards Inventory — Evidence Report for CTO Gate

**Mission**: Foundational Rules & Standards Inventory (full-repository institutional investigation, not implementation).
**Baseline**: `main@eb2700868ec6f7c4d6bf75379a9ea74b2c8060b6` (PR #157 merged/frozen).
**Prepared by**: Claude Code (Engenheiro Chefe), 2026-09-14.
**Status**: Evidence only. No code, RFC, ADR, or governance document was modified to produce this report. No new standard is created by this document.

> **Errata notice.** Three items below (F-02, F-08/F-08A, F-10) were refined by CTO Gate review after the original report and addenda A1-A7 were written. The original text is preserved unedited everywhere it appears; see **§A9 (Errata / Supersession Map)** near the end of this document for the current authoritative status of each, and the addendum section that carries the full correction.

---

## 1. Executive Finding

The repository does **not** lack rules. It has an unusually large amount of real, precisely-evidenced institutional truth — `docs/PROTOCOL_INVARIANTS.md` alone (1,278 lines) encodes 6 Structural Invariants, 12 Behavioral Core Invariants, 8 Derived Properties, and 11 Operational Invariants, each with RULE/WHY/DERIVES/EVIDENCE structure and, critically, loud self-disclosure of every known live violation. The RFC index (`docs/rfcs/00-INDEX.md`, 23 RFCs) and a set of narrow, purpose-built architecture notes (`DESTINATION_AUTHORITY_ARCHITECTURE.md`, `WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`, `WDK_FUND_MOVING_OPERATIONS_SAFETY.md`, `EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md`) cover most of what a from-scratch standards program would try to invent.

The real institutional problem is **not absence of rules** but **three specific, evidenced failure modes**, each occurring in a small number of identifiable places rather than pervasively:

1. **A rule can be real, implemented, and load-bearing, yet have never passed formal governance acceptance.** RFC-021 (Market-Based Arbitration, a 🔷 Core RFC) has all 5 implementation phases shipped, but its own status field remains "Proposed" — it has never cleared the Draft→Discussion→Decision gate `docs/GOVERNANCE.md` §5 requires before implementation is supposed to begin (Finding F-01).
2. **A named methodology can be invoked as binding by CTO mission briefs across multiple missions this session while having zero canonical definition anywhere in governance.** The "Sails Engineering Harness" discipline (`CLAIM / EXISTING INSTITUTIONAL TRUTH / EVIDENCE / PRODUCT-UI CONSEQUENCE / DECISION / CONSISTENCY SWEEP`) is used in `docs/MINIMUM_BLOCKING_DECISIONS_PRODUCT_UI_RETURN.md` and in this session's own mission briefs, but `grep -rl "Sails Engineering Harness" docs/` returns exactly one file — the same output document that uses it (Finding F-02, preserved as instructed from the prior preliminary flag).
3. **A real authority-enforcement mechanism can exist, be wired, and still not be active in the default deployment** — `config.features.enforceCapabilities` (INV-08) and dual-approval (INV-OP-2) both default to conditional/off, which is disclosed but has a real, live consequence: "capability does not imply authority" is a property that must be turned on, not one the system guarantees out of the box (Finding F-04).

Two further items, flagged before this report was compiled as unresolved evidence candidates, are carried forward unresolved per instruction: possible canonicalization gap around the Sails Engineering Harness (same as F-02 above — the two are the same finding, now merged), and stale sequencing metadata in Issue #99 (Finding F-10).

The dominant pattern found on inspection was **not** silent, hidden rule-making. The codebase's own convention — loud, dated, cross-referenced disclosure blocks for every known violation (e.g. `PROTOCOL_INVARIANTS.md` lines 125-146 on the `WdkSettlementProvider` custody violation, lines 246-283 on the dispute-service destination-authority gap) — is itself evidence of a functioning, if partially undocumented, institutional discipline. The report below treats that discipline as a model to preserve, not a gap to close.

---

## 2. Repository Truth Map

| Source | Role | Status |
|---|---|---|
| `docs/PROTOCOL_INVARIANTS.md` | Canonical home for Structural/Behavioral/Operational protocol law (Pillars A, B, D, F, G) | CANONICAL — richest single source found |
| `docs/rfcs/00-INDEX.md` + 23 RFCs | Canonical history of protocol-evolution decisions, one paragraph status per RFC | CANONICAL for RFC-level history; PARTIAL for current-implementation-status accuracy (see F-01) |
| `docs/GOVERNANCE.md` | Canonical RFC lifecycle (Draft→Discussion→Decision→Implementation→Adoption), Core RFC classification (§6A) | CANONICAL |
| `docs/adr/ADR-001-day0-multi-operator-network.md`, `ADR-002-asset-settlement-rail-adapter-provider-architecture.md` | Canonical domain-model definitions (Asset/Rail/Scope/Adapter/Provider; multi-node network) | CANONICAL |
| `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` | Canonical for the Economic Disposition Authority ≠ Destination Authority ≠ Execution Authority distinction | CANONICAL, narrow scope |
| `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`, `WDK_FUND_MOVING_OPERATIONS_SAFETY.md` | Canonical for retry/unknown-outcome semantics on the WDK rail | CANONICAL, narrow scope |
| `docs/EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md` | Canonical for external-implementation extensibility precedent and the "four uncoordinated version concepts" finding | CANONICAL, narrow scope |
| `docs/API_STABLE.md` | Canonical SDK-surface freeze commitment | CANONICAL for SDK semver; explicitly NOT tied to protocol-level versioning |
| `docs/SAILS_DESIGN_LANGUAGE.md`, `PRODUCT_INTERACTION_MODEL.md`, `packages/sails-ui/{PRODUCT,DESIGN}.md` | Human Interface Engineering principles (Pillar J) | PRESENT_BUT_DISPERSED — real content, no single index |
| `docs/BACKLOG.md`, `docs/ROADMAP.md` | Obligation tracker, sequencing | CANONICAL for open-obligation status; must be cross-checked, not trusted by filename alone |
| Issue #99 | Persistent CTO continuity marker | PARTIAL — content largely accurate but contains stale sequencing (F-10) |
| `docs/CROSS_LAYER_SEMANTIC_CONTRACT_AUDIT.md` | Prior audit findings (e.g. CSC-I01 logging gap, CSC-H01/02/03 versioning) | CANONICAL for those specific findings |
| Prisma schema inline comments (`prisma/schema.prisma`) | De facto canonical source for field-level provenance/versioning/immutability rules (e.g. `feePolicyVersionId`, DB trigger on `FeePolicyVersion`) | CANONICAL but undiscoverable except by reading the schema directly — no doc indexes these |
| `src/common/events/handlers.ts` header comment | De facto canonical cross-module authority map for event-triggered state transitions | IMPLICIT — real and precise, but lives only as a code comment, never referenced from any doc |

---

## 3. Inventory Matrix Per Pillar

Status vocabulary used exactly as specified: CANONICAL, PRESENT_BUT_DISPERSED, IMPLICIT, DUPLICATED, CONTRADICTORY, PARTIAL, ABSENT, NOT_APPLICABLE.

### Pillar A — Domain Model / Frozen Distinctions

| Distinction | Canonical home | Status |
|---|---|---|
| Asset ≠ SettlementRail ≠ SettlementScope ≠ SettlementAdapter ≠ SettlementProvider | `docs/adr/ADR-002-...md` | CANONICAL |
| Economic Identity ≠ Transport Identity | ADR-001, `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` | CANONICAL |
| Sails Protocol ≠ Sails Node | ADR-001 | CANONICAL |
| Structural Compatibility ≠ Eligibility | `src/common/execution-candidates.ts` (code-level, explicitly renamed away from "Eligible") + ADR-002 §6 | CANONICAL but split across a code file and an ADR — PRESENT_BUT_DISPERSED as a *reader experience*, not as a truth conflict |

### Pillar B — Business Rules

| Rule domain | Canonical home | Supporting/implementation locations | Status |
|---|---|---|---|
| Offer creation | Code-only (`liquidity.routes.ts:43-63`, `liquidity.service.ts:424-565`); RFC-018 covers "Offer is a published TradeIntent" | `prisma/schema.prisma:161-191` | PRESENT_BUT_DISPERSED (field-level validation rules have no doc home) |
| Offer publication/activation | **No separate step exists** — `Offer.status` defaults ACTIVE at creation | `liquidity.service.ts:667-684` | IMPLICIT (a real design choice, never stated as a rule anywhere) |
| Offer/Trade acceptance → Trade creation | Code-only, `trade.service.ts:59-149` | Inline "Robustness-audit fix 2026-07-20" comment | IMPLICIT |
| Cancellation (Trade) | Code + inline rationale, `trade.service.ts:35-54,276-315` | `MANUAL_TRADE_TRANSITIONS` map | PRESENT_BUT_DISPERSED (rule is explained but not doc-homed) |
| Cancellation (Offer) | **No transition guard exists at all** | `liquidity.service.ts:667-684` | ABSENT (real gap, see F-03) |
| Settlement/escrow initiation | Code-only for role split; `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` for reorg precondition | `escrow.service.ts:292-561` | PRESENT_BUT_DISPERSED |
| Payout/destination-address mutation | `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` | `escrow-lifecycle.ts:502-532`, `payout-address.service.ts` | CANONICAL, with one disclosed residual gap (F-06) |
| Dispute/arbitration initiation & assignment | RFC-021 (D1-D3) | `dispute.service.ts:90-162`, `market-arbitration.provider.ts:109-227` | CANONICAL |
| Evidence submission window | RFC-021 D8 (comment references only, no standalone doc) | `dispute.service.ts:890-919,954-1030` | PRESENT_BUT_DISPERSED |
| Retry rules (general idempotency) | Code-only, extensive file-header documentation | `src/common/idempotency.ts` | IMPLICIT (rich but doc-homed nowhere outside the file itself) |
| Retry rules (WDK-specific) | `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`, `WDK_FUND_MOVING_OPERATIONS_SAFETY.md` | `wdk-execution-truth.ts` | CANONICAL |
| Expiration (Escrow) | `prisma/schema.prisma:69-86` inline (Missão 11 Fase 7.3.3 §B); `PROTOCOL_INVARIANTS.md` INV-04/INV-07 | `escrow.service.ts:982-1112`, `expiry-authority.ts` | PRESENT_BUT_DISPERSED |
| Expiration (Intent) | `PROTOCOL_SPECIFICATION.md` §2.4/§3.1 | `src/core/state-machine.ts:49-74` | CANONICAL, with disclosed limitation (lazy, not swept) |
| Reputation event triggers | Code-only ownership map (`handlers.ts`); RFC-021 D7 for vouch burn only | `reputation.service.ts:51-137` | IMPLICIT for the general mapping; CANONICAL for vouch burn specifically |
| Post-commit mutation guards | Code-only, extensive inline comments; one DB-trigger-level guard (`FeePolicyVersion`) documented only in schema comment | `escrow-lifecycle.ts:29-58,290-330`, `prisma/schema.prisma:757-779` | IMPLICIT |
| Agent recommend vs. execute boundary | RFC-016 + extensive inline INV-12 rationale | `qvac-agent.provider.ts`, `dispute.service.ts:1032-1065` | CANONICAL — one of the best-documented rules in the repository |
| Market/UI overlay authority bypass | Code + UI copy only (`AgentIntentionPanel.tsx`), verified no bypass exists | — | IMPLICIT but falsifiable/verified |

### Pillar C — State & Lifecycle

| Object | Enum location | Transition guard | Terminal states | Status |
|---|---|---|---|---|
| Offer | `schema.prisma:32-37` | **NONE** — no `VALID_TRANSITIONS` map exists | Not enforced (inferred only) | ABSENT — real gap (F-03) |
| Trade | `schema.prisma:39-45` | Partial — `MANUAL_TRADE_TRANSITIONS` (`trade.service.ts:51-54`) covers only client-triggered edges; automatic edges driven by `handlers.ts`, not validated Trade-side | COMPLETED/CANCELLED terminal by omission, not explicit list | PARTIAL |
| Escrow | `schema.prisma:56-87` | Explicit, rigorous, double-enforced (`VALID_TRANSITIONS` + atomic `claimEscrowTransition`) | Explicit: COMPLETED/REFUNDED/SPLIT | CANONICAL |
| Dispute | `schema.prisma:1351-1364` | No single map — ad hoc per-method guards; `RESOLVED` is not strictly terminal (`appeal()` reopens it) | Not stated as a list; non-terminality of RESOLVED is a real, load-bearing fact not flagged as such anywhere | PARTIAL (F-05) |
| IdempotencyKey | `schema.prisma:2391-2396` | Explicit, carefully reasoned (`idempotency.ts`) | COMPLETED/UNKNOWN effectively terminal; FAILED reclaimable via CAS | CANONICAL |
| EscrowPendingTransaction | `schema.prisma:2161-2226` | **No status enum at all** — existence/absence is the only state signal | N/A | ABSENT — real gap (F-07) |
| WdkTransferAttempt | `schema.prisma:697-755` | Explicit, documented ordering; `SUBMISSION_UNKNOWN` is the canonical ambiguous-outcome state | CONFIRMED/REVERTED terminal per rail leg | CANONICAL |
| Intent | `state-machine.ts:28-41` | Explicit, centralized, declared "the single source of truth" | Explicit: FULFILLED/EXPIRED/CANCELLED/FAILED | CANONICAL |
| NegotiationChannel (in-memory) | `negotiation.service.ts:181-203` | Plain `Map`, never persisted, no transition validation | N/A | ABSENT — real gap, lower severity (ephemeral, not economically settled state) |

### Pillar D — Authority & Permission

| Capability | Canonical home | Status |
|---|---|---|
| Authenticate | Code-only (`auth.ts`, `identity.routes.ts`) | IMPLICIT — real and wired, no doc names the mechanism explicitly as institutional |
| Authorize (CapabilityGrant, RFC-005) | RFC-005 + `capability-registry.ts` header ("Real, not a stub") | CANONICAL |
| Sign (authority-decision signatures) | Code-only (`arbitration-authority.ts`), cross-referenced by `dispute.service.ts` comments | PRESENT_BUT_DISPERSED |
| Execute | Code-only, `escrow-lifecycle.ts:522-527` names itself the single choke point | IMPLICIT |
| Recommend → Execute barrier | RFC-016 + inline INV-12 rationale | CANONICAL |
| Arbitrate vs. platform admin | **No platform-admin role/bypass found anywhere** — arbiters are permissionless-registered participants | IMPLICIT — absence itself is the finding, undocumented as a stated design decision anywhere outside RFC-021's general framing |
| Change destination | `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` | CANONICAL, with disclosed residual gap (F-06) (**Corrected/Implemented 2026-11-28:** F-06 is superseded; per `docs/BUSINESS_RULES_DISCOVERY.md`, section "Prior Frozen Findings Superseded By New Evidence", there is no live residual gap on the disputed non-MULTISIG rails; see the note after section 16 of `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`) |
| Revoke (CapabilityGrant) | Code-only | IMPLICIT, real |
| Revoke (session) | **ABSENT** — zero matches for session revocation anywhere | ABSENT (F-08A) |
| Rotate (identity key) | **ABSENT**, explicitly disclosed as out of scope in `DESTINATION_AUTHORITY_ARCHITECTURE.md:302-307` ("OpenIdentity territory, not addressed here") | ABSENT, disclosed |
| Renew authorization | **ABSENT** as a distinct concept — only expiry, no `renew()` | ABSENT |
| Collapse check | One confirmed instance: the disclosed residual gap (F-06) where an arbiter's ruling request still carries destination authority for non-MULTISIG escrow types | CONTRADICTORY in that one narrow, already-disclosed scope only (**Corrected/Implemented 2026-11-28:** superseded; the F-06 scope no longer applies, see the note on the row above) |

### Pillar E — Policy / Eligibility / Risk

| Concept | Status | Evidence |
|---|---|---|
| Capability (structural) | CANONICAL | `settlement-provider-registry.ts:92` |
| Availability (runtime health/liveness) | **ABSENT**, confirmed by the code's own audit statement | `execution-candidates.ts:55` |
| Permission (CapabilityGrant) | CANONICAL | See Pillar D |
| Eligibility (multi-factor, ADR-002 §6 sense) | ABSENT as a genuine multi-factor concept; every real "eligib" usage is structural-only or arbiter-dispatch-specific | `execution-candidates.ts`, `errors/index.ts:20,44` |
| Risk policy | PARTIAL — real narrow mechanisms (circuit breaker, social-engineering detector, QVAC risk advisory) exist; no general risk-policy engine | `escrow-circuit-breaker.ts`, `social-engineering-agent.ts`, `qvac-agent.provider.ts:53-60` |
| Maturity/Evidence (ADR-002 §7) | **ABSENT** at runtime, confirmed by three separate code-comment disclaimers | `settlement-provider-registry.ts:76-78,96-97`, `settlement-scope.ts:11`, `execution-candidates.ts:29,55` |
| Production eligibility | **ABSENT** at runtime, documented-only, explicitly rejects `productionEligible = evidencePassed` as an automatic derivation | ADR-002 §6 |

**Frozen preservation confirmed intact**: Supported ≠ Available ≠ Healthy ≠ Eligible; Provider registration ≠ runtime availability; Provider registration ≠ maturity/evidence; Registered path ≠ production-eligible path — all five hold as stated, because the concepts on the "≠" right-hand side (Availability, Maturity, Production Eligibility) simply do not exist as runtime concepts yet, so nothing can have silently collapsed into them.

### Pillar F — Temporal & Concurrency Semantics

| Concept | Canonical home | Status |
|---|---|---|
| Retries / idempotency | Code-only, `src/common/idempotency.ts` (extensive header) | IMPLICIT |
| Verify-before-transition (re-check atomically, not from stale read) | `PROTOCOL_INVARIANTS.md` INV-04 | CANONICAL |
| Duplicate callbacks/requests | `IdempotencyKeyStatus` state machine | CANONICAL |
| Races (double-lock, double-release) | `PROTOCOL_INVARIANTS.md` (implicit via INV-04, INV-07); code-level "claim-before-execute" pattern across Escrow/Trade/Idempotency | CANONICAL for the principle; IMPLICIT for the specific "claim-before-execute" pattern name (never named as a pattern in any doc, only recognizable by reading multiple call sites) |
| Stale state / reorg | `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` | CANONICAL |
| Partial failure / network interruption | `docs/PARTNER_BETA_INTEGRATION_REALITY.md` §9 (Restart/offline/resume table) | CANONICAL, with one disclosed gap (session-expiry recovery is manual, no `refreshSession`) |
| Unknown outcome as first-class state | `WdkTransferAttemptStatus.SUBMISSION_UNKNOWN`, `IdempotencyKeyStatus.UNKNOWN` | CANONICAL — this is the one Pillar-F property most thoroughly and explicitly institutionalized in the repository |
| `IdempotencyKeyStatus` vs. economic operation state confusion check | **No confusion found.** `IdempotencyKeyStatus` governs bookkeeping-write completion only; `EscrowStatus`/`DisputeStatus`/`WdkTransferAttemptStatus` govern economic state independently. The two are cross-referenced, never merged. | NOT_APPLICABLE (checked, confirmed clean) |

### Pillar G — Evidence / Auditability / Observability

| Concept | Canonical home | Status |
|---|---|---|
| Event store durability | `event-store.ts` interface + header comments | CANONICAL — `durable: boolean` flag is an explicit, self-documenting design choice; `PostgresEventStore` is the wired default |
| Hash-chain (`entryHash`/`prevHash`) | `event-store.ts` comment (lines 45-59) documents a real, closed architectural correction | CANONICAL, with one documented scope nuance: `IntentEvent`'s own chain is narrower than the general `DurableEventRecord` chain `Timeline.verifyChain()` actually walks — this is disclosed in the code comment but not cross-referenced from any doc (F-09) |
| Dispute ruling reconstructibility | `arbitration-authority.ts` (Ed25519-signed, canonical serialization) | CANONICAL |
| Escrow provenance/versioning | `Escrow.type` (permanent) + `feePolicyVersionId` (versioned) | PARTIAL — no field exists for "which version of the provider's code executed," only which type; explicitly disclosed as a non-gap in `EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md:369-379` |
| Operational observability vs. economic evidence distinction | `docs/CROSS_LAYER_SEMANTIC_CONTRACT_AUDIT.md` (CSC-I01) | CANONICAL — explicitly names the durable EventStore/Timeline as authoritative over the pino log stream |

### Pillar H — Versioning & Migration

| Concept | Canonical home | Status |
|---|---|---|
| `protocolVersion` field | Present on ~13 Prisma models, `@default("0.1")` | **Dead/decorative** — self-documented as such in `capability-profile.ts:14-21` ("no real read-side enforcement anywhere"). CONTRADICTORY in the narrow sense that its presence implies live versioning to a naive reader, while its actual behavior is inert |
| SDK vs. server package version divergence | `docs/BACKLOG.md` item 40 | CANONICAL as a *named, tracked* finding; the underlying divergence itself is real and unresolved |
| Four uncoordinated version concepts (`/v1/` prefix, `protocolVersion`, SDK semver, server semver) | `docs/EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md:394-397` | CANONICAL as a named finding; OPEN as a Decision Mission per BACKLOG item 40 |
| In-flight economic episode handling across migrations | `docs/EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md` §9 | CANONICAL — correctly declines to invent a mechanism where no current dynamic-extension use case exists yet |
| `docs/API_STABLE.md` freeze commitment | Additive-only, explicit tier system | CANONICAL, narrow scope (SDK only, not protocol-level) |

### Pillar I — Interoperability & Conformance

| Concept | Canonical home | Status |
|---|---|---|
| External Capability → Public Contract → Capability Declaration → Constraints → Conformance → Evidence → Eligibility → Runtime Participation (frozen 8-stage lifecycle) | `docs/EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md` (per prior mission) | CANONICAL — preserved intact, `Constraints` stage confirmed still present |
| No-privileged-wallet guarantee | `PROTOCOL_INVARIANTS.md` INV-03 | CANONICAL |
| Deterministic conformance | `PROTOCOL_INVARIANTS.md` INV-11 | CANONICAL |
| Native rail semantics preservation | `PROTOCOL_INVARIANTS.md` INV-09 | CANONICAL |
| One normative construction algorithm per rail | `PROTOCOL_INVARIANTS.md` INV-OP-9 | PARTIAL, explicitly and honestly so — MULTISIG has no live drift risk today only because no second construction implementation exists yet, not because a mechanism enforces single-sourcing; wallet-side *construction* (as opposed to verification) is named as "genuinely open" |
| Conformance ≠ tests pass | `PROTOCOL_INVARIANTS.md` "Conformance Is Not 'Tests Pass'" section | CANONICAL — a rare, explicit, four-step definition of what conformance actually requires (Level 1 → Level 2 → Level 3 → executable evidence) |
| Reference-implementation success promoted to interoperability proof? | **Checked, not found.** No document or code path claims `sails-ui`'s own successful verification proves general interoperability; INV-03's evidence section explicitly frames `sails-ui` as behaving *as an external wallet would*, not as a privileged proof of the property | NOT_APPLICABLE (checked, confirmed clean) |

### Pillar J — Human Interface Engineering (inventory only)

| Principle | Canonical home | Status |
|---|---|---|
| Progressive disclosure | `docs/SAILS_MARKET_DESIGN_DIRECTION.md` §6 (three depths: Primary/Secondary/Advanced) | CANONICAL, but its own text (`PRODUCT_INTERACTION_MODEL.md:585`) discloses that the term does not literally appear in `PROJECT_CONTEXT.md` §2D, its cited origin — a self-corrected provenance note, not a contradiction |
| "UI compresses complexity, doesn't conceal truth" | Closest functional match: `SAILS_DESIGN_LANGUAGE.md:46-49` ("Technical sophistication should reduce user complexity, not expose it," UI-POLISH-2) | PRESENT_BUT_DISPERSED — the concept is real and named, the exact phrasing from the mission brief does not appear verbatim anywhere |
| Authority/consequence clarity | `docs/PRODUCT_INTERACTION_MODEL.md` §6 "Authority Matrix" | CANONICAL — explicit false-claims table ("seeing a control grants authority to use it" → False) |
| Cross-platform information integrity (never fracture meaning across breakpoints) | `SAILS_DESIGN_LANGUAGE.md` §23 | CANONICAL |
| Accessibility | `packages/sails-ui/PRODUCT.md` (WCAG 2.1 AA) + `DESIGN.md:274-277` (concrete prior-failure-driven rule) | CANONICAL |
| Error prevention / recovery (as named Nielsen-style headings) | **Not found under those names anywhere.** Substantive content exists under different framings (Authority Matrix, Restart/offline/resume table) | ABSENT as a named principle; PRESENT_BUT_DISPERSED as substance |
| User intent / feedback / progressive disclosure of information hierarchy (as named headings) | Not found as standalone named principles | ABSENT as named principles; substance dispersed across the same documents |

---

## 4. Findings

Each finding: ID, description, evidence, classification (A–J), severity, affected layers, frozen-truth impact, Product/Architecture Decision requirement, suggested destination.

**F-01 — RFC-021 implemented before formal acceptance.**
RFC-021 (Market-Based Arbitration, 🔷 Core RFC) has all 5 implementation phases built and committed ("Atualizado 2026-07-29" per `docs/rfcs/00-INDEX.md`), while its own status field remains "Proposed." `docs/GOVERNANCE.md` (lines 180-204) defines Draft→Discussion→Decision→Implementation→Adoption in that order, with Decision required before Implementation begins. This inverts the documented order for a Core RFC governing dispute arbitration and market-based authority selection — one of the highest-stakes rule domains in the protocol.
Classification: **C** (implementation truth mislabeled protocol truth — code is functioning as institutional rule without having been formally decided) with a secondary **I** component (a Product/Architecture Decision — ratify or roll back — is genuinely required, not optional).
Severity: High (the rule is real, load-bearing, and governs fund disposition via arbitration, but has never cleared the acceptance gate the project's own governance requires).
Affected layers: Governance, RFC process, dispute/arbitration subsystem.
Frozen truth affected: No — RFC-021's substance is not in question, only its procedural status.
Product Decision required: No.
Architecture/Governance Decision required: **Yes** — run RFC-021 through `GOVERNANCE.md` §5 Decision gate retroactively (Accept/Reject/Needs Revision), or explicitly document why an already-fully-implemented Core RFC is exempt.
Suggested destination: A one-line status correction in `docs/rfcs/00-INDEX.md` is not sufficient by itself; the underlying obligation is a governance action, not a doc edit — flag to Backlog as a Governance obligation.

**F-02 — "Sails Engineering Harness" has zero canonical definition.**
The structured finding-format `CLAIM / EXISTING INSTITUTIONAL TRUTH / EVIDENCE / PRODUCT-UI CONSEQUENCE / DECISION / CONSISTENCY SWEEP` is invoked as binding methodology by CTO mission briefs (including this session's own PR #156 mission) and used throughout `docs/MINIMUM_BLOCKING_DECISIONS_PRODUCT_UI_RETURN.md`. `grep -rl "Sails Engineering Harness" docs/` returns exactly one file (the output document that uses it); `grep -n "Engineering Harness|Harness discipline" docs/ENGINEERING_GOVERNANCE.md` returns zero hits. `docs/TEST_HARNESS_RELIABILITY.md` is a distinct, unrelated document (test-infrastructure reliability, not a decision-methodology).
Classification: **C** — a methodology is functioning as an institutional rule (mission briefs treat it as binding) without ever having been decided or written down as a standard.
Severity: Medium (does not affect fund safety; affects whether future missions can independently reproduce the same discipline without tribal knowledge — directly implicates the Stranger Developer Test).
Affected layers: Governance/process only.
Frozen truth affected: No.
Product Decision required: No.
Architecture Decision required: Arguably yes, but narrowly — this is exactly the class of finding the mission's DO-NOT-DO list warns against resolving unilaterally ("do not automatically create 8-10 standards"). **Preserved as an unresolved evidence candidate per explicit CTO instruction; not resolved by this report.**
Suggested destination: If ratified, `docs/ENGINEERING_GOVERNANCE.md` is the correct canonical home (it already governs process/discipline, not `PROTOCOL_INVARIANTS.md`, which governs protocol law).

**F-03 — Offer object has no lifecycle guard.**
`OfferStatus` (`prisma/schema.prisma:32-37`: ACTIVE/PAUSED/COMPLETED/CANCELLED) has no `VALID_TRANSITIONS` map anywhere in `src/modules/open-liquidity/`. `updateOfferStatus()` (`liquidity.service.ts:667-684`) checks only ownership. An owner can move `COMPLETED`→`ACTIVE` or `CANCELLED`→`ACTIVE` with no guard — in contrast to Escrow and Intent, which both have rigorous, doubly-enforced transition maps.
Classification: **H** (legitimate implementation detail) *if* Offer transitions are genuinely economically inconsequential (an Offer is pre-Trade, non-binding); **F** (hidden capability / maturity underclaim) if reactivating a COMPLETED offer has real discoverability/trust consequences the Marketplace UI does not currently guard against. This report does not resolve which — that determination requires Product input on whether Offer state visibility to counterparties depends on this guard.
Severity: Medium.
Affected layers: `open-liquidity` module, Marketplace UI (offer cards read `OfferStatus` to decide what to render).
Frozen truth affected: No.
Product Decision required: **Yes** — is an Offer's status transition economically/UX-meaningful enough to warrant a guard, or is its non-bindingness exactly why none exists?
Architecture Decision required: No, pending the Product answer.
Suggested destination: Backlog obligation, pending Product Decision.

**F-04 — Capability enforcement and dual-approval are real but off by default.**
`config.features.enforceCapabilities` (RFC-013/014) and `config.features.requireDualApprovalForRelease` (RFC-015) are both real, wired mechanisms — not stubs — but both default to `false`. `PROTOCOL_INVARIANTS.md` INV-08 explicitly frames this as intentional and disclosed ("conditional enforcement is stated, not hidden"), citing RFC-014's own boot-time guard (`FATAL: NODE_ENV=production but ENFORCE_CAPABILITIES is not set`) as the actual safety net for production.
Classification: **G** (legitimate deferral) as currently disclosed and gated — the boot-time guard prevents the dangerous case (silent off-in-production). Would become **E** (maturity overclaim) only if any Product-facing material describes "capability does not imply authority" as a guaranteed property without the qualifier "when enabled" — this report did not find such an overclaim in Product-facing docs, only correctly-qualified statements in `PROTOCOL_INVARIANTS.md` itself.
Severity: Low, given the disclosed boot guard; would be High if the guard were ever removed or bypassed.
Affected layers: `core/intent-engine.ts`, `escrow-lifecycle.ts`, `config/index.ts`.
Frozen truth affected: No.
Product/Architecture Decision required: No — already correctly disclosed and gated.
Suggested destination: No action; cross-reference only, confirming existing disclosure is sufficient.

**F-05 — Dispute `RESOLVED` is not terminal, and this non-terminality is not flagged as a stated fact anywhere.**
`dispute.service.ts`'s `appeal()` (lines 752-826) reopens a `RESOLVED` dispute into `APPEALED`. The schema comment (`prisma/schema.prisma:1447-1449`) states "this reference implementation's dispute flow has no 'reopen after RESOLVED' path" in the context of a *different* design point (a unique-constraint rationale), which reads as though it asserts non-reopenability — while `appeal()` in the same codebase does exactly reopen it. This is not a contradiction in economic behavior (appeal is a known, intended RFC-021 mechanism) but a **misleading local comment** that a reader relying on it in isolation would misread as "RESOLVED is terminal."
Classification: **C** — a comment stating implementation truth in a narrow context reads as a broader protocol claim it does not intend to make.
Severity: Low (the actual behavior is correct and RFC-021-conformant; only the comment's scope is unclear).
Affected layers: Documentation/comment accuracy only, `open-settlement` module.
Frozen truth affected: No.
Product/Architecture Decision required: No.
Suggested destination: Implementation defect (comment clarification) — trivial, non-architectural, does not require a mission of its own.

**F-06 — Disclosed residual destination-authority gap for unmigrated escrow types.**
`escrow.service.ts:602-609` — legacy `applyRuling()` for LIGHTNING_HODL/SAFE_GUARD_EVM/WDK_USDT_EVM/MOCK disputes still passes the arbiter's own `releaseToAddress` directly, explicitly commented as "a disclosed residual gap, not fixed by M8-R2 (out of that mission's bounded scope)."
Classification: **G** (legitimate, explicitly bounded deferral) — this is a model instance of correct disclosure, not a hidden gap.
Severity: Medium in absolute terms (a real destination-authority bypass exists for four escrow types) but institutionally Low-risk because it is loudly disclosed with a named scope boundary and a named remediation owner (M8-R2's successor).
Affected layers: `open-settlement`, four non-MULTISIG rails.
Frozen truth affected: No — `DESTINATION_AUTHORITY_ARCHITECTURE.md` explicitly names this boundary.
Product Decision required: No.
Architecture Decision required: A future mission decision on when to close this gap for the remaining rails — but not urgently, per the existing disclosure's own framing.
Suggested destination: Already correctly tracked; no new document needed. Confirm it remains listed in `docs/BACKLOG.md`.

**F-07 — `EscrowPendingTransaction` has no status field.**
`prisma/schema.prisma:2161-2226` — no enum, no `VALID_TRANSITIONS`. State is purely existence/absence (created then explicitly `.delete()`d). This contrasts with `WdkTransferAttempt`, which models an adjacent concern with a rich, explicit status enum including an ambiguous-outcome state.
Classification: **H** (legitimate implementation detail) if the object's lifetime is genuinely too short/simple to warrant a state machine (it appears to be a short-lived staging row bridging construction and broadcast); potentially **F** if an ambiguous outcome during that narrow window (e.g., a crash between create and delete) is unrecoverable in a way `WdkTransferAttempt`'s `SUBMISSION_UNKNOWN` state exists specifically to prevent for the adjacent concept.
Severity: Medium — warrants a direct code-level check (not performed by this evidence-only mission) of what happens on a crash between `.create()` and `.delete()`.
Affected layers: `escrow-pending-tx.ts`, `open-settlement`.
Frozen truth affected: No.
Product Decision required: No.
Architecture Decision required: Possibly — recommend a scoped, narrow follow-up investigation (not a mission) into crash-recovery behavior for this specific gap before deciding whether a status field is warranted.
Suggested destination: Backlog obligation (investigation, not yet implementation).

**F-08 — Session revocation and key rotation/renewal are absent.**
No `revoke.?session` match anywhere in `src/`; sessions end only via Redis TTL expiry. No `rotate.?key`/`key.?rotation` match anywhere; `DESTINATION_AUTHORITY_ARCHITECTURE.md:302-307` explicitly names this as OpenIdentity-territory and out of scope for that document. No `renew()` exists for `CapabilityGrant` — only expiry.
Classification: **F** (maturity underclaim / hidden capability gap) for session revocation specifically, since a compromised session token today has no early-invalidation path beyond waiting out the TTL — a real, live security-relevant gap, not yet disclosed anywhere as a named limitation. Key rotation is already correctly classified as **G** (legitimate, disclosed deferral) since `DESTINATION_AUTHORITY_ARCHITECTURE.md` names it explicitly.
Severity: Medium-High for session revocation (no disclosed compensating control was found); Low for key rotation (already disclosed, scoped to a named future owner).
Affected layers: `open-identity`, `auth.ts`.
Frozen truth affected: No.
Product Decision required: No.
Architecture Decision required: **Yes** for session revocation — this is the one finding in this report closest to an undisclosed security gap rather than a documentation gap, and should be evaluated for a scoped hardening pass independent of this inventory mission.
Suggested destination: Evidence/backlog obligation, flagged for security review priority.

**F-09 — `IntentEvent`'s hash chain is narrower than the chain `Timeline.verifyChain()` actually walks.**
`event-store.ts` comment (lines 45-59) documents a real, closed 2026-08-04 correction: RFC-008 D2 originally targeted `entryHash`/`prevHash` on `EscrowEvent`/`ReputationEvent`, but the actual wired verification (`Timeline.verifyChain()`) walks `DurableEventRecord` rows keyed by `correlationId`, not those tables. `IntentEvent`'s own `entryHash`/`prevHash` (`schema.prisma:1924-1944`) is a separate, narrower mechanism scoped only to Intent status transitions. This distinction is disclosed in one code comment but not cross-referenced from `PROTOCOL_INVARIANTS.md` (INV-05's evidence section cites `EscrowFundingEvidence`/`EscrowEvent`/`DurableEventRecord` generically without naming this scope nuance).
Classification: **C** (a narrower implementation fact could be silently read as broader protocol-wide chain coverage by someone reading INV-05 alone, without also reading `event-store.ts`'s comment).
Severity: Low — the actual coverage is correct and sufficient for its evidenced claims; only cross-referencing is incomplete.
Affected layers: Documentation cross-referencing only.
Frozen truth affected: No.
Product/Architecture Decision required: No.
Suggested destination: Cross-reference only — add a one-line pointer from `PROTOCOL_INVARIANTS.md` INV-05's evidence section to `event-store.ts`'s scope-correction comment.

**F-10 — Issue #99 stale sequencing (preserved from preliminary flag, not resolved).**
Issue #99 (`updatedAt: 2026-09-14T22:23:42Z`, i.e. after PR #157's merge) still lists step 2 of its "Current production sequencing" as pending institutionalization of Day-0 multi-node/blind-spot content, even though PR #154 already completed exactly that via `docs/BACKLOG.md` item 41.
Classification: **C** (a completed implementation fact is not reflected in the continuity tracker's own stated sequencing — the tracker's truth has lagged behind actual institutional state).
Severity: Low (does not affect protocol correctness; affects only whether future missions correctly perceive what is already done).
Affected layers: Process/continuity tracking only.
Frozen truth affected: No.
Product/Architecture Decision required: No.
Suggested destination: **Explicitly preserved unresolved per CTO instruction — not corrected by this report.** If ratified for correction, the fix is a one-line update to Issue #99 itself, not a new document.

**F-11 — `protocolVersion` field is decorative, self-disclosed as such, but its mere presence on ~13 models could mislead a reader into assuming live enforcement.**
`prisma/schema.prisma` — `protocolVersion String @default("0.1")` on ~13 models, confirmed by grep to never appear in a `WHERE` clause or version-gate check anywhere in `src/`, `packages/sails-sdk`, or `packages/sails-ui`. Already self-disclosed in `capability-profile.ts:14-21` and named directly in `EXTERNAL_EXTENSIBILITY_PRECEDENT_CONSOLIDATION.md:395` ("inert `0.1` literal").
Classification: **C** (a field named `protocolVersion`, present on nearly every economically-relevant model, functions purely as row provenance metadata — not a mislabeling by the codebase itself, which discloses this honestly, but a real risk for any external developer reading the schema without also reading the disclosing comment; a Stranger Developer Test failure point).
Severity: Low, given existing disclosure; the underlying versioning gap itself is already tracked as BACKLOG item 40 (Decision Mission, OPEN).
Affected layers: Schema-level documentation discoverability.
Frozen truth affected: No.
Product/Architecture Decision required: No new decision — BACKLOG item 40 already names this obligation; this finding only reinforces that it remains open.
Suggested destination: No new document; cross-reference confirms BACKLOG item 40 is the correct, already-existing destination.

**F-12 — Human Interface Engineering principles are real but have no single index; some Nielsen-style categories (error prevention, feedback, user intent) have no home under those names.**
Confirmed by direct search across `SAILS_DESIGN_LANGUAGE.md`, `PRODUCT_INTERACTION_MODEL.md`, `sails-ui/PRODUCT.md`, `sails-ui/DESIGN.md`, `PARTNER_BETA_INTEGRATION_REALITY.md` — substantive content on recovery/error handling exists (`PARTNER_BETA_INTEGRATION_REALITY.md` §9's Restart/offline/resume table) but not under an "error prevention" or "feedback" heading; these Nielsen-heuristic category names simply are not the vocabulary this project uses.
Classification: **J** (Architecture/Design-language Decision, if any) — this is explicitly Pillar J's own inventory-only mandate; no standard is proposed here.
Severity: Low — this is an inventory gap, not a functional one; the underlying substance exists, just not indexed under conventional UX-heuristic names.
Affected layers: Design documentation discoverability only.
Frozen truth affected: No.
Product Decision required: No — per explicit mission instruction, Pillar J is inventory-only; do not create the standard now.
Suggested destination: No action beyond this inventory entry, per DO-NOT-DO instruction.

---

## 5. Canonical-Home Recommendations For Every Real Gap

| Finding | Recommended disposition |
|---|---|
| F-01 (RFC-021 status) | Governance/Backlog obligation — run the retroactive Decision gate; not a new document |
| F-02 (Sails Engineering Harness) | No action by this report — explicitly preserved unresolved. If later ratified: extend `docs/ENGINEERING_GOVERNANCE.md`, do not create a new file |
| F-03 (Offer lifecycle) | Product Decision required first; then either extend `docs/adr/ADR-002-...md` scope or accept the current no-guard design explicitly in a backlog note |
| F-04 (capability enforcement default) | No action — already correctly disclosed |
| F-05 (misleading Dispute comment) | Implementation defect — direct code comment fix, no institutional document needed |
| F-06 (destination-authority residual gap) | No action — already correctly tracked; confirm BACKLOG entry currency |
| F-07 (`EscrowPendingTransaction` no status) | Backlog obligation: scoped investigation (not implementation) into crash-window behavior |
| F-08 (session revocation absent) | Evidence/security-review obligation — flag for a scoped hardening pass, prioritized ahead of most other findings in this report given severity |
| F-09 (`IntentEvent` chain scope) | Cross-reference only — one-line pointer added to `PROTOCOL_INVARIANTS.md` INV-05 |
| F-10 (Issue #99 stale sequencing) | No action by this report — explicitly preserved unresolved |
| F-11 (`protocolVersion` decorative) | No new document — BACKLOG item 40 already the correct destination |
| F-12 (HIE principle indexing) | No action — Pillar J is inventory-only per explicit instruction |

No finding in this report requires creating a new standards document. This is itself a material finding: the institutional gaps discovered are governance-sequencing gaps (F-01), a process-methodology gap (F-02), a security-hardening gap (F-08), and several small cross-referencing/documentation-discoverability gaps (F-03, F-05, F-07, F-09, F-11, F-12) — not a shortage of canonical homes.

---

## 6. Duplication Map

- **Healthy reference (not dangerous)**: `PROTOCOL_INVARIANTS.md`'s Level 2 Derived Properties (DP-1 through DP-8) each explicitly cite the Level 1 invariant they derive from and the Level 3 operational invariant that formalizes them (e.g. DP-5 → INV-09/INV-11 → INV-OP-9). This is intentional, disclosed layering, not duplication.
- **Healthy reference**: Structural Compatibility ≠ Eligibility is stated once in ADR-002 §6 and once, consistently, in `execution-candidates.ts`'s code comments — the two agree exactly and one clearly derives from the other (code implements the ADR's distinction).
- **Stale duplicate (narrow)**: The `prisma/schema.prisma:1447-1449` comment about Dispute non-reopenability is stale relative to `appeal()`'s actual behavior in the same codebase (F-05) — a genuine stale duplicate of intent, though narrow in blast radius.
- **No dangerous redefinition found.** No instance was found of two documents defining the same term with materially different meanings (the closest candidate — "Eligibility" appearing in both ADR-002 §6's multi-factor sense and the narrower arbiter-dispatch sense used in `dispute.service.ts` et al. — was checked and found to be consistent: the narrower usages never claim to satisfy ADR-002 §6's full definition, they use "eligible" colloquially for a much narrower dispatch-gate check, and `execution-candidates.ts` explicitly disclaims the broader meaning).
- **Implementation mirror, not duplication**: `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` and `docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` cover overlapping ground (unknown-outcome handling on the WDK rail) from two angles (retry safety vs. general fund-moving safety) — this reads as intentional angle-splitting, not redundant duplication, but was not independently verified line-by-line in this pass; flagged for a lighter-weight future check if either document is next edited.

---

## 7. Contradiction Map

Real contradictions only — different abstraction levels are excluded unless they actually conflict.

- **F-05** (Dispute non-reopenability comment vs. `appeal()`'s actual reopening behavior) is the only finding in this report that rises to a genuine, if narrow and low-severity, contradiction between a stated claim and observed code behavior.
- No contradiction was found between any two RFCs, any two ADRs, or between `PROTOCOL_INVARIANTS.md` and any RFC/ADR.
- No contradiction was found between Product-facing documentation and the Authority/Eligibility findings in Pillars D/E — Product docs (`PRODUCT_INTERACTION_MODEL.md`'s Authority Matrix) correctly state the same "capability ≠ authority," "no global admin role" facts the code inventory independently confirmed.
- The RFC-021 status/implementation mismatch (F-01) is **not** classified as a contradiction — it is a sequencing/process-gate violation, not two sources disagreeing about a fact.

---

## 8. Open Obligations Discovered

No prior OPEN obligation was found to have silently disappeared during this inventory. Cross-checking BACKLOG item 40 (versioning Decision Mission), the RFC-021 status field, the two preserved preliminary findings (Harness, Issue #99), and the disclosed residual gaps (F-06, INV-OP-9's "genuinely open" construction-sharing item) confirms all remain visible in their existing homes. New obligations surfaced by this mission, restated for backlog visibility:

1. F-01 — RFC-021 retroactive governance Decision gate.
2. F-02 — Sails Engineering Harness canonicalization decision (unresolved candidate, carried forward).
3. F-03 — Offer lifecycle guard Product Decision.
4. F-07 — `EscrowPendingTransaction` crash-window investigation.
5. F-08 — Session revocation hardening (highest-priority new item in this report).
6. F-09 — `IntentEvent` chain-scope cross-reference.
7. F-10 — Issue #99 sequencing correction (unresolved candidate, carried forward).
8. F-11 — `protocolVersion` reinforces existing BACKLOG item 40; no new tracking needed, only continued visibility.
9. INV-OP-9's own "genuinely open" item — shared wallet-side PSBT construction primitive — already tracked in `PROTOCOL_INVARIANTS.md` itself; restated here only for cross-mission visibility, not newly discovered.

---

## 9. Proposed Sequencing

Per instruction, this report does not begin another mission and does not recommend a specific next mission. For CTO awareness only, in rough order of what would need deciding before it could become one:

1. Findings F-08 (session revocation) and F-01 (RFC-021 governance gate) are the two items in this report with real, if differently-flavored, stakes — one security-shaped, one process-shaped — and would be the natural first candidates for a future scoped mission, if the CTO chooses to open one.
2. F-02 and F-10 remain exactly as flagged before this report was compiled: unresolved evidence candidates, not decided, not sequenced.
3. All other findings (F-03 through F-12, excluding F-08/F-10 above) are either already correctly disclosed (F-04, F-06), trivial defects (F-05), or already tracked under an existing BACKLOG item (F-07, F-09, F-11, F-12) and do not, on their own, warrant a new mission.

---

## 10. Stranger Developer Test — Applied

Reading the repository as an external developer with no access to this session's history:

- **Object meaning**: Discoverable for Asset/Rail/Scope/Adapter/Provider (ADR-002), Intent (PROTOCOL_SPECIFICATION.md + state-machine.ts), Escrow (PROTOCOL_INVARIANTS.md + escrow-lifecycle.ts). **Not reliably discoverable** for Offer (no doc states its lifecycle is intentionally unguarded) or EscrowPendingTransaction (no doc at all).
- **Permitted actions / authority**: Discoverable via `PRODUCT_INTERACTION_MODEL.md`'s Authority Matrix and `PROTOCOL_INVARIANTS.md`'s INV-01/INV-02/INV-12 — this is a genuine strength; two independent developers reading these would very likely reach the same conclusions.
- **Lifecycle**: Discoverable and precise for Escrow, Intent, IdempotencyKey, WdkTransferAttempt. Would require reading `escrow-lifecycle.ts` directly (not a doc) to learn the "claim-before-execute" pattern by name — no doc names this pattern, only recognizable by cross-referencing multiple files.
- **Eligibility / retry / failure semantics**: The Structural Compatibility ≠ Eligibility distinction is unusually well-preserved and would survive a stranger's reading; a stranger relying on `protocolVersion`'s presence to infer live version-gating would be actively misled unless they also found `capability-profile.ts:14-21`'s disclaimer.
- **FROZEN vs. OPEN**: `PROTOCOL_INVARIANTS.md`'s dated disclosure blocks make this unusually clear for protocol-level invariants. It is **not** clear for RFC-021 (its "Proposed" status label actively signals OPEN while its behavior is FROZEN-and-shipped) — this is the single clearest Stranger Developer Test failure found in this inventory, directly evidencing F-01.
- **Would two independent developers reach the same interpretation?** For most of Pillars A, C, D, F, G: yes, with high confidence, given the density and consistency of `PROTOCOL_INVARIANTS.md`. For Pillar B's Offer-lifecycle question and Pillar H's version-concept count: likely not, without independently re-deriving the gaps this report just made explicit.

---

## Executor Self-Audit

1. *Did I create a gap because I failed to search deeply enough?* Mitigated by combining three independent parallel research passes (this session's own direct reading of `PROTOCOL_INVARIANTS.md` in full, plus two dedicated Explore agents covering Business Rules/Lifecycle and Authority/Eligibility and Evidence/Versioning/Interface separately) before writing any finding.
2. *Did I confuse absence of a document with absence of a rule?* Checked explicitly for each ABSENT classification — e.g. F-08's session-revocation ABSENT is a grep-confirmed absence of the mechanism itself, not merely absence of a document describing it.
3. *Did I confuse implementation with institutional truth?* This is the report's central organizing question; F-01 and F-11 are direct instances of naming this distinction rather than collapsing it.
4. *Did I confuse healthy repetition with dangerous duplication?* Section 6 explicitly distinguishes healthy reference from stale duplicate and found only one narrow stale duplicate (F-05), not a pervasive pattern.
5. *Did I confuse different abstraction levels with contradiction?* Section 7 explicitly excludes ADR/RFC/PROTOCOL_INVARIANTS.md layering from being called contradictory, finding only one genuine contradiction.
6. *Am I proposing standards merely for symmetry?* No new standard is proposed anywhere in this report; Section 5 states this explicitly as a finding in itself.
7. *Am I importing complexity from another system?* No external framework or foreign vocabulary was introduced; all classifications use only the mission's own A–J scheme and the repository's own existing terms.
8. *Am I silently reinterpreting a frozen decision?* No frozen ADR/RFC/invariant was reopened or reinterpreted; F-01 recommends a governance *process* action (run the existing gate), not a substantive reinterpretation of RFC-021 itself.
9. *Should any finding land in backlog/issue/evidence?* Section 8 restates every new obligation for backlog visibility explicitly.
10. *Did any old OPEN obligation disappear?* Checked and confirmed none did (Section 8, opening sentence).
11. *Does any conclusion depend on privileged internal knowledge?* Every finding cites a specific file/line/comment a stranger could independently locate; Section 10 (Stranger Developer Test) was applied specifically to catch this failure mode.
12. *Could a stranger reproduce my reasoning from the repository alone?* Yes for the great majority of findings (each cites exact file:line evidence); the two exceptions are F-02 and F-10, which by their nature depend partly on this session's own continuity — both are flagged as preserved-unresolved rather than asserted as independently-reproducible findings, which is the honest disposition for them.

---

STOP. Awaiting CTO Gate.

---
---

## POST-REPORT EVIDENCE ADDENDUM

**Added 2026-09-14, after the initial CTO Gate response above.** Everything from "1. Executive Finding" through the original "STOP. Awaiting CTO Gate." line is the original report, unmodified. Nothing below changes any finding's text, classification, severity, or status as originally written. This addendum only (a) attaches the F-08 deep-dive evidence the CTO Gate specifically requested, (b) records two small clarifications the CTO Gate flagged for precision (F-02, F-10), (c) re-verifies no material fact in the original report has been superseded by subsequent repository activity, and (d) attaches a non-authoritative candidate debt-taxonomy mapping for Issue #158. Where this addendum's evidence sharpens a finding's framing, the original finding text is left as-is and the sharpening is stated here as additional context, not a silent rewrite.

### A1. F-08 — Full Negative-Evidence Search, By Dimension

Re-run and expanded per the CTO Gate's explicit request for stronger evidence on an absence-claim. All paths relative to repo root.

- **Authentication issuance** — Real. `src/common/middleware/auth.ts:43-52` `issueChallenge()`; `:59-108` `verifySignedChallenge()` (Ed25519, one-time-burn nonce via `nacl.sign.detached.verify`, `:70-74`).
- **Token/session validation** — Real, minimal. `auth.ts:143-155` `requireAuth()` — reads `Authorization: Bearer <token>`, looks up `auth:session:<token>` in Redis, attaches `participantId` if found. No revocation-list or denylist check exists for it to consult.
- **Persistence** — Redis only, not durable/DB-backed. `SESSION_PREFIX = 'auth:session:'` (`auth.ts:33`), value = `user.id`, set with `EX config.auth.sessionTtlSeconds` (`auth.ts:94-100`).
- **Expiry** — TTL only. `src/config/index.ts:182` — `sessionTtlSeconds: requiredInt('AUTH_SESSION_TTL', 3600)` (1 hour default). The only mechanism that ever ends a session.
- **Logout** — Exists, client-side only. `packages/sails-ui/src/context/AuthContext.tsx:248-260` `logout()` calls `sailsClient.setSessionToken(null)` (`packages/sails-sdk/src/transport.ts:132`, clears the transport's in-memory field) and clears local React state. It calls no server endpoint. Confirmed by a full read of `src/modules/open-identity/identity.routes.ts`: the complete route list is `/v1/identity/participants` (POST), `/v1/identity/participants/:id` (GET), `/v1/identity/challenge` (POST), `/v1/identity/authenticate` (POST), `/v1/identity/me` (GET), `/v1/identity/ws-ticket` (POST) — no `/logout`, no `DELETE`-style session route, nothing that touches the Redis key server-side. A token survives a UI "logout" until its TTL naturally elapses.
- **Revocation** — Absent for sessions. The only real `revoke()` in the codebase is `src/core/capability-registry.ts:83-93`, which revokes a `CapabilityGrant` row — a distinct concept (permission scope), unrelated to session identity. `Grep` for `revoke|invalidat` across `src/` (whole tree, not just `open-identity`) returns only capability-grant revocation, reorg-evidence invalidation (`REORGED_INVALIDATED`), and PSBT/fee-policy rotation hits — zero session-token hits.
- **Rotation** — Absent. No mechanism issues a replacement token for an already-live session; a new token only comes from a fresh `/challenge` → `/authenticate` round trip (re-authentication), not rotation of a live one.
- **Invalidation** — Same finding as revocation: none beyond TTL.
- **Middleware** — `requireAuth()` (`auth.ts:143-155`) is the sole gate and performs a pure Redis-existence check; no blacklist/denylist structure exists anywhere in the codebase for such a middleware to consult even in principle.
- **Session recovery/re-entry** — The one area with real, extensive design, but answering a different question. `docs/PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md` §7 ("Session and Re-Auth Model") and §15 (the `onSessionExpired` SDK hook, `packages/sails-ui/src/lib/sessionEpochGate.ts`, return-path continuity via `Login.tsx`) are a carefully built client-side UX layer for *reacting to* an already-ended session (expiry or a 401). This is adjacent to, but does not answer, whether a session can be ended early and deliberately before its own TTL.
- **Tests** — `tests/routes.test.ts:334-336` defines a stub `authedSession()` helper that writes directly to the Redis key (bypassing real challenge-response) and is used across roughly 80 route-level tests to exercise `requireAuth()`'s **positive** path (a valid token is accepted). `packages/sails-ui/tests/sessionEpochGate.test.ts` tests the client-side epoch-gate's race handling around logout/expiry. No test exists for server-side session revocation, because no code path exists for such a test to exercise.

**What exists**: real challenge-response authentication, a real TTL-bounded Redis session store, a real single-use WS-ticket derivation (`issueWsTicket`, `auth.ts:126-135`), and a genuinely well-built client-side expiry/re-auth continuity layer.
**What does not exist**: any mechanism to end a session before its TTL elapses — no logout endpoint, no revoke, no rotation, no denylist.
**Compensating control**: only the 1-hour default TTL bounds the exposure window. This is a generic mitigation, not a documented one — `docs/SECURITY_MODEL.md` was searched directly for session-token-theft/replay framing (`token theft`, `stolen token`, `hijack`, `compromised session`, case-insensitive) and returned no match; no document anywhere names session-token theft/replay as an accepted, mitigated risk, and none names short TTL as a deliberate compensating control for it.
**Is the property required by current Product/Protocol truth?** No document (searched `SECURITY_MODEL.md`, `PROTOCOL_SPECIFICATION.md`, `PROTOCOL_INVARIANTS.md`, `PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md`) states a requirement that a user must be able to terminate their own session, or that a compromised session token must be revocable. The requirement is exactly as unaddressed as the mechanism.

**Preserved split, per CTO Gate instruction, not collapsed:**
- **Session revocation absence** — evidence-backed, undisclosed. Nothing in the repository names this as a known, accepted gap the way the sibling item below is named. Classification stands as **F** (maturity underclaim / hidden capability gap) — frozen by CTO Gate as **F-08A**.
- **Key rotation / renewal absence** — a *different* gap, explicitly disclosed. `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md:302-307` states directly: "Key rotation, revocation, and recovery for a compromised identity key are OpenIdentity territory, not addressed here" — a named, scoped, deliberate deferral with an identified future owner (OpenIdentity). Classification stands as **G** (legitimate, disclosed deferral). This finding is not re-opened or altered by this addendum; it is restated here only to keep the split visible in the same place as F-08A's expanded evidence.

### A2. F-01 — Additional Corroborating Evidence (RFC-021's Own Text)

Re-reading `docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md` directly (lines 27-31 and 835-843) for this addendum found that the RFC **already states the exact mismatch this report calls F-01, in its own voice**, verbatim:

> "**Status:** Proposed — formal acceptance (`GOVERNANCE.md` §6A review step) has not happened yet, though as of 2026-08-02 every phase in 'Reference Implementation Plan' below (D1 through D9, no remaining deferred item) is implemented, tested, and committed; 'Proposed' describes governance status, not build status — see that section for what's actually real." (lines 27-31)

> "**Status as of 2026-07-29: all five phases below are implemented and committed**... kept below with real ✅ status per this repo's convention (`docs/DEVELOPER_JOURNEY.md`) so the history of what was proposed vs. what shipped stays visible, not overwritten." (lines 835-843)

This does not change F-01's classification or severity. It sharpens the finding's framing in exactly the direction the CTO Gate asked to check: the RFC text itself already distinguishes governance status from build status explicitly and by name, rather than conflating them or silently letting one imply the other. F-01's real, still-open content is narrower than "someone is hiding that this shipped before acceptance" — it is "the project's own governance gate (`GOVERNANCE.md` §5/§6A Decision step) has still never been formally exercised for this RFC, more than six weeks after the RFC's own text flagged that exact gap." Re-verified for this addendum: `grep '^\*\*Status' docs/rfcs/RFC-021-*.md` still returns "Proposed" as of 2026-09-14 — no subsequent commit has changed it. F-01 stands, unresolved, with neither side assumed to win.

### A3. F-02 — Precision Clarification (Not An Overstatement Correction)

A repository-wide search for the exact string `Sails Engineering Harness` (not limited to `docs/`, covering `src/`, `tests/`, `packages/`, and re-run for this addendum) returns exactly **two** files: `docs/MINIMUM_BLOCKING_DECISIONS_PRODUCT_UI_RETURN.md` (the document that uses the methodology) and `docs/FOUNDATIONAL_RULES_STANDARDS_INVENTORY.md` (this report, describing the finding). A search of open/closed GitHub issues for the same string returns zero results.

This is a useful precision the original report's PRESENT_BUT_DISPERSED-adjacent language did not make sharp enough: the correct status is not "dispersed" (which would imply the term recurring, independently, across multiple locations that converge on a shared meaning) but a **single, isolated, self-referential invocation** — the methodology is used exactly once, in one document, and never defined anywhere, including in that same document. The original finding's substance (zero canonical definition exists) is unchanged and not overstated; this addendum only sharpens "dispersed" to "singular and undefined," which is if anything a narrower, more conservative claim than dispersion would imply. Status remains an unresolved evidence candidate, not adjudicated by this addendum.

### A4. F-10 — Distinguishing Stale Metadata From Protocol/Architecture Contradiction

Re-fetched Issue #99 for this addendum (`gh issue list --search "..."` and direct issue state check): still **OPEN**, title unchanged ("[CTO MEMORY] Day-0 decentralized nodes, shared liquidity & production sequencing"). To make explicit what Section 7 (Contradiction Map) of the original report already implied but did not say in so many words: **F-10 is a continuity-tracking metadata drift, not a protocol or architecture contradiction.** No protocol behavior, RFC, ADR, or invariant conflicts with any other — the only thing that has drifted is Issue #99's own internal narrative of "what step comes next," which lags behind work (`docs/BACKLOG.md` item 41, closed by PR #154) that has already happened. This is the same category of finding as a stale TODO comment, scoped to a governance-continuity artifact rather than to code — real, worth correcting, but categorically distinct from a finding like F-05 (a comment whose claim actually conflicts with the code's own behavior). F-10 remains an unresolved evidence candidate, not corrected by this addendum.

### A5. Cross-Check Against Subsequent Repository Activity

Per the CTO Gate's instruction to check every claimed absence against docs, implementation, tests, issues, RFCs, ADRs, backlog/roadmap, and recent merged PRs: the ten most recently merged PRs at the time of this addendum (#143 through #157, spanning 2026-09-13 19:59 to 2026-09-14 22:06) were reviewed by title and, where titles were ambiguous, by content already known from this session's own prior work on them. None touch session/logout/revocation, RFC-021's governance status, Offer lifecycle transitions, or `EscrowPendingTransaction`. `docs/BACKLOG.md` was searched directly for `session`, `revocation`, `logout` (case-insensitive) and returned zero matches — confirming F-08A is genuinely untracked anywhere in the backlog, not merely omitted from this report's own reading of it. No material fact in the original F-01–F-12 findings has been superseded by activity since the original report was written.

### A6. Non-Authoritative Candidate Debt-Taxonomy Mapping (Issue #158)

Issue #158 was read directly for this addendum (not assumed from the CTO Gate message alone) to confirm its actual taxonomy before mapping anything to it. Its candidate categories, verbatim: Technical Debt, Architectural Debt, Institutional Debt, Semantic Debt, Product Debt, Evidence Debt, Operational Debt, Integration/Interoperability Debt, Human Interface/UX Debt — explicitly stated by the issue itself as "initially directional," to "be validated by the Foundational Inventory before becoming canonical," with the instruction "do not create categories merely for symmetry." Issue #158 also proposes a three-value disposition vocabulary (`RESOLVE_NOW` / `REGISTER_DEFER` / `NOT_DEBT_EXPECTED_TRADEOFF`), explicitly not yet frozen.

The mapping below is evidence for Issue #158's own future institutionalization mission. It is not canonical, does not retrofit every finding into the taxonomy for symmetry, and assigns no finding a category it does not clearly fit — several findings receive no confident category, which is itself information, not an omission to fix.

| Finding | Candidate debt categor(y/ies) | Rationale | Candidate disposition (non-binding) |
|---|---|---|---|
| F-01 | Institutional Debt | A governance acceptance gate was never exercised for an already-shipped Core RFC — the gap is procedural/institutional, not in the code or the architecture itself. | `REGISTER_DEFER` pending a governance action (run or formally waive the gate) |
| F-02 | Institutional Debt | A methodology is invoked as binding without ever being canonically written down anywhere. | Unresolved evidence candidate — no disposition proposed |
| F-03 | Architectural Debt (candidate); possibly Product Debt | Missing state-machine guard is an architectural gap; whether it matters depends on a Product answer not yet given. | `REGISTER_DEFER` pending Product Decision |
| F-04 | NOT_DEBT_EXPECTED_TRADEOFF | Already disclosed, already gated by a fail-closed production boot check — matches Issue #158's own "expected tradeoff" disposition, not debt. | `NOT_DEBT_EXPECTED_TRADEOFF` |
| F-05 | Semantic Debt | A comment's stated meaning and the code's actual behavior diverge in a narrow, low-stakes way — a meaning mismatch, not a behavioral one. | `RESOLVE_NOW` candidate (trivial fix) — not performed by this evidence-only mission |
| F-06 | Architectural Debt, disclosed | A real destination-authority bypass for four rail types, already named and scoped in `DESTINATION_AUTHORITY_ARCHITECTURE.md`. | `REGISTER_DEFER` (already in effect) |
| F-07 | Technical Debt / Architectural Debt (candidate) | A staging object with no status field, ambiguous crash-window behavior — genuinely uninvestigated rather than confidently classified. | Unresolved — investigation precedes disposition |
| F-08A | Evidence Debt + Operational Debt (candidate, dual) | The gap is invisible (no doc discloses it — Evidence Debt) and it is a live, missing operational capability (no revoke path — Operational Debt). Issue #158's taxonomy has no dedicated security-debt category; this finding sits at the intersection of the two closest fits. | Flagged for security-review priority, not yet dispositioned |
| F-08 (rotation) | NOT_DEBT_EXPECTED_TRADEOFF | Already disclosed, named, scoped to a future owner. | `NOT_DEBT_EXPECTED_TRADEOFF` (as currently scoped) |
| F-09 | Evidence Debt (minor) | A real capability exists but its scope is under-cross-referenced, risking a broader-than-true reading. | `RESOLVE_NOW` candidate (one-line cross-reference) — not performed by this evidence-only mission |
| F-10 | Institutional Debt | A continuity-tracking artifact's narrative has drifted from actual completed work — see A4 above distinguishing this from any protocol contradiction. | Unresolved evidence candidate — no disposition proposed |
| F-11 | Semantic Debt + Integration/Interoperability Debt (candidate, dual) | A field named `protocolVersion` implies live version-gating it does not perform (semantic mismatch); an external implementation reading the schema without also reading the disclaiming comment would be misled (interoperability-relevant). | `REGISTER_DEFER` (already in effect via BACKLOG item 40) |
| F-12 | Human Interface / UX Debt (candidate) | Real design substance exists but is not indexed under conventional names — an inventory-only finding per this mission's own Pillar J instruction. | Unresolved — inventory only, no disposition proposed |

No new debt category was created. No finding was force-fit where the evidence did not clearly support a category (F-02, F-07, F-10, F-12 are left partially or fully unresolved in this mapping rather than assigned a confident disposition).

### A7. CORRECTION TO A3 — Issue #155 Was Missed By The Original F-02 Search

**Added later on 2026-09-14, after A1-A6 above were already written and sent for inspection.** This is a self-correction, not a silent edit: A3's claim above ("exactly two files repo-wide... a single, isolated, self-referential invocation... never defined anywhere") is now known to be **incomplete**. A3 is left standing, unedited, as a record of what was claimed and when; this section states what changed and why.

**What was missed and why.** The original F-02 investigation and A3's repeat of it both searched repository *files* (`grep`/ripgrep across `docs/`, `src/`, `packages/`, `tests/`) for the literal string "Sails Engineering Harness," and separately ran `gh issue list --search "Sails Engineering Harness"` as an exact-phrase GitHub issue search, which returned no matches. A later, broader, unfiltered `gh issue list` call (run for an unrelated reason, in the background, without a search-string constraint) surfaced issues that the exact-phrase search had not — including **Issue #155**. This means the GitHub issue search filter used for F-02 either applied stricter phrase-matching than intended or was not exercised broadly enough; either way, the correct lesson is procedural: **an exact-phrase issue search is not a reliable substitute for confirming an absence** — this is now itself additional evidence for the F-08-style principle that absence claims need broader, more redundant search coverage than positive claims, applied here to a different finding than the one it was first learned from.

**What Issue #155 actually contains.** `gh issue view 155` (state: OPEN, created 2026-09-14T18:56:31Z, title: "[Architecture] Sails AI Harnesses — Engineering Harness, QVAC Runtime Harness & AI Governance Contract") contains a full section, verbatim heading `## 1. Sails Engineering Harness`, stating: "The Sails Engineering Harness governs **how AI participates in the development of Sails**. This already exists partially in practice and should be treated as an explicit architecture/governance surface rather than as a collection of prompts." It then lists current elements, including — verbatim — `MISSION → EVIDENCE → CTO GATE → FREEZE → BACKLOG DELTA → PROJECT SYNC → NEXT MISSION` (the same cycle named, without further definition, in `docs/ENGINEERING_GOVERNANCE.md` §16.20), plus "claim/evidence separation," "tests and CI as evidence, never protocol truth," "blind-spot / Goodhart / Cobra / Rube-Goldberg checks," "Stranger Developer / independent integrator testing," and "human/CTO authorization before institutional freeze" — several of which are the exact named disciplines this inventory mission itself was asked to apply.

**What this changes, precisely.** The issue explicitly states, in its own "Purpose" section: "This issue does **not** authorize implementation. It records the properties and boundaries that a future dedicated mission must refine and freeze." It is a discovery/proposal issue, open, unfrozen, and itself says a canonical definition does not yet exist — it does not contradict F-02's core claim that no *frozen, canonical* definition of the Sails Engineering Harness exists. What it does contradict is **A3's specific claim of a single, isolated, undefined invocation** and, by extension, the original report's framing that leaned toward ABSENT. The corrected status is:

- **F-02's core substance stands**: no frozen, canonical definition exists anywhere, and the term is still used as if binding in CTO mission briefs without that canonical backing.
- **A3's search-completeness claim was wrong and is superseded by this section**: there are at least three loci, not one isolated self-referential invocation: (1) `docs/MINIMUM_BLOCKING_DECISIONS_PRODUCT_UI_RETURN.md`, which uses the methodology; (2) **Issue #155**, an open architecture issue partially describing and listing the Harness's current elements, explicitly deferring formal freezing to a future mission; (3) this report, describing the finding.
- **Corrected status classification: PRESENT_BUT_DISPERSED / IN-PROGRESS, not ABSENT.** This is materially different from "zero canonical definition anywhere" — an institutional process to define it has already been opened, by the same actor who raised this CTO Gate, the same day as this mission. This is the precise distinction the CTO Gate's F-02 special review flag asked this report to get right, and the original report (plus A3) did not get it fully right until this correction.
- Also directly relevant to Issue #158 (the debt-taxonomy issue): Issue #158's own body states it is scoped to become part of "the Sails Engineering Harness," presupposing the same not-yet-canonical concept Issue #155 is trying to define — i.e., #155 and #158 are already two open, related, not-yet-reconciled institutional threads on the same undefined term, which is itself additional evidence for F-02's underlying concern (methodology invoked as if settled, ahead of being formally defined) even as it corrects the "isolated invocation" framing.

**Not resolved by this correction.** Per every instruction so far in this mission: this correction does not canonicalize the Harness, does not merge Issue #155 into a standard, does not modify `ENGINEERING_GOVERNANCE.md`, and does not close or edit Issue #155 or #158. F-02 remains an unresolved evidence candidate — now with more accurate, and more complete, evidence than either the original report or A3 had.

### A8. CTO GATE R1 SUPERSESSION — F-08 Classification Update

**Added after CTO Gate R1.** The original F-08 finding text (line 258 above) and A1's full negative-evidence search are preserved unedited as historical record. This section records a classification update the CTO Gate made after reviewing that evidence, without rewriting either.

**The distinction the CTO Gate drew, stated precisely:**

> Client Logout ≠ Server Session Revocation
> Local Session Exit ≠ Credential Invalidation

A1 already established the facts this rests on (`AuthContext.tsx`'s `logout()` only clears local state and the transport's in-memory token field; no server endpoint is ever called; the Redis-stored session token remains valid until TTL). The CTO Gate's correction is to the **classification**, not the facts: this report's original A–J label for F-08A — **F** (maturity underclaim / hidden capability) — implies a capability quietly exists but is withheld or under-surfaced. That is not what this is. No hidden capability exists anywhere in the code; the capability itself was never built. The A–J scheme, designed for *protocol/business-rule* findings, does not have a clean slot for "a foundational operational capability was never built and its absence was never named" — which is a fair reason to look past it here rather than force a fit.

**Superseding interpretation (CTO Gate, not adjudicated by the executor):** F-08A is better described by debt category than by the A–J letter scheme — **Security Debt, Institutional Debt, and Operational/Auth Debt**, simultaneously. This refines, and narrows, A6's own dual "Evidence Debt + Operational Debt" tag (row `F-08A` in A6's table above) — that tag stands as this executor's own candidate mapping; the CTO Gate's three-category framing is recorded here as the authoritative interpretation going forward.

**What is reaffirmed:** the absence is real; it is undisclosed (no document anywhere names it as an accepted gap, unlike its key-rotation sibling); it is pre-production relevant; and it is bounded only by the default 1-hour TTL today — nothing here is walked back from A1.

**What is corrected:** the original F-08 text's implicit framing that an Architecture Decision is the obvious next step is **not preserved as this report's forward-looking claim**. Per the CTO Gate: an Architecture Decision must not be assumed automatically required. The missing property, stated precisely and mechanism-independently:

> **An authenticated session must have an explicit institutional answer for whether and how it can be invalidated before natural expiry.**

A future mission may find the smallest correct fix is a simple server-side revocation endpoint, or may find broader architecture consequences once investigated — property first, mechanism second. This report does not pre-select which.

**Preserved, not collapsed, per explicit instruction:** key rotation/renewal remains a *separate*, already-disclosed deferral (`DESTINATION_AUTHORITY_ARCHITECTURE.md:302-307`, named OpenIdentity territory) — untouched by this supersession, and not merged into F-08A's debt classification above.

### A9. ERRATA / SUPERSESSION MAP

A dedicated index so a future reader does not have to reconstruct which original statements were later refined, and from where. This map does not erase or edit any original statement; every row points to the addendum section that carries the full correction.

**Current authoritative status, at a glance:**

- **F-02**: `PRESENT_BUT_DISPERSED / IN-PROGRESS`. Harness absent = **false**. Harness fully canonical/frozen = **false**. Harness partially institutionalized and awaiting formalization = **true**. (Evidence: Issue #155 explicitly defines the concept and states it "already exists partially in practice," but the same issue explicitly defers formal Architecture Discovery/freeze to a future mission — see A7.)
- **F-08A**: session revocation is absent, real, undisclosed, and pre-production relevant — reclassified by CTO Gate as Security Debt / Institutional Debt / Operational-Auth Debt rather than the original A–J letter **F** — see A8. No Architecture Decision is assumed required; the missing *property* is named, the mechanism is left open.
- **F-10**: continuity-metadata drift in Issue #99's own internal sequencing narrative — explicitly not a protocol/architecture contradiction (no invariant, RFC, ADR, or code path conflicts with any other) — see A4.

| Original item | Later evidence | Current interpretation |
|---|---|---|
| F-02 / A3 | A7 (Issue #155) | `PRESENT_BUT_DISPERSED / IN-PROGRESS` — not ABSENT, not canonical/frozen |
| F-08 / F-08A | A1 (full negative-evidence search) + CTO Gate R1 | Session revocation absent, real, undisclosed; Security + Institutional + Operational/Auth Debt (not the original letter **F** classification); key rotation remains a separate, disclosed deferral, unaffected |
| F-10 | A4 | Continuity-metadata drift in a governance-tracking artifact, not a protocol/architecture contradiction |
| HARNESS-01 | This mission's own evidence-delivery sequence (direct-file-transfer attempts not independently inspectable from the CTO's environment; corrected by PR #159) | Evidence used for a gate must be independently inspectable by the gatekeeper through a durable, reproducible location — validated finding, candidate property for future Harness institutionalization, not yet written into `ENGINEERING_GOVERNANCE.md` |

Nothing in this section modifies F-01 through F-12's original text, A1 through A7's original text, or any RFC, ADR, Issue, or governance document. It is an index layered on top of an unedited history.

---

END OF POST-REPORT EVIDENCE ADDENDUM (A1-A9).

STOP. Awaiting full CTO Gate.
