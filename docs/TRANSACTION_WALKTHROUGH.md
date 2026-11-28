# TRANSACTION_WALKTHROUGH.md
### Sails Protocol — One Real P2P Trade, End to End

> Not numbered in `00-INDEX.md`'s canonical 20 — added the same way
> `DEVELOPER_JOURNEY.md`/`HANDOFF.md` were, as a practical companion to
> the spec rather than part of it. Written because no single document
> narrated one real P2P transaction across every module/RFC involved —
> flagged directly during a rigor pass across the whole codebase,
> requested by the project owner ahead of external (Tether) technical
> review, as a real, named gap.
>
> **Every file/function named below was checked against the actual code
> at the time this was written (2026-07-18), not written from memory of
> what should be there.** Where a step is mocked or emulated rather than
> fully real, that is stated at the step, not left implicit — the same
> discipline `HANDOFF.md`/`THREAT_MODEL.md` already apply.

## What this traces

One PIX→USDT P2P trade: a buyer sends fiat (PIX, Brazil's instant-payment
rail) directly to a seller outside the protocol, and the seller releases
USDT from escrow in return. This is the exact flow `npm run demo:qvac`
runs (`demo-satsails-qvac.ts` → `examples/demo/pix-to-usdt-flow.ts`'s
`main()`) — the walkthrough below narrates that real, already-built code
path, not a hypothetical one. `HANDOFF.md` §1 already discloses that the
*full* run has never completed end-to-end in this environment (no
reachable Postgres/Redis/P2P bootstrap network here) — every individual
piece narrated below has, however, either been unit-tested for real or
live-smoke-tested once this session; which is which is called out at
each step.

Two real, config-gated controls this codebase added specifically for
custody defensibility — RFC-014's capability check and RFC-015's
two-person control — are **off by default** and so do not appear in the
demo script's own run. Section 3 below walks through the trade again
with both turned on, concretely, since that combination is what a
production deployment handling real value should actually run on an eligible rail (the WDK rail used in this walkthrough is production-ineligible, RFC-019, and these controls do not change that).

## Cast

| Actor | Real identity | Real role |
|---|---|---|
| **Comprador** (buyer) | A registered `User` (`identity.service.ts`) | Sends PIX (off-protocol), receives USDT |
| **Vendedor** (seller) | A registered `User` | Receives PIX, releases USDT from escrow |
| **BuyerAgent** / **SellerAgent** | `modules/open-agents/*-agent.ts`, wrapping the real local-LLM `QvacAgentProvider` | Autonomous wallet-side agents generating the buyer's Intent and the seller's offer — real inference, no hardcoded response |
| Two `PearNode`s | `infrastructure/p2p/pear.service.ts`, real `hyperdht`/`hyperswarm` | One per participant, direct P2P channel, no central server |

## 1. The trade, step by step (as `pix-to-usdt-flow.ts` actually runs it)

```
Vendedor                    QVAC (local LLM)         Comprador                 Core / Protocol
   │                              │                        │                          │
   │──(1) identityService.register()───────────────────────│──────────────────────────│  real Users persisted
   │                              │                        │                          │
   │──(2) SellerAgent.offerUsdtForPix()─────►│              │                          │  real local inference
   │◄────────────── offer shape ─────────────│              │                          │
   │──(3) liquidityRouter.createOffer()─────────────────────│──────────────────────────│  real Offer persisted
   │                              │                        │                          │
   │                              │◄─(4) BuyerAgent.requestUsdtViaPix()─│              │  real local inference
   │                              │       TradeIntentPayload ──────────►│              │
   │                              │                        │──(5) intentEngine.create()─►│  CISO checks, CapabilityGrant?
   │                              │                        │                          │  CREATED→VALIDATED→COORDINATED
   │                              │                        │                          │  (RFC-012, hash-chained audit)
   │                              │                        │──(6) tradeService.createTrade()►│  real Trade persisted
   │◄═══(6) sendIntentToPeer() — real HyperDHT hole-punch, real libsodium sealed box═══│  direct P2P, no server
   │                              │                        │                          │
   │──(7) qvacAgentProvider.assessIntentRisk()──►│          │                          │  real inference, advisory only
   │                              │                        │                          │
   │══════════════════════ (8) executeSettlement() ════════════════════════════════════│
   │   createEscrow → lockFunds (real signed WDK collateral) → markPaymentSent →       │
   │   emulateSellerPixReceipt() [emulated] → [RFC-014/015 gates, off by default] →     │
   │   releaseFunds() — real signed WDK USDT transfer (testnet)                         │
   │                              │                        │                          │
   │                              │                        │◄─(9) USDT received───────│  settlement.escrow.released
   │                              │                        │                          │  → reputation updated (both)
```

### (1) Identity — real

`identity.service.ts`'s `register()` persists a real `User` row for each
participant. **Honest caveat:** the demo script calls this service
in-process and supplies a placeholder string as the initial `publicKey`
— it does **not** exercise the real Ed25519 challenge-response HTTP flow
(`common/middleware/auth.ts`, `POST /v1/identity/challenge` →
`/authenticate`) that an actual `@satsails/p2p-trading-sdk`-based wallet integration
goes through. That flow is real and separately tested
(`tests/routes.test.ts`, `packages/sails-sdk/tests/identity.test.ts`'s
byte-for-byte signature check) — the demo just doesn't need it since it
calls services directly rather than over HTTP.

### (2)-(3) Seller's offer — real inference, real persistence

`SellerAgent.offerUsdtForPix()` (`open-agents/seller-agent.ts`) calls the
real, on-device `QvacAgentProvider` (`@qvac/sdk`, local LLM, no cloud
call) to generate an offer shape from a plain-language goal.
`liquidityRouter.createOffer()` persists it as a real `Offer` row and
emits `liquidity.offer.created`.

### (4)-(5) Buyer's Intent — real inference, real CISO checks, real (optional) capability check

`BuyerAgent.requestUsdtViaPix()` generates a real `TradeIntentPayload`
via the same local LLM path. `intentEngine.create('TradeIntent', ...)`
(`core/intent-engine.ts`) then runs, in order: structural validation
(CISO Byzantine Rule — malformed payloads never reach persistence),
`validateFinancialSanity()` (CISO Economic Rule), **the RFC-014
capability check** (only if `ENFORCE_CAPABILITIES=true` — off by default,
see Section 3), persistence, and the real `CREATED → VALIDATED →
COORDINATED` transition (RFC-012), each step writing a hash-chained
`IntentEvent` (RFC-008 D2) and emitting a real typed event
(`intent.created`/`.validated`/`.coordinated`).

### (6) Negotiation channel — real Trade record + real direct P2P delivery

`tradeService.createTrade()` persists the durable, authoritative `Trade`
row (Postgres — this is what `RFC-011`'s reconciliation catches up
against if the P2P leg below fails to deliver). In parallel,
`pearsTransportProvider.sendIntentToPeer()` (`infrastructure/p2p/transport-provider.ts`)
opens two real `HyperDHT` nodes, performs a real NAT hole-punch via
Hyperswarm, and sends the buyer's actual Intent directly to the seller's
node — encrypted with a real libsodium sealed box addressed to the
seller's actual public key (`infrastructure/p2p/payload-crypto.ts`), not
a stand-in for that handoff. No central server relays this message.
`tests/payloadCrypto.test.ts` verifies the real encryption round-trip;
`tests/intentTransport.test.ts` verifies the send composition — the
actual hole-punched connection itself is what can't be exercised without
a live network, per `HANDOFF.md`.

### (7) Risk assessment — real inference, advisory only

`qvacAgentProvider.assessIntentRisk()` runs a second real local-LLM call
against the resulting Trade. Per RFC-007 D7, this produces a signal
(`risk`/`recommendation`/`reasoning`), never a unilateral block — a real
deployment routes a `reject` recommendation to the Policy Engine (still
a stub, `TODO.md` §7) to decide; this demo logs it and continues, since
halting here would be the demo script deciding, not the Policy Engine.

### (8) Settlement — real escrow, real signed release, one emulated step

`settlement-orchestrator.ts`'s `executeSettlement()` is the single real
entrypoint for everything from here on, in order:

> **Status of the rail used in this walkthrough.** `WDK_USDT_EVM` is a server-custodial reference implementation (one server-held seed), testnet only and production-ineligible (RFC-019). Setting `MOCK_ESCROW=false` and funding the seed does not make it eligible for production. The status of every settlement provider is in `GETTING_STARTED.md` ("Settlement providers").

1. `escrowService.createEscrow()` + `lockFunds()` — a real, signed WDK
   transfer (`@tetherto/wdk-wallet-evm`) moving the seller's collateral
   from the treasury account to a per-trade escrow sub-account, when
   `MOCK_ESCROW=false` and a funded `WDK_SEED_PHRASE`/`WDK_USDT_CONTRACT`
   are configured — `MockSettlementProvider` otherwise (inert, same
   interface, `RED_TEAM_REVIEW.md` RT-001's boot-time gate makes this
   configuration explicit, never silent).
2. `markPaymentSent()` — the buyer's claim that PIX was sent. Real state
   transition; the PIX transfer itself happens entirely outside the
   protocol (`PROJECT_CONTEXT.md` §1 — fiat is never intermediated).
3. `emulateSellerPixReceipt()` — **the one genuinely emulated step in
   this whole flow.** Produces a clearly-labeled synthetic confirmation
   object (`emulated: true`), never dressed up as a real payment-rail
   proof. Closing this for real is Sails OpenProof's job (RFC-003), still
   📋 future — `escrow.service.ts`'s doc comments are explicit that this
   orchestrator does not claim to have built that.
4. **RFC-014's capability check and RFC-015's two-person control** —
   both live inside `escrowService.releaseFunds()` itself now (moved
   there from this orchestrator once RFC-015 found the orchestrator-only
   location missed two other real callers — see that RFC's Summary).
   Both off by default; see Section 3 for what changes with them on.
5. `releaseFunds()` — the real, digitally signed USDT transfer
   (`WalletAccountEvm.transfer()`), a genuine on-chain transaction with a
   real, checkable hash on testnet.

### (9) Reaction — real, cross-module, event-driven

`common/events/handlers.ts`'s `settlement.escrow.released` listener (the
**only** place cross-module reactions happen in this codebase — no
module ever imports another module's service directly) marks the `Trade`
`COMPLETED`, increments both participants' `totalTrades`/`totalVolumeBtc`,
and calls `reputationService.recordOutcome()` for both — dispute-aware
(RFC-007 D8's Outcome Engine): a happy-path completion scores
Positive/Positive; a disputed trade resolved with a `RELEASE` ruling
scores Positive for the winner and Negative for the loser, checked via
the real `Dispute` row rather than assumed from the fund movement alone.

## 2. What's real vs. emulated/mocked, in one place

| Step | Real | Emulated / mocked |
|---|---|---|
| Identity registration | `User` persistence | Placeholder `publicKey` in the demo script only (real Ed25519 flow exists, just not exercised here) |
| Offer / Intent generation | Local LLM inference (QVAC), no hardcoded response | — |
| Intent validation + lifecycle | CISO checks, hash-chained audit trail, real state machine | — |
| P2P delivery | Real HyperDHT/Hyperswarm hole-punch, real libsodium encryption | — |
| Risk assessment | Local LLM inference | — |
| Escrow lock/release | Real signed WDK transfer when configured for real | `MockSettlementProvider` when `MOCK_ESCROW=true` (default) — same interface, explicitly inert, never silent |
| PIX receipt | — | Always emulated (`emulated: true`) — no real payment-rail integration exists yet (OpenProof, RFC-003) |
| Capability check (RFC-014) | Real `capabilityRegistry.check()` against a persisted grant | Off by default (`ENFORCE_CAPABILITIES=false`) |
| Two-person control (RFC-015) | Real `EscrowReleaseApproval` gate | Off by default (`REQUIRE_DUAL_APPROVAL_RELEASE=false`); not on-chain multisig regardless — one WDK seed still signs |
| Reputation update | Real, dispute-aware `recordOutcome()` | — |

## 3. The same trade, with both custody controls turned on

> **This walkthrough uses `WDK_USDT_EVM`, which is production-ineligible (RFC-019).** The node refuses to boot when `NODE_ENV=production`, `MOCK_ESCROW=false` and `WDK_SEED_PHRASE` is non-empty. The two controls described below are what a deployment on an eligible rail should enable. They do not make the WDK rail eligible, and nothing in this walkthrough is a production instruction for WDK.

`ENFORCE_CAPABILITIES=true` and `REQUIRE_DUAL_APPROVAL_RELEASE=true`
are both off by default (Sections above) precisely so the happy-path demo
above keeps working unmodified. A production deployment handling real
value should turn both on, on an eligible rail (the WDK rail used here stays production-ineligible) — here is exactly what changes, concretely,
for the trade above.

**Before the buyer's Intent is even accepted:** `intentEngine.create()`
now requires the buyer to already hold a `trade-coordination` capability
grant covering `intent.created`. Issued once, ahead of time, e.g.:

```bash
curl -X POST /v1/capabilities/register \
  -H "Authorization: Bearer <buyer-session-token>" \
  -d '{"capabilityName":"trade-coordination","scope":["intent.created"]}'
```

**At the release step**, `escrowService.releaseFunds()` now requires two
things before the seller's signed WDK transfer fires, in this order:

1. **A capability grant** (RFC-014) covering the identity that's about
   to trigger the release (the seller's own id, or their agent's, e.g.
   `agent:seller-wallet:<sellerId>` — whichever was passed as
   `triggeredBy`) — same self-issued `POST /v1/capabilities/register`
   call as above, `capabilityName: "settlement"`, `scope:
   ["settlement.escrow.released"]`.
2. **Both counterparties' approval** (RFC-015) — genuinely two separate
   HTTP calls, from two separate sessions, that must both land before
   release is permitted:

```bash
# Seller confirms PIX was received and approves release
curl -X POST /v1/settlement/escrow/<escrowId>/approve-release \
  -H "Authorization: Bearer <seller-session-token>"

# Buyer confirms they're satisfied with the trade and approves release
curl -X POST /v1/settlement/escrow/<escrowId>/approve-release \
  -H "Authorization: Bearer <buyer-session-token>"

# Either party can check readiness before attempting the actual release
curl /v1/settlement/escrow/<escrowId>/release-approvals
# → {"approvals":[{...seller...},{...buyer...}],"readyToRelease":true}

# Only once both have approved does this succeed:
curl -X POST /v1/settlement/escrow/<escrowId>/release \
  -H "Authorization: Bearer <seller-session-token>" \
  -d '{"toAddress":"0x..."}'
```

**This means `executeSettlement()`'s single atomic call — the
convenience function the demo script and `openp2p.trade.created`'s
auto-settle handler both use — will fail at its final step whenever
`REQUIRE_DUAL_APPROVAL_RELEASE=true`, every time, by design**: no
approval can exist yet for an escrow that function just created moments
earlier in the same synchronous call. A deployment that wants this
protection stops calling `executeSettlement()` as one atomic step for
release and instead: creates/locks/confirms (still fine as one call),
waits for both `approve-release` calls to land, then calls the release
route directly. RFC-015's Decision §5 documents this exact constraint —
it is the real, load-bearing point of the control, not an oversight:
a two-person control that had no gap for two people to actually act in
would not be one.

**What does *not* change:** an arbitrated release
(`dispute.service.ts`'s `resolveDispute()`, only the one assigned,
`TRUSTED_ARBITRATORS`-configured arbiter may call it) always bypasses
the two-person check — re-requiring the original two counterparties'
agreement after a dispute already exists between them would defeat
arbitration's purpose. The capability check still applies to an
arbitrator's release, since that's a separate, unconditional gate.

**What this is not, stated plainly for a technical reviewer:** neither
control is on-chain multisig. `wdk-settlement.provider.ts`'s
`WDK_SEED_PHRASE` still controls both the treasury account and every
per-trade escrow sub-account — one seed, one signature, regardless of
how many application-layer approvals were recorded first. Real on-chain
multisig was investigated (`@tetherto/wdk-wallet-evm-erc-4337`'s actual
compiled types) and found single-owner-only for this pass; deploying
Safe contracts with multiple owners directly is real, valuable, and
explicitly deferred future work (RFC-015's Alternatives Considered #1),
not something this document or any other in this repository claims is
already solved.

## 4. Where the real proof of each step lives

Every claim above is backed by a specific, real test — not asserted on
faith:

| Claim | Test(s) |
|---|---|
| Ed25519 auth (not exercised by the demo, but real) | `tests/routes.test.ts`, `packages/sails-sdk/tests/identity.test.ts` |
| Intent CISO checks + lifecycle | `tests/intentFlow.test.ts` |
| P2P encryption + delivery composition | `tests/payloadCrypto.test.ts`, `tests/intentTransport.test.ts` |
| Settlement orchestration sequence | `tests/settlementOrchestrator.test.ts`, `tests/wdkSettlementProvider.test.ts` |
| Auto-settle config gate | `tests/autoSettleHandler.test.ts` |
| Reputation outcome (dispute-aware) | `tests/reputationOutcome.test.ts` |
| RFC-014 capability check | `tests/intentCapabilityCheck.test.ts`, `tests/escrowReleaseControls.test.ts` |
| RFC-015 two-person control | `tests/escrowReleaseControls.test.ts` |
| Rate limiting | `tests/rateLimit.test.ts` |

`npm test` runs all of these together (21 suites, 175 tests as of this
writing) — none require live infrastructure. What none of them are is a
substitute for the one thing that's never been run in this environment:
the actual end-to-end `npm run demo:qvac` execution against real
Postgres/Redis/WDK testnet/P2P network. `docker-compose.yml` +
`DEPLOYMENT.md` exist specifically so that run is now one command away
for whoever has Docker — see `HANDOFF.md` §1.
