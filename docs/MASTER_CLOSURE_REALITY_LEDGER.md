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

> **Integrity repair (2026-10-25):** All 53 lexical issue IDs below were independently matched against live GitHub issue titles and restored. This is a title-to-issue-ID integrity repair, **not** independent technical acceptance, an exhaustive Day-0 denominator or proof that all 53 are release blockers. The separate 29-issue state verification remains intact.

This is a **search-derived index of 53 open issues matching the phrase Day-0**, not a count of all Master obligations or proof each is a Day-0 release blocker. GitHub issue search is lexical and includes discovery, future and institutional-memory issues. **Issue OPEN ≠ implementation absent; PR merged ≠ independently accepted.** Classify each entry against normative Master/ADR, latest comments, linked PR and exact-SHA tests before assigning its gate.

| Issue | Title | Verified issue state / evidence status |
| --- | --- | --- |
| #306 | [Day-0 Security] Bound production observability and readiness disclosure | OPEN (issue); acceptance NOT VERIFIED |
| #237 | [Day-0 Recovery] Arbiter disappearance after economic commitment | OPEN (issue); acceptance NOT VERIFIED |
| #256 | [Day-0 Discovery] Production P2P Benchmark & Missing Behavior Sweep | OPEN (issue); acceptance NOT VERIFIED |
| #307 | [Day-0 Security] Bound authenticated WebSocket relay resource consumption | OPEN (issue); acceptance NOT VERIFIED |
| #297 | [Day-0 Security] AI-era public repository adversarial security audit | OPEN (issue); acceptance NOT VERIFIED |
| #228 | [Day-0 Testability] Production-isolated signature-collection test rail | OPEN (issue); acceptance NOT VERIFIED |
| #125 | Institutional Alignment — Day-0 truth across GitHub, Mintlify and GitBook | OPEN (issue); acceptance NOT VERIFIED |
| #105 | [Day-0] Multi-Operator Network + Partner Beta Completion Gate | OPEN (issue); acceptance NOT VERIFIED |
| #265 | [Day-0 Evidence] Production EvidenceProvider contract and durable object storage | OPEN (issue); acceptance NOT VERIFIED |
| #304 | [Day-0 Security] Pin privileged GitHub Actions to immutable commit SHAs | OPEN (issue); acceptance NOT VERIFIED |
| #308 | [Day-0 Security] Atomically serialize auto-resolution contest and expiry sweep | OPEN (issue); acceptance NOT VERIFIED |
| #99 | [CTO MEMORY] Day-0 decentralized nodes, shared liquidity & production sequencing | OPEN (issue); acceptance NOT VERIFIED |
| #299 | [Day-0 Security] Preserve UNKNOWN outcome across signature-collection provider submission | OPEN (issue); acceptance NOT VERIFIED |
| #234 | [Day-0 Evidence] Storage lifecycle, privacy, arbiter access & OpenProof/Dispute unification | OPEN (issue); acceptance NOT VERIFIED |
| #267 | [Day-0 Evidence] Evidence upload idempotency, rate limits, quotas and cleanup | OPEN (issue); acceptance NOT VERIFIED |
| #252 | [Day-0 Temporal Safety] Delayed live settlement can overwrite reconciled txReleaseId | OPEN (issue); acceptance NOT VERIFIED |
| #250 | [Day-0 Recovery] WDK partial SPLIT has no automated restart convergence | OPEN (issue); acceptance NOT VERIFIED |
| #248 | [Day-0 Crash Consistency] Direct-call recovery can misattribute settlement actor | OPEN (issue); acceptance NOT VERIFIED |
| #239 | [Day-0 Recovery] Cooperative pending signature round can be abandoned indefinitely | OPEN (issue); acceptance NOT VERIFIED |
| #343 | [Day-0 recovery] Bound M9-R dispatch recovery scan under accumulated PostgreSQL state | OPEN (issue); acceptance NOT VERIFIED |
| #310 | [Day-0 Security] Validate QVAC advisory outputs at the provider trust boundary | OPEN (issue); acceptance NOT VERIFIED |
| #300 | [Day-0 Security] Bound OpenProof evidence upload and inline proof payload size | OPEN (issue); acceptance NOT VERIFIED |
| #251 | [Day-0 Recovery] WDK confirmed RELEASE/REFUND cannot automatically converge after restart | OPEN (issue); acceptance NOT VERIFIED |
| #236 | [Day-0 Temporal Defect] Delayed escrow event can regress terminal Trade state | OPEN (issue); acceptance NOT VERIFIED |
| #238 | [Day-0 Temporal Defect] Dispute opening is not atomic with Escrow freeze | OPEN (issue); acceptance NOT VERIFIED |
| #312 | [Day-0 Security] Add server-side session revocation and bound stolen-session authority | OPEN (issue); acceptance NOT VERIFIED |
| #253 | [Day-0 Crash Consistency] Durable settlement event does not prove downstream projections completed | OPEN (issue); acceptance NOT VERIFIED |
| #258 | [Day-0 Result Integrity] SAFE bundler response can replace the signed UserOperation identity | OPEN (issue); acceptance NOT VERIFIED |
| #255 | [Day-0 Economic Idempotency] Arbiter collateral top-up has no durable contribution identity | OPEN (issue); acceptance NOT VERIFIED |
| #247 | [Day-0 Crash Consistency] Direct-call SPLIT loses durable allocation needed for recovery | OPEN (issue); acceptance NOT VERIFIED |
| #244 | [Day-0 Concurrency] Stale dispute-pending cleanup can delete a newly signed round | OPEN (issue); acceptance NOT VERIFIED |
| #235 | [Day-0 Defect] Payment-account trade-limit ramp is computed but not enforced | OPEN (issue); acceptance NOT VERIFIED |
| #309 | [Day-0 Security] Bind QVAC auto-resolution proposals to the exact evidence generation assessed | OPEN (issue); acceptance NOT VERIFIED |
| #245 | [Day-0 Accounting Consistency] Fee BROADCAST evidence and IN_PROGRESS transition are not atomic | OPEN (issue); acceptance NOT VERIFIED |
| #240 | [Day-0 Economic Safety] Signature-collection provider UNKNOWN can be rolled back as FAILED | OPEN (issue); acceptance NOT VERIFIED |
| #254 | [Day-0 Temporal Consistency] Reputation outcome is derived from mutable Dispute state at handler time | OPEN (issue); acceptance NOT VERIFIED |
| #341 | [Day-0 #254 residual] Persist immutable dispute provenance for LIGHTNING_HODL / SAFE_GUARD_EVM settlement completion | OPEN (issue); acceptance NOT VERIFIED |
| #293 | [Day-0 P2P Reality Audit] Lifecycle timers, no-show/griefing, payment-risk and basic trade-safety gaps | OPEN (issue); acceptance NOT VERIFIED |
| #311 | [Day-0 Security] Fail closed on invalid QVAC auto-resolution configuration and remove stale authority docs | OPEN (issue); acceptance NOT VERIFIED |
| #473 | [Master Backlog][Scalability] Multi-Integrator SDK & Million-MAU Readiness — Claude evidence mission | OPEN (issue); acceptance NOT VERIFIED |
| #487 | [Post-Master Backlog][Security] Adversarial resilience, AI guardrails & engineering evidence gates | OPEN (issue); acceptance NOT VERIFIED |
| #165 | Sails Beta Readiness — Integration & Reality Validation Gate | OPEN (issue); acceptance NOT VERIFIED |
| #221 | [CTO MEMORY] Operating model, Claude executor boundary & active institutional pipeline | OPEN (issue); acceptance NOT VERIFIED |
| #231 | [Product Discovery] DePix Terminal for Sails Market / P2P operators | OPEN (issue); acceptance NOT VERIFIED |
| #78 | Horizon: Sails Sandbox, Playground & Test Harness | OPEN (issue); acceptance NOT VERIFIED |
| #438 | [Arbitration Market / Future Policy] BTC-native arbiter bond, Taproot exit/slashing and reputation-at-risk | OPEN (issue); acceptance NOT VERIFIED |
| #220 | [Production Readiness] Production Surface Audit — mocks, stubs, fallbacks & unsafe runtime exposure | OPEN (issue); acceptance NOT VERIFIED |
| #361 | Institutional Product Direction — Sails Market-operated public bootstrap fleet | OPEN (issue); acceptance NOT VERIFIED |
| #420 | Beta Readiness — Industry Precedent / Incident Corpus | OPEN (issue); acceptance NOT VERIFIED |
| #123 | Backlog Delta — Fault-domain independence, dependency security, and Lightning footgun defense | OPEN (issue); acceptance NOT VERIFIED |
| #77 | Final Red Team Horizon: bounded adversarial case library | OPEN (issue); acceptance NOT VERIFIED |
| #155 | [Architecture] Sails AI Harnesses — Engineering Harness, QVAC Runtime Harness & AI Governance Contract | OPEN (issue); acceptance NOT VERIFIED |
| #86 | [Strategy] First-party wallet-kit adapters + multi-rail OpenP2P distribution | OPEN (issue); acceptance NOT VERIFIED |

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

## Live PR topology and CTO review-tool corrections — verified 2026-10-24

| PR | GitHub state checked | Gate meaning |
| --- | --- | --- |
| #512 | OPEN, draft, base main | Node runtime; no merge assumed |
| #515 | OPEN, draft, base main | Docker image optimization; no merge assumed |
| #516 | OPEN, draft, base main | Prisma migration job; no shared-DB authorization |
| #519 | OPEN, draft, base main | Self-host integration; staging != production |
| #521 | OPEN, draft, base main | Image security advisory remediation; not a full vulnerability closure claim |
| #523 | OPEN, draft, stacked on p4/gate3-claim-revert-convergence | P4 UNKNOWN policy evidence; parent branch chain requires verification |
| #525 | OPEN, draft, stacked on #523 branch | P4 Gate 3 guard; exact SHA 728ab00e83653b4f37b88facb9bdceb5bed4de65 |
| #531 | OPEN, draft, base main | Documentation-only Master reconciliation; no acceptance yet |

**Important:** PR titles mentioning 'stacked' do not prove their GitHub base points to another PR. The actual base refs above were checked. Never merge these as an assumed linear chain without comparing ancestry and independent gate evidence.

### Institutional review toolchain (#221 comments)

Later comments in #221 supersede earlier discussion: **Open CodeReview + Claude Code** is primary multi-agent code review; **Codex** is complementary independent verification; **Cloudflare security-audit-skill + Claude** is structured security audit; **Strix + Claude** is offensive/dynamic pentesting only on authorized Sails targets. **CTO/Gatekeeper** alone determines classification, acceptance, merge, freeze and release. Review ≠ verification ≠ audit ≠ pentest ≠ gate authority. Tool findings are not automatically proven defects.

### Outstanding work before closure percentage

The 53-row lexical issue index and live PR topology above are **not a complete obligation-level reconciliation**. The next pass must extract and normalize every numbered Master requirement, then check current issue body **and comments**, PR diff, current code, exact-SHA CI and independent acceptance for each. Record contradictions explicitly instead of choosing the most recent conversational claim. Until then the global percentage remains **not measurable**.

## Master BACKLOG.md table-row inventory — mechanical baseline (2026-10-24)

This inventory parses rows from the current default-branch BACKLOG.md. It is a **mechanical candidate list**, not a normative denominator: some rows are headings, historical/superseded entries, duplicates or explanatory records. The status column is a keyword from the row text and **not current acceptance**. Source line numbers are from the inspected 5,904-line snapshot and may drift after edits.

| Source line | Section | Candidate item | Historical text keyword | Acceptance |
| ---: | --- | --- | --- | --- |
| 53 | P0 — Core Primitives (block everything else) | Participant Model | NOT STARTED | UNVERIFIED |
| 54 | P0 — Core Primitives (block everything else) | Proof Primitive (Claim/Proof/Verification) | DONE | UNVERIFIED |
| 55 | P0 — Core Primitives (block everything else) | **Intent Engine** *(new — 03-implementation_plan.md, CISO+CTO-approved MVP blueprint)* | DONE | UNVERIFIED |
| 56 | P0 — Core Primitives (block everything else) | POST /api/v1/intents, DELETE /api/v1/intents/:id *(new)* | DONE | UNVERIFIED |
| 57 | P0 — Core Primitives (block everything else) | **Coordination Engine** *(new — RFC-012, rfcs/RFC-012-intent-validation-and-coordination.md)* | DONE | UNVERIFIED |
| 58 | P0 — Core Primitives (block everything else) | **Capability Registry** *(new — RFC-013, rfcs/RFC-013-capability-registry-and-wallet-adapter.md)* | DONE | UNVERIFIED |
| 59 | P0 — Core Primitives (block everything else) | **Capability Registry Enforcement** *(new — RFC-014, rfcs/RFC-014-capability-registry-enforcement.md; rel | DONE | UNVERIFIED |
| 60 | P0 — Core Primitives (block everything else) | **Two-Person Control for Escrow Release** *(new — RFC-015, rfcs/RFC-015-dual-authorization-escrow-release | DONE | UNVERIFIED |
| 61 | P0 — Core Primitives (block everything else) | **Real Protocol Fee collection** *(new — RFC-021 Phase 0, rfcs/RFC-021-market-based-arbitration-and-payme | DONE | UNVERIFIED |
| 62 | P0 — Core Primitives (block everything else) | **Permissionless arbiter registration** *(new — RFC-021 Phase 1, D1-D3)* | DONE | UNVERIFIED |
| 63 | P0 — Core Primitives (block everything else) | **Payment-account trust ramp** *(new — RFC-021 Phase 4, D5)* | DONE | UNVERIFIED |
| 64 | P0 — Core Primitives (block everything else) | **Slashing + reputation-weighted appeal escalation** *(new — RFC-021 Phase 2, D6)* | DONE | UNVERIFIED |
| 65 | P0 — Core Primitives (block everything else) | **cumulativeFeesObserved wiring (cost-to-fabricate floor, real)** *(new — RFC-021 Phase 3, D4)* | DONE | UNVERIFIED |
| 66 | P0 — Core Primitives (block everything else) | **DATABASE.md missing ArbiterProfile/PaymentAccount** *(gap found — RFC-021 doc-correction pass, 2026-07- | CLOSED | UNVERIFIED |
| 67 | P0 — Core Primitives (block everything else) | **Escrow timelock proactive sweeper** *(gap found — security-validation round, 2026-07-19, "trade abandon | DONE | UNVERIFIED |
| 68 | P0 — Core Primitives (block everything else) | Jest test framework *(new)* | DONE | UNVERIFIED |
| 69 | P0 — Core Primitives (block everything else) | Transport Provider | DONE | UNVERIFIED |
| 70 | P0 — Core Primitives (block everything else) | PearsTransportProvider.sendIntentToPeer() *(new)* | DONE | UNVERIFIED |
| 71 | P0 — Core Primitives (block everything else) | Negotiation State Machine + Channel | UNCLASSIFIED | UNVERIFIED |
| 72 | P0 — Core Primitives (block everything else) | ReconciliationService on peer reconnect *(new — RFC-011)* | DONE | UNVERIFIED |
| 73 | P0 — Core Primitives (block everything else) | Event Bus update | DONE | UNVERIFIED |
| 74 | P0 — Core Primitives (block everything else) | EventStore + mandatory correlationId *(new — RFC-010)* | DONE | UNVERIFIED |
| 75 | P0 — Core Primitives (block everything else) | RedisStreamsEventStore (durable backend) *(new — RFC-010)* | DONE | UNVERIFIED |
| 76 | P0 — Core Primitives (block everything else) | PostgresEventStore (durable backend, active default) *(new — RFC-008 D2 amendment, Missão 05.7)* | DONE | UNVERIFIED |
| 77 | P0 — Core Primitives (block everything else) | ↳ **Hard precondition before RedisStreamsEventStore can be switched in as the active store** (found by a  | NOT STARTED | UNVERIFIED |
| 78 | P0 — Core Primitives (block everything else) | **Future RFC candidate — Event Processing Guarantees** *(registered, not drafted — CTO-role recommendatio | NOT STARTED | UNVERIFIED |
| 79 | P0 — Core Primitives (block everything else) | Timeline read-model *(new — RFC-007 D5, real as of RFC-017)* | DONE | UNVERIFIED |
| 80 | P0 — Core Primitives (block everything else) | Timeline hash-chaining *(new — RFC-008 D2)* | DONE | UNVERIFIED |
| 86 | P1 — First Proven Module + SDK Core | Sails OpenP2P (trade lifecycle + chat) | OPEN | UNVERIFIED |
| 87 | P1 — First Proven Module + SDK Core | SDK Core (@satsails/p2p-trading-sdk, ships as **Sails P2P Trading SDK** per the Named-SDK Rule, PROJECT_C | PARTIAL | UNVERIFIED |
| 88 | P1 — First Proven Module + SDK Core | **@satsails/p2p-schemas** *(new — 04-Deepseek Review Task 1)* | DONE | UNVERIFIED |
| 89 | P1 — First Proven Module + SDK Core | CRDT / WebRTC adoption | UNCLASSIFIED | UNVERIFIED |
| 247 | P2 — Cross-Module Services | Sails OpenSettlement | OPEN | UNVERIFIED |
| 248 | P2 — Cross-Module Services | Float → Decimal schema migration *(new — RFC-009)* | DONE | UNVERIFIED |
| 249 | P2 — Cross-Module Services | PendingBankSettlement status *(new — RFC-007 D3)* | UNCLASSIFIED | UNVERIFIED |
| 250 | P2 — Cross-Module Services | Dispute persistence + raiseDispute()/resolveDispute() *(new — 04-Deepseek Review Task 2)* | DONE | UNVERIFIED |
| 251 | P2 — Cross-Module Services | SPLIT ruling settlement action | DONE | UNVERIFIED |
| 252 | P2 — Cross-Module Services | Participant payout address | DONE | UNVERIFIED |
| 253 | P2 — Cross-Module Services | Sails OpenIdentity | UNCLASSIFIED | UNVERIFIED |
| 254 | P2 — Cross-Module Services | Operational Profiles *(new — RFC-007 D8/D11)* | NOT STARTED | UNVERIFIED |
| 255 | P2 — Cross-Module Services | Sails OpenReputation | DONE | UNVERIFIED |
| 256 | P2 — Cross-Module Services | Outcome Engine + rate() demotion *(new — RFC-007 D8/D9)* | DONE | UNVERIFIED |
| 257 | P2 — Cross-Module Services | **Sails OpenProof** *(new — RFC-006)* | CLOSED | UNVERIFIED |
| 258 | P2 — Cross-Module Services | Proof Registry, EvidenceProvider, Evidence Bundle, TimestampAnchor *(RFC-007 D1/D2/D6, RFC-008 D1)* | DONE | UNVERIFIED |
| 259 | P2 — Cross-Module Services | MULTISIG cooperative spend without the server *(audit — Missão 11, Fase 9.1 §8, 2026-08-24)* | PARTIAL | UNVERIFIED |
| 260 | P2 — Cross-Module Services | sails-ui signs MULTISIG PSBTs blind, bypassing the SDK's own verification *(gap found — Missão 11, Fase 9 | CLOSED | UNVERIFIED |
| 266 | P3 — Advanced / Aspirational Modules | Sails OpenLiquidity | UNCLASSIFIED | UNVERIFIED |
| 267 | P3 — Advanced / Aspirational Modules | Sails OpenFinance | NOT STARTED | UNVERIFIED |
| 268 | P3 — Advanced / Aspirational Modules | Sails OpenAgents | CLOSED | UNVERIFIED |
| 269 | P3 — Advanced / Aspirational Modules | Social Engineering Agent *(new — RFC-007 D7, real as of RFC-017)* | UNCLASSIFIED | UNVERIFIED |
| 805 | Institutional Cold Sweep / Production Readiness (2026-09-08) | Issue | UNCLASSIFIED | UNVERIFIED |
| 807 | Institutional Cold Sweep / Production Readiness (2026-09-08) | **#75** | UNCLASSIFIED | UNVERIFIED |
| 808 | Institutional Cold Sweep / Production Readiness (2026-09-08) | **#77** | UNCLASSIFIED | UNVERIFIED |
| 809 | Institutional Cold Sweep / Production Readiness (2026-09-08) | **#78** | UNCLASSIFIED | UNVERIFIED |
| 810 | Institutional Cold Sweep / Production Readiness (2026-09-08) | **#84** | OPEN | UNVERIFIED |
| 811 | Institutional Cold Sweep / Production Readiness (2026-09-08) | **#86** | PARTIAL | UNVERIFIED |

**Next audit:** normalize these candidates together with prose obligations and issue-only deltas; determine canonical ID, duplicate/superseded status, Day-0 scope, linked PR and independent evidence. Do not use row count as project percentage.

## CTO CURRENT-TRUTH OPERATING CONTRACT — mandatory handoff protocol

### A. Authority hierarchy (never resolve conflicts by chat recency)

1. **Economic/architectural semantics:** accepted ADR/RFC and current normative repository documentation, checked against implementation. An issue cannot silently change a frozen invariant.
2. **Implementation reality:** current code on a named commit, migrations and tests; code can expose drift but does not automatically authorize a semantic change.
3. **Gate acceptance:** designated gate issue with independent review, reproducible exact-SHA evidence and explicit CTO decision. Green CI alone is insufficient.
4. **Execution coordination:** open bounded issues and draft PRs. These show work in progress, not acceptance or release.
5. **Historical discussion:** old docs, issue comments, Claude reports and chats. Keep as provenance, but do not elevate into current truth without reconciliation.

When sources disagree: capture **claim A / claim B / timestamps / normative owner / exact evidence / resolution / unresolved decision**. An unresolved conflict is YELLOW or RED, never implicitly GREEN. A later comment may correct a historical comment without changing an accepted ADR.

### B. Explicit issue-role registry

| Source | Institutional role | Do NOT infer |
| --- | --- | --- |
| docs/BACKLOG.md | Institutional technical backlog and dated debt/truth history | Every old DONE means current production acceptance |
| #99 | CTO continuity on Day-0 network architecture and sequencing | Independent acceptance of multi-operator network |
| #221 | CTO/Claude operating model, toolchain and handoff | Authority to merge or deploy from a comment |
| #105 + ADR-001 | Multi-operator Day-0 completion gate + architecture | Sails Market fleet alone proves independent operators |
| #125 | Cross-surface documentation truth gate | #275 closure means documentation is aligned |
| #165 | Scenario-level integration and Beta reality gate | Passing unit/DB tests proves live economic flows |
| #293 | P2P trade lifecycle and safety audit | Future UX enhancement / deferrable after Day-0 |
| #420 | Incident corpus and staged Beta evidence | Incident review is interchangeable with code review |
| #500 | Continuous discovery of production gaps | Every finding is already a validated defect |
| #275 | CLOSED historical reconciliation program | Current #125 gate is CLOSED |
| #525 | DRAFT P4 economic recovery change, exact-SHA CI | Merge, migration or production permission |
| #531 | DRAFT documentation reconciliation | Master accepted or canonical main updated |

### C. Time-qualified statements: known traps

- **Protocol freeze v1.0** is an architectural historical event, not code complete, Beta or production authorization.
- **BACKLOG phase table** includes older descriptions and later self-corrections; read the latest relevant correction, not just its top row.
- **Proof service / settlement providers:** historical 'not implemented' language was corrected in BACKLOG. Real implementation existence is distinct from production-authorized rail status.
- **FeeDistribution** historical implementation was superseded by the later FeeCollectionEvidence → FeeObligation → frozen DistributionPolicyVersion → EntitlementLedgerEntry authority. Do not resurrect frozen legacy writes based on an old DONE row.
- **Private Market ≠ Private Infrastructure** (#147): membership/market authority does not follow node hosting.
- **Sails Market bootstrap fleet** (#361): may help availability; does not substitute third-party independent operators in #105.
- **UNKNOWN ≠ FAILED** and transaction-public evidence ≠ economic authorization. Do not infer recovery success from a test-only explorer stub.
- **CI #40145591634** was successful for #525 SHA 728ab00e83653b4f37b88facb9bdceb5bed4de65; independent isolation review and migration approval remain separate.
- **P3/P4 PRs** remain draft as checked in this sweep; never treat a stack description as proof of ancestry or merge.

### D. Mandatory first-hour checklist for an incoming CTO

1. Read docs/BACKLOG.md **including later correction notes**, this ledger, accepted ADR-001, #99 and #221.
2. Fetch live issue states and last material comments for #105, #125, #165, #293, #420 and #500; recheck #275 closed-state versus body text.
3. Fetch exact PR HEAD, base, draft/merge state and CI for each active PR. Verify stacked ancestry rather than trusting titles.
4. Separate **normative obligations**, **implementation tasks**, **test evidence**, **acceptance decisions**, **operational deployments** and **research**.
5. Keep a contradiction log with owner and timestamp. Never silently overwrite or discard historical evidence.
6. Maintain the RED/YELLOW/GREEN gate and **measured percentage only for a named bounded denominator**; use NOT MEASURED for global Master until normalized.
7. Issue bounded missions to Claude. CTO retains final decision; independent verifier cannot be the same executor's unreviewed assertion.
8. Before any migration, merge, VPS staging, production or policy change: obtain its own explicit approval and environmental evidence.

### E. Acceptance definition for this *documentation* work

- [x] Explicit role/authority hierarchy and contradiction rule.
- [x] Open Day-0 lexical issue index with no fabricated closure claims.
- [x] Historical table candidate inventory with source line references.
- [x] Current P3/P4 draft PR topology snapshot.
- [x] Review/audit/pentest/gatekeeper responsibility separation.
- [x] Incoming CTO first-hour checklist and known temporal traps.
- [ ] All prose obligations individually extracted and deduplicated (large historical Master, not yet exhaustive).
- [ ] All issue comments, PR diffs, current code and independent acceptance checked obligation-by-obligation.
- [ ] GitBook/Mintlify cross-surface alignment independently accepted (#125).
- [ ] CTO-reviewed and merged to main (PR #531 remains draft).

**Interpretation:** the continuity contract is documented; the entire Master and release gates are NOT 100% accepted. This distinction is non-negotiable.

## Important correction: #420 versus #500 and release-stage sequencing

The live #420 issue explicitly classifies the incident corpus as a **post-Master / Beta Readiness** workstream. It is therefore not a blanket blocker for the *current bounded Master closure*; it is a later release gate unless a discovered issue independently proves a present Day-0 defect. #500 is a **continuous audit program**, not a finite item whose issue state should be counted as a completion percentage. #105 enumerates 53 launch-oriented obligations in its latest body; that is **not** a verified normalized Master denominator, and many are multi-part or overlap #165. Reconcile scope before counting.

The top-level entrypoint for incoming CTOs is [CTO_START_HERE.md](CTO_START_HERE.md). New CTOs must check this before using historical phase tables or conversation summaries.

## Economic/security verification queue — 2026-10-24

These 29 numbered issue owners must be checked individually against current issue body/comments, linked code, exact-SHA CI, independent acceptance and environment before counting any as accepted. The list is a **verification queue**, not a claim that all issue states were independently checked.

| Owner | Independent acceptance |
| --- | --- |
| #235 | NOT VERIFIED |
| #236 | NOT VERIFIED |
| #237 | NOT VERIFIED |
| #238 | NOT VERIFIED |
| #239 | NOT VERIFIED |
| #240 | NOT VERIFIED |
| #244 | NOT VERIFIED |
| #245 | NOT VERIFIED |
| #247 | NOT VERIFIED |
| #248 | NOT VERIFIED |
| #250 | NOT VERIFIED |
| #251 | NOT VERIFIED |
| #252 | NOT VERIFIED |
| #253 | NOT VERIFIED |
| #254 | NOT VERIFIED |
| #255 | NOT VERIFIED |
| #258 | NOT VERIFIED |
| #265 | NOT VERIFIED |
| #267 | NOT VERIFIED |
| #293 | NOT VERIFIED |
| #299 | NOT VERIFIED |
| #304 | NOT VERIFIED |
| #308 | NOT VERIFIED |
| #309 | NOT VERIFIED |
| #310 | NOT VERIFIED |
| #311 | NOT VERIFIED |
| #312 | NOT VERIFIED |
| #341 | NOT VERIFIED |
| #343 | NOT VERIFIED |

Prior attempted individual verification did not persist into the branch; do not count it as completed. This section restores the work queue without inventing results.

## Direct issue-state verification — 2026-10-25

All 29 specifically queued economic/security issue numbers below were individually fetched from GitHub and returned **OPEN**. This verifies issue state only; code, comments, PR evidence, independent acceptance and Day-0 severity still need per-owner review. Do not infer absence of implementation from OPEN.

| Verified OPEN issue numbers | Verification scope |
| --- | --- |
| #235, #236, #237, #238, #239, #240, #244, #245, #247, #248, #250, #251, #252, #253, #254 | Direct GitHub issue fetch |
| #255, #258, #265, #267, #293, #299, #304, #308, #309, #310, #311, #312, #341, #343 | Direct GitHub issue fetch |

**Result: 29/29 state checks complete; 0/29 independent acceptance checks complete.** This replaces the earlier queue-only statement for *state*, not for acceptance. This is not a Master denominator.

## CTO handoff readiness scorecard — 2026-10-25 (documentation-only)

**Scope:** readiness of this institutional handoff proposal, not completion of the Master backlog, Day-0, beta or production. Score uses eight explicitly defined checks, each worth 12.5 percentage points. No subjective weighting, and a checked documentation item is not a code acceptance.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| 1. Historical phase warning in Master | PASS | BACKLOG.md links this ledger ahead of the stale phase snapshot |
| 2. Source authority and contradiction rule | PASS | CTO current-truth operating contract |
| 3. Incoming CTO checklist | PASS | First-hour checklist and tool role separation |
| 4. Current owner/issue index | PASS | 53 lexical Day-0 issue candidates and active owner map; explicitly not exhaustive |
| 5. Historical Master table inventory | PASS | 56 mechanical candidate rows, not normative obligations |
| 6. Active PR topology and non-merge status | PASS | Snapshot of #512/#515/#516/#519/#521/#523/#525/#531; must re-fetch on handoff |
| 7. Individual issue state checks for risk queue | PASS | 29/29 direct OPEN-state checks; independent acceptance 0/29 |
| 8. Exhaustive obligation-to-evidence reconciliation and independent CTO sign-off | FAIL / PENDING | Prose obligations and comments not exhaustively classified; no final sign-off, #125 alignment or main merge |

**Measured documentation score: 7/8 = 87.5%.** The remaining 12.5% is a substantial audit gate, not merely editorial polishing. **This score cannot be used as a Master completion percentage.** The documentation PR is DRAFT and has not changed main. 

### Closeout protocol for check 8

1. Enumerate every *normative* Day-0 obligation from BACKLOG prose, ADR-001 and issue #105; deduplicate by stable obligation ID and classify research/post-Master separately.
2. For each obligation, record canonical owner, current implementation SHA, related PRs and comments, exact-SHA CI, independent reviewer and acceptance status. Do not convert old DONE to current ACCEPTED without evidence.
3. Record every unresolved contradiction as a bounded issue with explicit source timestamps, priority and next action. Mark missing evidence UNKNOWN, not PASS.
4. Verify GitBook/Mintlify truth against repository as a separate #125 gate; do not declare it complete from this PR.
5. Obtain independent CTO review, confirm no unapproved semantic edits, and decide whether PR #531 may leave draft. Merge requires separate authorization.

### Handoff instruction while check 8 is open

Incoming CTOs may use this ledger as a **provisional navigation and conflict-resolution index**, but must not treat it as a frozen exhaustive Master truth or use its 87.5% score for production readiness. Recheck live states before work; never re-run a supposedly completed mission solely because an older paragraph says NOT STARTED.

## Normative network obligation extraction — ADR-001 and #105 (2026-10-25)

**Extraction scope:** canonical ADR-001 top-level numbered obligations and issue #105 named gates, not every sub-bullet, correction, or full Master prose. These are **traceability anchors** rather than individual ACCEPTED requirements; detailed obligation splitting and independent verification remain pending. The ADR and issue contain later cold-sweep corrections; always read the whole current section before implementing.

### ADR-001 numbered anchor map (28)

| ADR anchor | Current section | Current acceptance |
| --- | --- | --- |
| §1 | 1. Shared Market Invariant (frozen) | NOT VERIFIED |
| §2 | 2. Object authority | NOT VERIFIED |
| §3 | 3. Signed Offer envelope (Protocol Envelope) | NOT VERIFIED |
| §4 | 4. Propagation model | NOT VERIFIED |
| §5 | 5. Convergence / conflict | NOT VERIFIED |
| §6 | 6. Bootstrap and membership | NOT VERIFIED |
| §7 | 7. Node identity and Sybil | NOT VERIFIED |
| §8 | 8. Trade ownership / handoff | NOT VERIFIED |
| §9 | 9. Offline / restart / resume | NOT VERIFIED |
| §10 | 10. Reputation portability | NOT VERIFIED |
| §11 | 11. Settlement / evidence portability | NOT VERIFIED |
| §12 | 12. Privacy | NOT VERIFIED |
| §13 | 13. Professional liquidity provider | NOT VERIFIED |
| §14 | 14. Liquidity discovery scaling | NOT VERIFIED |
| §15 | 15. Capability / rail discovery | NOT VERIFIED |
| §16 | 16. Node economics | NOT VERIFIED |
| §17 | 17. Incentive compatibility / no-cannibalization property | NOT VERIFIED |
| §18 | 18. Stranger-node test (future evidence gate) | NOT VERIFIED |
| §19 | 19. Stranger-developer test (future evidence gate) | NOT VERIFIED |
| §20 | 20. Partner-wallet evidence gate | NOT VERIFIED |
| §21 | 21. Implementation Sequence (obligatory order, not a "future" list) | NOT VERIFIED |
| §22 | 22. Complexity tests (applied to this ADR's own new artifacts) | NOT VERIFIED |
| §23 | 23. Claims not yet demonstrated (discipline, restated) | NOT VERIFIED |
| §24 | 24. Migration from current single-node topology | NOT VERIFIED |
| §25 | 25. BACKLOG DELTA | NOT VERIFIED |
| §26 | 26. Day-0 Completeness Cold Sweep — implementation consequence (2026-09-09) | NOT VERIFIED |
| §27 | 27. Exact economic binding correction (2026-09-09) | NOT VERIFIED |
| §28 | 28. Real-money agreement and dispute-authority correction (2026-09-09) | NOT VERIFIED |

### Issue #105 gate map (10)

| Gate | Canonical title | Current acceptance |
| --- | --- | --- |
| Gate A | Gate A — evidence infrastructure first | NOT VERIFIED |
| Gate B | Gate B — freeze actual first-beta scope | NOT VERIFIED |
| Gate C | Gate C — portable market objects + participant/node identity | NOT VERIFIED |
| Gate D | Gate D — one shared market across time/failure | NOT VERIFIED |
| Gate E | Gate E — exact economic commitment | NOT VERIFIED |
| Gate F | Gate F — real-world concurrency + recovery | NOT VERIFIED |
| Gate G | Gate G — node economics without liquidity enclosure | NOT VERIFIED |
| Gate H | Gate H — independent operation / developer reality | NOT VERIFIED |
| Gate I | Gate I — independent partner beta | NOT VERIFIED |
| Gate J | Gate J — Production Readiness | NOT VERIFIED |

**Deduplication rule:** ADR sections define the normative architecture, #105 gates own completion evidence, and BACKLOG rows track work/debt. One obligation can reference all three without becoming three independent requirements. No percentage may use these 28+10 anchors as an additive denominator. Every gate needs independent proof; if absent record EVIDENCE PENDING, not PASS.


### #105 scope guard — live issue inspection (2026-10-25)

The ten A–J gate headings above are **gate categories**, not the full obligation denominator. The live #105 body also includes an ordered implementation/evidence path, adversarial tests, and subsequent numbered cold-sweep additions (including signed economic-term binding, replay/double-commit, fiat/payment-instruction commitments, arbitration continuity, public-offer privacy, and partner-beta asset/rail support). A reviewer must extract and deduplicate these requirements against ADR-001, `docs/BACKLOG.md`, and the cold-sweep document before claiming check 8 complete. **No numeric global obligation denominator or acceptance percentage is established here.** Source: https://github.com/sails-protocol/Sails-Protocol/issues/105 .


### #105 canonical execution-order register — 54 source entries (2026-10-25)

The current #105 sequence has labels **1–53 with item 10 decomposed into 10a and 10b**: 54 executable source entries. This is a source-level inventory, **not** a deduplicated Master denominator, implementation failure count, or evidence acceptance. Multi-line descriptions remain authoritative in the linked issue; short labels below are index keys only. Earlier historical discovery lists must not be added to this count.

| Source item | Gate | Source requirement/milestone (first line) | Independent evidence |
| --- | --- | --- | --- |
| 1 | A | Merge/freeze PR #106 institutional memory after CTO Gate + green CI. | NOT VERIFIED |
| 2 | A | Resume and close Technical Debt #57 (`buildApp()` parallel contention) so the harness does not produce false evidence during the Day-0 implementation program. | NOT VERIFIED |
| 3 | A | Close #61 Public OfferDetail privacy defect before any partner receives the current endpoint. | NOT VERIFIED |
| 4 | B | Publish the Partner Beta Asset × Network/Rail × Wallet Adapter × Settlement Capability × Maturity matrix. | NOT VERIFIED |
| 5 | B | Decide whether first beta is BTC-only, bounded BTC+USDT, or includes DePix. | NOT VERIFIED |
| 6 | B | If DePix is in scope, make DePix representable end-to-end and do not claim support before its real settlement path is eligible. | NOT VERIFIED |
| 7 | B | Freeze the fiat quote-currency scope for the beta. | NOT VERIFIED |
| 8 | C | Implement canonical signed OfferEnvelope, including exact asset + network/rail + quote-currency semantics needed by the beta. | NOT VERIFIED |
| 9 | C | Implement stale-resurrection-safe revision/tombstone persistence. | NOT VERIFIED |
| 10a | C | Implement **Participant Transport Identity (B) persistence** — a | NOT VERIFIED |
| 10b | C | Design and implement **Operational Sails Node Identity (C)** — an | NOT VERIFIED |
| 11 | C | Implement Economic Identity (A) ↔ Participant Transport Identity | NOT VERIFIED |
| 12 | C | Implement Operational Sails Node Identity (C) lifecycle: backup, | NOT VERIFIED |
| 13 | C | Implement self-authenticating Node Descriptor, signed/authenticated | NOT VERIFIED |
| 14 | D | Implement bootstrap + peer exchange without mandatory Satsails authority. | NOT VERIFIED |
| 15 | D | Implement signed Offer gossip + dedup. | NOT VERIFIED |
| 16 | D | Implement catch-up / anti-entropy for late join and partition healing. | NOT VERIFIED |
| 17 | D | Implement multi-node discovery/convergence into the local order-book projection. | NOT VERIFIED |
| 18 | D | Implement gossip resource bounds/backpressure. | NOT VERIFIED |
| 19 | D | Demonstrate peer diversity / eclipse / selective-forwarding resilience. | NOT VERIFIED |
| 20 | D | Define clock-health behavior for signed expiries. | NOT VERIFIED |
| 21 | E | Implement jointly-verifiable trade-open anchor binding exact Offer revision/envelope hash, amount, price, asset, network/rail, quote fiat amount/currency, payment method and replay/idempotency context. | NOT VERIFIED |
| 22 | E | Bind privacy-preserving payment-destination commitment; keep raw payment instructions private/pairwise. | NOT VERIFIED |
| 23 | E | Require authenticated amendment for any post-commit payment-instruction change. | NOT VERIFIED |
| 24 | E | Bind the selected settlement mechanism / EscrowType / custody and signer semantics. | NOT VERIFIED |
| 25 | E | Bind participant-facing fee/policy version before commitment. | NOT VERIFIED |
| 26 | E | Bind arbitration authority/policy/appeal semantics before funds are committed. | NOT VERIFIED |
| 27 | F | Implement professional-provider inventory reservation across concurrent acceptance paths. | NOT VERIFIED |
| 28 | F | Prove duplicate/replayed trade-open cannot double-commit a limited Offer. | NOT VERIFIED |
| 29 | F | Implement cross-node restart/offline/resume using signed trade anchors as re-entry truth. | NOT VERIFIED |
| 30 | F | Prove node switching does not create economic amnesia. | NOT VERIFIED |
| 31 | F | Make dispute evidence/ruling/appeal continuity independently verifiable across nodes. | NOT VERIFIED |
| 32 | F | Prove one party node disappearing does not make a valid dispute unresolvable. | NOT VERIFIED |
| 33 | F | Preserve rail-specific funds-authority semantics through resolution. | NOT VERIFIED |
| 34 | G | Implement Node Contribution Accounting for the contribution classes actually verifiable in Day-0 scope. | NOT VERIFIED |
| 35 | G | Demonstrate Incentive Compatibility / No-Cannibalization against the real accounting model. | NOT VERIFIED |
| 36 | G | Keep liquidity propagation rational and do not pay for unverifiable relay claims. | NOT VERIFIED |
| 37 | G | Keep real payout activation separately gated; accounting/entitlement evidence may run through beta with payout disabled. | NOT VERIFIED |
| 38 | H | Pass Stranger Node Test. | NOT VERIFIED |
| 39 | H | Pass Independent Node Operator No-Assistance Test. | NOT VERIFIED |
| 40 | H | Pass Stranger Developer Test: integrate SDK from public docs/package with no Satsails team help. | NOT VERIFIED |
| 41 | H | Prove wallet integration and backend/web-service integration paths. | NOT VERIFIED |
| 42 | H | Provide recoverable service-event consumption before public production. | NOT VERIFIED |
| 43 | I | Pass all scope-relevant adversarial tests from `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`. | NOT VERIFIED |
| 44 | I | Run the first independent partner-wallet integration. | NOT VERIFIED |
| 45 | I | Run at least one professional/web-service integration if that class is in beta scope. | NOT VERIFIED |
| 46 | I | Exercise restart, offline, node switch, partition heal, dispute and recovery with no privileged operator shortcut. | NOT VERIFIED |
| 47 | I | Only then claim shared-liquidity multi-node beta evidence for the bounded tested scope. | NOT VERIFIED |
| 48 | J | Run Production Readiness Consolidated Gate. | NOT VERIFIED |
| 49 | J | Provider production eligibility per enabled beta/launch rail. | NOT VERIFIED |
| 50 | J | Network Simulation + Final Red Team at the accepted sequencing point. | NOT VERIFIED |
| 51 | J | External security audit/remediation. | NOT VERIFIED |
| 52 | J | RC1 + bounded real-value validation. | NOT VERIFIED |
| 53 | J | Public production activation only after claim/evidence alignment. | NOT VERIFIED |

**Source coverage:** 54/54 canonical entries indexed; **cross-document deduplication:** PENDING; **independent acceptance:** PENDING; **global Master completion:** NOT MEASURED. Source: https://github.com/sails-protocol/Sails-Protocol/issues/105 .


### ADR-001 source-anchor reconciliation — 2026-10-25

The ADR contains **29 numbered top-level heading occurrences** because section 7 also has a 7.1 heading. These are **28 major sections plus one explicit subsection (7.1)**, not 29 independent obligations. The 54 canonical #105 execution entries and ADR headings are different source structures; adding their counts would be a false denominator. Below is an auditable source-anchor registry; the detailed normative subrequirements within each section still require atomization and cross-document deduplication.

| ADR anchor | Source heading | Relation to #105 / Master | Evidence acceptance |
| --- | --- | --- | --- |
| §1 | Shared Market Invariant (frozen) | Cross-document mapping PENDING | NOT VERIFIED |
| §2 | Object authority | Cross-document mapping PENDING | NOT VERIFIED |
| §3 | Signed Offer envelope (Protocol Envelope) | Cross-document mapping PENDING | NOT VERIFIED |
| §4 | Propagation model | Cross-document mapping PENDING | NOT VERIFIED |
| §5 | Convergence / conflict | Cross-document mapping PENDING | NOT VERIFIED |
| §6 | Bootstrap and membership | Cross-document mapping PENDING | NOT VERIFIED |
| §7 | Node identity and Sybil | Cross-document mapping PENDING | NOT VERIFIED |
| §7 | 1 Economic Identity ↔ Transport Identity Binding (correction, 2026-09-09, CTO Gate) | Cross-document mapping PENDING | NOT VERIFIED |
| §8 | Trade ownership / handoff | Cross-document mapping PENDING | NOT VERIFIED |
| §9 | Offline / restart / resume | Cross-document mapping PENDING | NOT VERIFIED |
| §10 | Reputation portability | Cross-document mapping PENDING | NOT VERIFIED |
| §11 | Settlement / evidence portability | Cross-document mapping PENDING | NOT VERIFIED |
| §12 | Privacy | Cross-document mapping PENDING | NOT VERIFIED |
| §13 | Professional liquidity provider | Cross-document mapping PENDING | NOT VERIFIED |
| §14 | Liquidity discovery scaling | Cross-document mapping PENDING | NOT VERIFIED |
| §15 | Capability / rail discovery | Cross-document mapping PENDING | NOT VERIFIED |
| §16 | Node economics | Cross-document mapping PENDING | NOT VERIFIED |
| §17 | Incentive compatibility / no-cannibalization property | Cross-document mapping PENDING | NOT VERIFIED |
| §18 | Stranger-node test (future evidence gate) | Cross-document mapping PENDING | NOT VERIFIED |
| §19 | Stranger-developer test (future evidence gate) | Cross-document mapping PENDING | NOT VERIFIED |
| §20 | Partner-wallet evidence gate | Cross-document mapping PENDING | NOT VERIFIED |
| §21 | Implementation Sequence (obligatory order, not a "future" list) | Cross-document mapping PENDING | NOT VERIFIED |
| §22 | Complexity tests (applied to this ADR's own new artifacts) | Cross-document mapping PENDING | NOT VERIFIED |
| §23 | Claims not yet demonstrated (discipline, restated) | Cross-document mapping PENDING | NOT VERIFIED |
| §24 | Migration from current single-node topology | Cross-document mapping PENDING | NOT VERIFIED |
| §25 | BACKLOG DELTA | Cross-document mapping PENDING | NOT VERIFIED |
| §26 | Day-0 Completeness Cold Sweep — implementation consequence (2026-09-09) | Cross-document mapping PENDING | NOT VERIFIED |
| §27 | Exact economic binding correction (2026-09-09) | Cross-document mapping PENDING | NOT VERIFIED |
| §28 | Real-money agreement and dispute-authority correction (2026-09-09) | Cross-document mapping PENDING | NOT VERIFIED |

**Source integrity:** 29/29 top-level numbered ADR heading occurrences indexed; **normative obligation-level coverage:** NOT MEASURED; **acceptance:** NOT VERIFIED. This register is a structural checkpoint, not a release gate.


### #105-to-ADR crosswalk — bounded gate-level mapping (2026-10-25)

**Method:** Each of the 54 canonical #105 entries inherits a **candidate ADR topic family** from its gate. These are review pointers, not proven one-to-one normative equivalences. ADR subclauses, cold-sweep, BACKLOG prose, owners and SHA-level implementation/evidence must be inspected before marking a row accepted. Multiple rows can map to one ADR family; one row can require multiple proofs. No new authority is created.

| #105 item | Gate | Candidate ADR-001 sections (review pointers) | Master owner/evidence |
| --- | --- | --- | --- |
| 1 | A | §21, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 2 | A | §21, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 3 | A | §21, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 4 | B | §15, §20, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 5 | B | §15, §20, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 6 | B | §15, §20, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 7 | B | §15, §20, §25 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 8 | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 9 | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 10a | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 10b | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 11 | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 12 | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 13 | C | §2, §3, §7, §7.1, §26, §27 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 14 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 15 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 16 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 17 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 18 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 19 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 20 | D | §4, §5, §6, §9, §26 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 21 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 22 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 23 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 24 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 25 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 26 | E | §3, §8, §11, §27, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 27 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 28 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 29 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 30 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 31 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 32 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 33 | F | §8, §9, §11, §13, §28 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 34 | G | §16, §17 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 35 | G | §16, §17 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 36 | G | §16, §17 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 37 | G | §16, §17 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 38 | H | §18, §19, §20 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 39 | H | §18, §19, §20 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 40 | H | §18, §19, §20 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 41 | H | §18, §19, §20 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 42 | H | §18, §19, §20 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 43 | I | §18, §19, §20, §21 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 44 | I | §18, §19, §20, §21 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 45 | I | §18, §19, §20, §21 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 46 | I | §18, §19, §20, §21 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 47 | I | §18, §19, §20, §21 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 48 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 49 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 50 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 51 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 52 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |
| 53 | J | §11, §21, §23, §24 | OWNER / SHA / CI / INDEPENDENT ACCEPTANCE: NOT VERIFIED |

**Bounded progress:** 54/54 #105 source entries assigned to a gate-level ADR review family; **0/54 independently validated at item-level by this crosswalk** (not a claim that none were implemented or accepted elsewhere). BACKLOG line-level joins, item-specific normative deduplication, and evidence ownership are still OPEN. **No global Master percentage.**


### BACKLOG line-anchored cross-check — sampled semantic joins (2026-10-25)

This is a **seven-family source-presence sample**, not exhaustive 54-item or 5,906-line coverage. Lines refer to `docs/BACKLOG.md` as read at PR #531 head on this date. A text match proves the topic is present, **not** that its requirements are current, implemented, accepted, or identical to the #105 item. Every candidate still requires full paragraph reading, temporal supersession analysis and independent proof.

| #105 gate family | BACKLOG line | Source excerpt (topic only) | Status |
| --- | --- | --- | --- |
| D | L1549 | 1. **Gossip catch-up / anti-entropy / partition healing — Day-0.** | CANDIDATE MATCH / NOT ACCEPTED |
| C | L1445 | 4. **Persistent Node Identity (ADR-001 §7) — corrected, 2026-09-09, CTO | CANDIDATE MATCH / NOT ACCEPTED |
| E | L1716 | 13. **Trade-open exact revision/terms commitment + replay safety — | CANDIDATE MATCH / NOT ACCEPTED |
| G | L1462 | **Updated again, 2026-09-09 (CTO Gate, Fase 2-5/9) — Node Contribution | CANDIDATE MATCH / NOT ACCEPTED |
| H | L1679 | Partner Beta Readiness, stranger developer, stranger node, partner | CANDIDATE MATCH / NOT ACCEPTED |
| I | L828 | ## Partner Beta / Integration Reality (2026-09-08) | CANDIDATE MATCH / NOT ACCEPTED |
| F | L1655 | - Tombstone Resurrection Test | CANDIDATE MATCH / NOT ACCEPTED |

**Sample coverage:** 7/7 selected topic families have a BACKLOG anchor; **47 other #105 entries are not thereby mapped** and the seven selected families are not an exhaustive partition. **Cross-document obligation denominator and independent acceptance remain NOT MEASURED.**


### BACKLOG semantic presence expansion — 17 bounded topics (2026-10-25)

Search performed against the **5,906-line BACKLOG at the PR branch snapshot**, with case-insensitive literal phrase matching. This improves navigation, **not** normative atomization, proof of implementation, or historical/current authority classification. Counts reflect phrase occurrences and can include superseded claims, negative statements and historical tables; therefore no row is PASS. The earlier seven-topic sample is preserved as a prior checkpoint and must not be added to these 17 as distinct obligations.

| Topic | First BACKLOG line | Literal occurrences | Interpretation |
| --- | ---: | ---: | --- |
| Portable Offer envelope | L1487 | 1 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Participant transport identity | L176 | 11 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Node descriptor | L1561 | 4 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Anti-entropy | L1549 | 2 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Clock health | L1623 | 2 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Trade-open commitment | L1487 | 6 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Payment-destination commitment | L1752 | 4 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Settlement mechanism | L1767 | 1 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Arbitration authority | L1787 | 3 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Inventory reservation | L4295 | 1 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Node switching | L1692 | 1 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Dispute evidence | L3317 | 1 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Contribution accounting | L1415 | 5 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| No-cannibalization | L1416 | 2 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Stranger developer | L831 | 5 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| Partner wallet | L1367 | 5 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |
| External audit | L794 | 2 | TOPIC PRESENT; AUTHORITY / ACCEPTANCE UNKNOWN |

**Search coverage:** 17/17 chosen phrases located; **54-item #105 line-by-line join:** PENDING; **temporal authority adjudication:** PENDING; **independent evidence:** PENDING; **Master denominator:** NOT MEASURED.


### Temporal and deduplication adjudication — seven directly read BACKLOG cases (2026-10-25)

Unlike the earlier literal-search tables, the entries below were classified from the cited BACKLOG passage (some passages wrap across subsequent lines). **Classification concerns source authority and counting only; no row asserts live code, passing CI, independent acceptance or production eligibility.** These cases are not seven completed gates.

| Case | BACKLOG anchor | Source-authority classification | Decision / residual verification |
| --- | --- | --- | --- |
| FeeDistribution legacy | L63 | SUPERSEDED HISTORICAL IMPLEMENTATION | Same BACKLOG row explicitly supersedes FeeDistribution/chargeProtocolFee with FeeCollectionEvidence → FeeObligation → frozen DistributionPolicyVersion → EntitlementLedgerEntry. Do not carry historical DONE forward. |
| Node identity taxonomy | L1445 | CORRECTED / SPLIT | Participant transport identity B and operational node identity C must be separate; reference transport persistence cannot close operational identity C. |
| Contribution accounting | L1462 | EXPLICIT SUB-OBLIGATION / NOT NEW TOP-LEVEL | BACKLOG says accounting and incentive compatibility belong inside the already-counted implementation sequence, not extra top-level Master obligations. |
| Anti-entropy | L1549 | CURRENT REQUIREMENT / EVIDENCE UNKNOWN | Late-join and partition-heal convergence requires more than new-event flood gossip; no implementation acceptance inferred. |
| Trade-open exact commitment | L1716 | CURRENT REQUIREMENT / EVIDENCE UNKNOWN | Exact accepted revision and economic terms plus replay safety required; document presence is not proof. |
| Fiat/payment destination | L1752 | CURRENT REQUIREMENT / EVIDENCE UNKNOWN | Exact fiat terms and private payment-destination commitment required; no public gossip of raw instructions. |
| Stranger developer | L4294 | EXPLICITLY ALREADY COUNTED | BACKLOG labels the independent developer test canonical/current and already present in #105; no duplicate obligation registration. |

**Adjudicated sample:** 7/7 selected source passages classified for temporal/deduplication meaning; **54-item item-level evidence adjudication:** PENDING; **Master global numerator/denominator:** NOT MEASURED. Do not add these seven to the 17-topic search or 54 source entries as distinct obligations.

## Beta evidence registry boundary — #165 independently inspected 2026-10-25

Issue #165 is OPEN and owns **scenario-level integration and reality-validation evidence**; it is not interchangeable with #105 (multi-node), #125 (documentation), #420 (incident corpus), or this documentation-only PR. Its issue body was read directly during this pass. This ledger does **not** claim scenario PASS counts without a per-scenario evidence check, and it does not collapse issue-level OPEN into individual scenario FAIL. Incoming CTOs must follow #165's exact scenario statuses and latest comments rather than treating a completed implementation or green CI as Beta acceptance.

### Closure boundary to avoid false 100%

- **Handoff documentation 7/8:** accurately inventoried and time-qualified, but final exhaustive evidence reconciliation and independent CTO sign-off remain incomplete.
- **Master backlog:** global obligation denominator and accepted numerator are not established; **NOT MEASURED**.
- **Day-0 network #105:** normative obligations/gates enumerated, but gate evidence **NOT VERIFIED**.
- **Beta #165:** scenario evidence **NOT VERIFIED** by this pass.
- **Public documentation #125:** separate external reconciliation **NOT VERIFIED**.
- **PR #531:** draft; this branch is a proposed canonical update, not current main.

**No automatic promotion:** A future CTO may not change any of these to PASS solely because this ledger is detailed, the document grows, or the CI passes. Require independent gate evidence and explicit authority.

## Incoming CTO safe-start decision card — 2026-10-25

**Current snapshot, not a standing authorization.** On each new session, refetch repository state before acting.

| Question | Answer supported by this record | What is forbidden to infer |
| --- | --- | --- |
| What is the project's phase? | Protocol architecture freeze historically done; Day-0 implementation/hardening and evidence gates open | RC/Beta or production-ready |
| Where do I begin? | BACKLOG current-truth warning → this ledger → accepted ADRs → #99/#221 → #105/#165/#125 → live PRs and CI | A chat summary is the new source of authority |
| Is the Master 100% complete? | NO. Normative obligation-level denominator and accepted numerator NOT MEASURED | 56 historical table rows or 53 issue search hits represent total work |
| Are P3/P4 changes in main? | The cited PR snapshot says DRAFT and unmerged; recheck live state | Green CI equals merged or deployed |
| Who may decide? | CTO/Gatekeeper with bounded independent evidence and explicit authority | Claude, Codex or automated review independently grants merge/freeze |
| Can I start the next phase? | Only the independently accepted gate permits its dependent stage | Documentation progress unblocks production |
| What if two sources disagree? | Preserve dated claims, cite current normative owner, mark unresolved and escalate | Prefer newest chat or old DONE uncritically |

**Gatekeeper stop condition:** if the task depends on an unknown SHA, unknown accepted scope, disputed economic authority, unclear migration environment, or stale issue state, stop that bounded action and gather evidence. Continue unrelated safe documentation/research work without inventing clearance.

**Documentation closure decision:** Check 8 remains PENDING. The record is usable as a provisional navigation guide now; it cannot honestly reach 8/8 until the full obligation-by-obligation audit and independent CTO sign-off. The #125 external documentation gate and merge to main are separate approvals. No automatic merge, deploy, DB migration or production promotion.

## Master prose coverage map — 2026-10-25 (structure, not accepted obligations)

The canonical BACKLOG snapshot contains **5906 lines**. Its narrative sections carry obligations and correction notes not represented by the 56 mechanical table candidates. The following is a navigation inventory of all level-2 sections, not an exhaustive atomic obligation census. A new CTO must not assume that table extraction captures every Day-0 requirement.

| BACKLOG line | Narrative section | Audit disposition |
| ---: | --- | --- |
| 12 | Phase Verification — where the project actually stands | PROSE REVIEW REQUIRED |
| 51 | P0 — Core Primitives (block everything else) | PROSE REVIEW REQUIRED |
| 84 | P1 — First Proven Module + SDK Core | PROSE REVIEW REQUIRED |
| 93 | Known Debt — MULTISIG production-hardening (Missão 09 final freeze, 2026-08-18) | PROSE REVIEW REQUIRED |
| 245 | P2 — Cross-Module Services | PROSE REVIEW REQUIRED |
| 264 | P3 — Advanced / Aspirational Modules | PROSE REVIEW REQUIRED |
| 275 | Developer Experience / Tooling (out-of-band — doesn't gate any module) | PROSE REVIEW REQUIRED |
| 284 | Why the Order Differs From Pure Priority | PROSE REVIEW REQUIRED |
| 297 | Traceability Rule (per `GOVERNANCE.md` §6B, now in effect) | PROSE REVIEW REQUIRED |
| 306 | Update — Multi-Wallet-Kit + Multi-Rail Network-Effect Strategy (2026-09-07) | PROSE REVIEW REQUIRED |
| 376 | Identity Root & Multi-Protocol Identity UX (registered 2026-09-08) | PROSE REVIEW REQUIRED |
| 559 | `docs/CRYPTOGRAPHIC_MODEL.md` §1 documentation drift (found 2026-09-08, Identity Architecture Discovery) — CLOSED (corrected 2026-09-08, Institutional Cold Sweep) | PROSE REVIEW REQUIRED |
| 610 | Institutional Cold Sweep / Production Readiness (2026-09-08) | PROSE REVIEW REQUIRED |
| 828 | Partner Beta / Integration Reality (2026-09-08) | PROSE REVIEW REQUIRED |
| 959 | Day-0 Multi-Operator Sails Network / Node Independence (2026-09-08) | PROSE REVIEW REQUIRED |
| 1376 | ADR-001 Day-0 Multi-Operator Sails Network — decision registered (2026-09-09) | PROSE REVIEW REQUIRED |
| 1524 | Day-0 Completeness Cold Sweep — network continuity beyond the happy path (2026-09-09) | PROSE REVIEW REQUIRED |
| 5880 | OpenProof Day-0 Timestamp Anchoring — Multi-Calendar Availability Invariant (2026-09-20) | PROSE REVIEW REQUIRED |

### Remaining closure boundaries, explicitly owned

- **Obligation normalization:** each normative 'MUST/shall/required' statement in prose and correction notes requires a stable ID, source section, exact implementation/evidence and accepted scope. Owner: CTO/Gatekeeper, coordinated via #221 and canonical BACKLOG. **OPEN**.
- **Independent code/evidence verification:** especially #105 network, #165 Beta, #293 P2P, #125 documentation, P3/P4 economic safety. Owner: respective gate issues. **OPEN**.
- **External docs:** GitBook/Mintlify comparison is #125, not implicitly completed by PR #531. **OPEN**.
- **Documentation acceptance and merge:** #531 remains draft; review must verify that no historical claims were silently rewritten. **PENDING CTO decision**.

### Do not confuse three percentages

1. **87.5% = 7/8 handoff documentation checklist**, a process-readiness metric.
2. **Master completion = NOT MEASURED**, because normative obligation denominator and accepted numerator are incomplete.
3. **Day-0 / Beta / production readiness = NO-GO**, separately gated; no percentage inferred from documentation.

## Continuity verification loop — 2026-10-25 (live recheck)

**Recheck scope:** PR #531 state, current branch content, Master warning and seven core institutional gate issues. This is a bounded repeatable handoff check, not an independent acceptance of all Master obligations.

- PR #531: OPEN, draft=true, merged=false; inspected head SHA `216d74d6f23d9fc5da5d9a482d37a43acf460775` before this documentation update. Never treat this SHA as the new head after the update.
- `docs/BACKLOG.md`: current-reality warning present on reconciliation branch.
- Core owner issue states at check time: #105 OPEN; #125 OPEN; #165 OPEN; #221 OPEN; #293 OPEN; #420 OPEN; #500 OPEN.
- The 29/29 economic/security issue-state checks in this ledger **do not** equal 29 independent acceptances. All remain unverified for that purpose.
- **Gate status:** YELLOW for documentation review; Master acceptance NOT MEASURED; production NO-GO.

### Required next reviewer actions (check 8)

1. Identify every prose-only normative obligation and assign a stable identifier; deduplicate historical revisions against accepted ADR/RFC and live issue owner.
2. Sample-check every 'DONE', 'CLOSED', 'BLOCKED' and 'SUPERSEDED' historical row against the latest correction and exact code/evidence; log unresolved conflicts, never silently mark accepted.
3. Obtain independent CTO sign-off on the resulting denominator and evidence mapping, including #125's separate GitBook/Mintlify gate.
4. Only after the review decide whether #531 is ready to leave draft and merge. No implicit approval is granted here.

**Next-turn safety:** If another CTO has updated this branch, refetch its current blob SHA before writing. Do not overwrite concurrent work.

## Verification loop — 2026-10-25 00:53 local: current-state reconciliation

**Live recheck:** #531 remains OPEN / DRAFT / NOT MERGED. The current document includes 29/29 directly fetched issue-state checks under **Direct issue-state verification**; a prior claim that the check was missing was superseded by later branch work. The exact section heading differs from the earlier planned heading; absence of that string alone is not absence of the evidence. No independent acceptance of the 29 risks is claimed.

**Measured documentation score:** **7/8 (87.5%)** checks PASS in the bounded *CTO handoff readiness scorecard*; check 8 remains FAIL/PENDING. This is **not** 87.5% of Master technical completion, 87.5% of Day-0 readiness, or a claim that the 8 checks have equal risk/effort. The remaining check is large and cannot be inferred to be 12.5% of effort.

**Unresolved before check 8:** exhaustive prose extraction and deduplication; comment-level temporal correction review; per-obligation code/PR/SHA/CI/independent acceptance; GitBook/Mintlify #125 gate; CTO sign-off and main merge. None are bypassed by a green workflow or an executor's self-report.

**Continuation protocol:** future CTO must first re-fetch this file's blob SHA and #531 HEAD, review the open contradictions, and record the next verification loop. No merge/deploy/migration/production approval from this entry.

## Verification loop — 2026-10-25: temporal contradiction register

The following are **explicit resolution rules**, not implementation acceptance:

| Conflicting statements | Correct time-qualified reading | Source of decision / still needed |
| --- | --- | --- |
| Historical six-stage phase table says Implementation Review still lacks OpenProof / real settlement providers; later correction says implementations exist | Earlier snapshot superseded for *existence*, but real providers remain production-ineligible absent separate authorization | BACKLOG.md 2026-09-06 correction; release gate still open |
| Old FeeDistribution row marked DONE; later economy migration write-froze it | Do not use historical FeeDistribution write path; later frozen policy/evidence chain is current economic authority | BACKLOG.md P0 row with 2026-08-23 supersession; code/DB gate still independently checked |
| #275 closed, #125 open | Historical reconciliation program closure does not close live public/developer docs alignment | #275 closed; #125 open |
| #361 Sails Market fleet, #105 independent multioperator | Fleet is bootstrap/operations, not proof of independent operator diversity | #105 and ADR-001; external network evidence pending |
| #420 corpus and #500 continuous gap discovery | Different gates: incident-precedent corpus in Beta sequence vs ongoing production-gap audit | Both open; no substitution |
| #525 CI success and draft status | CI green at exact SHA, but review, DB migration and production approval remain separate | PR #525, run 40145591634; independent acceptance pending |
| #531 handoff score 7/8 and Master completion | 87.5% refers only to bounded documentation checklist, not Master technical or release readiness | This ledger; global Master denominator not accepted |
| #221 early Codex-primary wording and later comments | Open CodeReview + Claude Code primary review; Codex complementary verifier | #221 later correction comments; CTO retains gate |

**Temporal safety rule:** any new CTO must attach a date and authoritative owner to each status claim. When two sources differ, keep both in the contradiction register and explicitly identify supersession; never choose by conversation order alone.

### Independent review boundary

The 8th handoff check cannot be marked PASS merely by adding more indexes. It requires a reviewed obligation denominator, duplicate/superseded disposition, individual evidence links and CTO sign-off. This loop improves clarity but leaves the score **7/8 = 87.5%**. Main merge and GitBook/Mintlify #125 remain unapproved.

## Gatekeeper verification — 2026-10-25 00:55 local: eliminate false missing-evidence alert

**Direct inspection of PR #531 HEAD `dd1857272b3dfa0179c99b68a1c085d9f2c5548e`:** the previously reported missing 29-issue verification is **present** under the exact heading `Direct issue-state verification — 2026-10-25`. The earlier alert was a false negative caused by checking for a different planned section heading, not by absence of the verification data. Do not instruct the next CTO to 'restore missing 29 issue section' based on that obsolete alert.

**Scope of that verification:** 29/29 individually fetched issue *states*, **zero claims of independent acceptance**. It is a registry consistency check, not an implementation, security or production clearance. The handoff checklist remains **7/8 = 87.5%**; check 8 remains pending substantive evidence and independent CTO approval. No branch merge, database migration, staging, or release is authorized.

**Safe continuation:** re-fetch live #531 HEAD and file blob before editing; inspect exact section content instead of relying on heading-string matching; compare against the current default-branch Master and issue comments; append contradiction resolution with time and owner. This correction supersedes earlier chat claims that the 29-item register was absent.

## Independent CTO review packet — 2026-10-25 (check 8 still gated)

### Revalidated source snapshot

- GitHub PR #531 remains **OPEN / DRAFT / NOT MERGED** at HEAD `a3a95add20233109af99953914f207cdee7ddde5` when this review started. Re-fetch HEAD before any future edit.
- The 29 issue-state records **are present** in `Direct issue-state verification — 2026-10-25`; the earlier missing-section alert was an incorrect heading match.
- This file already has a network obligation extraction (ADR-001 and #105), a #165 Beta evidence boundary and a Master prose coverage map. Do not recreate these as parallel ledgers.

### Remaining check-8 acceptance matrix

| Requirement | Current evidence | Disposition |
| --- | --- | --- |
| Canonical entrypoint + temporal source hierarchy | In this ledger and docs/BACKLOG.md warning | Documented; requires CTO review |
| Known historical contradictions | Contradiction register, #221 review-tool correction, #275/#125 distinction | Documented; requires CTO review |
| Issue and PR state inventory | 53 lexical issue candidates, 29 individually inspected, draft PR topology | Partial coverage; live states are not implementation acceptance |
| Master normative obligation denominator | 56 historical table candidates plus prose and ADR/#105 extraction | **NOT FROZEN**; overlaps, duplicates and supersessions not individually dispositioned |
| Per-obligation evidence and independent gate | No complete joined owner→code→SHA→test→independent-acceptance table | **BLOCKED** for global completion claim |
| Documentation publication | PR #531 draft; #125 cross-surface gate open | **NOT PUBLISHED / NOT ACCEPTED** |

### Gatekeeper instruction

**Check 8 is NOT PASS.** Documentation handoff score stays **7/8 (87.5%)**, a bounded checklist only. The full Master closure percentage remains **NOT MEASURED**. To close check 8, an independent reviewer must freeze the normalized denominator, resolve every duplicate/superseded item with canonical owner, link exact evidence and record an explicit decision. A reviewer may approve the handoff documentation as an accurate *open-work map* without claiming technical Master completion, but must record that narrower acceptance explicitly.

No merge, shared database migration, VPS staging, production deploy, or release authorization follows from this packet.

## Closure contract for check 8 — 2026-10-25 (bounded decision)

**Current check 8:** BLOCKED, not failed. The missing artifact is a normalized *obligation-level* join, not another summary or a new percentage estimate. A reviewer can close the documentation handoff separately from the technical Master only by accepting this open-work map with explicit limitations.

### Required evidence fields for each normalized obligation

| Field | Required value |
| --- | --- |
| obligation_id | Stable ID and source line/ADR paragraph/issue clause |
| normative_owner | One accepted spec/ADR/issue gate; supporting sources are links only |
| time_basis | Decision date and supersession/correction chain |
| scope | Day-0 blocker / Beta evidence / post-Master discovery / historical only |
| lifecycle | OPEN / IMPLEMENTING / EVIDENCE PENDING / ACCEPTED / BLOCKED / DEFERRED with owner |
| implementation | PR, commit SHA, code path, migration and environment |
| proof | CI run, targeted test, independent reviewer, scenario result and limitations |
| closure | Explicit CTO decision and date; otherwise NOT ACCEPTED |

### Review gates and precise stop conditions

1. **Coverage:** every candidate from the 56 historical table rows and prose sections plus ADR-001/#105 and open issues is assigned to a normalized obligation or marked non-normative with a reason.
2. **Temporal correctness:** every contradictory DONE, superseded fee model, provider authorization claim and old phase label has a named current authority and traceable correction.
3. **Audit mapping:** P2/P3/P4, CI, security, P2P, beta and network audits have named owner, last SHA and evidence gap; open PR does not imply accepted.
4. **Independent verification:** reviewer who did not author the inventory signs off on coverage and classification; unresolved items remain explicit blockers, not hidden.
5. **Publication:** only after review, authorize merge of #531 independently. #125 GitBook/Mintlify synchronization is its own later gate and cannot be inferred from repository merge.

### Stop / go decision

- **GO for continued engineering:** yes, existing bounded missions can continue with their own gatekeepers; no need to wait for technical Master 100% to fix a documentation index.
- **NO-GO for claiming documentation reconciliation 100%:** check 8 pending independent coverage acceptance.
- **NO-GO for technical Master 100%, Beta, production or deploy:** no global denominator, independent release acceptance or live economic rehearsal.
- **Escalation:** if an incoming CTO encounters an unresolved historical conflict, record a contradiction and ask the canonical owner rather than inventing an answer or reimplementing an already superseded path.

## Independent reviewer addendum — 2026-10-25

- PR #531 inspected at `93149a707bbe505c19325b5c19fe170654a51ab4` before this review's documentation corrections: OPEN / DRAFT / UNMERGED; 3 changed documentation files; zero registered PR reviews. Check HEAD again before next action.
- **Current bounded score: 7/8 = 87.5% recorded controls, not accepted release obligations.** The 6/10 and 8/12 checklists in CTO_START_HERE.md are historical, superseded authoring measurements. Check 8 remains pending.
- Defect confirmed: 53 lexical Day-0 index issue numbers are `#undefined`; treat its titles as *unlinked candidates* until verified IDs are populated. Do not duplicate the separately present 29-issue OPEN-state verification.
- Rechecked P2/P3/P4 PRs #512, #515, #516, #519, #521, #523 and #525: all OPEN / DRAFT / NOT MERGED at this review; base branches of #523 and #525 are stacked, not `main`.
- Rechecked core issues #99, #105, #125, #165, #221, #293, #420, #500: OPEN; issue state is not an independent acceptance.
- **Reviewer decision: YELLOW for check 8.** The branch is usable as a provisional operational handoff map with disclosed imperfections, but is not independently signed off as a complete, normalized Master obligation-to-evidence ledger. Separate gates govern #125 public docs, #531 merge, Master technical closure and release.
- **Next bounded steps:** (1) correct issue IDs by title-to-live-GitHub validation; (2) normalize and deduplicate normative obligations across the entire prose Master, ADR-001, #105 and current owners; (3) map each to code/PR/SHA/CI/independent acceptance or explicit UNKNOWN; (4) log unresolved contradictions; (5) obtain independent reviewer and designated CTO gate sign-off for the accurately bounded documentary scope. Never infer production clearance.


**Issue-index reconciliation checkpoint (2026-10-25):** 53/53 lexical index rows have exact title-to-GitHub issue-number matches; zero unmatched/ambiguous. Master normative denominator remains NOT MEASURED; check 8 remains PENDING.
