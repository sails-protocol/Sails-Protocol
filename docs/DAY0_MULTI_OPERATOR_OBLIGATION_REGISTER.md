# Day-0 Multi-Operator Obligation Register — bounded source normalization

**Date:** 2026-10-25. **Status:** DRAFT / NOT INDEPENDENTLY ACCEPTED. **Canonical source:** [issue #105](https://github.com/sails-protocol/Sails-Protocol/issues/105), execution-order items 1–53 with 10a/10b split. This is an exact **54-source-entry register**, NOT the deduplicated Master Backlog obligation denominator, not a statement that all 54 lack implementation, and not a 54-item completion percentage. Multi-line normative details remain in #105; labels are navigation summaries only.

**Normalization:** stable local keys MO-001…MO-053 (MO-010a/b), source gate, canonical evidence owner, provisional lifecycle, proof and closure. ADR-001 owns architecture, #105 completion; these are not additive obligations. `EVIDENCE PENDING` means **this reconciliation has not independently verified acceptance**, not proof that code is absent. Every entry requires a code/PR/commit/CI and scenario evidence join, or an explicit supersession/de-duplication decision, before reviewer sign-off. No assignee or reviewer is invented.

| Local key | Gate | Source clause | Short requirement | Authority / routing | Lifecycle (provisional) | Independent proof | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MO-001 | A | #105 item 1 | Merge/freeze PR #106 institutional memory after CTO Gate + green CI. | #105 (completion gate); audit §57/§61 for items 2/3 | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-002 | A | #105 item 2 | Resume and close Technical Debt #57 (`buildApp()` parallel contention) so the harness does not produce false evidence during the Day-0 implementation program. | #105 (completion gate); audit §57/§61 for items 2/3 | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-003 | A | #105 item 3 | Close #61 Public OfferDetail privacy defect before any partner receives the current endpoint. | #105 (completion gate); audit §57/§61 for items 2/3 | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-004 | B | #105 item 4 | Publish the Partner Beta Asset × Network/Rail × Wallet Adapter × Settlement Capability × Maturity matrix. | #105 (scope gate); ADR-002 architecture-only | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-005 | B | #105 item 5 | Decide whether first beta is BTC-only, bounded BTC+USDT, or includes DePix. | #105 (scope gate); ADR-002 architecture-only | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-006 | B | #105 item 6 | If DePix is in scope, make DePix representable end-to-end and do not claim support before its real settlement path is eligible. | #105 (scope gate); ADR-002 architecture-only | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-007 | B | #105 item 7 | Freeze the fiat quote-currency scope for the beta. | #105 (scope gate); ADR-002 architecture-only | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-008 | C | #105 item 8 | Implement canonical signed OfferEnvelope, including exact asset + network/rail + quote-currency semantics needed by the beta. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-009 | C | #105 item 9 | Implement stale-resurrection-safe revision/tombstone persistence. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-10a | C | #105 item 10a | Implement **Participant Transport Identity (B) persistence** — a | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-10b | C | #105 item 10b | Design and implement **Operational Sails Node Identity (C)** — an | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-011 | C | #105 item 11 | Implement Economic Identity (A) ↔ Participant Transport Identity | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-012 | C | #105 item 12 | Implement Operational Sails Node Identity (C) lifecycle: backup, | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-013 | C | #105 item 13 | Implement self-authenticating Node Descriptor, signed/authenticated | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-014 | D | #105 item 14 | Implement bootstrap + peer exchange without mandatory Satsails authority. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-015 | D | #105 item 15 | Implement signed Offer gossip + dedup. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-016 | D | #105 item 16 | Implement catch-up / anti-entropy for late join and partition healing. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-017 | D | #105 item 17 | Implement multi-node discovery/convergence into the local order-book projection. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-018 | D | #105 item 18 | Implement gossip resource bounds/backpressure. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-019 | D | #105 item 19 | Demonstrate peer diversity / eclipse / selective-forwarding resilience. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-020 | D | #105 item 20 | Define clock-health behavior for signed expiries. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-021 | E | #105 item 21 | Implement jointly-verifiable trade-open anchor binding exact Offer revision/envelope hash, amount, price, asset, network/rail, quote fiat amount/currency, payment method and replay/idempotency context. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-022 | E | #105 item 22 | Bind privacy-preserving payment-destination commitment; keep raw payment instructions private/pairwise. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-023 | E | #105 item 23 | Require authenticated amendment for any post-commit payment-instruction change. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-024 | E | #105 item 24 | Bind the selected settlement mechanism / EscrowType / custody and signer semantics. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-025 | E | #105 item 25 | Bind participant-facing fee/policy version before commitment. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-026 | E | #105 item 26 | Bind arbitration authority/policy/appeal semantics before funds are committed. | ADR-001 (architecture); #105 (acceptance) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-027 | F | #105 item 27 | Implement professional-provider inventory reservation across concurrent acceptance paths. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-028 | F | #105 item 28 | Prove duplicate/replayed trade-open cannot double-commit a limited Offer. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-029 | F | #105 item 29 | Implement cross-node restart/offline/resume using signed trade anchors as re-entry truth. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-030 | F | #105 item 30 | Prove node switching does not create economic amnesia. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-031 | F | #105 item 31 | Make dispute evidence/ruling/appeal continuity independently verifiable across nodes. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-032 | F | #105 item 32 | Prove one party node disappearing does not make a valid dispute unresolvable. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-033 | F | #105 item 33 | Preserve rail-specific funds-authority semantics through resolution. | #105 (completion); #165 (Beta scenarios) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-034 | G | #105 item 34 | Implement Node Contribution Accounting for the contribution classes actually verifiable in Day-0 scope. | #105 (economic gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-035 | G | #105 item 35 | Demonstrate Incentive Compatibility / No-Cannibalization against the real accounting model. | #105 (economic gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-036 | G | #105 item 36 | Keep liquidity propagation rational and do not pay for unverifiable relay claims. | #105 (economic gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-037 | G | #105 item 37 | Keep real payout activation separately gated; accounting/entitlement evidence may run through beta with payout disabled. | #105 (economic gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-038 | H | #105 item 38 | Pass Stranger Node Test. | #105 (independent operation) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-039 | H | #105 item 39 | Pass Independent Node Operator No-Assistance Test. | #105 (independent operation) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-040 | H | #105 item 40 | Pass Stranger Developer Test: integrate SDK from public docs/package with no Satsails team help. | #105 (independent operation) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-041 | H | #105 item 41 | Prove wallet integration and backend/web-service integration paths. | #105 (independent operation) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-042 | H | #105 item 42 | Provide recoverable service-event consumption before public production. | #105 (independent operation) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-043 | I | #105 item 43 | Pass all scope-relevant adversarial tests from `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`. | #105 (Partner Beta); #165 (scenario registry) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-044 | I | #105 item 44 | Run the first independent partner-wallet integration. | #105 (Partner Beta); #165 (scenario registry) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-045 | I | #105 item 45 | Run at least one professional/web-service integration if that class is in beta scope. | #105 (Partner Beta); #165 (scenario registry) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-046 | I | #105 item 46 | Exercise restart, offline, node switch, partition heal, dispute and recovery with no privileged operator shortcut. | #105 (Partner Beta); #165 (scenario registry) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-047 | I | #105 item 47 | Only then claim shared-liquidity multi-node beta evidence for the bounded tested scope. | #105 (Partner Beta); #165 (scenario registry) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-048 | J | #105 item 48 | Run Production Readiness Consolidated Gate. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-049 | J | #105 item 49 | Provider production eligibility per enabled beta/launch rail. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-050 | J | #105 item 50 | Network Simulation + Final Red Team at the accepted sequencing point. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-051 | J | #105 item 51 | External security audit/remediation. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-052 | J | #105 item 52 | RC1 + bounded real-value validation. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |
| MO-053 | J | #105 item 53 | Public production activation only after claim/evidence alignment. | #105 (release gate) | EVIDENCE PENDING | NOT VERIFIED | NOT ACCEPTED |

## Reviewer join procedure

For each row, (1) read complete #105 clause; (2) join BACKLOG prose/table, ADR-001 and relevant code/PR/issue; (3) identify supersession and scope, including audit-local TD §57/§61 (not GitHub issue #57/#61); (4) attach exact source lines, SHA, tests, CI and independent reviewer, or record UNKNOWN; (5) mark duplicate/non-normative with rationale; (6) accept only by explicit authorized gate decision. Gate B freeze does not authorize ADR-002 implementation. Gates H/I/J need independent external/production evidence. Post-Master-100 philosophy conformance is separately scheduled under #125/#165 and does not waive current launch gates.

**Review status:** check 8 in [MASTER_CLOSURE_REALITY_LEDGER.md](MASTER_CLOSURE_REALITY_LEDGER.md) remains YELLOW / 7 of 8 bounded continuity controls. No release/merge/deploy authorization.
