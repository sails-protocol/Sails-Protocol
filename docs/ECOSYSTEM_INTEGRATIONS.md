# ECOSYSTEM_INTEGRATIONS.md
### Sails Protocol — Ecosystem Integration Direction & Historical Fit Analysis

> **Authority / status:** vision/fit analysis, not a protocol specification and not a current implementation inventory. Some integrations or adjacent capabilities discussed here have evolved since this document was first written. For current implementation, maturity and production eligibility, use SYSTEM_DESIGN, provider/rail evidence, BACKLOG and live Issues/Project.
>
> Statements below that describe a network as a possible fit remain architectural/positioning analysis unless backed by explicit current implementation evidence. Do not infer "not built" or "production-ready" from this document alone.

---

## 1. The One Claim This Document Makes

Sails Protocol is a coordination layer, not a competing settlement,
execution, or custody layer. It does not replace any network, wallet
infrastructure, or key-management provider named below — it sits above
them and coordinates *who* transacts with *whom*, under *what terms*,
before any of them are asked to move value.

The sentence to use whenever this needs stating plainly:

> **"Settlement networks move value. Sails Protocol coordinates who,
> with whom, and under what conditions that value moves."**

This is a restatement of `PROJECT_CONTEXT.md` section 1's canonical
description ("Sails Protocol doesn't operate a P2P exchange — it's the
infrastructure that lets any wallet become an interoperable P2P Financial
Marketplace"), applied to third-party networks instead of to the wallets
that integrate the SDK. It does not supersede that sentence — the One
Sentence Test answer in `PROJECT_CONTEXT.md` section 5 is still the
canonical "what is Sails Protocol" answer everywhere.

**This document does not create implementation authority by itself.** The Sails P2P Trading SDK remains the first concrete developer product, while implementation priorities and integration maturity are governed by the current Backlog, accepted ADR/RFCs and live Issues. A network named here may be aspirational, implemented, reference-only or production-ineligible depending on current evidence; this document does not decide that status.

**What this document must never claim, per `PROJECT_CONTEXT.md`'s "What
the protocol is NOT" list and `THREAT_MODEL.md`'s Custody Creep concern:**
that Sails Protocol reads any external chain's state directly, replaces a
network's own settlement primitives, resolves disputes automatically,
removes the counterparty's fiat-side obligation, or reduces any
integrator's own regulatory exposure to zero. Every section below is
written to avoid those claims — if a rewrite reintroduces one, that is
drift to fix, not an acceptable simplification.

---

## 2. Where This Fits Architecturally (nothing new — reapplying section 2B)

`PROJECT_CONTEXT.md` section 2B's Core / Not Core test applies to every
network named in this document without exception: **would the point still
make sense if the Reference Wallet were rewritten in Rust against
CockroachDB tomorrow, running on a different settlement network entirely?**
If yes, it's a Core coordination concern and belongs in
`PROTOCOL_SPECIFICATION.md`. If the answer changes because of which network
is underneath, it was never Core — it's a `SettlementAdapter` or
`WalletAdapter` question (`PROTOCOL_SPECIFICATION.md` §4B,
`SDK_GUIDE.md` §3-4C), same as PIX, Lightning, and Bitcoin already are.

Every network in sections 4-7 below is, at most, a **potential
`SettlementAdapter` or `WalletAdapter` target** — not a protocol
dependency, not a new official module, and not a new primitive. None of
them require `PROTOCOL_SPECIFICATION.md` to change. `SDK_GUIDE.md` §4C's
"Wallet Stack Compatibility" table already establishes the honest pattern
for this ("📋 Compatible in principle — no `WalletAdapter` implementation
exists yet") — treat every row below the same way.

---

## 3. Key-Management and Custody: Sovereign Mode vs. Institutional Mode

`WalletAdapter` (`SDK_GUIDE.md` §3, real as of RFC-013) is already
transport- and custody-agnostic by design — it does not assume a local
seed. This means the SDK can sit in front of two structurally different
signing setups without any protocol change:

- **Sovereign Mode** (the only one built today): WDK-backed local signing
  on the user's own device — `PROJECT_CONTEXT.md` §3's WDK relationship,
  the Reference Wallet's actual setup.
- **Institutional Mode** (📋 compatible in principle, not built): a
  `WalletAdapter` backed by an institutional key-management API —
  Turnkey, Fireblocks, or an HSM/MPC provider — where signing happens in a
  managed enclave under the integrator's own policy engine instead of on
  a user's device. `SDK_GUIDE.md` §4C's "Custodial APIs" row already
  names this category generically; Turnkey and Fireblocks are concrete
  examples of it, not a new row type.

**Why this distinction matters, not just as a feature list:** an
institutional signer changes who can approve a release, not what the
protocol coordinates. Sails' own `Dispute`/`Policy` primitives
(`PROTOCOL_SPECIFICATION.md` §1) and an institutional signer's transaction
policy operate at different layers — the protocol decides *whether a
release should happen*; the signer enforces *how it's authorized*. Stating
"Turnkey secures the vault" is a different (and more accurate) claim than
"Turnkey is part of Sails Protocol" — the latter would violate the Level
1/Level 3 separation `PROJECT_CONTEXT.md` section 2 is built around.

No module named "OpenKeyManagement" exists in `PROTOCOL_SPECIFICATION.md`
or `ARCHITECTURE.md`'s module table. If institutional custody support ever
becomes real work, it is a new `WalletAdapter` implementation
(`SDK_GUIDE.md` §4C), not a new official module — adding one would need
its own RFC and Module Registry entry (`GOVERNANCE.md` §4), which this
document does not propose.

---

## 4. Bitcoin-Ecosystem Settlement Rails

The pattern in this section repeats for each network: the network solves
a real execution/settlement problem; Sails, if ever integrated, would be a
discovery-and-coordination layer sitting in front of it via a
`SettlementAdapter`, not a replacement for it. None of the integrations
below exist in code. Where a network's own architecture is still evolving
publicly (Spark), claims are deliberately phrased as conditional.

**Scope note (2026-09-10, Product Truth Sweep, F10).** "None of the
integrations below exist in code" refers specifically to the
`SettlementAdapter`/discovery-and-coordination pattern this table
proposes for each network — it is not a claim that no Bitcoin-L2-adjacent
settlement code exists anywhere in this repository. `LIGHTNING_HODL`
(`src/modules/open-settlement/lightning-hodl.provider.ts`) is a real,
testnet-evidenced escrow provider settling via the Ark/Arkade protocol (closed to new admissions for Day 0) —
a materially different design (VTXO-based multi-party escrow) from the
Hold-Invoice/submarine-swap coordination pattern the Lightning row below
describes. Spark's row is not merely "conditional" scope — Spark is
Day-0-required for the Reference Wallet per `docs/BACKLOG.md` item 20;
the conditional phrasing here describes only the maturity of Spark's own
publicly-evolving protocol design, not whether Sails intends to support
it.

| Network | What it actually solves | Where Sails could sit (if built) |
|---|---|---|
| **Lightning Network** | Sub-second, sub-cent Bitcoin payments via payment channels | Off-chain intent matching + Hold-Invoice/submarine-swap coordination for a P2P fiat↔sats leg — inbound-liquidity and routing concerns stay entirely Lightning's, not something Sails models |
| **Liquid Network** | Federated Bitcoin sidechain; confidential transactions; native atomic swaps via PSET | Discovery/negotiation layer in front of PSET-based swaps — Sails would coordinate who swaps with whom and at what price, never the swap's own atomicity guarantee |
| **RGB Protocol** | Client-side-validated smart contracts on Bitcoin/Lightning; no global on-chain state | Coordination layer for the exact problem RGB's design creates: since there is no public mempool or order book, counterparty discovery and consignment-file delivery are off-chain problems RGB deliberately leaves to the application layer |
| **Ark (Ark Labs' Arkade)** | Bitcoin L2 scalability via shared VTXOs, no new token, no sidechain | Discovery/reputation layer — Ark solves execution and scalability; it does not solve "how do two strangers find and trust each other before transacting" |
| **Spark (Lightspark)** | Positioned as a high-throughput Bitcoin-native settlement layer for stablecoins — this positioning is still evolving publicly as of this writing and is described here conditionally, not as settled fact | If Spark's settlement model matures as described publicly, a P2P fiat on-ramp coordinated by Sails is architecturally analogous to the Lightning/Liquid rows above |
| **Rootstock (RSK)** | Bitcoin merge-mined EVM sidechain (RBTC, smart contracts) | Same `SettlementAdapter` pattern as any other EVM-compatible chain (section 6) — RSK's Bitcoin anchoring doesn't change the coordination-layer argument |
| **Stacks (STX / sBTC)** | Bitcoin-anchored smart contracts in Clarity, non-custodial sBTC | Off-chain intent coordination in front of Clarity contracts — Clarity's deliberate non-Turing-completeness is a feature of Stacks, not a gap Sails is claiming to fill |

**Explicitly not claimed for any row above:** that Sails reads these
networks' on-chain or off-chain state directly, that an adapter exists, or
that any of these teams have been contacted. This table is an inventory of
architectural fit, not a partnership announcement.

---

## 5. Community and Social Protocols

- **Fedimint / Fedi** — solves private, low-fee community e-cash custody
  and circulation. It deliberately does not solve fiat on/off-ramping or
  cross-federation trust — connecting a federation's economy to the outside
  world is explicitly left to external tooling. A Sails integration, if
  built, would be exactly that connective tissue: a fiat↔e-cash P2P leg
  and `Reputation`-based (see `PROTOCOL_SPECIFICATION.md` §1's Reputation
  primitive) portability of trust across federations — not a claim that
  Fedi has a flaw Sails "fixes."
- **Nostr** — solves censorship-resistant identity and messaging via
  signed events; it is not a financial coordination protocol and doesn't
  attempt to be one. A Sails integration, if built, would add the
  financial-intent primitives (`Intent`, `Negotiation`, escrow-backed
  `Settlement`) on top of Nostr's own relay/identity layer — framed as an
  addition, not a fix, consistent with Nostr's own scope.

---

## 6. Smart-Contract Networks (EVM, Solana, TRON)

Sails Protocol's positioning is **Bitcoin-first, rail-agnostic** — the
Ideal Customer Profile in `PROJECT_CONTEXT.md` section 1 explicitly
includes "multi-chain non-custodial wallets," not Bitcoin-only ones. The
architectural argument for these networks is the same `SettlementAdapter`
pattern as section 4, with one addition specific to how these networks
work:

- **Ethereum and L2s** — negotiation, chat, and offer discovery are
  expensive to do on any gas-metered chain. Keeping that layer off-chain
  (the transport layer already is — `NODE_ARCHITECTURE.md`) and only
  touching an EVM chain at the settlement step is a real cost argument,
  not speculative — it's the same reason the protocol's own transport
  layer (Pears/HyperDHT) was chosen over an on-chain message bus in the
  first place (`RFC-002-transport-provider.md`).
- **Solana** — high throughput makes it a plausible settlement rail for
  an agent-driven use case (`OpenAgents`, still 🏗️ Specified per
  `PROJECT_CONTEXT.md` §4) — machine-speed negotiation needs a
  correspondingly fast settlement leg. This is a fit argument, not a
  claim that any Solana-specific work exists today.
- **TRON** — carries a large share of real-world retail USDT volume in
  several regions this project's own ICP targets (`PROJECT_CONTEXT.md`
  §1). The regulatory-neutrality argument here is the same one section 8
  below states carefully for the whole document — Sails coordinating
  intents off-chain does not, by itself, exempt an integrating wallet from
  its own KYC/AML obligations; see section 8.

---

## 7. Bridges, DeFi, and Swaps

Two structurally distinct arguments, kept separate deliberately:

**Bridges.** Lock-and-mint bridges concentrate value in a single
contract, which is why they are a recurring hack target. A P2P
intent-matching model (discover a counterparty who already holds the
target-chain asset and wants the reverse trade, settle bilaterally) avoids
concentrating custody in one contract — this is an architectural argument
about liquidity concentration, not a claim that Sails has "solved bridge
security." Any real cross-chain settlement still depends on both chains'
own finality and adapter correctness.

**DeFi credit / MEV.** Two separate, smaller claims worth keeping
distinct rather than merged into one "DeFi story":
- Reputation (`PROTOCOL_SPECIFICATION.md` §1's Reputation
  primitive; node-local today, portability is an objective) could be a plausible input to a lending protocol's own risk model,
  the same way a credit bureau score is external to a bank's decision —
  Sails would supply a signal, never a lending decision or a guarantee.
- Off-chain negotiation is not visible to a public mempool, which is a
  structural reason MEV bots can't front-run it — this follows directly
  from the transport layer already being off-chain (section 6), not from
  any MEV-specific feature.

Neither claim implies Sails operates a lending market or a DEX itself —
both remain explicitly out of scope per `PROJECT_CONTEXT.md`'s "What the
protocol is NOT" list.

---

## 8. Emerging Verticals (DePIN, RWA, Gig/Freelance, Agent Economy)

These four are grouped because they share one shape: **two parties who
don't know each other need to discover, price, and settle an exchange of
value for a real-world deliverable**, which is exactly `Intent →
Negotiation → Settlement` (`PROJECT_CONTEXT.md` §1's Mental Model) applied
to a non-trading domain instead of P2P currency exchange.

- **DePIN** (decentralized physical infrastructure — GPU/storage/sensor
  networks): machine-to-machine discovery, reputation for hardware
  reliability, and micro-settlement per unit of work.
- **RWA** (tokenized real-world assets): compliance-gated `Intent`
  matching plus fiat-proof-synchronized settlement, structurally identical
  to the PIX↔asset flow `PROTOCOL_SPECIFICATION.md` §4 already specifies.
- **Gig/freelance work**: `Reputation` that could carry across platforms (an objective; node-local today) instead
  of resetting per platform, escrow-backed settlement on deliverable
  acceptance instead of a platform-run payout queue.
- **Agent economy**: `OpenAgents` (🏗️ Specified, `PROJECT_CONTEXT.md` §4)
  extended so autonomous agents — not just human-operated wallets — are
  the `Intent` originators. This is the most direct extension of existing
  real code (`QvacAgentProvider`, `BuyerAgent`/`SellerAgent`,
  `RFC-016-qvac-crypto-native-agent-boundary.md`), and the vertical this
  document rates most plausible for near-term exploration if any of this
  section becomes prioritized work.

  **A concrete mechanism worth naming, not just the vertical in the
  abstract (checked against WDK's own docs, 2026-07-20,
  `docs.wdk.tether.io/ai/x402/`):** x402 is an HTTP-402-based
  machine-to-machine micropayment protocol (originally Coinbase's) —
  request a resource, get a 402 with a price, sign an EIP-3009 USDT
  authorization, retry, get the resource, all in one HTTP round trip.
  It solves a genuinely different problem than Sails OpenP2P (single-shot,
  fixed-price, no negotiation, no fiat leg, no escrow/dispute) — it is
  **not** a fit for the core P2P trading flow. Where it could fit, if
  OpenAgents is ever built out: a Sails agent paying a third-party API
  for data or inference as part of forming or pricing an `Intent`, which
  is squarely a machine-to-machine, already-digital-asset payment —
  consistent with RFC-016's Crypto-Native Agent boundary (never touches
  fiat). Notable because the client-side signer is `WalletManagerEvm`
  from `@tetherto/wdk-wallet-evm` — the same package
  `wdk-settlement.provider.ts` already depends on, not a new wallet
  stack. **Two honest caveats, not glossed over:** (1) x402 needs a
  Facilitator to verify and settle — either a third-party service (WDK's
  own docs disclaim it: "Tether does not endorse, operate, or assume
  legal or financial responsibility for any third-party facilitator") or
  a self-hosted one (`@semanticio/wdk-wallet-evm-x402-facilitator`,
  `@x402/core`), a real operational choice either way; (2) it is USDT/EVM
  only (Plasma/Stable recommended chains), so it inherits the same
  chain-scope limits as `WDK_USDT_EVM` today. Not scoped, not backlogged
  — recorded here as the answer to "what would an agent-to-agent payment
  mechanism actually look like," should that question come up.

None of these four are scoped, specced, or backlogged — they are recorded
here as fit arguments only, consistent with this document's framing note.

---

## 9. Comparative Positioning: Bisq, Hodl Hodl, Sails Protocol

`PROJECT_CONTEXT.md` section 1 already states the core distinction: *"Bisq
is an application... Sails Protocol is infrastructure a wallet integrates
so that it becomes the application."* The table below extends that
distinction specifically to dispute handling, since it's the sharpest
technical difference. **This does not restate `SECURITY_MODEL.md`'s
dispute-resolution mechanics — see that document for how Sails' own
`Dispute` primitive actually works; this table only compares the
*model*.**

| | Bisq | Hodl Hodl | Sails Protocol |
|---|---|---|---|
| Shape | Standalone desktop application | Centralized web service, non-custodial escrow | Protocol + SDK, integrated into any wallet |
| Escrow | 2-of-2 multisig + security deposits | 2-of-3 multisig (platform holds 3rd key) | Pluggable `SettlementProvider` (`PROTOCOL_SPECIFICATION.md` §4B) — the Reference Wallet's own provider is disclosed as single-seed custody today, `RFC-019-settlement-custody-reference-vs-normative.md` |
| Dispute resolution | DAO-elected mediators/arbitrators | Platform support team, using the 3rd key | Delegated to whichever integrator/community configures it — `SECURITY_MODEL.md`'s Dispute Assistant provides evidence, not automatic rulings |
| Reputation | Local to the Bisq account | Local to the Hodl Hodl account | Shared by any wallet on the same node integrating `@satsails/p2p-trading-sdk` (`PROTOCOL_SPECIFICATION.md` §1's Reputation primitive); cross-operator portability is an objective, not demonstrated |

**The honest caveat this table must carry:** "delegated to whichever
integrator configures it" is not automatically an advantage — it also
means Sails itself provides weaker built-in dispute guarantees than
Hodl Hodl's centralized arbitration out of the box, precisely because it
isn't a single operated service. `SECURITY_MODEL.md` already discloses
this trade-off (the timelock-fallback correction made in that document is
the same honesty standard this table follows) — don't let this table imply
a stronger guarantee than that document does.

---

## 10. What This Document Does Not Claim (regulatory neutrality, stated carefully)

The single biggest risk in any version of this document is overstating
legal/regulatory neutrality. The corrected claim, consistent with
`THREAT_MODEL.md`'s Custody Creep concern and `PROJECT_CONTEXT.md`'s "What
the protocol is NOT" list:

> Sails Protocol's core (message coordination, state transitions,
> cryptographic proofs) does not itself custody assets, operate a market,
> or control participants — which narrows, but does not eliminate, the
> regulatory surface of whoever integrates it. Every integrating wallet or
> application remains responsible for its own KYC/AML, licensing, and
> consumer-protection obligations in whatever jurisdictions it operates.

This is deliberately weaker than "the protocol has zero regulatory
obligations" — that stronger claim is not this project's to make, isn't
verified by any legal review in this repository, and should not appear in
any pitch material sourced from this document. If a future legal review
changes this assessment, update this section and cite the review, don't
strengthen the claim from a strategy conversation alone.

---

## 11. If Any of This Becomes Real Work

Per `GOVERNANCE.md`'s RFC Process and the Implementation Freeze posture
(`GOVERNANCE.md` §6B), nothing in this document authorizes new code, a
new module, or a new primitive by itself. If a specific integration in
this document moves from "vision" to "someone is actually building it,"
the path is the same as any other protocol change:

1. Check whether it's genuinely a `SettlementAdapter`/`WalletAdapter`
   question (most of this document) or an actual Core primitive change
   (none of this document, per section 2's test) — `CONTRIBUTING.md`'s
   RFC trigger conditions decide which.
2. If it needs an RFC, it follows the normal process
   (`GOVERNANCE.md` §3), not a special "ecosystem integration" track —
   consistent with [[feedback_avoid_new_governance_process]]'s standing
   instruction not to invent new process categories.
3. Update `BACKLOG.md` and this document's status markers once real code
   exists, the same discipline `REFERENCE_IMPLEMENTATIONS.md` section 8
   already applies to its own integration facts.
