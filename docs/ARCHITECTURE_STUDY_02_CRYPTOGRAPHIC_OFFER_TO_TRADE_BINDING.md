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

The EPM reference to a “D-A” point was not identifiable in the supplied audit text. The direct, verifiable architectural mapping for #771 is ADR-001 §27.2. The D-A label should not be treated as reconciled until its exact source passage is identified.

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
