# Master Backlog — Current Reality & Closure Ledger (initial baseline)

> 2026-10-24 CTO reconciliation proposal. **Inventory in progress, NOT exhaustive.** This document is an index of live owners and gates, not a new source of protocol authority. Do not calculate global completion percentage until all Master obligations are normalized, deduplicated and individually classified. Read with docs/BACKLOG.md, accepted ADRs, code and exact-SHA evidence.

## Current position

- Protocol v1 architecture freeze: historical completion recorded in BACKLOG; not production approval.
- Implementation/reliability/security hardening: active, with open economic, temporal, recovery, network and security owners.
- Master closure: **NOT PROVEN**; global numerator/denominator **NOT AUDITED**.
- Beta/Day-0/production: **NO-GO** absent independently evidenced gates.
- P4 Gate 3 PR #525: DRAFT / NO MERGE / NO DEPLOY / NO SHARED-DB MIGRATION. Head 728ab00e83653b4f37b88facb9bdceb5bed4de65; workflow 40145591634 CI success; independent acceptance and order-sensitive suite isolation review pending. The executor's ~95% applies to this bounded mission only.

## Active owner / evidence map (not a closure claim)

| Domain | Canonical owner | What remains to establish | Current classification |
| --- | --- | --- | --- |
| CTO operating memory / continuity | #221, #99 | Reconcile handoff with current issues, code and decisions | Institutional record |
| Day-0 multi-operator, shared market | #105, ADR-001 | 25 network/operator obligations and independent external proofs | Day-0 gate OPEN |
| Partner integration and economic reality | #165 | Scenario-level PASS/FAIL/BLOCKED, independent wallet, real recovery | Beta gate OPEN |
| Production mocks/stubs/fallbacks | #220 | Production-surface proof and exclusions | Day-0 audit OPEN |
| Continuous gap discovery | #500 | Evidence-backed gaps with canonical ownership | Gatekeeper OPEN |
| P2P timers, no-show, risk and lifecycle | #293, #256 | State-by-state timeout/authority/restart matrix | Day-0 audit OPEN |
| Security / adversarial / dependencies | #297, #304, #461 | Reachability, fixes, exact SHA, remaining vulnerability evidence | Day-0 security OPEN |
| Relay client / DHT parity / limits | #497, #498, #499 | Real TCP E2E, functionality and scoped resource bounds | Day-0 OPEN |
| P4 Gate 3 disputed re-creation | PR #525, #436 | Independent review; targeted suite-isolation acceptance; migration decision | YELLOW, draft |
| P3 self-host and P4 chain | PR #512/#515/#516/#519/#521, #523/#525 | Recheck current branch/PR states and independent gates; no inferred closure | REVALIDATION REQUIRED |
| Documentation truth | #125; #275 closed historical | Reconcile GitHub/Mintlify/GitBook and present-day claims | Day-0 gate OPEN |
| Design/reference products | #217, docs/REFERENCE_IMPLEMENTATIONS.md | UI must represent, not invent, protocol truth | Prework / gated |
| Incident corpus and adversarial rehearsal | #420, #77 | Corpus → Red Team → live economic rehearsal | Beta sequence OPEN |
| Scale/integrator readiness | #473 | Model and evidence at realistic workloads | Discovery, no architecture authorization |
| Post-Master security research | #487, #123 | Do not defer Day-0 blockers | Discovery |
| SDK/adapters/platforms | #75, #86, #78 | Capability-specific conformance and maturity | Horizon, not shipped by issue |
| Extension lifecycle | #152 | Lifecycle and runtime eligibility design | Discovery only |
| AI harness / debt governance | #155, #158 | Authority boundaries, truth/debt lifecycle | Discovery/governance |
| Private markets / bootstrap fleet | #147, #361 | Hosting ≠ membership/authority; fleet ≠ independent operators | Product/architecture direction |
| Taproot and arbiter economics | #121, #438 | Research before design freeze | Future discovery |
| QVAC upgrade / routing watch | #84, #124 | Trigger-based re-entry; no auto upgrade | Radar |

## Exact closure ledger schema

For every Master obligation record: `Stable ID | normative owner | stage | Day-0 or later | status | blocker | PR/commit SHA | CI | independent evidence | acceptance authority | next action | last checked`.

Statuses: `NOT INVENTORIED / OPEN / IMPLEMENTING / EVIDENCE PENDING / ACCEPTED / BLOCKED / DEFERRED WITH OWNER`. Only ACCEPTED with a named gate and verifiable evidence contributes to completion. No counting headings, historical statements, merged PRs or tests as accepted obligations by default.

## Mandatory next reconciliation loop

1. Enumerate every current Master obligation and historical correction; establish denominator.
2. Join live issues, PRs, comments, accepted ADR/RFC, code and CI at exact SHA.
3. Identify unowned audits, duplications, stale claims, unresolved blockers and test/environment gaps.
4. Produce issue/PR-level closure ledger and evidence-based completion percentage.
5. CTO review and freeze documentation only; separate implementation/migration/deploy approvals.

## Release sequence

Master Backlog closure → Reality Validation → SDK/Adapter Conformance → Asset × Network × Rail × Adapter × Capability Matrix → Day-0 Economics/Providers/Nodes/UI → Incident Corpus → Adversarial Red Team → Regulatory Control Review → Live Economic Rehearsal → RC/Beta. Staging/VPS evidence must be scheduled within the appropriate dependency gates; deploying a server does not itself satisfy readiness.

**Hard stop:** No merge/deploy/shared-DB migration/production authorization is granted by this document.

## Reconciliation sweep — 2026-10-24: indexed Day-0 issue candidates

This is a **search-derived index of 53 open issues matching the phrase Day-0**, not a count of all Master obligations or proof each is a Day-0 release blocker. GitHub issue search is lexical and includes discovery, future and institutional-memory issues. **Issue OPEN ≠ implementation absent; PR merged ≠ independently accepted.** Classify each entry against normative Master/ADR, latest comments, linked PR and exact-SHA tests before assigning its gate.

| Issue | Title | Verified issue state / evidence status |
| --- | --- | --- |
| #undefined | [Day-0 Security] Bound production observability and readiness disclosure | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Recovery] Arbiter disappearance after economic commitment | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Discovery] Production P2P Benchmark & Missing Behavior Sweep | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Bound authenticated WebSocket relay resource consumption | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] AI-era public repository adversarial security audit | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Testability] Production-isolated signature-collection test rail | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Institutional Alignment — Day-0 truth across GitHub, Mintlify and GitBook | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0] Multi-Operator Network + Partner Beta Completion Gate | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Evidence] Production EvidenceProvider contract and durable object storage | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Pin privileged GitHub Actions to immutable commit SHAs | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Atomically serialize auto-resolution contest and expiry sweep | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [CTO MEMORY] Day-0 decentralized nodes, shared liquidity & production sequencing | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Preserve UNKNOWN outcome across signature-collection provider submission | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Evidence] Storage lifecycle, privacy, arbiter access & OpenProof/Dispute unification | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Evidence] Evidence upload idempotency, rate limits, quotas and cleanup | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Temporal Safety] Delayed live settlement can overwrite reconciled txReleaseId | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Recovery] WDK partial SPLIT has no automated restart convergence | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Crash Consistency] Direct-call recovery can misattribute settlement actor | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Recovery] Cooperative pending signature round can be abandoned indefinitely | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 recovery] Bound M9-R dispatch recovery scan under accumulated PostgreSQL state | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Validate QVAC advisory outputs at the provider trust boundary | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Bound OpenProof evidence upload and inline proof payload size | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Recovery] WDK confirmed RELEASE/REFUND cannot automatically converge after restart | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Temporal Defect] Delayed escrow event can regress terminal Trade state | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Temporal Defect] Dispute opening is not atomic with Escrow freeze | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Add server-side session revocation and bound stolen-session authority | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Crash Consistency] Durable settlement event does not prove downstream projections completed | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Result Integrity] SAFE bundler response can replace the signed UserOperation identity | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Economic Idempotency] Arbiter collateral top-up has no durable contribution identity | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Crash Consistency] Direct-call SPLIT loses durable allocation needed for recovery | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Concurrency] Stale dispute-pending cleanup can delete a newly signed round | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Defect] Payment-account trade-limit ramp is computed but not enforced | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Bind QVAC auto-resolution proposals to the exact evidence generation assessed | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Accounting Consistency] Fee BROADCAST evidence and IN_PROGRESS transition are not atomic | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Economic Safety] Signature-collection provider UNKNOWN can be rolled back as FAILED | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Temporal Consistency] Reputation outcome is derived from mutable Dispute state at handler time | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 #254 residual] Persist immutable dispute provenance for LIGHTNING_HODL / SAFE_GUARD_EVM settlement completion | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 P2P Reality Audit] Lifecycle timers, no-show/griefing, payment-risk and basic trade-safety gaps | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Day-0 Security] Fail closed on invalid QVAC auto-resolution configuration and remove stale authority docs | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Master Backlog][Scalability] Multi-Integrator SDK & Million-MAU Readiness — Claude evidence mission | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Post-Master Backlog][Security] Adversarial resilience, AI guardrails & engineering evidence gates | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Sails Beta Readiness — Integration & Reality Validation Gate | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [CTO MEMORY] Operating model, Claude executor boundary & active institutional pipeline | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Product Discovery] DePix Terminal for Sails Market / P2P operators | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Horizon: Sails Sandbox, Playground & Test Harness | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Arbitration Market / Future Policy] BTC-native arbiter bond, Taproot exit/slashing and reputation-at-risk | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Production Readiness] Production Surface Audit — mocks, stubs, fallbacks & unsafe runtime exposure | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Institutional Product Direction — Sails Market-operated public bootstrap fleet | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Beta Readiness — Industry Precedent / Incident Corpus | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Backlog Delta — Fault-domain independence, dependency security, and Lightning footgun defense | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | Final Red Team Horizon: bounded adversarial case library | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Architecture] Sails AI Harnesses — Engineering Harness, QVAC Runtime Harness & AI Governance Contract | OPEN (issue); acceptance NOT VERIFIED |
| #undefined | [Strategy] First-party wallet-kit adapters + multi-rail OpenP2P distribution | OPEN (issue); acceptance NOT VERIFIED |

### Unresolved classification tasks

- **Production blocker vs discovery vs post-Master:** issue titles and search matches cannot decide release scope. Reconcile #473, #487, #438, #78, #75, #86, #155 and #221 with their explicit scope, not a generic Day-0 tag.
- **Issue #275 closed:** historical documentation reconciliation program closure does not supersede current #125 documentation alignment gate.
- **Issue #361:** Sails Market-operated bootstrap fleet can supply operational redundancy, not proof of independently operated nodes required by #105.
- **Issue #147:** private market membership and infrastructure hosting are independent; no mandatory provider.
- **Issue #293:** trade lifecycle deadline/authority/restart matrix is a first-class Day-0 audit, not merely a P2P UX wish.
- **PR #525:** successful CI is verified at SHA, but suite cleanup independent review and migration approval remain separate gates. Draft/stacked PR must not be counted as merged.
- **Audit independence:** reviewer must distinguish code-reviewed, tests-reproduced, external validated, and production authorized.

### CTO handoff rule — prevent discussion drift

Each future CTO starts by reading the Master, this ledger, #221/#99, accepted ADRs, current open owners, stacked PR topology and exact-SHA CI. For contradictory claims, record both sources and resolution with timestamp and reviewer. Keep historical claims dated; do not silently rewrite them. A discussion or executor report is evidence to assess, not automatically normative truth. Update the canonical owner and this index together when a gate changes.
