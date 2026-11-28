# Architecture Study 02 — Cryptographic Offer-to-Trade Binding

**Classification:** independent documentary audit; complementary; non-normative.  
**Verdict:** **GO_DOCUMENTAL — PRESERVE EXISTING ARCHITECTURE**, restricted to the recommended architectural direction.  
**Primary audit baseline:** `75d14a7b11e2e68bb00ecc2afd6af82add36c88f`.  
**Repository cross-check:** `main` at `0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a` (2026-11-28).  
**Date:** 2026-11-28.

## 1. Purpose and boundary

This record preserves the independent documentary audit of cryptographic binding from an offer to an accepted trade. It is a research and evidence companion, not a normative specification, an ADR, an implementation authorization, or a production-readiness declaration.

The inspection considered the relationship between ADR-001, E21 R1, TradeCommitmentV1, ArbitrationCommitmentV1, persistence of the commitment pair, transactional capacity reservation, and the binding of the pair to escrow.

The primary audit baseline remains the commit identified above. The later `main` cross-check is recorded separately so that subsequent repository state is not silently attributed to the original audit.

## 2. Verdict

**GO_DOCUMENTAL — PRESERVE EXISTING ARCHITECTURE.**

The inspection found the study direction coherent with ADR-001, particularly §27, and found the fundamental economic-binding mechanisms present in the examined artifacts.

No documentary basis was found to replace the existing architecture. The recommended direction is to preserve the existing mechanisms, complete their already-registered obligations, and demonstrate the properties that remain unproven.

This verdict applies only to the documentary direction. It is not a GO for implementation, merge, migration, deployment, homologation, or economic activation.

## 3. Sails evidence examined

The audit selectively examined:

- **E21 R1:** the exact signed OfferEnvelope revision accepted by a trade.
- **TradeCommitmentV1:** the trade commitment and its reference to the accepted offer-envelope digest and logical offer identity.
- **ArbitrationCommitmentV1:** the separate arbitration commitment bound to the trade commitment.
- **Pair persistence:** the durable representation of the bilateral commitment pair.
- **Capacity reservation:** the reservation associated with the COMMITTED transition.
- **Escrow binding:** the reference from escrow to the applicable committed pair.

The later repository cross-check at `main` confirms the relevant implementation surfaces and provides revision-pinned navigation:

- [E21 trade admission service](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-p2p/trade.service.ts)
- [E21 accepted-envelope migration](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/prisma/migrations/20261121120000_trade_accepted_envelope/migration.sql)
- [TradeCommitmentV1](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-p2p/trade-commitment.ts)
- [ArbitrationCommitmentV1](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-p2p/arbitration-commitment.ts)
- [Commitment-pair service](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-p2p/commitment-pair.service.ts)
- [Commitment-pair persistence migration](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/prisma/migrations/20261120120000_commitment_pairs/migration.sql)
- [Escrow service](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-settlement/escrow.service.ts)
- [Escrow repository](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-settlement/escrow-repository.ts)
- [Commitment-pair persistence integration tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/commitmentPairPersistence.test.ts)
- [Accepted-envelope integration tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/tradeAcceptedEnvelope.test.ts)
- [Escrow terms-binding integration tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/escrowTermsBinding.test.ts)

These links identify code and test artifacts. Their presence does not mean this documentary audit executed the tests or independently proved distributed behavior.

## 4. External precedents

The external projects below are distinct implementations. Their properties are useful precedents, not proof that Sails has identical behavior or should copy their architectures.

The source links are pinned to the repository snapshots recorded here for reproducible navigation.

**Pinning note:** the source commit pins below are the exact snapshots used for these permalinks on 2026-11-28. The supplied audit summary stated that three external SHAs had been confirmed but did not enumerate their values; these pins are therefore not asserted to be identical to the original audit pins unless matched against the original source worksheet.

### 4.1 OpenBazaar

Repository: [OpenBazaar/openbazaar-go](https://github.com/OpenBazaar/openbazaar-go)  
Pinned commit: `74075f74a22fff3e24ee0104212b1010b84efe96`.

The RicardianContract schema groups vendor listings, buyer order, vendor confirmation, fulfillment, completion, dispute and resolution records, refund, and a signature collection. The Purchase flow signs the order contract before sending it to the vendor.

Relevant source permalinks:

- [RicardianContract and signature fields](https://github.com/OpenBazaar/openbazaar-go/blob/74075f74a22fff3e24ee0104212b1010b84efe96/pb/protos/contracts.proto#L9-L19)
- [Purchase flow and SignOrder call sites](https://github.com/OpenBazaar/openbazaar-go/blob/74075f74a22fff3e24ee0104212b1010b84efe96/core/order.go#L127-L200)

This demonstrates a staged signed-order/contract structure. It is not treated as equivalent to Sails' OfferEnvelope revision and bilateral trade-commitment model.

### 4.2 Bisq V1

Repository: [bisq-network/bisq](https://github.com/bisq-network/bisq)  
Pinned commit: `c79a2fb078d18d954a361544d88231bbde052cac`.

Bisq V1 is recorded separately from Bisq 2. Its inspected flow includes:

- an OfferPayload hash derived from canonical encoding;
- a maker-created Contract containing the offer payload and trade-specific terms;
- maker signing of the serialized contract;
- taker reconstruction and comparison of the contract representation, followed by verification of the maker's signature.

Relevant source permalinks:

- [V1 OfferPayload hash](https://github.com/bisq-network/bisq/blob/c79a2fb078d18d954a361544d88231bbde052cac/core/src/main/java/bisq/core/offer/bisq_v1/OfferPayload.java#L201-L210)
- [V1 Contract model](https://github.com/bisq-network/bisq/blob/c79a2fb078d18d954a361544d88231bbde052cac/core/src/main/java/bisq/core/trade/model/bisq_v1/Contract.java#L62-L115)
- [Maker creates and signs the Contract](https://github.com/bisq-network/bisq/blob/c79a2fb078d18d954a361544d88231bbde052cac/core/src/main/java/bisq/core/trade/protocol/bisq_v1/tasks/maker/MakerCreateAndSignContract.java#L82-L115)
- [Taker reconstructs and verifies the maker's Contract](https://github.com/bisq-network/bisq/blob/c79a2fb078d18d954a361544d88231bbde052cac/core/src/main/java/bisq/core/trade/protocol/bisq_v1/tasks/taker/TakerVerifyAndSignContract.java#L90-L155)

### 4.3 Bisq 2

Repository: [bisq-network/bisq2](https://github.com/bisq-network/bisq2)  
Pinned commit: `7b7da8016bc5c1eeb75f34448e54992ec96e4563`.

Bisq 2 is not described as a continuation of the V1 implementation details. In the inspected Bisq Easy flow, the trade contract is a two-party contract; ContractSignatureData carries a contract hash, signature, and public key; ContractService derives the hash from the serialized contract and verifies both hash equality and the signature. The take-offer request transports the contract and its signature data.

Relevant source permalinks:

- [Bisq 2 Offer model](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/offer/src/main/java/bisq/offer/Offer.java#L55-L138)
- [Bisq Easy two-party contract](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/contract/src/main/java/bisq/contract/bisq_easy/BisqEasyContract.java#L40-L135)
- [ContractSignatureData](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/contract/src/main/java/bisq/contract/ContractSignatureData.java#L37-L90)
- [Contract hash and signature verification](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/contract/src/main/java/bisq/contract/ContractService.java#L40-L68)
- [Bisq Easy take-offer request](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/trade/src/main/java/bisq/trade/bisq_easy/protocol/messages/BisqEasyTakeOfferRequest.java#L34-L89)
- [Maker contract-hash and signature verification](https://github.com/bisq-network/bisq2/blob/7b7da8016bc5c1eeb75f34448e54992ec96e4563/trade/src/main/java/bisq/trade/bisq_easy/protocol/messages/BisqEasyTakeOfferResponseHandler.java#L42-L66)

### 4.4 Hodl Hodl

Official API documentation: [Hodl Hodl API v1](https://hodlhodl.com/api/docs).

The contract-creation API requires the offer version and payment-method-instruction version. The documentation states that these versions change when the corresponding terms change, so the contract request identifies the versions the user saw. The same endpoint defines a create-request idempotency key: a retry must repeat the identical payload and returns the original contract rather than creating another one.

This is useful evidence of version-bound acceptance and API idempotency. It is not, by itself, evidence of a cryptographic offer signature or a Sails-equivalent bilateral commitment.

## 5. ADR alignment and repository follow-up

### 5.1 ADR-001 §27.2 — accepted Offer revision

[ADR-001 §27.2](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/docs/adr/ADR-001-day0-multi-operator-network.md#L1609) requires the trade-open anchor to commit both parties to one exact economic proposal, including the accepted Offer revision or OfferEnvelope hash.

The current main branch contains E21 R1 service, persistence, and database-guard support for acceptedEnvelopeId. It does not yet expose that optional field through the public trade-creation route and SDK. [PR #771](https://github.com/sails-protocol/Sails-Protocol/pull/771) proposes that API/SDK exposure and corresponding forwarding tests.

The PR is therefore relevant to delivery of the §27.2 property, but the parameter alone is not the cryptographic guarantee: server admission and durable database enforcement remain essential. This documentary note does not authorize the PR's merge.

The direct, verifiable architectural mapping for #771 is ADR-001 §27.2. The related open point is the verification obligation in §6 item 2 (“atomicity between the current accepted revision and the transition to COMMITTED”).

### 5.2 ADR-001 §28.1 — fiat-side obligation

[ADR-001 §28.1](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/docs/adr/ADR-001-day0-multi-operator-network.md#L1669) requires the jointly verifiable agreement to freeze the fiat denomination, fiat amount, payment method, and a verifiable commitment to the payment destination before the fiat-side payment becomes binding.

**Documentary recommendation:** add an explicit reference to ADR-001 §28.1 in the rationale for E22. This clarifies the relationship between the arbitration/commitment record and the real-money agreement without creating a new primitive or changing the architecture.

## 6. Remaining verification obligations

The following remain open and must not be represented as proven by this audit:

1. Full reconciliation of E22 obligations.
2. Technical verification of atomicity between the current accepted revision and the transition to COMMITTED.
3. Evidence of concurrency and consistency across independent nodes.
4. Confirmation of complementary external properties that were not fully inspected.
5. EPM reconciliation of the backlog and live Project #3.

No new Issue, module, primitive, or mandatory infrastructure is recommended by this audit.

## 7. Sails trilemma — open hypothesis

The formulation **Economic Integrity × Economic Sovereignty × Availability of the Economic Commitment** remains an open hypothesis.

It is not promoted to a theorem, protocol invariant, or frozen architectural decision. The audit provides no basis for asserting that the three dimensions have a proven two-of-three trade-off in Sails.

## 8. Backlog Delta

**BACKLOG DELTA: ZERO — CANDIDATE.**

This classification is suitable only as a candidate and remains conditional on operational reconciliation by the EPM. It is not a declaration that all obligations are complete. No duplicate Issue or new infrastructure is recommended at this stage.

## 9. Limitations and authorization boundary

This was a selective documentary inspection of code, migrations, canonical documents, institutional records, and external references.

- No tests were executed as part of this audit.
- Distributed consistency was not fully verified.
- Project #3 was not audited live.
- No vulnerability is declared on the basis of this inspection.
- The existence of test files or prior test reports is not a substitute for a fresh SHA-bound execution and independent review.

The original inspection did not change canonical architecture, create an Issue, or authorize implementation. This file records the non-normative audit and its traceability; it does not authorize implementation, merge, migrations, deploy, homologation, or economic activation.

**Preserve what works. Complete what is missing. Prove what matters.**


## 10. Study decision register — D01 to D09

The following are the nine architectural decisions consolidated by the study. They are not the separately numbered D1–D8 follow-ups recorded in CTO 29 on 2026-11-23.

| Study decision | Consolidated direction |
|---|---|
| **D01** | Preserve the Signed Offer Envelope as the portable, owner-authorized offer object. |
| **D02** | Preserve E21 R1 and the exact accepted revision reference, `acceptedEnvelopeId`. |
| **D03** | Preserve `TradeCommitmentV1` as the bilateral trade commitment. |
| **D04** | Preserve `ArbitrationCommitmentV1` as the distinct arbitration commitment bound to the trade commitment. |
| **D05** | Complete E22; do not treat the payment-destination obligation as already implemented merely because its architectural direction is selected. |
| **D06** | Preserve M-1b and demonstrate its limits under distributed/concurrent conditions; do not add a global lock service by assumption. |
| **D07** | Preserve F4: executable escrows must be bound to the applicable committed pair, with the existing deny-by-default boundary. |
| **D08** | Preserve ADR-001 and Issue #105 as the canonical architecture/evidence authorities. |
| **D09** | Introduce no new structure, primitive, authority or infrastructure without a demonstrable gap and benefit. |

These decisions preserve the existing architecture; they do not authorize new implementation, migration, deployment, homologation or economic activation.

## 11. Twelve adversarial scenario references

The study recorded the following scenario set. These are preserved here as scenario names/references, not expanded into invented acceptance criteria. The exact original per-scenario invariant, expected outcome and evidence mapping must be taken from the source study or its test records.

1. Alteration of an offer after commitment.
2. Substitution of the accepted revision.
3. Cancellation and expiry.
4. Substitution of payment instructions.
5. Replay and duplication.
6. Competing buyers.
7. Node partitions and reconnection.
8. Persistence failures and recovery.
9. Divergence between SDK, UI and backend.
10. Substitution of the resolution authority.
11. Divergence between escrow and commitment.
12. Node migration or loss.

The set is intended to test continuity of the economic agreement across acceptance, commitment, escrow and resolution—not to imply that every scenario has already passed a current, SHA-bound, cross-node test.

## 12. Bastiat — benefit against total cost

The study preserves this decision rule:

> Cada proposta deve ser avaliada pelo benefício demonstrável e pelo custo total de implementação, operação, integração, manutenção, recuperação e auditoria.

Applied to this study:

- **What is gained:** preservation of the economic agreement; independent verifiability; compatibility with different nodes; reuse of mechanisms and work already present.
- **What may be sacrificed:** immediate confirmation when the required guarantees are unavailable.
- **What is not sacrificed:** sovereignty, economic integrity, fund safety and transparency.
- **What is avoided:** a new blockchain, a token, mandatory global consensus, redundant commitments or another central authority.

This is a complexity and cost discipline, not a claim that every operational risk has already been eliminated.

## 13. Open Sails trilemma hypothesis

The study keeps the following as an open hypothesis:

**Economic Integrity × Economic Sovereignty × Availability of the Economic Commitment.**

It is not a theorem, a proven two-of-three constraint, a protocol invariant or a frozen design decision. The study's practical direction is to preserve the agreement and the parties' sovereignty, and to refuse immediate confirmation when integrity cannot be established. This remains a hypothesis to be tested against concrete failure modes.

## 14. E22 — real-money agreement and payment-destination binding

### 14.1 Canonical requirement

ADR-001 §28.1 requires the jointly verifiable agreement, before fiat payment becomes binding, to freeze the exact fiat denomination, exact fiat amount, payment method and a verifiable commitment/reference to the payment destination. Raw payment details remain private and pairwise; a public Offer or network-wide record must not disclose the PIX key or bank account.

Preserved distinctions:

- **Payment destination commitment ≠ Public payment destination.**
- **Chat Instruction ≠ Economic Authority.**

### 14.2 CTO 29 direction — selected, not implemented

The EPM's 2026-11-23 traceability note records the selected direction for E22 (D4, option b):

`paymentDestinationDigest = SHA-256(salt || canonical instruction)`

The digest belongs inside the bilateral commitment (V2), with canonical unambiguous serialization and domain separation. The salt must come from a cryptographic source and have a safe recovery path for both parties. The digest is to be checked at payment confirmation and during dispute. The raw instruction and salt must never enter public logs. `PaymentAccount` remains a separate trust/reputation layer, not a second source of truth for accepted terms. Historical V1 commitments remain valid.

The corresponding versioning direction (D5, option a) is `TradeCommitmentV2` with a new domain tag, `sails-trade-commitment-v2`: V1 signatures remain verifiable byte for byte; unknown versions are rejected; a V2 field is never reinterpreted as if it had been signed under V1.

Source: [EPM traceability note on Issue #105, 2026-11-23](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-7089089195).

**Status boundary:** this is an approved architectural direction, not evidence of implementation or homologation. E22 reconciliation, implementation and evidence remain open. The payment-method requirements in [Issue #735](https://github.com/sails-protocol/Sails-Protocol/issues/735) and private seller receiving-details requirement in [Issue #738](https://github.com/sails-protocol/Sails-Protocol/issues/738) remain related product/contract work; neither is an authorization to migrate or activate.

## 15. Price semantics — reference is not obligation

The study preserves the distinction between a market/reference price and the price that the parties actually accept:

- A market price may inform discovery or negotiation; it is not, by itself, the binding trade price.
- The maker's agreed price/quote becomes binding only when the exact accepted Offer revision and agreed trade terms are committed at trade-open.
- A later market-price movement does not silently rewrite an already committed trade.
- `REFERENCE_PREMIUM` is not authorized by this study.

This is consistent with ADR-001 §27.2 (exact accepted revision and agreed price/quote in the trade-open anchor) and §28.3 (participant-facing fee/policy obligations are frozen before commitment). Do not present a reference-price display as an accepted economic obligation.

## 16. Existing mechanisms — status and boundaries

This section records the repository cross-check at main `0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a`. It distinguishes code presence from proof of all distributed or production properties.

### 16.1 Signed Offer Envelope

The portable signed-offer evidence describes an owner-authorized Ed25519 envelope with canonical serialization, independent verification, revision ordering, signed tombstones and expiry. The offer identity is `(ownerPublicKey, logicalOfferId)`; signed-fact identity is `contentDigest`; ordering is `revision`; the signature is authorization evidence. A deterministic vector is recorded in `tests/offerEnvelope.test.ts`.

Source: [PORTABLE_SIGNED_OFFERS_EVIDENCE.md](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md).

### 16.2 E21 R1 and accepted revision

The current trade-admission service contains optional `acceptedEnvelopeId` support, and the database guard validates the selected owner's active accepted revision against the trade terms. Omission remains compatible with the older Offer-only path and leaves `acceptedEnvelopeId` NULL. Therefore, the existence of E21 R1 does not mean every public trade-creation path necessarily supplies the exact revision.

The current public route and SDK exposure are the subject of [PR #771](https://github.com/sails-protocol/Sails-Protocol/pull/771). This study records the architectural relationship to ADR-001 §27.2; it does not authorize #771's merge.

### 16.3 E25 and E26

The current repository contains distinct `TradeCommitmentV1` and `ArbitrationCommitmentV1` implementations and a commitment-pair service. The study preserves their separation: the trade commitment binds the accepted economic proposal; the arbitration commitment binds the applicable dispute-authority terms. A code path or test file is not, by itself, proof of cross-node consistency or production readiness.

### 16.4 M-1b — owner-declared offer capacity

The current repository contains an owner-signed capacity declaration for a logical Offer, a durable `offer_capacity` record and reservation logic tied to the `COMMITTED` transition. The inspected integration-test sources include real PostgreSQL reservation, release, wiring, concurrent-order and runtime-grant cases.

Relevant source paths:

- [Offer capacity service](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/src/modules/open-liquidity/offer-capacity.service.ts)
- [Reservation integration tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/offerCapacityReservation.test.ts)
- [Release integration tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/offerCapacityRelease.test.ts)
- [Runtime grant tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/f4RuntimeGrants.test.ts)

The study does not convert these repository artifacts into a claim that independent-node races and partition/reconnect behavior are already proven. Those remain explicit verification obligations.

### 16.5 F4 — escrow/commitment binding

The current schema and migration record a database-level guard for new executable escrows: the escrow must bind to a `COMMITTED` commitment pair, and the binding is immutable. The existing boundary is deny-by-default; `MOCK` is the explicit test exception. Runtime privileges and database-trigger behavior have dedicated integration evidence.

Source: [schema and F4 binding comments](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/prisma/schema.prisma) and [F4 runtime-grant tests](https://github.com/sails-protocol/Sails-Protocol/blob/0f2b7b4242ba4146ddf20cf9b2ee54ae6cac321a/tests/integration/f4RuntimeGrants.test.ts).

## 17. Auditor reconciliation — AS02-R01 through AS02-R07

| Finding | Required documentary treatment | Current treatment in this record |
|---|---|---|
| **AS02-R01** | Cite ADR-001 §28.1 explicitly in the E22 rationale. | **Addressed:** §14.1 now links and states the fiat-side obligation. |
| **AS02-R02** | Provide precise, version-pinned external source permalinks; distinguish Bisq V1 from Bisq 2. | **Addressed with provenance caveat:** §4 pins the inspected snapshots and states that equality with the original worksheet pins has not been established. |
| **AS02-R03** | Reconcile E22 with the selected payment-destination commitment direction and related records. | **Partially addressed:** §14 records the 2026-11-23 direction and explicitly leaves implementation/evidence open. |
| **AS02-R04** | Verify the distinction between informative reference price and binding accepted price. | **Addressed as a documentary rule:** §15 states the distinction and the non-authorization of `REFERENCE_PREMIUM`. |
| **AS02-R05** | Verify technically the atomicity between accepted revision and transition to `COMMITTED`. | **Open:** code/test presence is linked, but this study has not executed a fresh SHA-bound atomicity or distributed-concurrency proof. |
| **AS02-R06** | Preserve the trilemma as a hypothesis, not a theorem or invariant. | **Addressed:** §13 states the boundary explicitly. |
| **AS02-R07** | Keep `BACKLOG DELTA: ZERO — CANDIDATE` as a candidate, subject to EPM reconciliation. | **Addressed:** §8 retains the conditional status; no new Issue is recommended. |

## 18. Source-integrity limits still requiring the original study artifact

The exact conclusions of the original sections **02-A through 02-G** and the original per-scenario invariant/outcome/evidence rows for the twelve scenarios were not present in the materials available for this repository update. This record preserves the recovered D01–D09 decisions, twelve scenario references and AS02-R01–R07 audit deltas, but does not fabricate the missing section conclusions or scenario test mappings.

The open point connected to #771 is tracked as §6 item 2 (“atomicity between the current accepted revision and the transition to COMMITTED”); the direct, verifiable mapping for #771 remains ADR-001 §27.2.

Until the original Study 02 source is reconciled against §§10–18, this file is an expanded documentary consolidation, not a claim that every original section has been reproduced verbatim.

