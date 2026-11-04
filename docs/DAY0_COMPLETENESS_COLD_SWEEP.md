# Day-0 Completeness Cold Sweep — Multi-Operator Network + Partner Beta

**Type:** Institutional Memory / Architecture Completeness / Production Reality.
**Date:** 2026-09-09.
**Authority:** CTO cold sweep following ADR-001 and the Partner Beta / Integration Reality discovery.
**Status:** evidence + obligation registration only. No implementation is authorized by this document.

## 1. Why this sweep exists

The current architecture now correctly freezes the central Day-0 property:

> **Node choice must not define market membership.**

and the operating principle:

> **Liquidity should be network-level; node operation should be service-level.**

This sweep asks a different question: **what can still fail in practice even if ADR-001's signed-offer gossip architecture is implemented exactly as written?**

The purpose is to prevent hidden Day-0 requirements from living only in conversation, intuition, or future operational experience.

## 2. What was already institutionalized before this sweep

Already represented and therefore **not duplicated as new obligations**:

- shared market universe across independent nodes;
- no mandatory Satsails-operated membership/truth authority;
- signed portable Offer envelopes;
- persistent **participant transport identity** (the current `peerId`
  mechanism — scoped to one economic participant, not an operational
  node/deployment identity; see §3.5 below);
- Economic Identity ↔ Transport Identity binding;
- bootstrap + peer exchange;
- gossip propagation with fact-identity dedup (**correction, CTO Gate,
  final institutional precision pass**: originally worded "revision
  dedup" here — imprecise, and stale relative to ADR-001 §4's own
  current truth: a node must never suppress relay of a genuinely new,
  distinct signed fact merely because that revision number was already
  seen. Fact identity/`contentDigest` ≠ signature bytes ≠ revision
  ordering ≠ current-state selection ≠ the still-undesigned future
  gossip relay-dedup mechanism. No dedup mechanism is selected by this
  correction — only the property is restated correctly);
- cross-node trade-open handshake;
- capability/rail pre-creation discovery;
- professional liquidity-provider flow;
- restart/offline/resume;
- node contribution accounting;
- no-cannibalization / incentive-compatibility evidence;
- stranger-node test;
- stranger-developer test;
- first independent partner-wallet beta;
- node selection UX;
- node economics separated from protocol authority;
- privacy rule: shared market ≠ shared private state;
- production readiness and partner-beta gates;
- professional-provider quote expiry/min-max and inventory reservation;
- partial fill and outbound webhooks explicitly preserved as later obligations, not forgotten;
- Sybil/spam risk already named;
- protocol-version compatibility and node failover already named as evidence-required categories.

## 3. New Day-0 completeness obligations discovered by this sweep

### 3.1 Gossip catch-up / anti-entropy / partition healing

**Gap:** ADR-001 specifies propagation of newly-seen revisions. That alone does not prove a node joining later, reconnecting after downtime, or healing after a network partition receives active offers and newer tombstones that were published while it was absent.

**Property:**

> A conformant node that joins late or reconnects after a partition must be able to converge toward the current valid offer universe without requiring offers to be republished manually.

Required evidence must cover:
- late-joining node;
- node offline while an offer is created;
- node offline while an offer is revised;
- node offline while an offer is cancelled;
- partition heals with different highest-known revisions on each side.

No mechanism is selected here. Snapshot exchange, bounded inventory reconciliation, revision summaries, or another anti-entropy technique must earn selection separately.

### 3.2 Tombstone / highest-revision retention and stale resurrection prevention

**Gap:** cancellation is a higher-revision tombstone. If a node later discards the only evidence that revision N cancelled an offer, an old ACTIVE revision N-1 arriving from a stale peer can resurrect liquidity that no longer exists.

**Property:**

> Garbage collection must never make an older validly-signed ACTIVE offer become valid again after a higher revision or cancellation was previously accepted.

A node may compact data, but it must preserve enough monotonic knowledge to reject stale resurrection.

### 3.3 Node descriptor / self-authenticating operator advertisement

The network can discover peer addresses without yet exposing enough information for a wallet, service or operator to make a safe node choice.

**Day-0 property:**

> A node must be able to self-authenticate and disclose the minimum operational facts needed for compatibility and informed selection without a central registry becoming authority.

Minimum categories to define and evidence:
- stable node identity;
- reachable endpoint / transport information;
- supported protocol / wire version range;
- enabled Sails capabilities relevant to the integrator;
- enabled settlement rails and disclosed maturity/custody labels;
- fee/policy disclosure applicable to using that node;
- expiry/freshness of the descriptor;
- signature/authenticity of the descriptor.

Optional human-facing metadata (name, jurisdiction, support contact) must remain metadata, never protocol authority.

This is analogous in *property* to operator-info advertisements in other P2P systems, but no external schema is adopted by this registration.

### 3.4 Protocol/wire compatibility negotiation

Merely knowing that two processes speak “Sails” is insufficient once protocol objects evolve.

**Property:**

> Before exchanging economic advertisements, nodes must be able to determine whether they share a compatible wire/object semantics version and must fail clearly rather than silently reinterpret economic meaning.

This is distinct from Independent Implementation Conformance:
- conformance asks whether two implementations interpret the same canonical object the same way;
- version negotiation asks whether two live nodes should exchange that object at all.

### 3.5 Node identity lifecycle and operator-recipient separation

ADR-001 correctly freezes **Node Identity ≠ Participant Identity**. This sweep adds a missing adjacent distinction:

> **Node Identity ≠ Operator Economic Recipient.**

**Taxonomy freeze (2026-09-09, CTO Gate, final institutional precision
pass) — four cardinalities, not two, must never collapse. Stated as
protocol/semantic concepts first; today's TypeScript/database
identifiers are cited only as reference-implementation evidence, never
as the definition itself — an independent Rust/Go implementation, or a
future non-Pears transport, must be able to satisfy the same semantics
without reproducing this repository's schema
(`docs/adr/ADR-001-day0-multi-operator-network.md`'s own "Pears
capability ≠ mandatory architecture," "TypeScript is first, not
authoritative"):**

> **A. Participant Economic Identity** — the protocol/economic concept
> of one participant's own economic identity, non-custodial by
> requirement.
> *Current reference implementation:* represented by `User.publicKey`
> in this repository's Prisma schema. A conforming implementation on a
> different stack needs its own economic-identity primitive satisfying
> the same non-custodial property; it does not need a `User` table or
> this exact key format.
>
> **B. Participant Transport Identity** — the protocol concept of one
> participant's own stable, participant-scoped transport identity, used
> for direct participant-to-participant communication and reconnection.
> *Current reference implementation:* represented by a participant
> `peerId`, associated locally through `ownerUserId`, over Pears/
> HyperDHT. A conforming implementation may use any transport with
> equivalent peer-discovery and direct-connection properties (ADR-001
> §4's own "Pears capability ≠ mandatory architecture") and any local
> association mechanism — `ownerUserId` is this reference
> implementation's own local/database identity, not a portable protocol
> identifier. Persistence of this artifact is what "persistent node
> identity" has, historically and imprecisely, been used to describe
> elsewhere in this repository's own prior wording (§2 above,
> corrected) — B is **not** C.
>
> **C. Operational Sails Node Identity** — the protocol concept of an
> identity for the operator/deployment's own running node instance,
> used for node-to-node gossip trust and to sign a future Node
> Descriptor (§3.3). *Current reference implementation:* none — does not
> exist in this codebase today. No mechanism, key format, or transport
> binding is selected or authorized here.
>
> **D. Operator Economic Recipient** — the protocol/economic concept of
> whichever economic entity or entities are entitled to Node
> Contribution Accounting compensation for a given node's verified
> service. *Current reference implementation:* none — undesigned. **C
> does not determine D**: node cardinality does not imply
> economic-recipient cardinality in either direction (an operator's
> economic-recipient structure — one recipient, several, a pooled
> arrangement, or something else — is a policy choice not made here, not
> a fact derivable from how many C instances exist). Operational
> node-key (C) rotation or rebuild must not automatically redefine
> economic entitlement (D); conversely, economic-recipient policy (D)
> must not grant operational node authority (C). **C and D must not be
> assumed to share a key, and no recipient model or C↔D mapping
> mechanism is selected in this pass.**
>
> **A ≠ B ≠ C ≠ D.** No canonical term such as "Sails Node Operator
> Identity" is adopted for either C or D individually, or for the pair —
> using one label for both is exactly the collapse this freeze exists to
> prevent.

A node key may be compromised. Economic entitlement must not accidentally turn an operational transport key into permanent financial identity.

Day-0/production obligations (concerning C and D, not B — B's own
persistence/binding obligations are tracked separately, §2/ADR-001
§7.1/§21(b)), stated as properties, not implementation:
- operational node identity (C) backup/recovery policy;
- compromise response;
- rotation/replacement semantics;
- how peers stop trusting a superseded node key;
- how economic accounting (D) survives legitimate node-key (C) rotation where policy says it should;
- no node key (C) gains authority over participant funds, D's entitlement, or protocol semantics.

No new operator-identity primitive is authorized here.

### 3.6 Eclipse / peer-diversity / selective-forwarding resilience

Signed offers prevent forgery; they do not prevent a node from being surrounded by peers that selectively withhold valid liquidity.

**Property:**

> A single malicious bootstrap peer, relay set, or operator must not be sufficient to define the market view of an otherwise conformant node.

Evidence must include at least:
- one withholding peer with alternate honest paths;
- multiple malicious peers attempting eclipse/isolation;
- bootstrap diversity / operator-editable bootstrap behavior;
- peer rotation/reconnection behavior sufficient to escape a stale or censoring neighborhood.

This is not a claim of perfect censorship resistance.

### 3.7 Gossip resource bounds and abuse containment

Valid signatures do not make traffic economically valid. Attackers can create many valid keys and many validly-signed garbage offers.

**Property:**

> A conformant node must be able to bound CPU, memory, storage and bandwidth consumption from gossip without requiring central permission for honest participation.

The eventual design must explicitly bound:
- envelope size;
- per-peer ingress;
- duplicate/revision cache growth;
- expired/tombstone retention;
- malformed-message cost;
- signature-verification amplification;
- peer connection count;
- backpressure.

Formal Sybil resistance remains a separate question; basic resource safety does not.

### 3.8 Clock / expiry operational correctness

ADR-001 intentionally avoids cross-node clock ordering for revisions, but `expiresAt` is evaluated against local time.

**Property:**

> Clock error must not silently create materially different market availability across otherwise conformant nodes.

Day-0 production operations must define a bounded clock-health expectation and fail/degrade visibly when the node clock is outside that bound. This is an operational requirement, not a global consensus clock.

### 3.9 Node failover / migration without economic amnesia

The Backlog already names failover/migration as evidence-required. This sweep makes the user-facing consequence explicit:

> Changing the node used by a wallet must not inherently erase participant identity, signed trade anchors, portable evidence, historical rights, or access to network liquidity.

A node switch may change local policy or local score calculation. It must not redefine already-signed economic facts.

This must be exercised in Partner Beta / Production Readiness, not left as an abstract category.

### 3.10 Node operator self-service / runbook

If independent operation is a Day-0 requirement, running a node cannot depend on private assistance from Satsails.

**Property:**

> A competent independent operator must be able to deploy, configure, join, observe, upgrade, back up, recover and safely stop a conformant Sails Node from public documentation and supported artifacts.

The future operator path must cover at minimum:
- installation/deployment;
- Postgres/Redis requirements;
- persistent node-key custody;
- bootstrap configuration;
- TLS/network ports;
- supported rail configuration;
- migrations;
- health/metrics/logging;
- backups/restores;
- upgrade/rollback;
- incident/recovery procedures;
- protocol-version compatibility;
- fee/policy publication where applicable.

This is the node-side counterpart to the already-frozen Stranger Developer Test.

### 3.11 Service-integration event delivery

Outbound webhooks remain explicitly deferred past the first beta in ADR-001. They are **not forgotten**.

For public production:

> A backend/service integrator must have a documented, recoverable way to consume economically relevant state changes without relying on an unbounded best-effort WebSocket session.

The eventual production answer may be webhooks, resumable event consumption, polling with durable cursors, or another bounded mechanism. This sweep does not choose one.

## 4. Properties deliberately NOT promoted to Day-0 beta blockers

The following remain correctly separated from the first independent partner-wallet beta unless later evidence makes them load-bearing:

- partial fills;
- a universal node reputation score;
- paid gossip/relay rewards;
- DHT-stored offer architecture;
- Rust/Go implementations themselves;
- public Playground;
- full global Sybil-proof membership;
- every settlement rail in the long-term matrix.

They remain institutional obligations where already registered.

## 5. Adversarial Day-0 evidence set added by this sweep

Before any “shared liquidity / multi-node / decentralized” production claim, the evidence program must include:

1. Late Join Test.
2. Partition Heal Test.
3. Tombstone Resurrection Test.
4. Malicious Selective Forwarding Test.
5. Eclipse/Bootstrap Diversity Test.
6. Node Descriptor Authenticity / Staleness Test.
7. Wire-Version Mismatch Test.
8. Node-Key Rotation / Compromise Test.
9. Node Switch / Economic Continuity Test.
10. Gossip Resource-Exhaustion Test.
11. Clock-Skew / Expiry Test.
12. Independent Node Operator No-Assistance Test.

These extend, not replace, ADR-001's stranger-node, stranger-developer and partner-wallet tests.

## 6. Sequencing consequence

The accepted ADR-001 architecture decision is unchanged.

However, the Day-0 implementation sequence is incomplete unless it also covers:
- anti-entropy/catch-up and partition healing;
- stale-resurrection-safe revision retention;
- self-authenticating node descriptor + protocol compatibility;
- node identity lifecycle;
- peer-diversity/eclipse resilience;
- gossip resource bounds;
- clock-health behavior;
- node operator self-service;
- node failover/migration evidence.

No item above may disappear merely because the happy path works.

## 7. Claim discipline

Until evidence exists, do not claim:
- all nodes see the same liquidity;
- late joiners converge;
- node switching is seamless;
- node operation is permissionless in practice;
- node economics are incentive-compatible in production;
- censorship resistance;
- production-grade decentralized operation.

## 8. Institutional result

**BACKLOG DELTA DETECTED.**

This sweep found a second-order class of obligations: not “can two live nodes gossip a new offer?”, but “does the network remain one market across time, failures, upgrades, partitions, operator changes and adversarial peers?”

These are Day-0 completeness obligations because without them a multi-node architecture can appear decentralized in a demo while remaining fragile or economically fragmented in real operation.


## 9. Loop 2 — economic-binding sweep (2026-09-09)

A second pass was run specifically against the accepted `OfferEnvelope`
and cross-node trade-open handshake, asking: **can two honest nodes
cryptographically agree that they are talking about the exact same
economic deal, not merely the same offer identity?**

Two additional load-bearing gaps were found.

### 9.1 Signed Offer must commit to rail/network semantics

ADR-001's current minimum signed field list includes `asset` but omits
the existing `Offer.network` field.

That omission is unsafe for Sails' multi-rail direction. A value such as
`USDT_ERC20` identifies an asset family but does not, by itself,
uniquely distinguish every EVM network Sails intends to support. Two
nodes must not verify the same signature while silently resolving the
economic settlement rail differently.

**Property:**

> A portable Offer signature must commit to every field whose
> interpretation can change the economic asset, rail, payment obligation
> or settlement destination semantics.

At minimum, the canonical signed representation must include the
canonical network/rail identifier whenever the asset type alone is not
sufficient.

More generally:

> **Asset identity ≠ Network identity ≠ Settlement-provider identity.**

The exact future canonical identifier vocabulary must follow existing
Sails asset/network contracts or a separately-authorized compatibility
decision; this sweep does not invent one.

### 9.2 Trade-open handshake must bind the exact accepted Offer revision and terms

ADR-001 currently describes the jointly-signed trade-open anchor using
`logicalOfferId + mutually-derived tradeId`. That is not sufficient
to prove buyer and seller accepted the same revision or the same
economic terms.

Example failure:

1. Buyer discovered revision 4 at price X.
2. Seller has already issued revision 5 at price Y.
3. Both know the same `logicalOfferId`.
4. A handshake that commits only to `logicalOfferId + tradeId` does not
   itself prove which revision/price/network/amount was accepted.

**Day-0 property:**

> A trade-open anchor must cryptographically commit both parties to one
> exact economic proposal.

The commitment must cover, directly or by canonical hash:
- `logicalOfferId`;
- exact accepted offer `revision` (or exact OfferEnvelope hash);
- trade amount;
- agreed price/quote;
- asset;
- network/rail semantics;
- payment method/fiat-side semantics required for the deal;
- mutually-derived `tradeId`;
- replay/idempotency context sufficient to prevent the same acceptance
  from creating multiple logical trades.

This does **not** require global Trade replication. It makes the existing
pairwise model safe and independently re-verifiable.

Preserved:

> **Offer Discovery ≠ Trade Acceptance.**

> **Offer Identity ≠ Accepted Offer Revision.**

> **Trade ID ≠ Economic Terms.**

### 9.3 Concurrent acceptance / double-commit evidence

A shared, widely propagated Offer can be acted on by multiple buyers at
nearly the same time.

The existing professional-provider entry already requires local
inventory reservation/optimistic locking. The multi-node consequence is
made explicit here:

> A seller must not become economically committed to more mutually
> exclusive trade opens than its signed availability permits merely
> because requests arrive through different nodes or devices.

Required evidence must cover:
- two buyers race the same single-fill offer;
- stale revision attempts after a newer revision;
- duplicate/replayed trade-open handshake;
- seller reconnects through another node during an acceptance race.

No global lock service is authorized. The eventual mechanism must
preserve owner authority and pairwise coordination.

## 10. Loop status

After Loop 2, the institutional sweep has covered:

- topology;
- discovery;
- catch-up;
- convergence;
- stale state;
- exact economic object binding;
- trade acceptance;
- node identity;
- operator economics;
- node compatibility;
- partitions/eclipses;
- abuse/resource bounds;
- privacy;
- recovery/failover;
- operator self-service;
- developer self-service;
- partner-wallet evidence;
- professional service integrations;
- production event consumption.

**BACKLOG DELTA DETECTED again within the same cold-sweep obligation:**
signed rail/network semantics and exact accepted-revision/terms binding
were not previously explicit enough.


## 11. Loop 3 — real-money agreement + dispute authority sweep (2026-09-09)

A third pass traced the Day-0 design from “offer discovered” through
“fiat is actually sent,” “escrow is selected,” “fees become binding,”
and “the parties disagree.” This surfaced four additional load-bearing
properties that a clean gossip implementation would not solve by itself.

### 11.1 Exact fiat obligation and payment-instruction binding

Repository truth is currently asymmetric:

- `TradeIntentPayload.currency` exists;
- the persisted `Offer` has `priceUsd` plus optional `priceBrl`, but
  no generic quote-currency column;
- `Trade` persists `priceUsd`/`totalUsd`, not a generic fiat
  denomination/amount;
- `Offer.paymentDetails` is mutable application data;
- a privacy-preserving `PaymentAccount.accountHash` already exists.

For real-world PIX/bank-transfer P2P, “buyer accepted Offer X” is not
enough. The buyer must know exactly how much of which fiat denomination
is owed and must not be redirected to a different payment account by an
unsigned chat message after commitment.

**Day-0 property:**

> Before a fiat-side payment becomes the user's obligation, both parties
> must be able to verify the exact fiat amount, fiat currency,
> payment method and committed payment-destination identity/reference
> that belong to this trade.

Privacy requirement:

> **Payment destination commitment ≠ Public payment destination.**

The raw PIX key/bank account must not be gossiped merely to make the
commitment verifiable. A hash/reference such as the already-existing
`PaymentAccount.accountHash`, or an equivalently verifiable
trade-scoped commitment, can preserve privacy while binding the
instruction. The exact mechanism requires its own implementation review.

Any post-commit payment-instruction change must be an explicit,
authenticated amendment accepted by the affected party/parties; a chat
message alone must not silently redefine the economic obligation.

Preserved:

> **Chat Instruction ≠ Economic Authority.**

> **Payment Method ≠ Payment Destination.**

> **Price Quote ≠ Final Fiat Obligation until denomination and amount are bound.**

### 11.2 Settlement contract / custody semantics must be frozen before commitment

Loop 2 already established:

> **Asset identity ≠ Network identity ≠ Settlement-provider identity.**

This pass makes the consequence explicit. Two nodes may support the same
asset/network through settlement mechanisms with materially different
custody, signer, refund, dispute, finality and recovery properties.

**Day-0 property:**

> The trade/escrow agreement must bind the exact settlement mechanism
> whose authority, custody and recovery semantics the parties accepted;
> a node may not silently substitute a different SettlementProvider or
> EscrowType after economic commitment.

The binding must include, directly or through a canonical capability/
contract reference:
- selected `EscrowType` / settlement mechanism;
- network/rail;
- asset;
- custody model relevant to user authority;
- required signer/approval shape;
- finality/confirmation policy where economically relevant;
- refund/dispute capability required by the trade;
- maturity/eligibility disclosure used to permit that mechanism in the
  environment.

This is not a requirement that every provider share one security model.
It is the opposite: the user must be bound to the *actual* one.

> **Interface uniformity ≠ Security uniformity.**

### 11.3 Fee / policy commitment before economic commitment

Independent nodes are intended to compete on service quality and may
participate economically. That creates another Day-0 ambiguity if two
nodes can apply different fees or policy versions to the same trade.

**Property:**

> Every fee that can become an obligation for a participant must be
> disclosed and frozen before the participant becomes economically
> committed, including who pays, the economic basis, the applicable
> policy/version and the recipient class where relevant.

A node or policy rotation after trade-open must not retroactively change
the agreed obligation.

Preserved:

> **Fee discovery ≠ Fee obligation.**

> **Verified contribution ≠ Fee entitlement.**

> **Node competition on fees must not permit hidden post-commit fees.**

The existing immutable `FeePolicyVersion` /
`DistributionPolicyVersion` architecture is useful prior art, but this
sweep does not assume cross-node fee agreement is already solved merely
because those tables exist in one node.

### 11.4 Cross-node dispute/arbitration authority is a Day-0 blocker

The current dispute implementation is node-local:

- `Dispute` rows live in one Postgres database;
- the configured `ArbitrationProvider` is deployment-local
  (`trusted-list` or market mode);
- arbiter assignment is performed by the node handling
  `raiseDispute()`;
- MULTISIG can have an arbiter cryptographically committed in the
  settlement script, while other rails have different authority shapes.

In a multi-operator trade, “which node received the dispute request?”
must never decide who has authority to rule.

**Day-0 property:**

> Dispute authority, applicable arbitration policy and appeal semantics
> must be established by the trade/settlement agreement — not chosen
> unilaterally by whichever node processes the dispute first.

Required properties:
- both parties can verify the same arbitration authority/policy before
  funds are committed;
- a node-local config change cannot reinterpret an already-open trade;
- an assigned/committed arbiter can access the evidence necessary to
  decide without trusting one operator's private database as truth;
- the ruling carries independently verifiable authority attribution
  (existing `authoritySignature` / `DisputeOutcome` are useful prior
  art);
- both parties/nodes can verify the same ruling and appeal round;
- one party's node disappearing must not make an otherwise-valid dispute
  unresolvable;
- settlement execution still follows the rail's own funds-authority
  requirements.

Preserved:

> **Dispute Hosting Node ≠ Arbitration Authority.**

> **Arbitration Policy ≠ Node Local Configuration once a trade is committed.**

> **Ruling Attribution ≠ Funds Authority.**

This does not select one universal arbitration model. It requires the
chosen model to be frozen and independently checkable for that trade.

### 11.5 New adversarial evidence cases

Add:

13. Fiat Amount/Currency Binding Test.
14. Payment-Destination Substitution Test.
15. Post-Commit Payment-Instruction Change Test.
16. Settlement-Provider Substitution Test.
17. Fee-Policy Rotation / Hidden-Fee Test.
18. Cross-Node Arbitration-Policy Mismatch Test.
19. Dispute Hosting-Node Failover Test.
20. Appeal-Round Cross-Node Consistency Test.

## 12. Loop 3 status

This pass closes a class of blind spots that sit *after* discovery but
*before* safe real-world payment:

- what exactly the buyer owes;
- where the buyer is authorized to pay;
- which settlement/custody contract the parties accepted;
- which fees are binding;
- who may resolve a dispute.

**BACKLOG DELTA DETECTED again within the same Day-0 completeness
obligation.** These properties were not explicit enough in ADR-001's
original happy-path sequence and are required before first real-value
multi-operator testing.


## 13. Loop 4 — current privacy-surface audit (2026-09-09)

A fourth pass stopped reasoning about future architecture and inspected
the **current public HTTP surface** that a partner would actually use.

A concrete implementation defect was found.

### 13.1 Public single-Offer read returns the raw persisted Offer

Current truth:

- `GET /v1/liquidity/offers/:id` has no authentication requirement;
- its handler calls `liquidityRouter.getOffer(id)`;
- `getOffer()` returns the raw Prisma `Offer` row plus a broad
  `User` projection;
- the raw Offer includes `paymentDetails`;
- the included User currently contains `id`, `publicKey`,
  `displayName`, `peerId`, `reputationScore`, `totalTrades`,
  `disputeCount`, `totalVolumeBtc`, `verified`, and `createdAt`.

This is materially different from the aggregate discovery surface,
whose `LiquidityOffer` deliberately excludes `paymentDetails`.

The repository's own security/privacy discipline has already fixed the
same class of bug on other public endpoints by introducing purpose-built
public projections (`PublicPaymentAccountView`,
`PublicPayoutAddressView`, public participant view). The OfferDetail
route has not received that correction.

**Classification: CURRENT IMPLEMENTATION PRIVACY DEFECT / PARTNER-BETA
BLOCKER.**

### 13.2 Required property

> A public Offer lookup must reveal only the information required to
> discover and evaluate advertised liquidity; it must not disclose raw
> private payment instructions or unrelated participant bookkeeping merely
> because the caller knows an Offer id.

At minimum:

> **Public Offer View ≠ Raw Offer Row.**

> **Offer Discovery Data ≠ Payment Execution Data.**

> **Payment Destination Commitment ≠ Public Payment Destination.**

The current `paymentDetails` field must not be exposed unauthenticated
as a side effect of fetching an Offer.

The future route should use an explicit public projection, exactly as
the repository already does for other privacy-sensitive public reads.
Which participant/profile fields belong in that projection must be
justified field-by-field rather than copied from the database model.

### 13.3 Multi-node consequence

This defect becomes more severe under ADR-001 if a future implementation
naively signs/gossips the existing raw Offer row.

ADR-001 correctly omitted `paymentDetails` from the signed public
OfferEnvelope. That omission is now explicitly **required**, not
accidental:

> Raw payment instructions remain pairwise/private even while their
> authenticated commitment can become part of the exact trade agreement.

### 13.4 Required evidence

Add:

21. Public Offer Projection Privacy Test.
22. Unauthenticated Payment-Details Non-Disclosure Test.
23. Gossip Envelope Private-Field Exclusion Test.
24. Trade-Party Payment-Instruction Availability Test — proves the two
    actual counterparties still receive the instruction through the
    authorized pairwise trade path after public disclosure is removed.

**BACKLOG DELTA DETECTED:** this is a current code defect, not merely a
future network-design obligation.


## 14. Loop 5 — partner-beta asset/rail reality sweep (2026-09-09)

A fifth pass compared the concrete partner scenarios discussed for the
first tests — wallet integrations plus web buy/sell services for BTC,
USDT and potentially DePix — against the actual public type system.

### 14.1 Strategic coverage ≠ current representability

The README correctly lists **USDT, USDC, BTC, LBTC, L-USDT, DePix,
Tether Gold and RGB assets** as relevant assets “in view,” explicitly
without claiming final support.

The current persisted `AssetType`, however, is narrower:

- BTC
- USDT_ERC20
- USDT_TRC20
- USDT_LIQUID
- USDT_LIGHTNING
- LN_BTC
- LIQUID_BTC
- SPARK
- STACKS
- RSK_BTC

There is currently no `AssetType` for DePix, USDC or Tether Gold.

This is not an architectural contradiction. It is a launch-scope fact
that must be impossible to miss when talking to partner integrators.

### 14.2 Partner Beta Asset/Rail Scope Gate

**Property:**

> The first partner beta must publish an explicit
> Asset × Network/Rail × Wallet Adapter × Settlement Capability ×
> Maturity matrix, and every advertised beta flow must be representable
> end-to-end by the actual SDK/schema/provider combination used in that
> beta.

Preserved:

> **Roadmap Asset ≠ SDK-Representable Asset ≠ Settlement-Supported Asset ≠ Beta-Enabled Asset.**

If DePix is included in the first partner beta promise, its current
absence from `AssetType` and the absence of a production-eligible
Liquid/DePix settlement path are **beta blockers to be resolved before
that claim**.

If the first beta is intentionally BTC-only or BTC+USDT on a bounded
rail, DePix remains a later beta-scope item rather than blocking the
narrower test. The scope must be explicit; silence is not acceptable.

The same rule applies to USDC, Tether Gold and every future asset.

**SUPERSEDED (2026-09-10, Product Direction Freeze — Gate B).** The two
paragraphs above correctly identified the open question on 2026-09-09 —
preserved verbatim, not deleted. Product Direction has since closed it:
the Day-0 target is not a choice among BTC-only / bounded BTC+USDT /
DePix-inclusive scopes. It is the **Full Reference Wallet Day-0
Capability Target** (BTC across on-chain/Spark/Lightning/Arkade/Liquid;
DePix across Liquid **and** Spark, both required; USDT across eleven
named networks; USDC across six; XAUT on Ethereum) — see the canonical
matrix in `docs/BACKLOG.md`'s Cold Sweep Loop 5 entry (item 20) for the
authoritative, current version. DePix is Day-0-required, not a
later-scope item contingent on a narrower beta choice. The underlying
gate this section names — that current absence from `AssetType` and
absence of a production-eligible settlement path are blockers **to the
production claim**, not to the scope itself — remains true and is
restated, not weakened, by this freeze: immaturity does not remove a
capability from scope (frozen product property, `docs/BACKLOG.md`
item 20).

**SUCCESSOR (2026-11-01, Product Owner + CTO).** The Full Reference
Wallet Day-0 Capability Target named above has itself been superseded as
the Day-0 commitment by a narrower set of 14 native P2P `{asset, rail}`
combinations (`docs/adr/ADR-002-asset-settlement-rail-adapter-provider-architecture.md`
§5A; `docs/BACKLOG.md` item 20). DePix is outside that set. The text
above and the 2026-09-10 supersession stay as history; the
"DePix-inclusive" evidence in §14.4 follows the 14-row commitment.

### 14.3 Quote-currency / market-pair discoverability

The current aggregate `LiquidityOffer` public discovery shape exposes
`priceUsd` but not a canonical quote-currency/fiat-obligation field.
The persisted Offer has optional `priceBrl`; `TradeIntentPayload`
has optional `currency`; the public aggregated discovery surface does
not unify those into one explicit market-pair contract.

This reinforces Loop 3's exact-fiat obligation:

> A participant must not have to infer the fiat denomination from
> geography, payment method, UI locale, or which node returned the
> Offer.

For any beta that supports more than one fiat quote currency, canonical
quote-currency semantics are a Day-0 requirement.

### 14.4 Required partner-beta evidence

Add:

25. Beta Asset/Rail Matrix Truth Test — advertised matrix checked against
    runtime capability discovery and real type/provider support.
26. Unsupported Asset Fail-Closed Test.
27. DePix End-to-End Representability Test, **only if DePix is declared
    in beta scope**.
28. Multi-Fiat Quote-Currency Disambiguation Test, when more than one
    fiat quote currency is enabled.

**BACKLOG DELTA DETECTED:** the strategic coverage matrix already
existed, but an explicit Partner Beta scope gate tying marketing/
partner promises to actual representability did not.


## 15. Execution authority after the five-loop sweep

The discoveries above are **not** to be executed in the order they were
found. Issue **#105 — [Day-0] Multi-Operator Network + Partner Beta
Completion Gate** contains the canonical CTO sequencing authority,
organized as Gates A-J.

High-level dependency order:

1. evidence infrastructure (#57) + current privacy blocker (#61);
2. explicit first-beta asset/rail/fiat scope;
3. signed portable market objects + node identity/binding;
4. bootstrap/gossip/catch-up/convergence + adversarial network safety;
5. exact trade/fiat/payment/settlement/fee/arbitration commitment;
6. concurrency, restart, node-switch and dispute continuity;
7. node contribution accounting + no-cannibalization evidence;
8. stranger node/operator/developer tests;
9. independent partner-wallet + professional-service beta evidence;
10. Production Readiness → provider eligibility → Network Simulation /
    Final Red Team → external audit → RC1 → bounded real-value validation.

> **No “later bucket” exists for an item required by the declared launch
> scope. Scope may be narrowed explicitly; an obligation may not
> disappear implicitly.**

This document preserves the *why/properties/evidence*. Issue #105
preserves the live *execution order*. `docs/BACKLOG.md` preserves the
institutional obligation even if the Issue is later closed.
