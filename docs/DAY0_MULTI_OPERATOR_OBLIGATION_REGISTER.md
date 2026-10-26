# Day-0 Multi-Operator Obligation Register — bounded source normalization

**Date:** 2026-10-25. **Status:** DRAFT / NOT INDEPENDENTLY ACCEPTED. **Canonical source:** [issue #105](https://github.com/sails-protocol/Sails-Protocol/issues/105), execution-order items 1–53 with 10a/10b split. This is an exact **54-source-entry register**, NOT the deduplicated Master Backlog obligation denominator, not a statement that all 54 lack implementation, and not a 54-item completion percentage. Multi-line normative details remain in #105; labels are navigation summaries only.

**Normalization:** stable local keys MO-001…MO-053 (MO-010a/b), source gate, canonical evidence owner, provisional lifecycle, proof and closure. ADR-001 owns architecture, #105 completion; these are not additive obligations. `EVIDENCE PENDING` means **this reconciliation has not independently verified acceptance**, not proof that code is absent. Every entry requires a code/PR/commit/CI and scenario evidence join, or an explicit supersession/de-duplication decision, before reviewer sign-off. No assignee or reviewer is invented.

| Local key | Gate | Source clause | Short requirement | Authority / routing | Lifecycle (provisional) | Independent proof | Acceptance | Owner issue | Bloqueia |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MO-001 | A | #105 item 1 | Merge/freeze PR #106 institutional memory after CTO Gate + green CI. | #105 (completion gate); audit §57/§61 for items 2/3 | IMPLEMENTED / GATE REVIEW PENDING | PR #106 MERGED; original head 658c4cc: CI Tests, CI, CodeQL SUCCESS. CTO freeze/independent gate sign-off not verified | NOT ACCEPTED | #105; merged PR | PB |
| MO-002 | A | #105 item 2 | Resume and close Technical Debt #57 (`buildApp()` parallel contention) so the harness does not produce false evidence during the Day-0 implementation program. | #105 (completion gate); audit §57/§61 for items 2/3 | PARTIAL IMPLEMENTATION / SYSTEMIC OPEN | PR #115 MERGED; original head 1509690: CI Tests, CI, CodeQL SUCCESS; Swagger UI test isolation only; TD-AUDIT §57 broader contention remains OPEN | NOT ACCEPTED | #105; merged PR | PB |
| MO-003 | A | #105 item 3 | Close #61 Public OfferDetail privacy defect before any partner receives the current endpoint. | #105 (completion gate); audit §57/§61 for items 2/3 | REMEDIATION MERGED / ACCEPTANCE PENDING | PR #117 MERGED; original head e41e83e: CI Tests, CI, CodeQL SUCCESS; public mapper and adversarial HTTP regression test; independent Gate A acceptance not verified | NOT ACCEPTED | #105; merged PR | PB |
| MO-004 | B | #105 item 4 | Publish the Partner Beta Asset × Network/Rail × Wallet Adapter × Settlement Capability × Maturity matrix. | #105 (scope gate); ADR-002 architecture-only | SCOPE DEFINITION / PUBLICATION UNVERIFIED | PROJECT_CONTEXT.md asset direction; #105 capability/maturity matrix publication not verified | NOT ACCEPTED | #105 Gate B | PB |
| MO-005 | B | #105 item 5 | Decide whether first beta is BTC-only, bounded BTC+USDT, or includes DePix. | #105 (scope gate); ADR-002 architecture-only | PRODUCT SCOPE DECIDED / BETA ACCEPTANCE OPEN | BACKLOG.md Gate B later product freeze supersedes #105 choice menu; beta capability gated | NOT ACCEPTED | #105 Gate B | PB |
| MO-006 | B | #105 item 6 | If DePix is in scope, make DePix representable end-to-end and do not claim support before its real settlement path is eligible. | #105 (scope gate); ADR-002 architecture-only | PRODUCT SCOPE FROZEN / SETTLEMENT UNVERIFIED | PROJECT_CONTEXT.md DePix Liquid/Spark future at snapshot; real rail eligibility unverified | NOT ACCEPTED | #105 Gate B | PB |
| MO-007 | B | #105 item 7 | Freeze the fiat quote-currency scope for the beta. | #105 (scope gate); ADR-002 architecture-only | SCOPE DEFINITION / ACCEPTANCE OPEN | BACKLOG.md Gate B later fiat quote scope correction; beta acceptance unverified | NOT ACCEPTED | #105 Gate B | PB |
| MO-008 | C | #105 item 8 | Implement canonical signed OfferEnvelope, including exact asset + network/rail + quote-currency semantics needed by the beta. | ADR-001 (architecture); #105 (acceptance) | PARTIAL IMPLEMENTATION / GATE OPEN | offer-envelope.ts signed schema and offerEnvelope.test.ts exist; exact asset+network/rail+fiat beta semantics and gossip wiring NOT VERIFIED | NOT ACCEPTED | #105 | PP* |
| MO-009 | C | #105 item 9 | Implement stale-resurrection-safe revision/tombstone persistence. | ADR-001 (architecture); #105 (acceptance) | PARTIAL IMPLEMENTATION / RESURRECTION PROOF OPEN | PORTABLE_SIGNED_OFFERS_EVIDENCE.md signed tombstone tests 11/12 and scoped highest lookup; distributed retention unproven | NOT ACCEPTED | #105 | PP* |
| MO-10a | C | #105 item 10a | Implement **Participant Transport Identity (B) persistence** — a | ADR-001 (architecture); #105 (acceptance) | ARCHITECTURE DECIDED / PERSISTENCE UNVERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md §3.5 transport identity B; runtime proof unverified | NOT ACCEPTED | #105 | PP* |
| MO-10b | C | #105 item 10b | Design and implement **Operational Sails Node Identity (C)** — an | ADR-001 (architecture); #105 (acceptance) | ARCHITECTURE DECIDED / NODE RUNTIME UNVERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md §3.5 operational node identity C; runtime proof unverified | NOT ACCEPTED | #105 | PP* |
| MO-011 | C | #105 item 11 | Implement Economic Identity (A) ↔ Participant Transport Identity | ADR-001 (architecture); #105 (acceptance) | IDENTITY LIFECYCLE / RUNTIME PROOF NOT VERIFIED | ADR-001 and DAY0_COMPLETENESS_COLD_SWEEP.md §3.5 (identity separation); item MO-011 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-012 | C | #105 item 12 | Implement Operational Sails Node Identity (C) lifecycle: backup, | ADR-001 (architecture); #105 (acceptance) | IDENTITY LIFECYCLE / RUNTIME PROOF NOT VERIFIED | ADR-001 and DAY0_COMPLETENESS_COLD_SWEEP.md §3.5 (identity separation); item MO-012 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-013 | C | #105 item 13 | Implement self-authenticating Node Descriptor, signed/authenticated | ADR-001 (architecture); #105 (acceptance) | IDENTITY LIFECYCLE / RUNTIME PROOF NOT VERIFIED | ADR-001 and DAY0_COMPLETENESS_COLD_SWEEP.md §3.5 (identity separation); item MO-013 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-014 | D | #105 item 14 | Implement bootstrap + peer exchange without mandatory Satsails authority. | ADR-001 (architecture); #105 (acceptance) | ARCHITECTURE DECIDED / NETWORK PROOF OPEN | SAILS_NODE_SHARED_LIQUIDITY_DISCOVERY.md no shared network at snapshot; bootstrap runtime unproven | NOT ACCEPTED | #105 | PP* |
| MO-015 | D | #105 item 15 | Implement signed Offer gossip + dedup. | ADR-001 (architecture); #105 (acceptance) | SIGNED PRIMITIVES EXIST / GOSSIP UNVERIFIED | offer-envelope.ts schema; PRE_STATE_LIFECYCLE_DECISION_GATE.md §3.2 says not wired to gossip | NOT ACCEPTED | #105 | PP* |
| MO-016 | D | #105 item 16 | Implement catch-up / anti-entropy for late join and partition healing. | ADR-001 (architecture); #105 (acceptance) | REQUIREMENT DOCUMENTED / ANTI-ENTROPY UNVERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md §3.1 late-join/partition-heal gap at snapshot | NOT ACCEPTED | #105 | PP* |
| MO-017 | D | #105 item 17 | Implement multi-node discovery/convergence into the local order-book projection. | ADR-001 (architecture); #105 (acceptance) | REQUIREMENT DOCUMENTED / CONVERGENCE UNVERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md §3.1; independent cross-node convergence unproven | NOT ACCEPTED | #105 | PP* |
| MO-018 | D | #105 item 18 | Implement gossip resource bounds/backpressure. | ADR-001 (architecture); #105 (acceptance) | REQUIREMENT DOCUMENTED / BOUNDS UNVERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md §3.7 gossip resource bounds; relay #307/#499 distinct | NOT ACCEPTED | #105 | PP* |
| MO-019 | D | #105 item 19 | Demonstrate peer diversity / eclipse / selective-forwarding resilience. | ADR-001 (architecture); #105 (acceptance) | NETWORK RESILIENCE / ADVERSARIAL PROOF NOT VERIFIED | ADR-001 and DAY0_COMPLETENESS_COLD_SWEEP.md §3 (network adversarial gaps); item MO-019 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-020 | D | #105 item 20 | Define clock-health behavior for signed expiries. | ADR-001 (architecture); #105 (acceptance) | NETWORK RESILIENCE / ADVERSARIAL PROOF NOT VERIFIED | ADR-001 and DAY0_COMPLETENESS_COLD_SWEEP.md §3 (network adversarial gaps); item MO-020 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-021 | E | #105 item 21 | Implement jointly-verifiable trade-open anchor binding exact Offer revision/envelope hash, amount, price, asset, network/rail, quote fiat amount/currency, payment method and replay/idempotency context. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-021 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-022 | E | #105 item 22 | Bind privacy-preserving payment-destination commitment; keep raw payment instructions private/pairwise. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-022 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-023 | E | #105 item 23 | Require authenticated amendment for any post-commit payment-instruction change. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-023 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-024 | E | #105 item 24 | Bind the selected settlement mechanism / EscrowType / custody and signer semantics. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-024 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-025 | E | #105 item 25 | Bind participant-facing fee/policy version before commitment. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-025 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-026 | E | #105 item 26 | Bind arbitration authority/policy/appeal semantics before funds are committed. | ADR-001 (architecture); #105 (acceptance) | TRADE COMMITMENT / END-TO-END PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md trade-open/economic commitment gap; #105 Gate E; item MO-026 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-027 | F | #105 item 27 | Implement professional-provider inventory reservation across concurrent acceptance paths. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-027 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-028 | F | #105 item 28 | Prove duplicate/replayed trade-open cannot double-commit a limited Offer. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-028 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-029 | F | #105 item 29 | Implement cross-node restart/offline/resume using signed trade anchors as re-entry truth. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-029 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-030 | F | #105 item 30 | Prove node switching does not create economic amnesia. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-030 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-031 | F | #105 item 31 | Make dispute evidence/ruling/appeal continuity independently verifiable across nodes. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-031 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-032 | F | #105 item 32 | Prove one party node disappearing does not make a valid dispute unresolvable. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-032 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-033 | F | #105 item 33 | Preserve rail-specific funds-authority semantics through resolution. | #105 (completion); #165 (Beta scenarios) | RECOVERY GATE / CROSS-NODE PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md cross-node recovery/dispute scenarios; #105 Gate F; item MO-033 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-034 | G | #105 item 34 | Implement Node Contribution Accounting for the contribution classes actually verifiable in Day-0 scope. | #105 (economic gate) | ECONOMIC GATE / RUNTIME PROOF NOT VERIFIED | ADR-001 contribution accounting/incentive requirements; #105 Gate G; item MO-034 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-035 | G | #105 item 35 | Demonstrate Incentive Compatibility / No-Cannibalization against the real accounting model. | #105 (economic gate) | ECONOMIC GATE / RUNTIME PROOF NOT VERIFIED | ADR-001 contribution accounting/incentive requirements; #105 Gate G; item MO-035 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-036 | G | #105 item 36 | Keep liquidity propagation rational and do not pay for unverifiable relay claims. | #105 (economic gate) | ECONOMIC GATE / RUNTIME PROOF NOT VERIFIED | ADR-001 contribution accounting/incentive requirements; #105 Gate G; item MO-036 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-037 | G | #105 item 37 | Keep real payout activation separately gated; accounting/entitlement evidence may run through beta with payout disabled. | #105 (economic gate) | ECONOMIC GATE / RUNTIME PROOF NOT VERIFIED | ADR-001 contribution accounting/incentive requirements; #105 Gate G; item MO-037 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-038 | H | #105 item 38 | Pass Stranger Node Test. | #105 (independent operation) | EXTERNAL INTEGRATION / INDEPENDENT PROOF NOT VERIFIED | PARTNER_BETA_INTEGRATION_REALITY.md §§10–11 independent stranger/operator evidence bar; #105 Gate H; item MO-038 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP* |
| MO-039 | H | #105 item 39 | Pass Independent Node Operator No-Assistance Test. | #105 (independent operation) | EXTERNAL INTEGRATION / INDEPENDENT PROOF NOT VERIFIED | PARTNER_BETA_INTEGRATION_REALITY.md §§10–11 independent stranger/operator evidence bar; #105 Gate H; item MO-039 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP |
| MO-040 | H | #105 item 40 | Pass Stranger Developer Test: integrate SDK from public docs/package with no Satsails team help. | #105 (independent operation) | EXTERNAL INTEGRATION / NOT ACCEPTED | PARTNER_BETA_INTEGRATION_REALITY.md §10–11 stranger SDK test bar unmet at snapshot | NOT ACCEPTED | #105; #165 | PB |
| MO-041 | H | #105 item 41 | Prove wallet integration and backend/web-service integration paths. | #105 (independent operation) | EXTERNAL INTEGRATION / INDEPENDENT PROOF NOT VERIFIED | PARTNER_BETA_INTEGRATION_REALITY.md §§10–11 independent stranger/operator evidence bar; #105 Gate H; item MO-041 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PB |
| MO-042 | H | #105 item 42 | Provide recoverable service-event consumption before public production. | #105 (independent operation) | EXTERNAL INTEGRATION / INDEPENDENT PROOF NOT VERIFIED | PARTNER_BETA_INTEGRATION_REALITY.md §§10–11 independent stranger/operator evidence bar; #105 Gate H; item MO-042 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP |
| MO-043 | I | #105 item 43 | Pass all scope-relevant adversarial tests from `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`. | #105 (Partner Beta); #165 (scenario registry) | BETA SCENARIO / INDEPENDENT PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md and PARTNER_BETA_INTEGRATION_REALITY.md independent scenario evidence; #105 Gate I; item MO-043 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-044 | I | #105 item 44 | Run the first independent partner-wallet integration. | #105 (Partner Beta); #165 (scenario registry) | EXTERNAL INTEGRATION / NOT ACCEPTED | PARTNER_BETA_INTEGRATION_REALITY.md §11 independent partner-wallet proof unmet at snapshot | NOT ACCEPTED | #105; #165 | PB |
| MO-045 | I | #105 item 45 | Run at least one professional/web-service integration if that class is in beta scope. | #105 (Partner Beta); #165 (scenario registry) | BETA SCENARIO / INDEPENDENT PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md and PARTNER_BETA_INTEGRATION_REALITY.md independent scenario evidence; #105 Gate I; item MO-045 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PB |
| MO-046 | I | #105 item 46 | Exercise restart, offline, node switch, partition heal, dispute and recovery with no privileged operator shortcut. | #105 (Partner Beta); #165 (scenario registry) | BETA SCENARIO / INDEPENDENT PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md and PARTNER_BETA_INTEGRATION_REALITY.md independent scenario evidence; #105 Gate I; item MO-046 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PB |
| MO-047 | I | #105 item 47 | Only then claim shared-liquidity multi-node beta evidence for the bounded tested scope. | #105 (Partner Beta); #165 (scenario registry) | BETA SCENARIO / INDEPENDENT PROOF NOT VERIFIED | DAY0_COMPLETENESS_COLD_SWEEP.md and PARTNER_BETA_INTEGRATION_REALITY.md independent scenario evidence; #105 Gate I; item MO-047 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | PP* |
| MO-048 | J | #105 item 48 | Run Production Readiness Consolidated Gate. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-048 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP |
| MO-049 | J | #105 item 49 | Provider production eligibility per enabled beta/launch rail. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-049 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-050 | J | #105 item 50 | Network Simulation + Final Red Team at the accepted sequencing point. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-050 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-051 | J | #105 item 51 | External security audit/remediation. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-051 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-052 | J | #105 item 52 | RC1 + bounded real-value validation. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-052 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105; #165 | BC |
| MO-053 | J | #105 item 53 | Public production activation only after claim/evidence alignment. | #105 (release gate) | RELEASE GATE / ACCEPTANCE NOT VERIFIED | #105 Gate J production sequence; #220 production audit, #297 security, #500 discovery as applicable; item MO-053 requires exact runtime SHA, CI and independent scenario; none accepted in this review | NOT ACCEPTED | #105 | PP |


## First evidence join — Gate A and signed-offer partial implementation (2026-10-25)

Live GitHub PR metadata confirms **#106, #115 and #117 MERGED**. Their **original PR head** commits `658c4cc625df5bd01b089376ce938bf172ec632e`, `150969036a13656ff8ed23ae7df6c8ce04da76ea`, and `e41e83ef08dd357228c79d1096571f4b4cf9b7e5` respectively each had **CI Tests / CI / CodeQL completed success** when queried. These are original-head CI observations, **not** merge-SHA checks, fresh execution, or independent acceptance. #106 merge and CI do not independently establish the required CTO freeze; #115 only addresses Swagger UI registration as one §57 contention factor; #117 addresses the narrow public HTTP OfferDetail projection and tests, not wire-gossip privacy. #105 Gate A acceptance is still unverified. Item 8 has signed-envelope primitives but the full beta network/rail/fiat binding and cross-node transport have not been independently verified. See the detailed evidence and caveats in the Master Closure Reality Ledger.

## Parallel evidence triage — 14 further clauses (2026-10-25)

These 14 row updates are **source-grounded triage**, not newly executed tests. They distinguish architecture/product freeze, partial signed-offer implementation and missing independent runtime/partner proof. Source documents are dated snapshots and do not conclusively prove present code absence. Relay security work #307/#499 is not equivalent to economic gossip bounds. No row is ACCEPTED without implementation SHA, reproducible scenario and gatekeeper review.

## Batch normalization — remaining 36 clauses (2026-10-25)

All 54 #105 source entries now have **individual provisional classification**: 4 earlier Gate A/offer entries, 14 earlier architecture/beta/network entries, and 36 gate-specific evidence-demand entries in this batch. This is **100% first-pass triage of the #105 source-entry subset only**; not 100% proof coverage, acceptance, deduplicated Master obligations or technical completion. These 36 updates deliberately identify **the exact class of missing verification** rather than inventing implementation absence, test failures, assignees, audit outcomes or acceptance. Next pass must attach exact code/PR/CI, temporal authority, external operator scenario and reviewer decisions row by row. Independent review remains required.

## Reviewer join procedure

For each row, (1) read complete #105 clause; (2) join BACKLOG prose/table, ADR-001 and relevant code/PR/issue; (3) identify supersession and scope, including audit-local TD §57/§61 (not GitHub issue #57/#61); (4) attach exact source lines, SHA, tests, CI and independent reviewer, or record UNKNOWN; (5) mark duplicate/non-normative with rationale; (6) accept only by explicit authorized gate decision. Gate B freeze does not authorize ADR-002 implementation. Gates H/I/J need independent external/production evidence. Post-Master-100 philosophy conformance is separately scheduled under #125/#165 and does not waive current launch gates.

**Review status:** check 8 in [MASTER_CLOSURE_REALITY_LEDGER.md](MASTER_CLOSURE_REALITY_LEDGER.md) remains YELLOW / 7 of 8 bounded continuity controls. No release/merge/deploy authorization.

## Day-0 reconciliation audit matrix (R01–R104) — provisional reference, 2026-10-26

**Status: PROVISIONAL / NOT INDEPENDENTLY ACCEPTED.** This is the working matrix of the Day-0 reconciliation audit. It is **not** the deduplicated Master Backlog denominator, it does not represent the whole Master Backlog, and no global completion percentage may be derived from it. COVERED means implementation and tests are present on main at the audited SHA (456d3e52, CI green on that SHA); it is not ACCEPTED. Owner is the provisional link decided by the CTO and is not proof of coverage. Degrau is the first release step blocked by an open item: PB = Partner Beta, BC = Controlled Beta, PP = Public Production, PP* = only if a multi-operator claim is made. Rows are in Portuguese, as delivered to the CTO. No row declares an implementation, test or homologation that lacks evidence; R79, R82 and R101 remain DAY0-GAP.

States: COVERED / GATE (implemented, awaiting homologation) / GAP (DAY0-GAP) / POST (POST-DAY0) / CONFLICT.

| ID | Fonte | Requisito | Estado | Evidência | Owner | Degrau |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | RFC-001 | Interface Participant | GAP | sem interface em src; Backlog L53 | #105 item 11 | BC |
| R02 | RFC-002 | Abstração de transporte, Pears/relay | COVERED | transportFallback | – | – |
| R03 | RFC-003/006 | OpenProof primitiva e serviço | COVERED | proofService, proofRegistry | – | – |
| R04 | RFC-004 | Estado de negociação persistido | GAP | negotiation.service.ts:181 (Map) | #165, #293 | PB |
| R05 | RFC-005/013/014 | Capability Registry e enforcement | COVERED | #303 fechado | – | – |
| R06 | RFC-007 | EvidenceProvider S3 e Dispute.evidence | COVERED | PRs #265/#266 (issues abertas) | #234 | – |
| R07 | RFC-007 | Limites, idempotência, cota de upload | GAP | – | #267, #300 | BC |
| R08 | RFC-008 | Hash-chain da Timeline | COVERED | timeline, escrowEventHashChain | – | – |
| R09 | RFC-008/Backlog 09-20 | OTS multi-calendário (≥2 operadores independentes) | GAP | timestamp-anchor.ts:61 | #234 | BC |
| R10 | RFC-009 | Decimais | COVERED | – | – | – |
| R11 | RFC-010 | Event store durável | COVERED | postgresEventStore | – | – |
| R12 | RFC-010 | Garantias de processamento | GAP | handlers.ts; teste BAD | #253, #236 (+#252,#245,#254,#341) | BC |
| R13 | RFC-011 | Reconciliação P2P | COVERED | – | – | – |
| R14 | RFC-012 | Estados de Intent | COVERED | – | – | – |
| R15 | RFC-015 | Aprovação dupla (opt-in) | COVERED | escrowReleaseControls | – | – |
| R16 | RFC-016 | Fronteira fiat do QVAC | COVERED | – | – | – |
| R17 | RFC-017 | Timeline e Social Engineering (flag off) | COVERED | – | – | – |
| R18 | RFC-018 | Intent como entrada canônica | COVERED | intent-handler.ts | – | – |
| R19 | RFC-019 | Fase 1: custódia rotulada, guarda fatal WDK | COVERED | config guard | – | – |
| R20 | RFC-019/020 | ERC-20 não-custodial (guard ERC-20, verificação no cliente, proteção desde a criação, taxa) | GAP | guard só nativo; assinatura às cegas | #105 Gate B, #165 (+#258,#299,#240,#341,#237,#228) | BC |
| R21 | RFC-020 | Taproot/MuSig2 | POST | #121 | #121 | – |
| R22 | RFC-021 | Arbitragem market | POST | ADR-003 | – | – |
| R23 | RFC-021 | Colateral/bond/slashing on-chain | POST | #255, #438 | – | – |
| R24 | RFC-021 D4 | Piso de custo de fabricação | GAP | Escrow.feeCharged sem escritor | #105 Gate B (liga R82) | BC |
| R25 | RFC-021 D5 | Rampa de limite aplicada | GAP | trade.service.ts:109-123 | #235 | BC |
| R26 | RFC-021 D6 | Apelação | POST | só market | – | – |
| R27 | RFC-021 D7 | Vouching (efeito depende de R25) | COVERED | vouchService | – | – |
| R28 | RFC-021 D8 | Segurança da auto-resolução QVAC | GAP | – | #308–#311 | BC |
| R29 | RFC-021 D9 | Recuperação de SPLIT | GAP | – | #247, #250 | BC |
| R30 | RFC-021 D9 | SPLIT em SAFE/Arkade | POST | contrato novo | – | – |
| R31 | RFC-021 D10 | Leituras autenticadas | COVERED | settlementReadAccess | – | – |
| R32 | RFC-022 | Reputação em Lightning | POST | rascunho | – | – |
| R33 | RFC-023 | QVAC propose | COVERED | liquidityProposeForIntent | – | – |
| R34 | RFC-024 | Bitcoin Gen-2 | POST | candidato | – | – |
| R35 | RFC-DRAFT | Paykit | POST | decisão 1 | – | – |
| R36 | ADR-002 | Taxonomia Ativo/Rail, registry 25 linhas | COVERED | settlement-scope-registry | – | – |
| R37 | ADR-003 | Política de arbitragem por trilho | COVERED | arbitrationPolicy | – | – |
| R38 | ADR-004 | Autoridade temporal de grants | COVERED | #216 | – | – |
| R39 | ADR-005 | Autoridade por geração (código) | COVERED | #222/#227 | – | – |
| R40 | ADR-005 | Cenário Beta de corrida | GATE | #225 | #225, #165 | BC |
| R41 | ADR-001 (a) | OfferEnvelope assinado | COVERED | offerEnvelope tests | – | – |
| R42 | Cold Sweep L4 | Projeção pública da Offer | COVERED | publicOfferDetailDisclosure | – | – |
| R43 | ADR-001 (b) | Identidade de transporte persistente | GAP | – | #105 item 10a | PP* |
| R44 | ADR-001 (c) | Vínculo identidade econômica↔transporte | GAP | – | #105 item 11 | PP* |
| R45 | ADR-001 (d) | Bootstrap e gossip | GAP | – | #105 itens 14–15 | PP* |
| R46 | Cold Sweep §3.1–3.2 | Anti-entropia, convergência | GAP | – | #105 itens 16–17 | PP* |
| R47 | Cold Sweep §3.3–3.4 | Node Descriptor, versão de protocolo | GAP | – | #105 item 13 | PP* |
| R48 | Cold Sweep §3.5 | Identidade de nó (C) e destinatário (D) | GAP | – | #105 itens 10b, 12 | PP* |
| R49 | Cold Sweep §3.6–3.8 | Eclipse, limites de gossip, relógio | GAP | – | #105 itens 18–20 | PP* |
| R50 | ADR-001 §27.2 | Âncora de abertura de trade | GAP | – | #105 item 21 | BC |
| R51 | ADR-001 §28.1 | Compromisso fiat e destino de pagamento | GAP | – | #105 itens 22–23 | BC |
| R52 | ADR-001 §28.2–28.4 | Vínculo de mecanismo, taxa e arbitragem | GAP | – | #105 itens 24–26 | BC |
| R53 | ADR-001 §27.3 | Aceitação concorrente, reserva de inventário | GAP | – | #105 itens 27–28 | BC |
| R54 | ADR-001 §9 | Retomada, troca de nó, continuidade de disputa | GAP | – | #105 itens 29–33 | PP* |
| R55 | ADR-001 (j,k) | Contabilidade de contribuição do nó | GAP | – | #105 itens 34–37 | PP* |
| R56 | Cold Sweep §3.10 | Operador independente sobe nó | GATE | PRs #512–#536 | #105 item 39 | PP |
| R57 | ADR-001 §26.9 | Consumo de eventos por serviços | POST | antes da produção pública | #105 item 42 | PP |
| R58 | ADR-001 §18–20 | Testes de estranho e partner beta | GATE | – | #105 H/I, #165 | PB |
| R59 | Backlog item 20 | Matriz Ativo×Rede×Adapter×Maturidade | GAP | AssetType sem DEPIX/USDC | #105 Gate B | PB |
| R60 | ADR-001 §11 | Assinatura de autorização em release comum | GAP | EscrowReleaseApproval sem assinatura | #165 (prov.) | BC |
| R61 | Decisão 1 | OpenIdentity Pubky | GAP | só drafts #543/#545 | #105, #165 | PP |
| R62 | Decisão 1 | Docs "Pubky não obrigatório" vs direção | CONFLICT | notas datadas pendentes | #125 | – |
| R63 | Decisão 1 | PortableData | GAP | – | #105, #165 | PP |
| R64 | Decisão 1 | Pear: persona e recuperação | GAP | spike | #105, #165 | PP |
| R65 | Decisão 1 | Provas econômicas portáteis | GAP | – | #105, #165 | PP |
| R66 | Decisão 1 | Reputação independente de operador | GAP | – | #105, #165, #254, #341 | PP |
| R67 | Backlog/Issues | Cluster temporal, recuperação, crash | GAP | 18 issues | #236–#254,#299,#341,#343,#453 | BC |
| R68 | RFC-007/#293 | Timers, no-show, griefing | GAP | – | #293, #256 | BC |
| R69 | #304 | Actions por SHA | GAP | @v3/@v4 | #304 | PB |
| R70 | #312 | Revogação de sessão | GAP | – | #312 | BC |
| R71 | RFC-002 | Relay: cliente, limites, DHT | GATE | PRs #501/#507 | #307, #497–#499 | PB |
| R72 | #306 | Readiness sem vazamento | GATE | PR draft | #306 | PB |
| R73 | #461/#444 | Dependências | GATE | PR #521 | #461, #444 | BC |
| R74 | P4 Gate 3 | Re-criação de disputa | GATE | PR #525 | #436 | BC |
| R75 | #220/#474 | Superfície de produção, isolamento WDK | GATE | – | #220, #474 | PB |
| R76 | #125 | Verdade documental | GAP | – | #125 | PB |
| R77 | Fila pós-Backlog | Corpus, Red Team, escala | GATE | – | #165, #420, #77, #473 | BC |
| R78 | Horizontes | #86,#152,#75,#78,#84,#124,#121,#231,#155,#158 | POST | – | – | – |
| R79 | ADR-001 §16; decisão 2026-10-26 | Execução automática da distribuição da taxa no settlement (atômica ou encadeada) | GAP | – | #105 Gate B, #165 | BC |
| R80 | Decisão 3 | Rotas de registro/perfil de árbitro com colateral autodeclarado | GAP | settlement.routes.ts | #255 | PB |
| R81 | Decisão 3 | Autoridade de disputa e "sem apelação" no acordo | GAP | appeal só em market | #105 item 26, #165 | BC |
| R82 | Decisão 8b | Taxa 0,40% Day 0 em toda linha de settlement de produção | GAP | só MULTISIG tem código; nada ativado | #105 Gate B, #165 (+#245) | BC |
| R83 | Backlog 20.2 | Carteira de referência: seletor de rede, Spark, DePix | GAP | PublishOffer.tsx mapa 1:1 ativo→rede | #217, #105 Gate B | BC |
| R84 | Backlog 20.4 | Volume cross-asset (totalVolumeBtc soma unidades) | GAP | handlers.ts recordTradeCompletion | proposto #158 | PP |
| R85 | Backlog 20.5 | Contrato de ativos do QVAC (7 de 10) | GAP | qvac-agent.provider.ts | #105 Gate B | BC |
| R86 | Backlog 20.6 | PayoutAddress sem dimensão de rede | GAP | chave (participantId, asset) | #105 Gate B | BC |
| R87 | Backlog 22/24/32 | Reference UI: FundingInstruction/SigningRequest por rail, white-label, dogfooding | GAP | Trade.tsx não exibe multisigAddr | #217 | BC |
| R88 | Backlog 35/46 | Paridade de erros tipados; provider inalcançável = 500 INTERNAL_ERROR | GAP | ERROR_CODE_MAP sem 3 códigos | #165 (prov.), #306 | PB |
| R89 | Backlog 36 (CSC-B03/B04) | Crash recovery fora do MULTISIG: falha fechada, prova #165 §E | GATE | reconciliação só MULTISIG | #165 §E | BC |
| R90 | Backlog 37/46 | Idempotência de criação opt-in; resume de postPersist; job para IdempotencyKey UNKNOWN; pré-condição de migração | GAP | sem job (grep 0) | #165 (prov.) | BC |
| R91 | Backlog 40 | Versionamento de protocolo/API, Decimal wire, expiresAt | POST | missão de decisão não executada | liga R47 | – |
| R92 | Backlog 42–44 | Ciclo de vida de Offer: guard A3 e semântica de PAUSED | GAP | updateOfferStatus só checa dono | #165 (prov.) | BC |
| R93 | Backlog 46 | Spam econômico, identidades e ofertas sem custo (decisão Day 0) | GAP | – | #293 | BC |
| R94 | Backlog 46 | timelockHours sem validação contra janela do trilho (Arkade 144 blocos) | GAP | settlement.routes.ts:75 z.number().optional() | #293 | BC |
| R95 | Backlog 46 | Estados de recuperação: fundo com valor errado, refund sem razão, extensão de prazo, ciência do ruling | GAP | – | #165 §E, #293 | BC |
| R96 | Backlog 45 | OpenAgents: mandato delegado (direção futura) | POST | sem owner | #155 só restrição | – |
| R97 | Backlog 20.1 | Destination Authority nos 5 rails (cooperativo e disputado) | COVERED | disputeDestinationAuthorityConformance | – | – |
| R98 | Backlog 33/38/39 | SPLIT na UI/schemas, privacidade de payout, tipos do SDK, razão de negação | COVERED | tests; reason DISABLED residual | – | – |
| R99 | Backlog 47 | Governança de release da família de SDK (0.2.0) | COVERED | workflows | – | – |
| R100 | Backlog 41 | Paginação do discover (nó único) | COVERED | liquidityDiscoverPagination | – | – |
| R101 | PROTOCOL_ECONOMY §4–6, ADR-001 §16 | Distribuição da taxa de 0,40% (política homologada; classes carteira/nó/árbitro/protocolo; alocação, idempotência, reconciliação; payout separado) | GAP | só classe SAILS_PROTOCOL; ledger real; alocação não ligada; payout inexistente | #105 Gate B, #165 (+#245, #253) | BC |
| R102 | PROTOCOL_ECONOMY §3/§4.4/§6.4(4), RFC-021 D6 | Cobranças além dos 0,40% (taxa opcional por integrador, taxa de arbitragem 1–2% do perdedor, taxa de apelação 2×) conflitam com a decisão do CTO | CONFLICT | DisputeAppealFee só em market; docs | #125 + decisão | BC |
| R103 | ADR-001 §16/§21; PROTOCOL_ECONOMY §6.5 | Payout tratado como etapa/gate posterior vs distribuição automática no settlement | CONFLICT | notas datadas propostas (PR de economia) | #125 | BC |
| R104 | PROTOCOL_ECONOMY §4.4 | Política de remuneração do árbitro (tesouraria) | POST | reserva de 10% é receita da tesouraria, não pagamento automático | – | – |

Count at this date: CONFLICT 3 · COVERED 27 · GAP 51 · GATE 10 · POST 13 = 104.

## MO ↔ R crosswalk and Master Backlog denominator — provisional, 2026-10-27

**Status: PROVISIONAL / NOT INDEPENDENTLY ACCEPTED.** Links marked *explicit* are written in the Owner/Fonte columns of the R01–R104 matrix above; links marked *inferred* are the author's reading and need reviewer confirmation. No row here declares an implementation, test or homologation without evidence.

| MO rows | R rows | Owner issue(s) | Project #3 card | Link |
| --- | --- | --- | --- | --- |
| MO-001..003 | – | #105 | #105 | n/a |
| MO-004..007 | R36, R59 | #105 Gate B, #165 | #105, #165 | explicit |
| MO-008..009 | R41 | #105 | #105 | inferred |
| MO-10a, MO-011 | R43, R44, R01 | #105 items 10a, 11 | #105 | explicit |
| MO-10b, MO-012 | R48 | #105 items 10b, 12 | #105 | explicit |
| MO-013 | R47 | #105 item 13 | #105 | explicit |
| MO-014..015 | R45 | #105 items 14–15 | #105 | explicit |
| MO-016..017 | R46 | #105 items 16–17 | #105 | explicit |
| MO-018..020 | R49 | #105 items 18–20 | #105 | explicit |
| MO-021 | R50 | #105 item 21 | #105 | explicit |
| MO-022..023 | R51 | #105 items 22–23 | #105 | explicit |
| MO-024..026 | R52, R81 | #105 items 24–26 | #105 | explicit |
| MO-027..028 | R53 | #105 items 27–28 | #105 | explicit |
| MO-029..033 | R54, R29 | #105 items 29–33; #247, #250 | #105, #247, #250 | explicit |
| MO-034..037 | R55, R79, R101 | #105 items 34–37 | #105 | explicit |
| MO-038 | R58 | #105, #165 | #105, #165 | explicit |
| MO-039 | R56 | #105 item 39 | #105 | explicit |
| MO-040..041, MO-043..047 | R58 | #105, #165 | #105, #165 | explicit (R58) |
| MO-042 | R57 | #105 item 42 | #105 | explicit |
| MO-048 | R72, R73, R75 | #306; #461, #444; #220, #474 | same Issues | explicit (R72/73/75), inferred (MO↔R) |
| MO-049 | R20, R59, R82 | #105 Gate B, #165 | #105, #165 | explicit |
| MO-050..052 | R77 | #165, #420, #77, #473 | same Issues | explicit (R77), inferred (MO↔R) |
| MO-053 | – | #105 | #105 | n/a |

Issues #121, #155 and #158 (POST-DAY0 or provisional owners) and PR #436 are intentionally not Project cards.

### Master Backlog denominator (BACKLOG.md items 1–47), deduplicated — 117 units

Verified at main SHA 456d3e52 by file/symbol presence only; tests were not run in this pass; nothing is ACCEPTED.

| Block | Units | Code-verified |
| --- | --- | --- |
| 54 MO obligations | 54 | 2 (MO-001 merged doc; MO-003) |
| Item 20 (20.1, 20.4, 20.5, 20.6) | 4 | 1 (20.1) |
| Item 32 (F-01, F-06, F-07, F-09, F-11, F-12) | 6 | 2 |
| Item 34 | 7 | 5 |
| Item 36 (CSC findings, 25 obligations, H01/H02 merged into R91) | 24 | 5 (B01, B02, C01, D01, G01) |
| Items 22–31 | 14 | 3 (items 25, 26, 27) |
| Items 41, 47 | 2 | 2 |
| R89, R90, R92–R95 | 6 | 0 |
| **Total** | **117** | **20** |

Three separate indicators: Project organization 103/103 items with Frente, Workstream, Priority and Risk (Evidence Status filled only where verified: 27/103); verified implementation 20/117 (17%); independent Day-0 homologation 0/25 settlement lines and 0/54 obligations accepted. Not counted as implemented: MO-002 (partial), P3-F08.1/F08.2, the R90 residual.

**Correction 2026-10-27:** CSC-F02 (contest vs. expiry sweep race) was first counted as delivered. Re-checked: contestAutoResolution() still performs a plain prisma.dispute.update() without a conditional claim, and Issue #308 is open; the updateMany found earlier belongs to the appeal path. CSC-F02 is therefore OPEN and the verified count is 20/117, not 21/117.
