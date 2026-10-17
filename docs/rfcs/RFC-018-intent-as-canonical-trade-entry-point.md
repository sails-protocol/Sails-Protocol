# RFC-018: Intent as the Canonical Entry Point for Every Trade

## Summary

Today, `Intent`/`IntentEvent` (`core/intent-engine.ts`) and OpenP2P's
`Offer`/`Trade` (`liquidity.service.ts`, `trade.service.ts`) are two
fully separate, unconnected code paths — no real `Offer` or `Trade` has
an `Intent` row behind it, despite `PROTOCOL_SPECIFICATION.md` §1.11
already stating that a published `Offer` "is OpenLiquidity's concrete
database artifact representing a published, discoverable Intent." This
RFC makes that claim true: every `Offer` is created *from* a real
`TradeIntent`, and every `Trade` references the `Intent` that produced
it. The Intent Engine becomes the single owner of the intention's
lifecycle (creation, validation, expiration); OpenP2P's `Trade` becomes
purely the materialized agreement once negotiation concludes — it never
duplicates lifecycle logic Intent already owns.

**Status:** Accepted. Triggered by a project-owner-relayed CTO-role
review that first flagged a documentation gap ("Intent não está no
centro"), which a code-level fidelity audit then corrected in the
opposite direction — Intent *is* already the 2nd primitive,
fully specified, but the real Offer/Trade code path never calls it. The
CTO review's follow-up response approved this as a P0 architecture item
("ARC-001" in that review; renumbered here to stay in this project's
single, permanent RFC sequence — see `GOVERNANCE.md` §5's "numbered,
sequential, never reused" rule, itself part of what this consolidation
effort has been enforcing). Bypasses the Discussion window
(`GOVERNANCE.md` §5), the same precedent RFC-007/RFC-015/RFC-016/RFC-017
already used for owner-directed RFCs.

**Classification:** Core RFC (`GOVERNANCE.md` §6A) — changes which code
path is the canonical entry point for `Trade`, a lifecycle-wiring
change to an existing primitive, not an additive one.

## Motivation

A concrete, present-day consequence of the gap: an SDK consumer calling
`@satsails/p2p-trading-sdk`'s `createIntent()` today gets a real, persisted `Intent`
with zero relationship to any actual P2P trade they might separately
start via `POST /v1/openp2p/trades`. Nothing lets that consumer answer
"what happened to my Intent?" — the audit trail `parentIntentId`
composability (§2.2) is explicitly designed for, and the whole reason
`AgentIntent`-driven flows need a traceable decision tree, cannot exist
while `Offer`/`Trade` sit outside the Intent lifecycle entirely.

This also means `PRINCIPLES.md` Principle 2 ("Intent Driven" — "lets
humans, wallets, and AI agents all speak the protocol the same way ...
never a direct API call") is currently violated by the one real trade
flow this codebase ships: `trade.routes.ts`'s `POST
/v1/openp2p/trades` is exactly the "direct, action-specific API call"
that principle says shouldn't be the starting point.

## Alternatives Considered

- **Eliminate `Intent`/`IntentEvent`, keep `Offer`/`Trade` as the only
  real model.** Rejected — this is what the code accidentally does
  today, and it's the thing being fixed, not adopted. It would also
  mean deleting real, tested, working code (`intent-engine.ts`'s
  `create()`/`cancel()`/`transition()`, the hash-chained `IntentEvent`
  audit trail) to paper over a wiring gap.
- **Eliminate `Offer`/`Trade`, route everything through raw `Intent`.**
  Rejected — `Trade` carries OpenP2P-specific fields (`buyerId`,
  `sellerId`, escrow relationship) the generic `Intent.payload: Json`
  blob was never meant to model directly, and `PROTOCOL_SPECIFICATION.md`
  §3.1 already establishes the pattern every application module should
  follow: a module-specific lifecycle refinement that maps back onto
  the generic one, never a parallel top-level lifecycle. `Trade` is
  OpenP2P's refinement; it should reference its originating `Intent`,
  not replace it.
- **Make `Offer` optional but `intentId` mandatory on `Trade` only,
  skip linking `Offer`.** Considered, rejected: `Offer` is the
  *discoverable, public* form of a `TradeIntent` — leaving it
  unlinked would mean Discovery (§1.3) still can't answer "which
  Intent does this candidate satisfy," reproducing the same gap one
  layer later.

## Decision

Every `Offer` gains a nullable `intentId` foreign key to `Intent`.
`liquidity.service.ts`'s `createOffer()` calls `intentEngine.create()`
first (with `type: 'TradeIntent'`, deriving `TradeIntentPayload` from
the `CreateOfferInput` fields it already receives — `asset`, `side`,
`fiatMethod: input.paymentMethod`, `network`, and a `maxValue`/
`minValue` pair derived from `priceUsd × maxAmount`/`minAmount`), then
persists the `Offer` row with the resulting `intentId`.

Every `Trade` gains a nullable `intentId` foreign key, copied from the
accepted `Offer`. **Corrected during implementation (2026-07-19) from
this RFC's original draft:** `createTrade()` does **not** transition
straight to `COMMITTED` — `assertValidTransition` (`core/state-machine.ts`)
does not allow `COORDINATED → COMMITTED` directly, and
`PROTOCOL_SPECIFICATION.md` §3.1's own, already-accepted mapping table
places `COMMITTED` at "05 ESCROW LOCKED," not at trade creation ("02
COUNTERPARTY FOUND"). `createTrade()` instead walks the Intent through
`DISCOVERING → MATCHED → NEGOTIATING` (the search that led here, the
counterparty being found, and `negotiationService.open()` all happening
synchronously in this reference implementation's "accept an offer"
flow) — real, scoped engineering work, not a documentation fix.
`COMMITTED` fires from `common/events/handlers.ts`'s
`settlement.escrow.locked` reaction instead, matching §3.1 exactly.
When settlement completes, the existing `settlement.escrow.released`
reaction walks `SETTLING → FULFILLED`; `settlement.escrow.refunded`
transitions directly to `FAILED` (valid from both `COMMITTED` and
`SETTLING` per the state machine, so no need to track which one the
Intent is in at refund time).

**Also corrected during implementation:** the ownership-check change
flagged in Implementation Impact below turned out unnecessary —
`intent-engine.ts`'s exported `transition()` has no ownership check at
all (only `cancel()` does); it was already designed as an open
mechanism any module can drive with any `triggeredBy` string, per its
own doc comment. Verified by reading the function before assuming a
change was needed, not by trial and error.

`IntentHandler` (§2.7)'s real implementation
(`OpenP2PTradeIntentHandler`, formalizing the inline `TradeIntent`
validation `intent-engine.ts` currently does directly) remains
deferred — Phase 3, not built in this pass (see Reference
Implementation Plan).

## Implementation Impact

**Status: implemented 2026-07-19** (`npm run build` clean, `npm test`
212/212 — 5 new tests). What actually changed, corrected from the
original plan below where implementation found a better path:

- `prisma/schema.prisma` — `Offer` and `Trade` each gained a nullable
  `intentId String?` column + relation to `Intent` (`Intent` gained
  back-relation arrays `offers`/`trades`). **Schema edited and
  `npx prisma generate` run; no live Postgres available in this
  environment to run `prisma migrate dev`/`db push` against — a real
  deployment needs to apply this schema change before this code path
  will work.**
- `src/modules/open-liquidity/liquidity.service.ts` — `createOffer()`
  calls `intentEngine.create()` before `prisma.offer.create()`, exactly
  as planned.
- `src/modules/open-p2p/trade.service.ts` — `createTrade()` copies
  `offer.intentId` onto the new `Trade` row and walks
  `DISCOVERING → MATCHED → NEGOTIATING` (not straight to `COMMITTED` —
  see Decision's correction above).
- `src/common/events/handlers.ts` — `settlement.escrow.locked` gained
  the `COMMITTED` transition; `settlement.escrow.released` gained
  `SETTLING` then `FULFILLED`; `settlement.escrow.refunded` gained
  `FAILED`. New module-level `INTENT_LIFECYCLE_TRIGGER` constant
  (`'system:trade-lifecycle'`), matching the existing
  `'system:expiry-check'` sentinel convention.
- `src/core/intent-engine.ts` — **not changed.** The planned ownership-
  check adjustment was found unnecessary on inspection (see Decision).
- `src/modules/open-p2p/intent-handler.ts` (`OpenP2PTradeIntentHandler`)
  — **not built.** Phase 3, still deferred.
- New tests: `tests/routes.test.ts` (offer-publish and trade-creation
  HTTP round-trips now assert the Intent chain fires) and
  `tests/reputationOutcome.test.ts` (a new describe block asserting
  each `settlement.escrow.*` handler drives the right transition, and
  that a pre-RFC-018 Trade with `intentId: null` is skipped cleanly).

**Second pass, same day (2026-07-19)** — a CTO-directed follow-up asked
for failure-scenario test coverage (escrow not locked, trade cancelled,
settlement failed, dispute during negotiation) plus real-Postgres
migration validation. The migration validation could not be performed —
no Docker/Postgres reachable in this sandboxed environment; deferred to
the sócio dev's infra pass. The failure-scenario request surfaced two
real gaps, both fixed:

- `src/modules/open-p2p/trade.service.ts` — `updateStatus()` left a
  Trade cancelled before escrow ever locked with its Intent stuck at
  `NEGOTIATING` forever. Now transitions it to `CANCELLED` (a valid
  direct transition from every pre-`COMMITTED` state per
  `core/state-machine.ts`).
- `src/common/events/handlers.ts` — investigating "dispute during
  negotiation" surfaced a **more severe, pre-existing bug unrelated to
  RFC-018 itself**: `Trade.escrowId` was never persisted anywhere in
  the live code path (`escrow.service.ts`'s `createEscrow()` emits
  `settlement.escrow.created` but its own module-boundary rule forbids
  it from writing `Trade` directly, and no handler reacted to that
  event). `dispute.service.ts`'s `raiseDispute()` guard
  (`if (!trade.escrowId) throw ...`) therefore rejected every dispute
  unconditionally against a real database — not merely during
  negotiation. Added the missing `settlement.escrow.created` handler.
- Escrow-lock provider failure was confirmed already correct (fails
  before persisting or emitting, so the Intent is never falsely
  advanced) — captured as a regression test, no code change needed.
- New tests: 2 in `tests/routes.test.ts` (trade cancellation),
  1 in `tests/escrowReleaseControls.test.ts` (lock failure), 1 in
  `tests/reputationOutcome.test.ts` (`Trade.escrowId` persistence).
  `npm run build` clean, `npm test` 216/216.

**Third pass, same day (2026-07-19)** — RFC-018's validation pass was
approved; the CTO-role follow-up asked to validate the complete
end-to-end flow with real persistence and provider integration. Real
Postgres/live-network validation still could not be executed here (same
constraint as the first pass above). Built instead:
`tests/fullTradeLifecycle.test.ts` — unlike every other test file in this
suite (each mocks at one service boundary), this one chains the REAL
service layer — `liquidityRouter`, `tradeService`, `escrowService`,
`dispute.service.ts`, `settlement-orchestrator.ts`'s `executeSettlement()`
— with the REAL `eventBus` (`InMemoryEventStore`) actually dispatching to
the REAL `registerEventHandlers()` reactions, only Prisma (an in-memory
fake) and the external WDK/HyperDHT providers mocked. Two tests: a full
Intent→Offer→discovery→Trade→escrow→settlement→reputation happy path, and
a dispute raised after escrow locks (proving the `Trade.escrowId` fix
above holds through the real chain, not just at the handler level).
Caught a real bug neither fix above did: `dispute.service.ts`'s
`resolveDispute()` moved funds via `escrowService.releaseFunds()`/
`refundFunds()` **before** marking the `Dispute` row `RESOLVED` — the
event those calls emit is exactly what `common/events/handlers.ts`'s
RFC-007 D8/D9 dispute-aware reputation branch reacts to, and its
`status: 'RESOLVED'` query always raced this function's own not-yet-run
update and lost. Every disputed resolution was silently scored as a
plain no-dispute outcome. Fixed by marking `RESOLVED` first, with a
revert-on-failure path if the fund movement then fails. `npm run build`
clean, `npm test` 218/218.

**Core RFC Review Checklist** (`GOVERNANCE.md` §6A):

- [x] `PROTOCOL_SPECIFICATION.md` — updated (§1.11's `Offer` entry,
  §1.12's footnote).
- [ ] `PROTOCOL_INVARIANTS.md` — not applicable. No Constitutional or
  Operational invariant changes; the Intent/Trade link is a wiring fix,
  not a custody or trust-boundary change.
- [ ] `TRUST_BOUNDARY.md` — not applicable, same reason.
- [ ] `SECURITY_MODEL.md` — not applicable, same reason.
- [ ] `CRYPTOGRAPHIC_MODEL.md` — not applicable, same reason.

## Primitives Used or Extended

Extends **Intent** (§1.2, §2) and **Discovery** (§1.3, via `Offer`'s new
`intentId`). No new primitive — this operationalizes a relationship
§1.11 already asserts conceptually but the code has never built.

## Principle Alignment

- **Principle 2, Intent Driven** — directly restored. Today's gap is
  the one live violation of this principle in the shipped code; this
  RFC's whole purpose is closing it.
- **Principle 9, Interface Agnostic** — unaffected. `Trade`'s existing
  shape is unchanged except for the additive `intentId` column; no UI
  or SDK-facing contract needs to change to keep working (a caller that
  never looks at `intentId` sees no difference).

## Specification

```prisma
model Offer {
  // ...existing fields unchanged...
  intentId String?
  intent   Intent? @relation(fields: [intentId], references: [id])
}

model Trade {
  // ...existing fields unchanged...
  intentId String?
  intent   Intent? @relation(fields: [intentId], references: [id])
}
```

```typescript
// liquidity.service.ts
async createOffer(input: CreateOfferInput) {
  const intent = await intentEngine.create('TradeIntent', {
    asset: input.asset,
    side: input.side,
    maxValue: Number(input.priceUsd) * Number(input.maxAmount),
    minValue: Number(input.priceUsd) * Number(input.minAmount),
    fiatMethod: input.paymentMethod,
    network: input.network,
  }, input.userId)

  const offer = await prisma.offer.create({
    data: { /* ...existing fields..., */ intentId: intent.id },
  })
  // ...existing event emission unchanged...
}

// trade.service.ts
async createTrade(input: CreateTradeInput) {
  const offer = await prisma.offer.findUnique({ where: { id: input.offerId } })
  // ...existing validation unchanged...
  const trade = await prisma.trade.create({
    data: { /* ...existing fields..., */ intentId: offer.intentId },
  })
  if (offer.intentId) {
    const triggeredBy = 'system:trade-lifecycle'
    await intentEngine.transition(offer.intentId, 'DISCOVERING', triggeredBy, 'intent.discovering', { intentId: offer.intentId })
    await intentEngine.transition(offer.intentId, 'MATCHED', triggeredBy, 'intent.matched', { intentId: offer.intentId, candidateIds: [input.counterpartyId] })
    await intentEngine.transition(offer.intentId, 'NEGOTIATING', triggeredBy, 'intent.negotiating', { intentId: offer.intentId, negotiationId: trade.id })
  }
  // ...existing event emission + negotiationService.open() unchanged...
}

// common/events/handlers.ts — settlement.escrow.locked
eventBus.on('settlement.escrow.locked', async (payload) => {
  const trade = await prisma.trade.update({ where: { id: payload.tradeId }, data: { status: 'ACTIVE' } })
  if (trade.intentId) {
    await intentEngine.transition(trade.intentId, 'COMMITTED', INTENT_LIFECYCLE_TRIGGER, 'intent.committed',
      { intentId: trade.intentId, settlementId: payload.escrowId, terms: null })
  }
})
```

**No `intent-engine.ts` change was needed** — `transition()` (as
opposed to `cancel()`) has no ownership check at all; it's an open
mechanism any module can drive with any `triggeredBy` string, by
design (its own doc comment). The original draft assumed a change was
needed here without having re-read the function first; corrected once
it was.

## Backward Compatibility

No `protocolVersion` bump — `intentId` is additive and nullable on both
tables, same pattern RFC-008 used for `entryHash`/`prevHash`. Existing
`Offer`/`Trade` rows keep `intentId: null` and remain fully valid;
`Timeline`/reputation/dispute code that reads `Trade`/`Offer` today
needs no change, since nothing currently reads `intentId` off either
table.

## Reference Implementation Plan

Satsails reference implementation (this repo).

**Phases 1-2 — done (2026-07-19).** Schema (`Offer`/`Trade` gain
nullable `intentId`), `createOffer()`/`createTrade()` wired as
specified, and the full `DISCOVERING → MATCHED → NEGOTIATING →
COMMITTED → SETTLING → FULFILLED`/`FAILED` lifecycle driven from
`trade.service.ts` and the three `settlement.escrow.*` reactions in
`common/events/handlers.ts` — landed together as one real engineering
pass, not left provisional, once the target was registered and clearly
understood (per the CTO review's own instruction: register and plan
first, then this pass is the "implementation" step, not a second
provisional fix layered on top). `intent-engine.ts` needed no change
(see Decision). Verified: `npm run build` clean, `npm test` 212/212 (5
new tests). **Not yet applied to a live database** — no Postgres
reachable in this environment; the schema change needs
`npx prisma migrate dev` (or `db push`, matching whichever this
project's real deployment uses — no `prisma/migrations/` directory
exists in this repo to indicate which) run against a real database
before this code path works outside tests.

**Phase 3 — `OpenP2PTradeIntentHandler` — done (2026-07-20).**
`modules/open-p2p/intent-handler.ts` now holds the real, registered
`IntentHandler` (§2.7): the exact field-level validation previously
inlined in `intent-engine.ts`'s `validateStructure()`, moved verbatim,
plus no-op `onCreated`/`onFulfilled`/`onExpired` (documented as
intentionally empty — Phases 1-2's `liquidity.service.ts`/
`trade.service.ts` already drive those reactions as `intentEngine`
callers, not as handler callbacks; duplicating them here would double
them). `validateStructure()` now delegates to `handlers.get(type)`
instead of hardcoding `TradeIntent`'s fields — the Core no longer knows
what a TradeIntent looks like, closing the gap `PROTOCOL_SPECIFICATION.md`
§2.6 disclosed ("only one real IntentHandler exists — none yet,
actually"). Registered at boot in `app.ts`'s `buildApp()`, next to
`registerEventHandlers()`. Behavior-preserving, as predicted — no
route, test assertion, or error message changed; the 3 test files that
call `intentEngine.create('TradeIntent', ...)` outside `buildApp()`
(`intentFlow.test.ts`, `intentCapabilityCheck.test.ts`,
`fullTradeLifecycle.test.ts`) now register the same real handler
explicitly, mirroring production boot instead of relying on inline
Core validation. `npm run build` clean, `npm test` 222/222 (no new
tests needed — existing coverage already exercises every branch through
the new indirection).


---

## Amendment A1 — Trade-scoped Intent (2026-10-10, #235 R7H-NF-E3C-5)

**Corrigido/Implementado 2026-10-10** — this amendment corrects §Decision ("Every `Trade` gains a nullable `intentId`
... copied from the accepted `Offer`" and "`createTrade()` ... walks the Intent through DISCOVERING -> MATCHED ->
NEGOTIATING"). That text described an `Offer` as the thing that ends in one `Trade`; an `Offer` is a standing
advertisement that admits many independent trades, and the Intent state machine (`core/state-machine.ts`) is
single-shot. With one shared Intent, every trade after the first failed its post-commit Intent walk with an error
for a trade that already existed, and any trade's lifecycle transition (cancel, escrow lock, settle, refund)
rewrote the Intent every sibling trade depended on. Evidence: NF-E3C-5, scenarios S1–S11.

### Offer Intent — the advertisement

- Created with the Offer, unchanged (`liquidity.service.ts`). It represents the lifecycle of the **standing
  advertisement**, never of an individual negotiation. It stays `COORDINATED` while the advertisement is open.
- **No trade transitions it.** Its terminal states are the existing `CANCELLED` / `EXPIRED`. `Offer.status` remains the
  only authority that admits (or stops admitting) trades; closing an offer never affects trades already admitted.
- It cannot be cancelled through `DELETE /v1/intents/:id` while an Offer or a Trade references it (409
  `INTENT_BOUND`): doing so bypassed the trade-cancellation guards (F-1).
- `Offer.intentId` and `Trade.intentId` keep their published meaning: the originating Offer's Intent.

### Trade Intent — one negotiation

- Created **atomically with its trade**, in the same PostgreSQL transaction as the trade, its idempotency result and
  its durable events (`trade-repository.ts` `admit()`), and referenced by the new `Trade.tradeIntentId` (nullable,
  `UNIQUE`, foreign key `RESTRICT`, fixed at creation; migration `20261018120000_trade_scoped_intent`).
- `type = TradeIntent`, `participantId` = the taker, `parentIntentId` = the Offer's Intent, `expiresAt = NULL` (a
  trade's time authority is its escrow timelock and F8 expiry, not Intent expiry). Created already `NEGOTIATING`,
  with the full approved walk recorded as hash-chained IntentEvents (CREATED -> VALIDATED -> COORDINATED ->
  DISCOVERING -> MATCHED -> NEGOTIATING) and as durable `intent.*` events, triggered by `system:trade-admission`.
  Creation is an internal, system-derived action: it needs no capability grant.
- Its lifecycle is the trade's own and nothing else moves it: escrow lock -> `COMMITTED`, release/split ->
  `SETTLING`/`FULFILLED`, refund -> `FAILED` (`common/events/handlers.ts`), cancellation -> `CANCELLED` (inside the
  cancellation transaction, after the economic cancellation guards). It cannot be cancelled through the generic
  Intents API.
- State machine: unchanged. No new states or transitions.

### Lookup

`GET /v1/openp2p/trades/by-intent/:intentId` is scoped to the caller's own trades and deterministic: a trade's own
Intent resolves to that trade for its buyer and seller; an Offer/legacy Intent resolves to the caller's trade when
they are a party to exactly one, to **409 `AMBIGUOUS_INTENT`** (with only the caller's own trade ids) when to several,
and to **404** otherwise (no other participant's trade is ever revealed). `findFirst` is gone.

### Legacy (L1) — trades admitted before this amendment

`tradeIntentId` is `NULL` for every historical trade and is **never back-filled**; no Intent history is fabricated.
Their lifecycle keeps following the shared `intentId`, with one explicit, audited policy: when such a trade is
cancelled — only after every existing economic cancellation guard passed, and only if it has no escrow of its own —
the shared Intent is left untouched, and the decision recorded as the durable event
`openp2p.trade.intent_unchanged`, when (a) another trade on the same Intent is still live, or (b) the Intent is
already terminal. Any other combination keeps the pre-amendment behaviour: the transition is attempted and an Intent
that cannot be cancelled refuses the **whole** cancellation with no durable effect (#235 R7G-B1).

### Idempotency (CSC-1-R2, trade creation only)

`openp2p.trade.create` no longer goes through `withIdempotency()`. Its claim is inserted already `COMPLETED` with its
`resultRef` by `INSERT ... ON CONFLICT DO NOTHING` inside the admission transaction: a committed trade always has its
claim, no `IN_PROGRESS` row is ever created in this scope, a refused admission leaves no claim at all, and the
same-key waiter is resolved by the database. What happens after COMMIT (event dispatch, in-memory bookkeeping) is
non-authoritative and can never become an error response for a committed trade. Other `withIdempotency()` scopes are
unchanged.

**Legacy `IN_PROGRESS` claims are never attributed to a trade** *(Corrigido 2026-10-10, Gate C corrective — the first
text of this amendment let a reconciliation resolve a claim when exactly one trade matched its owner, payload hash and
a 30 s window; an independent audit reproduced false and double attribution from exactly that)*. Before this amendment
a trade and its claim were two separate commits and the trade row carries no reference to the claim, so owner +
payload + timestamp only **correlate** them, and correlation is not causation. A legacy claim stays `IN_PROGRESS`
(never `COMPLETED`, never `FAILED`, no `resultRef`), its key stays reserved (no second trade can be created through it),
and a replay is answered **409 `IDEMPOTENCY_OUTCOME_UNKNOWN`** with `details: { authoritative: false,
unverifiedCandidateTradeIds }` — hints (the caller's own legacy trades created shortly after the claim), never a
result. `trade-claim-reconciliation.ts` only observes: it appends at most one immutable `UNRESOLVED` audit row per claim
(the database refuses any other decision) and has no operator override. A claim is resolved only by durable causal
evidence written by the code that created the trade, which is what the atomic admission above does.

### Technical freeze — audited B2 scope (CTO, 2026-10-10)

The CTO approved a **technical freeze of the audited B2 scope** at implementation HEAD
`c51b8bb8da47048fac7fce8968e45c51950d1df9` (PR #432, DRAFT, unmerged; exact-head CI run 38066511891, success).
Evidence: the independent Gate A–G security audit and the Gate C re-audit
(`READY_FOR_CTO_R7H_NF_E3C_5_B2_GATE_C_FINAL_REAUDIT`: Gate C PASS; material findings C-M1 and C-M2 closed with executable
PostgreSQL evidence). This is **not** a merge, a deployment, an E3 global freeze or an E4 authorization, and it does not
close #235. Residual findings are registered in `docs/BACKLOG.md` ("B2 technical freeze and residual findings register");
deployment prerequisites are in `docs/DEPLOYMENT.md` section 2.2. Commits added to this branch after the audited HEAD are
documentation only.

Frozen invariants. **Any change to one of them requires a new explicit CTO decision.**

1. The standing Offer Intent is not transitioned by independent trades.
2. Every newly admitted trade has its own Trade Intent.
3. The claim, the Trade Intent, its IntentEvents, the durable events, the Trade and the economic-binding validation form
   one atomic PostgreSQL admission unit.
4. A same-key retry returns only an outcome supported by durable evidence.
5. Legacy `IN_PROGRESS` claims without causal proof remain unresolved.
6. No inferred MATCHED, no fabricated FAILED, no duplicate trade on replay.
7. An unresolved legacy claim returns `409 IDEMPOTENCY_OUTCOME_UNKNOWN`.
8. Candidate trade hints are caller-scoped and non-authoritative.
9. Intent deletion and by-Intent lookup preserve the F-1 / F-7 authorization.
10. Historical shared-Intent trades remain legacy; there is no speculative backfill.

### Known limitation (unchanged here)

The Intent a TAKER creates through `createIntent()` / `proposeTrade()` (RFC-023) is a free-standing buyer-side Intent
that no trade references (it tops out at `DISCOVERING`). `dispute(intentId)` / `releaseAsset(intentId)` therefore do not
resolve a trade from it (404); use `trade.tradeIntentId`. Linking the two (`originIntentId`) is deliberately out of
scope of this amendment.
