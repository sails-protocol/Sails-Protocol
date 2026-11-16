# PROTOCOL_ECONOMY.md
### Sails Protocol — Economic Architecture & Historical Policy Rationale

> **Authority / status:** economic architecture, policy rationale and historical proposals. This document does not by itself activate fees, distribution policies or production economics. Current economic execution truth is owned by implemented policy/versioning/ledger mechanisms plus live operator configuration/evidence.
>
> **Where this fits:** this document covers economic design `ROADMAP.md` covers engineering phases (external funding
> specifics are intentionally not disclosed there); `PROJECT_CONTEXT.md`
> briefly states the "no speculative token" principle. This document is
> the actual economic architecture:
> how the protocol sustains itself indefinitely, how it incentivizes six
> distinct stakeholder groups, and exactly how fees flow — with worked
> comparisons against Morpho, Aave, Uniswap, Bisq, HodlHodl, and Lightning.
>
> Read `PROTOCOL_SPECIFICATION.md` first — the fee mechanisms described
> here attach to the Settlement and Reputation primitives defined there.
>
> **Expanded following an external economic-model review** ("Architecture
> Directive — Economic Model & Adoption Strategy"): sections 1B, 1C, 2B,
> 3B, 4.7, 5B, and 8B are new; 4.5 and 6.2 were extended in place. This
> document is not a technical specification — per that review's own
> instruction, economic architecture and protocol specification are kept
> deliberately separate; where a mechanism here depends on a technical
> primitive or Adapter interface, it is cross-referenced by name, never
> redefined. **Section 3C** (Partner Neutrality) was added in a follow-up
> pass, not part of the original directive — see that section for why it
> is documented here rather than as a new numbered principle in
> `PRINCIPLES.md`. The Sails Foundation concept (a further follow-up) is
> primarily documented in `GOVERNANCE.md` §2B, cross-referenced from
> sections 3 and 4.3 here rather than duplicated.

---

## 1. The Core Constraint: No Speculative Token

**Sails Protocol does not issue, require, or depend on a native token.**

This is a deliberate architectural constraint, not an oversight. Three
reasons:

1. **Regulatory simplicity.** A protocol whose core function (escrow,
   settlement, reputation) depends on a speculative asset invites securities
   scrutiny that has nothing to do with whether the coordination layer
   itself works. Removing the token removes that entire risk surface.
2. **Alignment with "Bitcoin-first, not Bitcoin-only."** Introducing a
   Sails-native token would compete with the assets the protocol is meant
   to coordinate (BTC, USDT, etc.) rather than serve them.
3. **It's not necessary.** Section 4 below shows, module by module, that
   every stakeholder group can be incentivized using the settlement assets
   already flowing through the protocol — the same insight that lets
   HodlHodl and Lightning function without a token (see section 5).

This constraint disciplines every design choice in this document: if a
mechanism can only work by paying someone in a new token, that mechanism is
rejected and redesigned to pay in BTC, USDT, or another already-supported
settlement asset instead.

---

## 1B. Value Capture Principle: Infrastructure, Not Users

**Added following an external economic-model review (Architecture
Directive — Economic Model & Adoption Strategy) — this section makes
explicit a rule the fee mechanics in section 6 already implied but never
stated as its own principle.**

**The protocol does not monetize users. The protocol monetizes operations
executed through the infrastructure it coordinates.**

This is a real distinction, not a rephrasing:

- A user who never trades, never negotiates, never settles costs the
  protocol nothing and owes it nothing — there is no per-account fee,
  no subscription, no cost to simply holding a `Participant` identity
  (`PROTOCOL_SPECIFICATION.md` §1.1).
- The Protocol Fee (section 6) only ever attaches to a completed
  `Settlement` — a real operation that used the Intent → Discovery →
  Negotiation → Settlement pipeline the protocol actually built and
  coordinated.
- This is the same reasoning that separates Morpho, Hyperliquid, Uniswap,
  and Aave from a platform that charges for access or accounts: value
  capture is tied to *coordinating* an operation, not to *controlling*
  who may participate (`PRINCIPLES.md` principle 7, "Open Integrations" —
  no approval process gates who may build against the protocol).

**Why this matters for the wallet-adoption argument (1C below):** it is
what makes the rebate model in section 4.5/4.7 sustainable rather than
extractive — a wallet integrating the SDK is not paying the protocol to
access users, it is sharing in fee revenue generated only when its users
actually transact through the infrastructure the protocol provides.

## 1C. The Wallet Economy — Why This Section of the Document Exists

**Added following the same review.** Any wallet founder evaluating the
Sails P2P Trading SDK (the MVP's branded release of `@satsails/p2p-trading-sdk` — see
`PROJECT_CONTEXT.md` section 3) asks one question in the first thirty
seconds: *"Why would I integrate the Sails Protocol if I already have a
working wallet?"* If the
honest answer is "because it's an elegant architecture," nobody integrates
— elegance doesn't pay engineering salaries. The answer this document has
to make true is: **"because your wallet gains new, low-effort revenue
streams it would otherwise have to build (or forgo) entirely."**

**Today, most non-custodial wallets monetize very little.** Revenue
typically comes from swap spreads, on/off-ramp fees, affiliate referrals,
donations, and hardware-wallet sales — the wallet itself is close to a
free product, a cost center the rest of the business subsidizes.

**With the Sails Protocol, a wallet stops being just a wallet.** It
becomes a financial application that earns revenue by participating in
the ecosystem — without building marketplace, reputation, escrow,
mediation, settlement, agent, or liquidity infrastructure itself. Section
4.5, 4.7, and 6.2 below specify exactly how; this section exists only to
name the strategic reason those mechanisms matter: **a protocol only
reaches network-effect scale when the technical architecture and the
economic architecture evolve together.** A well-designed protocol with no
incentive for a third party to integrate it stays a single company's
internal tool, no matter how sound the engineering is.

---

## 2. How the Protocol Sustains Itself Financially

Four revenue mechanisms, all denominated in existing settlement assets or
fiat — never a protocol-native token:

| Mechanism | Description | Who pays |
|---|---|---|
| **Protocol Fee** | A small, configurable fee on successful settlement (trade, future loan/swap) | Split between the two counterparties |
| **API / SDK Usage Tiers** | Free sandbox + low-volume tier; paid tier for high-volume integrators needing SLA | Integrators above the free tier |
| **Enterprise Licensing** | White-label protocol access with dedicated support for OTCs, fintechs, exchanges | Enterprise licensees |
| **Premium Reputation Services** | Optional advanced verification, analytics, badges for high-volume participants | Opt-in participants |

The **Protocol Fee** is the only mechanism structurally tied to the
protocol's core function (settlement) — it is the primary long-term
sustainability engine and the only one analyzed at the fee-flow level in
section 6. The other three are reference-implementation/business-layer
revenue (Satsails' business model, not the protocol's), included here for
completeness because they fund the same ecosystem.

## 2B. Future Revenue Sources (architecture-ready, not implemented)

**Added following the same review — explicitly not a commitment to build
any of these now.** The point of naming them here is the same discipline
`PROTOCOL_SPECIFICATION.md` §4B already applies to Settlement/OpenFinance/
Transport Adapters: the architecture must stay capable of supporting a
future source of value capture without a redesign, even while nothing
below is scheduled:

- **Marketplace P2P** — current economic design target around Sails OpenP2P. Mechanism implementation and actual production activation are separate claims; section 6/current policy evidence governs what is really active.
- **Settlement** — direct fees on future `SettlementAdapter` (§4B)
  implementations beyond today's escrow flow (e.g. Lightning HODL,
  Liquid Covenant, once real).
- **Liquidity Routing** — a fee on `Sails OpenLiquidity`'s aggregation
  across multiple `LiquidityProvider`s (`liquidity.service.ts`'s
  `LiquidityRouter`) once external providers (HodlHodl, RoboSats) are
  real, not stubbed.
- **OpenFinance** — `LoanIntent`/`SwapIntent`/`EarnIntent` (§2.3,
  `PROTOCOL_SPECIFICATION.md`) each carry the same Protocol Fee mechanism
  as `TradeIntent` once implemented — no new fee design needed, the
  existing Settlement-attached fee already generalizes.
- **Agent Marketplace** — a future fee or revenue-share on `Sails
  OpenAgents`/QVAC-mediated automated trading, matching/negotiation, or
  risk analysis performed on a Participant's behalf (§1.7).
- **Enterprise Services** — expands section 2's existing Enterprise
  Licensing row (white-label, dedicated support, SLA).
- **Commercial APIs** — expands section 2's existing API/SDK Usage Tiers
  row for higher-volume or higher-guarantee integrators.
- **Premium Infrastructure** — e.g. priority routing, dedicated node
  capacity, or enhanced `EventStore` durability (RFC-010) tiers for
  integrators who need stronger guarantees than the open default.

None of these change section 1's no-token constraint or section 1B's
infrastructure-not-users principle — every one of them, if and when built,
is a fee on a real operation executed through real protocol
infrastructure, paid in an existing settlement asset or fiat.

---

## 3. How the Protocol Evolves — With or Without External Funding

External funding (see `ROADMAP.md`, which does not disclose specifics
publicly) may accelerate protocol *engineering* in Months 1-12, but is
explicitly not meant to be a permanent funding source, and (**revised
2026-08-11**) the protocol's actual sustainability does not wait for it
to be confirmed. Funding is not guaranteed the moment it's applied for,
and a real team's runway shouldn't be built on the assumption that it
is. The earlier version of this section had the Protocol Fee OFF for
the first 12 months, activating only after a grant-funded period ended
— that plan is superseded below.

**Corrected 2026-08-24** — the diagram below describes the DESIGNED
activation plan for Day 0, not a claim that it is active today. As of
this writing, `PROTOCOL_FEE_RATE` remains at its inactive default, no
`FeePolicyVersion`/`DistributionPolicyVersion` has been published outside
a test, and no production 0.40% fee has ever been charged (see section
6.5 below for the full, authoritative activation-state disclosure — this
correction exists specifically because an earlier version of this
section's present-tense wording contradicted that section). The intended
design itself is unchanged and not weakened by this correction: the
mechanism is IMPLEMENTED and code-tested, real activation is a deliberate
operator action described in section 6.5, not automatic on launch day.

```
Day 0 (launch, once activated — see the correction immediately above)
  → Protocol Fee is ON at 0.40% (section 6.2's 35/30/25/10 split),
    independent of whether grant funding is secured — real, sustainable
    revenue from real usage, not a promise contingent on a third party's
    decision
  → Protocol Engineering, Security Audits, SDK, Operations continue in
    parallel, grant-funded if the grant lands, fee-funded regardless

Ongoing (fee-funded from Day 0)
  → Fee revenue seeds the Developer/Treasury Fund (section 4.3) and pays
    the Node Operator Pool (section 4.2) as soon as either has a real
    configured payout address (section 6.3's current gap)
  → Enterprise Licensing and Premium Reputation revenue (Satsails' own
    business layer) supplements but does not replace protocol-level
    sustainability

Months 18+ (governance maturity)
  → Fee parameters and Treasury Fund disbursement move from
    Satsails-controlled to the multi-stakeholder "Governance layer v1"
    already committed in ROADMAP.md's Months 10-12 phase
  → This is the anti-centralization mechanism — see section 7
```

This still mirrors how the Ethereum Foundation or the Uniswap Foundation
used initial concentrated funding/control to bootstrap an ecosystem, then
handed fee-parameter and treasury governance to a broader body once the
protocol had enough real usage to make that governance meaningful rather
than theoretical — the governance handoff timeline (Months 18+) is
unchanged. What changed is only *when the fee itself starts*, not the
long-run decentralization plan.

**Why 0.40%, checked against the real market (2026-08-11):** the two
closest comparables are the other non-custodial P2P platforms, not
custodial exchanges — HodlHodl charges 0.5%-0.75% per side (0.5% with a
referral code, per their own published fee guide), Bisq charges
0.65%-1.30% combined depending on payment token. Binance P2P's 0%-0.35%
range looks cheaper on paper but trades away privacy and self-custody —
not a like-for-like comparison for what Sails offers. 0.40% prices below
both direct non-custodial comparables while remaining high enough to fund
a real Node Operator Pool and Treasury (section 6.2) rather than a
token-gesture fee that can't sustain either.

> **Dated note, 2026-10-26 — mandatory fee (Founder/CTO decision).** The Protocol Fee is 0.40% from the first day of operation and is a homologation condition for every settlement line enabled in production; a controlled beta with real funds charges it from the first operation. The "Protocol Fee is OFF" bootstrap wording earlier in this document and the "optional per integrator" statement in §6.4 item 4 no longer describe the plan; both are preserved unchanged as history. The fee is charged to the seller on the value actually delivered, with an additional funded reserve (`SELLER_PAYS` / `SELLER_DELIVERED_VALUE`). A REFUND carries no Protocol Fee; a RELEASE ruling charges it and a REFUND ruling does not; settlement `SPLIT` stays disabled on fee-enabled lines until proportional fee treatment is defined and homologated; amounts are rounded down to the asset's smallest unit; per-line minimums must be justified and no fee may be waived silently; external costs (network, miner, gas) stay separate from the fee. This note activates nothing: no `FeePolicyVersion` or `DistributionPolicyVersion` is published by it, and no settlement line is claimed here as implemented, tested or homologated.

**Concrete entity structure for "Governance Layer v1":** `GOVERNANCE.md`
§2B names this — Satsails plays the Morpho-Labs/Fedi role (the company
that builds); a future **Sails Foundation** (working name, not yet a
formed legal entity) is intended to play the Morpho-Association/Fedimint
role (the nonprofit that stewards the protocol and, once it exists,
administers the Developer/Treasury Fund below). See `GOVERNANCE.md` §2B
for what is and isn't true about this today — the intent is documented
now, the entity itself is not yet formed.

---

## 3B. Wallets Are Partners, Not Clients

**Added following the same review — this is the framing principle the
stakeholder-by-stakeholder design in section 4 is built on, stated
explicitly rather than left implicit.**

A wallet integrating `@satsails/p2p-trading-sdk` is not a consumer of a hosted service —
it is a participant in the protocol's economy, the same category as a
Liquidity Provider or an Arbitrator (section 4). Two consequences follow
directly:

1. **Wallets earn, they don't just pay.** Section 4.5/4.7 and section 6.2
   exist because an integration that only costs a wallet engineering time
   and offers nothing back does not scale past whichever wallet builds it
   first for its own reasons (Satsails). A wallet that earns a rebate on
   every operation it originates has a durable, ongoing reason to keep
   integrating deeper.
2. **Neutrality is not optional.** The protocol never favors one wallet
   over another. Every wallet that correctly implements the SDK has
   access to *exactly* the same economic opportunities — same rebate
   mechanism, same fee-discount tiers (section 4.1), same eligibility for
   the Node Operator Pool (section 4.2) if it also runs infrastructure.
   This is `PRINCIPLES.md` principle 1 (Protocol First) and principle 7
   (Open Integrations) applied specifically to economics, not just to
   technical access: an open protocol whose economic layer quietly
   privileges its own reference implementation is not actually neutral,
   regardless of how open its SDK's source code is.

**What this changes in practice:** wallets stop competing for who builds
the best internal P2P/escrow/reputation stack, and start competing purely
on user experience — the infrastructure underneath is shared. Section 5B
develops why this produces a network effect rather than a race to the
bottom.

## 3C. Partner Neutrality — Avoiding Single-Ecosystem-Partner Concentration

**Added following a follow-up discussion after the external economic-model
review, not present in the original directive — a real gap identified by
checking this document and `PRINCIPLES.md`/`GOVERNANCE.md` for existing
coverage before assuming one was needed.**

Section 3B's neutrality principle protects against the protocol favoring
one *wallet* over another. It says nothing about a different, real risk:
`ARCHITECTURE.md` §1C's four-layer diagram places **Tether Ecosystem** as
the foundational layer beneath the Open Infrastructure Stack (WDK + Pears
+ QVAC) that Sails Protocol coordinates on top of. That's an accurate
description of where the project's infrastructure comes from today — but
if USDT/Tether-originated liquidity comes to dominate real settlement
volume, the protocol can be *technically* chain-agnostic
(`PRINCIPLES.md` principle 6, Infrastructure Neutral) while still being
*perceived and functionally treated* as "the Tether P2P protocol" by the
market. That perception alone is enough to make a competing stablecoin
issuer, or a wallet that doesn't want to be read as Tether-aligned,
hesitate to integrate — undermining exactly the neutrality section 3B
exists to guarantee, through a channel neither section 3B nor principle 6
was written to cover.

**The distinction that matters:** principle 6 (Infrastructure Neutral)
protects against *technical* lock-in — no fixed chain, custody
technology, or transport. This section protects against *ecosystem*
lock-in — no single backer, issuer, or strategic partner the protocol
becomes functionally synonymous with, even while remaining technically
neutral on paper. A protocol can pass every test of principle 6 and still
fail this one.

**What this means in practice, stated as a standing goal, not a
restriction on any current relationship:**

- Tether/WDK is correctly the **first** major ecosystem partner and
  infrastructure provider — nothing here suggests reducing or
  deprioritizing that relationship, which is real, valuable, and already
  load-bearing in the architecture.
- The protocol should actively pursue integration with **additional**
  large liquidity sources, stablecoin issuers, and infrastructure
  partners over time, the same way it pursues additional wallets (section
  3B) and additional `SettlementAdapter`/`LiquidityProvider`
  implementations (section 4.7) — partner diversity is success, not
  disloyalty to the first partner.
- Economic mechanisms in this document (the fee model, section 6; the
  rebate model, section 4.5) must stay identically available to volume
  originating from any settlement asset or backing partner — the same
  "no favoritism" commitment section 3B makes for wallets, extended to
  partners.

**Not yet a formal Principle 10.** Per `GOVERNANCE.md` §3, changes to
`PRINCIPLES.md` require Governance Layer v1, which does not exist during
the current bootstrap phase (Months 1-12) — this section is recorded here,
in the economic-architecture document, as the reasoned case for it, not as
an unauthorized edit to the frozen 9-principle list. Once Governance Layer
v1 exists, formally elevating "Partner Neutrality" to a numbered principle
in `PRINCIPLES.md` should go through the same RFC process
(`GOVERNANCE.md` §5) as any other principle change — this section is the
proposal that RFC would draw on, not a substitute for it.

---

## 4. Incentive Design by Stakeholder Group

### 4.1 Liquidity Providers (market makers, OTC desks posting standing offers)

**Primary incentive: the spread**, exactly as in any P2P market — an LP
quotes a price with a margin over the reference rate and earns that margin
on every fill. This requires no protocol-level payment at all; it's the
natural economics of quoting a two-sided market.

**Protocol-level enhancement:** volume/reputation-tiered fee discounts —
LPs with high `volumeScore` (see `PROTOCOL_SPECIFICATION.md` section 1.6)
pay a reduced Protocol Fee, similar to maker-rebate tiers on centralized
exchanges. This costs the protocol a small amount of fee revenue but grows
total settlement volume, which is the actual goal.

**Why no token here:** Uniswap pays LPs via pool fee-share, requiring
pooled capital and a token-like LP-share accounting unit. Sails has no
pooled liquidity — offers are individually posted and matched P2P — so
there's no pool-share problem to solve with a token in the first place.

### 4.2 Node Operators (Bootstrap nodes, Reputation nodes, future relay nodes)

This is the hardest group to incentivize without a token, because unlike
LPs, node operators don't have a natural transaction to earn a spread on.
Three tiers of answer, matched to the roadmap:

- **Bootstrap nodes (today):** run voluntarily, the same way Bitcoin full
  nodes or Tor relays are run today — goodwill, ecosystem interest, and (for
  companies like Satsails) direct business interest in network reliability.
  No payment mechanism needed at this stage.
- **Reputation nodes (Months 7-9, cross-module portability phase):** once
  reputation validation requires real infrastructure at scale, a small
  slice of Protocol Fee revenue is earmarked for a **Node Operator Pool**,
  distributed proportionally to verifiable uptime/service metrics (not
  emissions — a real payout from real fee revenue, paid in the settlement
  asset).
- **Relay/routing nodes (Months 10-12, Pears Runtime / distributed order
  book phase):** modeled directly on **Lightning Network's routing fee**
  mechanism (see section 5) — a peer that relays discovery or negotiation
  traffic earns a tiny, protocol-defined routing fee denominated in the
  settlement asset, paid by whoever benefits from the routed message.

**Corrected/Current-truth update (2026-09-08, Day-0 Network Property
Correction).** The three-tier text above (preserved verbatim) reads as
if node economic *capability* itself only exists starting Months 7-9 —
that is no longer the governing decision. `docs/BACKLOG.md`'s "Day-0
Multi-Operator Sails Network / Node Independence" entry registers
independent node operation as a **Day-0 launch property**, not a
Months 10-12 aspiration. Consequently:

> Node economic participation must be Day-0-capable. Exact
> percentages, attribution formula, and incentive weights remain
> policy-versioned and must earn separate evidence.

> A node does not earn fees merely by existing or registering. Economic
> entitlement must follow confirmed contribution to an economic outcome
> under the applicable frozen `DistributionPolicyVersion`.

This corrects the *capability timeline* only — the mechanism (already
real: `FeeCollectionEvidence(CONFIRMED)` → `FeeObligation` →
`DistributionPolicyVersion` → `EntitlementLedgerEntry`,
`prisma/schema.prisma`) must not be architecturally blocked until
Months 7-9. It does **not** change the three tiers' own *rollout*
narrative above (bootstrap nodes still run voluntarily today; the
Reputation-node Pool and Lightning-style routing fee above remain
real, phased product decisions, not frozen by this correction) and it
does **not** adopt any percentage, formula, or proof-of-relay/
coordination mechanism — none of those is decided here or anywhere
else in this repository yet. See `docs/BACKLOG.md`'s entry for the
full registration.

**Open question, registered non-normatively (2026-09-09, Day-0
Multi-Node + Partner Beta Reality institutional reconciliation):**
whether **"Node Operator" should become a formal eligible-recipient
category** within the existing
`FeeCollectionEvidence(CONFIRMED) → FeeObligation →
DistributionPolicyVersion → EntitlementLedgerEntry` chain — i.e.,
whether a future `DistributionPolicyVersion` could name "Node Operator"
alongside whatever recipient classes it already names, the same way
this section already treats LPs and Developers as distinct categories.
**Not decided here** — no schema change, no percentage, no eligibility
criteria. See `docs/BACKLOG.md`'s Day-0 Multi-Node entry for the full
registration and cross-links.

### 4.3 Developers (protocol-spec, SDK, and module contributors)

- **Open-source contribution model** — the same non-monetary incentive
  that sustains Bitcoin Core, Linux, and most successful protocols:
  reputation, career capital, and being early in an ecosystem's growth
  curve.
- **Developer/Treasury Fund** — seeded from Protocol Fee revenue once fees
  activate (section 3). Used for: ongoing `@sails/protocol-spec` and
  `@satsails/p2p-trading-sdk` maintenance, funding third-party security audits beyond the
  grant-funded first one, and **grants to external contributors** who build
  new modules (e.g., a fintech that needs `Sails OpenFinance` sooner than
  the roadmap schedule can fund its own development and contribute it back).
- This is structurally identical to how the Uniswap Foundation or Ethereum
  Foundation fund ongoing ecosystem development from protocol
  revenue/foundation treasury rather than ongoing token emission — and,
  once it exists, is intended to be administered by the Sails Foundation
  rather than Satsails directly (`GOVERNANCE.md` §2B), the same separation
  those two foundations maintain from their respective founding companies.

### 4.4 Arbitrators (dispute resolution — see `SECURITY_MODEL.md` section 3)

**Updated (v8.10) to reference the formalized primitives:** an arbiter's
decision is a `Verification` (`PROTOCOL_SPECIFICATION.md` §1.8,
RFC-003) evaluating the `Proof`s submitted to a `Dispute` (§1.9), and the
`Dispute.ruling` (`RELEASE` | `REFUND` | `SPLIT`) is what determines the
fee split below — this section previously described the mechanism only in
prose, before either primitive existed in this form.

- **Bond:** arbitrators stake **reputation**, not a token — their
  `ReputationScore` (already a protocol primitive) acts as collateral. A
  bad-faith or clearly incorrect ruling damages their score, which is
  publicly visible and portable across the whole network — a real,
  non-speculative cost to acting in bad faith.
- **Fee:** a small arbitration fee (e.g., 1-2% of the disputed amount) is
  paid **by the losing party** in the dispute, drawn from the escrowed
  funds at resolution time. If a dispute is resolved without fault (e.g.,
  a timeout with no clear bad actor), the fee is split evenly between both
  parties as a shared cost of using dispute resolution — comparable to how
  insurance/mediation fees work in traditional escrow arrangements.
- **Why not a token-staking model like Kleros:** Kleros (a real
  decentralized arbitration protocol) requires jurors to stake a native
  token (PNK) to be selected and rewarded. Sails deliberately avoids this —
  reputation-as-bond achieves the same "skin in the game" property without
  introducing a speculative asset arbitrators would need to acquire first.

> **Dated note, 2026-10-26.** No charge exists beyond the 0.40% Protocol Fee. The loser-pays arbitration fee (1-2%) described above is not part of the Day-0 model, and the appeal-fee multiplier of RFC-021 D6 is not a Day-0 charge. The 10% Arbitration Reserve (§6.2) is protocol-treasury revenue earmarked to finance arbitration; it is not a user balance and not an automatic payment to any arbiter. Effective arbiter remuneration is a later policy (POST-DAY0) that must not depend on the direction of a ruling. Provisionally, for the beta, the operator that designates an arbiter bears that arbiter's operational costs; in a beta operated by Sails, Sails bears them; users are charged nothing additional.

### 4.5 Wallets (reference implementations and third-party wallet integrators)

- **Primary incentive:** product differentiation. A wallet that offers
  non-custodial P2P trading via Sails attracts and retains users without
  building that infrastructure itself — the SDK does the work.
- **Protocol-level rebate:** a portion of the Protocol Fee generated by
  trades executed through a specific wallet's integration flows back to
  that wallet as a rebate — an affiliate/referral mechanism, comparable to
  how some DEX aggregators share a cut of fees with the front-end that
  originated the trade. This directly rewards wallets for integrating
  deeply and promoting usage, without requiring a token.
- **The rebate is per-side, not per-trade, which is what makes it work
  across different wallets (added following the external review):**
  because a `TradeIntent` has a buyer and a seller (`PROTOCOL_SPECIFICATION.md`
  §1.2), and each independently originates from whichever wallet they're
  using, the Wallet Rebate bucket (section 6.2) splits by origin, not by
  trade. Concretely:

  ```
  User A (Satsails Wallet)  buys USDT  from  User B (Rumble Wallet)

  Protocol Fee (0.40% of trade value)
    ├── Satsails Wallet  ← rebate for originating User A's side
    ├── Rumble Wallet    ← rebate for originating User B's side
    └── Node/Treasury/Arbitrator buckets (section 6.2)
  ```

  When both sides happen to use the same wallet, that wallet simply
  receives both origination rebates. When they differ — the common case
  once multiple wallets integrate — **both wallets are paid for the same
  trade**, neither one having to be the "primary" integration. This is the
  mechanism that makes section 3B's neutrality principle concrete rather
  than aspirational: Rumble Wallet earns exactly as much for originating
  its side of this trade as Satsails does for originating the other, with
  no dependency on which wallet the Reference Implementation happens to
  be.

### 4.6 Integrators (fintechs, ERPs, enterprise apps beyond wallets)

- Same rebate mechanism as wallets (4.5) for standard integrations.
- **Enterprise Licensing** (section 2) applies to integrators needing
  white-label branding, dedicated support, or an SLA beyond the open SDK —
  this is Satsails' reference-implementation business model layered on top
  of the open protocol, not a protocol-level fee.

### 4.7 Infrastructure Provider Economy (added following the external review)

Sections 4.1 and 4.4 already establish that Liquidity Providers and
Arbitrators are economically incentivized, not free labor — this section
names the pattern explicitly and extends it to two roles the original
stakeholder list didn't yet cover, so "who gets paid for running Sails
infrastructure" has one answer instead of being scattered across the
document:

| Role | Protocol interface | Incentive | Detail |
|---|---|---|---|
| **Liquidity Provider** | `LiquidityProvider` (`liquidity.service.ts`, `PROTOCOL_SPECIFICATION.md` §1.3) | Spread + volume-tiered fee discounts | Section 4.1 |
| **Arbitration Provider** | `ArbitrationProvider` (RFC-007, `rfcs/RFC-007-real-world-p2p-requirements.md`, decision D4) | Arbitration fee from the losing party + reputation bond | Section 4.4. RFC-007 registers arbitrators per application ("Trusted Arbitrators"), not as a protocol-native role — the fee mechanism here is what makes filling that role economically worthwhile, not just a trust obligation. |
| **Agent Provider (QVAC / Sails OpenAgents)** | `AgentGrant`/`AgentScope` (`PROTOCOL_SPECIFICATION.md` §1.7) | 📋 Future — see section 2B's "Agent Marketplace" | Not yet monetized in this document prior to this review. An entity running QVAC-backed matching, fraud detection (RFC-007 D7's Social Engineering Agent), or risk analysis on behalf of Participants is providing real infrastructure, and section 2B commits the architecture to eventually pricing that the same way as every other role here — paid in settlement assets, never a token. |
| **Settlement Provider** | `SettlementProvider`/`SettlementAdapter` (`PROTOCOL_SPECIFICATION.md` §1.5, §4B) | Node Operator Pool share (section 4.2) today; a direct per-settlement fee is one of section 2B's named future sources | A future `SettlementAdapter` beyond Mock/Multisig/Lightning HODL/Liquid Covenant (e.g. a specialized custody/covenant provider) is exactly the kind of infrastructure role this economy is designed to extend to without a redesign — the Adapter pattern already makes "add a new implementation" a non-event architecturally; this table makes it a non-event economically too. |

**Why this table matters strategically:** it is the answer to "the
protocol doesn't just pay whoever builds a wallet — it creates an economy
around every role that sustains the ecosystem," which is the distinction
between a protocol with one sponsor (rebates only) and a protocol with a
genuine open economy (rebates *and* infrastructure incentives, matching
how Lightning Network routing nodes and Ethereum validators are both
paid, not just wallet front-ends).

---

## 5. Comparative Analysis

| Protocol | Token? | Core revenue mechanism | Liquidity model | Relevance to Sails |
|---|---|---|---|---|
| **Uniswap** | Yes (UNI) — governance + optional fee-switch | Swap fee (0.01%-1%) paid by swapper to pooled LPs | Pooled AMM (LPs deposit ahead of time) | Low direct relevance — Sails has no pooled liquidity, so LP-share/impermanent-loss mechanics don't map. Confirms fee-switch-style governance (fee parameters controlled by a broader body, not a single company) is worth adopting conceptually. |
| **Aave** | Yes (AAVE) — governance + Safety Module staking | Interest rate spread; "reserve factor" cut to DAO treasury | Pooled lending (aTokens represent pool share) | Low direct relevance for the same pooling reason. Confirms a treasury/reserve-factor pattern is a proven way to fund ongoing protocol development from real usage. |
| **Morpho** | Yes (MORPHO) — governance only, not required for matching | P2P rate improvement over underlying pool (Aave/Compound); protocol fee optional | **P2P-matching-first**, falls back to pooled liquidity when no direct match exists | **Highest relevance.** Morpho proves that a "prefer direct P2P matching over pooled inefficiency" philosophy — the same philosophy behind Sails' Discovery/Negotiation primitives — is viable at scale. Its token is for governance, not required for the matching engine itself, which validates that Sails' no-token stance doesn't sacrifice any core functionality. |
| **Bisq** | **Yes (BSQ)** — a colored-coin token used for trading fees, arbitrator/mediator bonds, and DAO voting | Trading fees payable in BSQ or BTC; BSQ burned/distributed | True P2P, non-custodial, no pooled liquidity | **Important honest caveat:** Bisq is often cited as a "no-token" P2P exchange, but it does have BSQ for fees and arbitrator bonding. Sails deliberately diverges here — all Sails fees and arbitrator bonds are denominated in the settlement asset (BTC/USDT) or reputation (not a new token), trading away Bisq's unified accounting unit in exchange for avoiding a new speculative asset entirely. |
| **HodlHodl** | **No token** | Small escrow fee, paid in BTC/fiat by one or both parties | True P2P, non-custodial, no pooled liquidity | **Direct proof-of-concept.** HodlHodl demonstrates a non-custodial P2P Bitcoin marketplace can sustain itself purely on transaction fees denominated in the traded asset, with zero token. This is the closest real-world validation of Sails' fee model. |
| **Lightning Network** | No token | Routing fees (base fee + proportional fee per hop), paid in satoshis by the sender to routing nodes | N/A — payment channel network, not a marketplace | **Direct model for Node Operator incentives** (section 4.2) — pay infrastructure providers directly in the asset being moved, proportional to service provided, with no token or emissions required. |

**Conclusion drawn from this comparison:** every protocol on this list that
uses pooled liquidity (Uniswap, Aave) also uses a governance token, because
pooled liquidity needs a share-accounting mechanism a token provides
naturally. Every protocol that is genuinely P2P without pooling (HodlHodl,
Lightning, and Morpho's core matching engine) either has no token or
doesn't need one for its core function. **Sails has no pooled liquidity —
it is P2P discovery and negotiation, like HodlHodl and Morpho's matching
layer — which is precisely why it doesn't need a token either.**

---

## 5B. Network Effects & Why Wallets Collaborate Instead of Compete

**Added following the external economic-model review.** Morpho's
integrators (custodial and non-custodial wallets, aggregators, other
protocols) all earn from routing volume through Morpho rather than
building their own lending engine — the same effect this section claims
for Sails, cited directly because it's the closest real precedent for
"a neutral coordination layer makes competitors into co-beneficiaries."

**Without a shared protocol**, wallets compete for the same finite pool of
users by each building isolated, non-interoperable P2P infrastructure —
duplicated engineering cost across every wallet, and each wallet's
liquidity and reputation data trapped inside its own walls.

**With the Sails Protocol**, cross-wallet trades (section 4.5's example)
mean liquidity and reputation are shared resources, not competitive
moats:

```
More wallets integrate
  ↓
More liquidity visible to Discovery (§1.3)
  ↓
More successful matches, more settlement volume
  ↓
More Protocol Fee revenue split across every originating wallet (§6.2)
  ↓
Stronger incentive for the next wallet to integrate
```

This is a real network effect, not a marketing claim: each additional
wallet makes the protocol more valuable to every wallet already
integrated, because `Sails OpenLiquidity`'s Discovery primitive
aggregates across all of them (`liquidity.service.ts`'s `LiquidityRouter`
already aggregates multiple `LiquidityProvider`s by design — the same
mechanism, extended to more integrators, is exactly what compounds this
effect). Wallets stop competing on "who has better P2P infrastructure"
(the infrastructure is now shared and identical for everyone, per 3B's
neutrality principle) and compete purely on user experience, support, and
distribution — which is a healthier, more differentiable axis of
competition for the wallet businesses themselves.

---

## 6. Fee Mechanics — Exact Flow

### 6.1 Who pays

**HISTORICAL / SUPERSEDED — never implemented this way (noted Missão 11
Fase 6.5.2).** The paragraph below describes the original design
proposal. What was actually built (`FeePayerModel`/`FeeEconomicBasis` in
`prisma/schema.prisma`) has exactly one payer model —
`SELLER_PAYS`/`SELLER_DELIVERED_VALUE` — with no split-between-parties
option ever added to the schema. This is the normative text going
forward: **the Protocol Fee is charged to the seller, computed on the
value the seller delivered.** The split-proportionally description below
is kept for historical record, not corrected in place, per this
project's own discipline of never silently rewriting past design intent.

<details>
<summary>Original proposal (superseded, kept for historical record)</summary>

The Protocol Fee is charged at **Settlement** (see the `Settlement`
primitive in `PROTOCOL_SPECIFICATION.md` section 1.5), split proportionally
between the two counterparties of the completed trade (buyer and seller,
or borrower and lender for future OpenFinance intents) — not charged to
either party alone. This mirrors how HodlHodl splits its escrow fee.

</details>

### 6.2 Who receives

**HISTORICAL / SUPERSEDED as of Missão 11 Fase 6.5.2 — the mechanism
below (`chargeProtocolFee()`/`FeeDistribution`, RFC-021 Phase 0) and the
Fase 2.2 evolution of it that followed
(`FeeDistributionBatch`/`FeeDistributionBatchItem`) have been retired and
are now write-frozen at the database level; neither is capable of
producing a new economic entitlement.** The single normative economic
authority going forward is `FeeCollectionEvidence(CONFIRMED) →
FeeObligation → a frozen DistributionPolicyVersion →
EntitlementLedgerEntry` (Missão 11 Fase 6.3A,
`src/modules/open-settlement/entitlement-allocation.service.ts`) — an
exact, policy-versioned, N-recipient ledger, not a fixed four-bucket
split. **No production distribution policy has been published under that
new architecture as of this writing** — the 35/30/25/10 split below
remains a documented, dated, never-formally-activated *proposal*, not a
frozen decision; it is preserved here as the historical rationale a
future distribution policy may or may not adopt, not as something
already in force.

The description below is kept for historical record, describing a
mechanism that no longer accepts new writes:

The fee is never collected into a single company's account. It splits into
four buckets at the moment of settlement:

```
Protocol Fee (100%, default rate 0.40% of trade value — section 3)
  ├── 35% → Originating Wallet/Integrator Rebate  (section 4.5/4.6)
  │           split per-side (section 4.5) — e.g. 17.5% to the buyer-side
  │           wallet's origination, 17.5% to the seller-side wallet's, or
  │           the full 35% to one wallet when both sides use it
  ├── 30% → Node Operator Pool        (infrastructure providers, section 4.2)
  ├── 25% → Developer/Treasury Fund    (ongoing protocol development, section 4.3)
  └── 10% → Arbitrator Reserve         (pre-funds dispute resolution, section 4.4)
```

**Revised 2026-08-11** from the original 40/30/20/10 (Node/Treasury/Wallet/
Arbitrator) split. Rationale: wallets are the acquisition channel — without
a partner wallet integrating the SDK, the protocol has no users at all, so
their rebate is now the largest single bucket rather than the smallest of
the three infrastructure/treasury/wallet shares. Node Operator Pool and
Treasury both step down slightly (40%→30%, 30%→25%) to fund that increase;
Arbitrator Reserve is unchanged at 10% — dispute-resolution funding doesn't
scale with go-to-market incentives the way wallet acquisition does.

These percentages are a proposed starting allocation, not fixed forever —
see section 7 on how they're governed and changed over time. The
buyer-side/seller-side split *within* the 35% bucket (section 4.5) is
likewise illustrative, not fixed — the architectural commitment is that
the split is per-originating-side, so a trade between two different
wallets pays both, never just one.

> **Dated note, 2026-10-26 — approved target distribution.** The Founder/CTO approved the following distribution of the 0.40% as the Day-0 target: 35% originating wallet/integrator, 30% node operators, 25% protocol treasury (development), 10% arbitration reserve. The 25% and the 10% are both treasury revenue: the treasury receives 35% of the fee automatically at settlement and keeps the two shares in separate, verifiable accounting classes (`TREASURY_DEVELOPMENT`, `TREASURY_ARBITRATION_RESERVE`). The reserve is not a user balance and not an automatic payment to an arbiter. This is a target, not an activation: no `DistributionPolicyVersion` has been published, and publication or production activation requires the technical and security gates and independent homologation per settlement line. Terminology: "SPLIT" is reserved for the settlement ruling between buyer and seller (`EscrowStatus.SPLIT`); the division of the fee is "distribution".

### 6.3 How distributed

**HISTORICAL / SUPERSEDED — see §6.2's own note.** The real, built
architecture (Fase 6.3A) separates *entitlement* (an exact ledger record
of what a recipient is owed) from *payout* (moving real value to that
recipient) — entitlement accrual is real and implemented; payout
execution is a distinct, not-yet-built future phase. The "paid directly
at settlement time, no claim process" description below reflects the
original, pre-Fase-6.3A proposal, not the current architecture.

Distribution happens **at settlement time**, computed by the
`SettlementProvider` implementation as part of the release transaction —
not batched, not held by an intermediary, not requiring a separate claim
process. Each bucket's share is paid directly in the settlement asset to:

- the **Node Operator Pool** — an address/mechanism defined in the Protocol
  Spec (not controlled by any single reference implementation)
- the **Developer/Treasury Fund** — similarly protocol-defined
- the **originating wallet's** designated payout address (registered when
  a wallet integrates the SDK)
- the **Arbitrator Reserve** — accumulates until drawn on for dispute
  resolution fees (section 4.4)

Because this logic lives in the `SettlementProvider` interface
(`PROTOCOL_SPECIFICATION.md` section 1.5), **every reference implementation
distributes fees identically** — a company implementing Sails Protocol in
Rust follows the same split as the Satsails TypeScript implementation. This
is what makes the fee model a protocol-level guarantee rather than a
business decision any single implementer could quietly change.

> **Dated note, 2026-10-26 — distribution happens at settlement.** The settlement-time distribution of the original proposal above is reinstated in intent by the Founder/CTO decision, with the entitlement ledger kept as accounting and not as a deferred payout. Wallet and node shares are paid automatically — inside the settlement itself where the rail supports it safely — to recipients frozen in the escrow's economic snapshot and validated by the participants before the escrow opens; the treasury receives its 35% in the same operation. Where an atomic payment is not viable, an automatic payment chained to the confirmation of the settlement may be evaluated, with durable execution, idempotent retries and verifiable pending/recovery states. A ledger entry is not receipt of funds: each recipient has a verifiable state of its own. If a verifiable wallet or node attribution is missing, the operation fails before the escrow opens; third-party shares are never silently redirected to the treasury. Amounts are whole units of the asset; each wallet and node share is rounded down individually; the unavoidable rounding residue goes to `TREASURY_DEVELOPMENT` by a deterministic rule and never reduces a share already computed for another beneficiary; the sum distributed never exceeds the fee. No Sails Node can unilaterally redirect a wallet or node share. Cooperative participants may be able to bypass the official flow on some script-based rails; no mandatory central co-signer is introduced for that reason. This note does not state that any of this is implemented, tested or homologated; see the `docs/BACKLOG.md` entry of 2026-10-26.

### 6.4 How to avoid centralization

Four concrete mechanisms:

1. **No intermediary custody of fee revenue.** Funds move directly from the
   settling escrow to each bucket's destination at release time — there is
   no step where "Sails Inc." (or any company) holds collected fees before
   distributing them. This avoids recreating exactly the custodial
   single-point-of-failure the whole protocol exists to eliminate.
2. **Fee parameters live in the versioned Protocol Spec, not in any single
   implementation's code.** The percentages in section 6.2, the fee rate
   itself, and which assets qualify are part of `@sails/protocol-spec` —
   publicly documented and versioned. A reference implementation cannot
   unilaterally redirect fee revenue without diverging from the spec in an
   auditable way.
3. **Governance of fee parameters transitions away from Satsails.** Per
   section 3, once "Governance layer v1" ships (`ROADMAP.md`, Months
   10-12), changes to the fee rate or the bucket-split percentages require
   the multi-stakeholder governance process, not a unilateral decision by
   whichever company happens to run the most-used reference implementation.
4. **The fee is optional per integrator, not mandatory.** Any wallet or
   fintech integrating the SDK can configure a 0% Protocol Fee for their
   own users if their business model doesn't need it — see the "Protocol
   Fee is OFF (0%)" bootstrap-phase default in section 3. This prevents the
   protocol itself from becoming a mandatory rent-extraction layer that
   integrators have no way to opt out of.

> **Dated note, 2026-10-26.** Superseded for production settlement lines: the Protocol Fee is mandatory at 0.40% (see the note in §3). The statement above is kept as history.

### 6.5 Economic Authority Model — Terminology (Missão 11 Fase 7.1/7.2)

Three distinct real, implemented entities govern economics today — easy to
conflate by name alone, so spelled out explicitly:

- **`FeePolicyVersion`** (`src/modules/open-settlement/fee-policy.service.ts`)
  — governs fee **charging**: the rate, `payerModel`/`economicBasis`
  (today exactly `SELLER_PAYS`/`SELLER_DELIVERED_VALUE`, no other value
  implemented), and `requiredConfirmations`. **Rail-scoped** — a real
  Postgres partial unique index
  (`fee_policy_versions_single_published_per_rail_key`, migration
  20260823182951) enforces at most one PUBLISHED row per `railScope`.
  Its four legacy bucket-percentage columns (`nodeOperatorPct`/
  `treasuryPct`/`walletRebatePct`/`arbitratorReservePct`, section 6.2's
  original four-bucket description) are no longer normative inputs for a
  new publication — nullable, no longer validated. Existing historical
  rows keep their original values, unchanged and fully readable.
- **`DistributionPolicyVersion`** (`src/modules/open-settlement/distribution-policy.service.ts`)
  — governs fee **allocation**: which `DistributionRecipient`s exist and
  their `weightPct` split, summing to exactly 100. **Global, not
  rail-scoped** (Phase 6.2 D4 — distribution economics are protocol-level,
  not per-rail) — a real Postgres partial unique index
  (`distribution_policy_versions_single_published_key`, migration
  20260823182951) enforces at most one PUBLISHED row, period.
- **`FeeCollectionEvidence`(CONFIRMED)** — the **collection-generation
  identity**. **Missão 11 Fase 7.2's central decision:** the
  `DistributionPolicyVersion` governing a generation's future allocation
  is selected exactly once, at the moment this CONFIRMED row is recorded
  (`FeeObligation` transitioning to `COLLECTED`) — never at whenever an
  allocation worker happens to run later. The selected policy's id is
  persisted directly on this row (`distributionPolicyVersionId`,
  nullable — `null` is a real, permanent outcome when zero policy was
  PUBLISHED at that moment, never backfilled) and is immutable once set
  (a real Postgres trigger,
  `fee_collection_evidence_distribution_policy_immutability_guard,`
  rejects any later change, including raw SQL). **Operational latency
  never changes economic ownership**: if a different policy is published
  later, or an allocation worker runs seconds, minutes, or a process
  restart afterward, the frozen reference is unaffected. A reorg followed
  by a genuine reconfirmation creates a brand-new CONFIRMED row — a new
  generation, independently frozen to whatever policy is live at THAT
  moment — the original generation's own frozen reference is never
  rewritten.
- **`EntitlementLedgerEntry`** (Phase 6.2 §G/§20) — the historical
  **entitlement truth**: an append-only, `ALLOCATION`/`REVERSAL`-kind
  ledger, one row per (recipient, collection generation), always
  referencing the frozen policy the generation itself already decided —
  `EntitlementAllocationService.allocate()` never re-derives the policy
  from live state; it only materializes what recognition-time already
  fixed. A recipient's balance is always `SUM(amount)` over this table —
  never a cached/mutable balance column. Internal accounting; not exposed
  by any public route unless a concrete participant-facing use case
  requires it later.

Both policy tables fail closed on ambiguity: a lookup that finds more
than one simultaneously-PUBLISHED row throws `EconomicAuthorityAmbiguityError`
rather than silently picking "the newest" — structurally prevented from
arising at all by the two unique indexes above, this is defense-in-depth
for a legacy/corrupt/raw-SQL-bypass state, not an expected runtime path.

**Bootstrap distribution model status:** 100% of collected fee revenue to
a single `PROTOCOL_TREASURY`-class recipient is the **intended bootstrap
shape** for the first controlled Satsails production flow — proven,
exactly, by an isolated real-Postgres test
(`tests/integration/collectedTimeDistributionFreeze.test.ts`'s own R18
case, test-only, never published outside a test). **This is not activated
anywhere.** No `DistributionPolicyVersion` matching this (or any) shape
has been published in any real environment as of this writing. This does
not mean Wallet/Node/Arbiter economics (section 6.2's original
four-bucket proposal) are abandoned — they require their own design,
implementation, tests, and documentation as additional
`DistributionRecipient` classes, each independently designed/
implemented/tested/documented/auditable, before any external economic
offer is made on them. Future `DistributionPolicyVersion`s activate those
models prospectively; already-created entitlements are immutable and
never reinterpreted.

**Bootstrap operator control plane:** publishing a `FeePolicyVersion`/
`DistributionPolicyVersion` (moving it from DRAFT to PUBLISHED) is done
via a server-side-only operator CLI (`scripts/publish-economic-policy.ts`,
`npm run economics:publish-policy`), not an HTTP admin endpoint and not
any reuse of `CapabilityRegistry` — see that script's own header comment
for the full reasoning. This is bootstrap operational governance, not
final protocol governance; when "Governance Layer v1" (section 7,
`ROADMAP.md` Months 10-12) exists, only the caller of the same
service-layer `publish()` methods changes.

**`CustodyAttestation`** (Missão 11 Fase 7.3.2/7.3.3 §F,
`src/modules/open-settlement/custody-attestation-repository.ts`) — a
fifth entity, deliberately kept separate from the four above: it never
governs charging, allocation, collection-generation identity, or
entitlement truth. It answers a narrower, previously-undocumented
question — *"where does the operator say a given recipient's funds
physically live"* — as an append-only, rail-agnostic historical record,
linked to a `DistributionRecipient` but never to a specific
`EntitlementLedgerEntry` or collection generation directly (a read-time
cross-reference, `CustodyAttestationService.findAttestationsForEscrow()`,
joins the two for audit purposes; the underlying tables remain
independent).

**Critical distinction, stated explicitly and not to be blurred in any
partner-facing material:** a `CustodyAttestation` row's
`attestationAuthority` field is `BOOTSTRAP_OPERATOR_ATTESTED` for every
row this codebase can currently produce — meaning **a human operator
declared this historically, through the same trust boundary as every
other bootstrap-operator action** (`scripts/draft-economic-policy.ts`,
no HTTP surface, no admin token). **This proves what was declared, not
who actually controls the underlying custody key.** It is not a
signature from the custody key itself, not an on-chain proof, and not
independently verifiable by a third party beyond trusting the operator's
own attestation. The schema reserves a second value,
`CRYPTOGRAPHIC_PROOF`, for a future mechanism (e.g. a signed message from
the actual custody key, or an on-chain covenant) that would independently
prove control rather than merely record a declaration — **nothing in
this codebase produces a `CRYPTOGRAPHIC_PROOF` row today**, and no such
mechanism is implemented, scheduled, or claimed by this document. Never
present a `BOOTSTRAP_OPERATOR_ATTESTED` row as if it were cryptographic
proof of custody control in any external-facing material.

No payout or claim mechanism reads or acts on a `CustodyAttestation` row
— recording one activates nothing, moves nothing, and generates no key
or address.

**Partner-facing documentation principle:** any document describing this
economic model to an external partner must distinguish, explicitly,
between *architecture that is implemented* (the entities above, the
exclusivity/fail-closed/COLLECTED-time-freeze guarantees, the bootstrap
proof) and *economic parameters that are actually activated in
production* (as of this writing: none — `PROTOCOL_FEE_RATE` remains at
its bootstrap default, no `FeePolicyVersion` or `DistributionPolicyVersion`
has been published outside a test). Never present an unpublished/
unauthorized parameter as if it were already live.

> **Dated note, 2026-10-26 — three categories kept absolutely separate.** (1) User escrow funds. (2) The economic rights of beneficiaries — wallet/integrator and node-operator shares belong to the beneficiary from settlement and are paid to the address frozen in the snapshot. (3) Protocol-treasury revenue (25% development + 10% arbitration reserve), administered by the treasury. Treasury keys are distinct from any escrow or arbiter signing key and can never control an escrow, move user funds, or decide a dispute unilaterally; administering the arbitration reserve grants no power over user funds or over dispute resolution beyond powers previously consented to. A beneficiary address is registered and validated per asset and network, tied to the beneficiary's verifiable identity, and frozen in the snapshot before the escrow opens; later changes apply only to new operations. A registration by itself is not proof of economic eligibility (see the Sails Console entry in `docs/BACKLOG.md`, 2026-10-26).

---

## 7. Governance of Economic Parameters (cross-reference to `ROADMAP.md`)

The economic parameters in this document (fee rate, bucket splits,
arbitration fee %) are **defaults proposed for the bootstrap phase**, owned
by Satsails during Months 1-12 while the ecosystem was still early in its reference-implementation phase. This sentence is historical rationale, not a current module-count statement. As the ecosystem
matures per the roadmap:

- **Months 1-12:** Satsails proposes and can adjust these defaults as
  needed to support adoption (e.g., keeping the Protocol Fee at 0% longer
  if that better serves growth).
- **Months 10-12 onward:** "Governance layer v1" (already committed in
  `ROADMAP.md`) becomes the body that reviews and approves changes to fee
  parameters — composed of recognized ecosystem stakeholders (reference
  implementers, major integrators, node operators), not necessarily a
  token-weighted vote (consistent with the no-token principle), but a
  multi-signature or delegated-representative process instead.

Do not treat the percentages in section 6.2 as final — they are a
reasoned starting proposal, explicitly designed to be revisited by
governance once real settlement volume makes the trade-offs concrete rather
than theoretical.

---

## 8. Summary Table — Six Stakeholders, One Page

| Stakeholder | Incentive mechanism | Paid in | Token required? |
|---|---|---|---|
| Liquidity Providers | Spread + volume-tiered fee discounts | Settlement asset | No |
| Node Operators | Node Operator Pool share (uptime-proportional) + future Lightning-style routing fees | Settlement asset | No |
| Developers | Developer/Treasury Fund grants + open-source reputation | Settlement asset / fiat | No |
| Arbitrators | Arbitration fee (from losing party) + reputation bond | Settlement asset (fee) / reputation (bond) | No |
| Wallets | Fee rebate on originated volume + product differentiation | Settlement asset | No |
| Integrators | Same rebate + optional Enterprise Licensing (Satsails business layer) | Settlement asset / fiat | No |

Every row is satisfied without introducing a Sails-native token — the
constraint from section 1 holds across the entire design.

**Not exhaustive as of section 4.7's addition:** this table predates the
external economic-model review and covers stakeholder groups from the earlier economic-design pass. Do not read this table as evidence that those incentives are currently active in production. Section 4.7 adds two
more infrastructure-provider roles — Agent Providers and Settlement
Providers beyond today's Mock/Multisig — both still 📋 Future rather than
active, which is why they're documented there rather than folded into
this table as a seventh and eighth row that would overstate how built-out
they are.

---

## 8B. Why Any Wallet Should Integrate (added following the external review)

By the end of this document, any wallet founder should be able to answer,
concretely, the question opened in section 1C:

> **"Why would I integrate the Sails Protocol if I already have a working
> wallet?"**

**Because integrating turns a cost center into a revenue participant,
without building the infrastructure yourself.** Instead of engineering a
marketplace, reputation system, escrow, dispute mediation, settlement
logic, agent integration, and liquidity discovery independently — the
`@satsails/p2p-trading-sdk` (`SDK_GUIDE.md`) provides all of it — a wallet integrates the
SDK and starts earning a rebate (section 4.5) on every operation its users
originate, with exactly the same economic opportunity as every other
wallet in the ecosystem (section 3B), and its earning surface grows every
time another wallet joins (section 5B) rather than shrinking.

> "The Sails Protocol turns wallets from cost centers into participants
> in an open economy of financial infrastructure."

This sentence is the one-line version of sections 1B through 8 above —
useful for a pitch deck or a first integration conversation, but every
claim in it traces back to a specific, non-speculative mechanism
documented in this file, not to a marketing promise.
