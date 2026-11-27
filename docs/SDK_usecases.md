# SDK_usecases.md
### Sails Protocol — Future SDK Family, Use-Case by Use-Case

> **Authority / status:** future SDK-family / use-case exploration, not a current implementation inventory, spec or commitment. Current package/API/maturity truth is owned by `API_STABLE.md`, `SDK_GUIDE.md`, `SYSTEM_DESIGN.md`, BACKLOG and live Issues.
>
> **This is a vision/roadmap document, not a spec and not a commitment.**
> It does not change, replace, or broaden today's actual product scope —
> that remains exactly what `PROJECT_CONTEXT.md` and `README.md` already
> say: **one named, shipping product, the Sails P2P Trading SDK**,
> deliberately scoped narrow (a prior external review flagged
> "genericness" as an adoption blocker, and that's the reason the scope
> was narrowed in the first place — see `PROJECT_CONTEXT.md` for the full
> story). Nothing here is built, none of these are announced products,
> and none of the candidate names below are final. The point of writing
> this down is narrower and more useful than a product announcement: to
> register, in one place, how the same real core primitives *could*
> extend into other named SDKs later — so a team building on this
> protocol has something concrete to react to, object to, or build
> instead of guessing.

## Why this exists, and why it isn't "Compliance SDK"

An earlier draft of this document used the term "Compliance SDK" for the
policy/rules use case. That term was removed deliberately — "compliance"
implies KYC/AML/regulatory coverage this protocol does not provide and
has no plan to claim. What actually exists (or will exist) is a
**Policy Engine use case**: a way for a wallet or agent to declare and
check capabilities/rules before acting. That's a real architectural
component (`PROTOCOL_SPECIFICATION.md` §1.10, `RFC-005`), not a
regulatory claim, and the renamed term keeps it that way.

## Status Legend

Same legend `ROADMAP.md` already uses, applied here per use case so
this document can't be read as claiming more than what's actually true
today:

- **✅ Proven** — implemented and functional in the reference implementation
- **🏗️ Specified** — interface/contract defined, implementation partial or stubbed
- **📋 Aspirational** — on the roadmap, spec not yet written

## The shared foundation every use case below builds on

| Pillar | Status | What it actually is today |
|---|---|---|
| `WalletAdapter` | 🏗️ Specified | Real interface in `@satsails/p2p-trading-sdk` (RFC-013) — `getPeerId()`/`getAddress()`/`signTransaction()`/etc. A wallet implements it; the SDK never assumes how signing happens. |
| Capability Registry | ✅ Proven | Real, persisted (`CapabilityGrant`, RFC-013), and — as of RFC-014/015 — actually **enforced** at the two real money-moving choke points (`intentEngine.create()`, `escrow.service.ts`'s `releaseFunds()`), not just a store nothing consults. |
| Policy Engine (governed rules) | 📋 Aspirational | **Correction from an earlier draft of this document, which said this was already implemented — it is not.** `policy-engine.ts` today only has `validateFinancialSanity()` (the CISO Economic Rule — a hardcoded sanity check, not a governed/configurable rule system). The `get`/`propose`/`activate` governed-policy interface `RFC-012`'s own Alternatives Considered describes has never been built. This is the one pillar in this table that's a real gap, not a nuance — see the Policy use case below for what that means concretely. |
| OpenReputation | ✅ Proven | `recordOutcome()` is the sole input to `User.reputationScore` (RFC-007 D8/D9, dispute-aware), `rate()` is real informational feedback, both tested (`tests/reputationOutcome.test.ts`). Not yet packaged as a *portable, cross-module* SDK surface usable outside OpenP2P (`ROADMAP.md` Months 7-9) — the computation is real, the standalone distribution isn't built. |
| Pears (`peerId`) | ✅ Proven transport capability / ⚠️ identity portability not proven | Pears/HyperDHT is a real transport substrate in the Reference Implementation. Current `peerId` is generated from a separate ephemeral transport keypair on `PearNode.start()` and is not the participant's portable economic identity. See `SYSTEM_DESIGN.md`, `CRYPTOGRAPHIC_MODEL.md` and `IDENTITY_ARCHITECTURE_DISCOVERY.md`. |
| QVAC (local inference) | ✅ Proven | Real on-device LLM inference (`@qvac/sdk`), live-smoke-tested this project, no cloud call. Produces structured signals an agent or the (still-aspirational) Policy Engine can act on — it does not decide unilaterally (RFC-007 D7). |

## The use cases

Each one below is framed the way Breez frames its own SDK family
(breez.technology/sdk — one brand, several sharply-scoped products on
shared technology, so nobody looking at any single one has to guess what
it does) — the same pattern `PROJECT_CONTEXT.md` §3's Named-SDK Rule
already commits this protocol to. **Candidate name** below means exactly
that: a candidate, following the existing "Sails P2P Trading SDK" /
"Sails P2P Lending SDK" naming pattern, not a decision made in this
document.

### 🔄 Trading — *the one that already ships*

- **Status: ✅ Proven.** This is not a future use case — it's
  `PROJECT_CONTEXT.md`'s **Sails P2P Trading SDK**, shipping today
  (`@satsails/p2p-trading-sdk`, OpenP2P + OpenSettlement + OpenReputation +
  OpenIdentity). Included here only so the comparison table below has
  the real baseline next to the aspirational ones, not to suggest it's
  new.
- Market equivalents: Binance P2P, Bisq, HodlHodl.
- Differentiator: not a platform an integrator visits — a library any
  wallet embeds, carrying **portable** reputation (via `peerId`) instead
  of reputation locked inside one platform's silo.

### 💸 Settlement — *candidate: "Sails Settlement SDK"*

- **Status: 🏗️ Specified.** OpenSettlement's escrow lifecycle and dispute
  resolution are real and tested. **Corrigido 2026-09-06 (Current Truth
  P1+ Cleanup):** this cell originally said only `WDK_USDT_EVM`/`MOCK`
  were real and that `LightningHodlProvider` still threw "not yet
  implemented" — that was accurate when written but is stale now.
  Current state: `MULTISIG`, `LIGHTNING_HODL` (real since 2026-07-27, via
  Arkade/VTXO/Taproot — not the classic HTLC/hold-invoice design this
  cell originally implied), `WDK_USDT_EVM`, and `SAFE_GUARD_EVM` are all
  real providers today; none is production-authorized, and each rail differs: `MULTISIG` is the only mainnet-capable provider, has one disclosed micro-value mainnet rehearsal and is not decided or homologated for production (`docs/adr/ADR-002` section 5B); `LIGHTNING_HODL` and `SAFE_GUARD_EVM` are testnet only; `WDK_USDT_EVM` and `MOCK` are production-ineligible (per
  `docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md` §7). Update (2026-11-27): new offers, intents, trades and escrows for `LN_BTC` or `LIGHTNING_HODL` are refused with `RAIL_CLOSED` in every environment (`src/common/day0-closed-rails.ts`); existing escrows keep their dispatch, refund and recovery paths. A single micro-value Bitcoin mainnet rehearsal of `MULTISIG` is recorded in `docs/MAINNET_MULTISIG_PROOF.md`; it is a historical record, not a production authorization.
  `LiquidCovenantProvider` remains genuinely unimplemented — reserved,
  deliberately not built (2026-08-01 decision) — the one part of the
  original claim still accurate. The "abstract multiple rails behind one
  interface" value proposition is real both as an interface
  (`SettlementProvider`) and as delivered multi-rail coverage for four of
  the five registered escrow types; it is not yet real as demonstrated
  operational substitution between rails (`docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`'s
  own frozen conclusion).
- Market equivalents: Lightning (LDK), Liquid, Strike.
- Differentiator: a team wanting only cross-rail settlement — without
  adopting the full P2P trading/negotiation flow — could integrate this
  slice alone once the additional providers exist.

### 🌊 Liquidity — *candidate: "Sails Liquidity SDK"*

- **Status: 🏗️ Specified.** Real order book, offer matching, and
  aggregation (`liquidity.service.ts`) — genuinely real code, not a
  mock. "Cross-rail" (PIX, BRL, BTC, USDT routed through one interface)
  describes the data model today; live routing/execution across
  disparate rails at once is not yet proven end to end (no live
  environment has run it, `HANDOFF.md`).
- Market equivalents: 1inch, CowSwap, OTC order books.
- Differentiator: not limited to EVM/DeFi liquidity — fiat rails
  (PIX/BRL) are first-class, not bolted on.

### ⭐ Reputation — *candidate: "Sails Reputation SDK"*

- **Status: ✅ Proven as a module, 📋 Aspirational as a standalone SDK.**
  The scoring itself is real and dispute-aware. What doesn't exist yet
  is packaging it so a wallet with *no other Sails integration* could
  pull in just portable reputation — today it ships bundled inside the
  Trading SDK.
- Market equivalents: Binance P2P ratings, Bisq reputation.
- Differentiator: reputation tied to a portable `peerId`, not to one
  platform's account — a trader's history could follow them across
  wallets built on this protocol.

### 🛡️ Policy — *candidate: "Sails Policy SDK"*

- **Status: Capability Registry ✅ Proven (and enforced, RFC-014/015);
  Policy Engine (governed, versioned rules) 📋 Aspirational.** This is
  the correction from the earlier draft, stated plainly: what's real
  today is checking a participant against a static, self-issued
  `CapabilityGrant`. What's aspirational is a governed rule system
  (propose a rule, version it, activate it, evaluate scopes against it)
  — `RFC-012`'s own Alternatives Considered explicitly deferred this,
  and it remains deferred as of this document.
- Market equivalents: internal permission/rule systems generally (no
  single named product maps cleanly — this is closer to an
  authorization framework than a market category).
- Differentiator, once built: capability declaration and policy
  evaluation as a reusable primitive, explicitly **not** KYC/AML — see
  "Why this exists" above.

### 🤖 AI (QVAC) — *candidate: "Sails Agent SDK"*

- **Status: The underlying integration is ✅ Proven (real local
  inference, live-tested); a dedicated external-facing Agent SDK surface
  is 📋 Aspirational.** `qvac-agent.provider.ts` and the `BuyerAgent`/
  `SellerAgent` pattern are real, working code today — but they're
  internal to this reference implementation, not yet exposed as
  something a third-party team could adopt directly.
- Market equivalents: Hummingbot, Gauntlet, trading bots generally.
- Differentiator: on-device inference (no cloud dependency, no API key),
  producing signals that feed a Capability/Policy check rather than
  acting unilaterally (RFC-007 D7 — an agent proposes, it doesn't decide
  alone).
- **Architectural boundary (RFC-016,
  `docs/rfcs/RFC-016-qvac-crypto-native-agent-boundary.md`):** this is a
  **Crypto-Native Agent**, never a "PIX Agent" or "Banking Agent." It
  only ever acts on digital assets already in the user's non-custodial
  wallet, via WDK — negotiating, creating/accepting offers, moving
  BTC/USDT/DePix/USDC, locking/releasing escrow. It never calls a
  banking API and never touches PIX or any other fiat rail. Any future
  "Sails Agent SDK" surface, and the negotiation-delegation concept
  prototyped (mocked) in `packages/sails-ui`, is scoped inside this
  boundary from the start, not retrofitted onto it later.

## Comparison table

| Use case | Market equivalent | Similarity | Differentiator | Status |
|---|---|---|---|---|
| Trading | Binance P2P, Bisq, HodlHodl | P2P market, seller reputation, escrow | Embeddable library, not a platform; portable reputation via `peerId` | ✅ Proven — shipping today as the Sails P2P Trading SDK |
| Settlement | Lightning (LDK), Liquid, Strike | On/off-chain settlement, fiat↔crypto rails | One interface across rails | 🏗️ Specified — WDK_USDT_EVM and MULTISIG real; `LIGHTNING_HODL` real via Ark/Arkade (closed to new admissions for Day 0, `RAIL_CLOSED`; see this document's own 2026-09-06 correction above — **corrected 2026-09-10, Product Truth Sweep, F17**, this row previously said "Lightning/Liquid still stubs," contradicting that correction); Liquid Covenant still a stub |
| Liquidity | 1inch, CowSwap, OTC books | Liquidity discovery, order matching | Fiat rails (PIX/BRL) first-class, not EVM-only | 🏗️ Specified — real order book, cross-rail *routing* not yet proven live |
| Reputation | Binance P2P ratings, Bisq | Trade-history-based score | Portable across wallets via `peerId`, not platform-locked | ✅ Proven as a module / 📋 Aspirational as a standalone SDK |
| Policy | Internal permission/rule engines | Capability/rule validation | Not KYC/AML — a reusable authorization primitive | Capability Registry ✅ Proven+enforced / Policy Engine 📋 Aspirational |
| AI (QVAC) | Hummingbot, Gauntlet | Automated offer/risk evaluation | On-device inference, feeds a policy check rather than deciding alone | Integration ✅ Proven / external Agent SDK surface 📋 Aspirational |

## What this document is for

To register these use cases where a team evaluating or building on Sails
Protocol can find them — including a team that never talks to the
current maintainers directly — and let the real, already-built core
(Capability Registry, OpenReputation, Pears `peerId`, QVAC) suggest what
else it could become, without overselling any of it as already built.
If a future team wants to build one of these for real, that work starts
the same way every real change to this protocol does: an RFC
(`CONTRIBUTING.md`, `GOVERNANCE.md`) — this document is the idea, not the
proposal.
