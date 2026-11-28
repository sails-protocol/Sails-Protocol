# RFC-023: QVAC Negotiated Trade Proposal (price/reputation-bounded discovery)

## Summary

Adds two additive optional fields to the frozen `TradeIntentPayload`
(`maxPriceUsd`/`minPriceUsd`, decimal strings, RFC-009) and a new
`POST /v1/intents/:id/propose` route that uses them — together with the
already-real `minReputationRating` (RFC-013) — to find a real matching
`Offer` for a persisted `Intent`, without creating a `Trade` or touching
escrow/settlement in any way. This is the backend half of making
`packages/sails-ui`'s "AI Negotiator" panel real: QVAC already drafts a
structured `TradeIntent` from a goal (`POST /v1/agents/generate-trade-intent`,
real since the `open-agents` module shipped); everything after that was a
client-side `setInterval` simulation until this RFC.

**Status:** Accepted. Directive from the project's CTO (relayed via chat,
2026-08-15): implement now, scoped as a small, demonstrable vertical slice —
explicitly not "QVAC completo." Hard boundary he set, preserved in full
here: QVAC may negotiate/discover autonomously within user-declared limits,
but gets no autonomous authority over escrow/settlement. The human approves
the returned proposal; only then does the existing, unmodified
`POST /v1/openp2p/trades` flow run — the same call the UI already makes
today for a manually-selected offer.

**Status at a glance, after the Missão 02 amendment below:** QVAC
Negotiation — **REAL / IMPLEMENTED** (discovery + single-shot bounded
counterproposal, both real, both tested). Settlement autonomy — **NOT
ENABLED** (unchanged: this route and everything it calls never touches
`open-settlement`). Policy — **implemented only to the extent this flow
needs** (`evaluateIntentPolicy()`, real, renamed/restructured from this
document's own `authorizeIntentAction()` by the Missão 03 amendment
below; the governed multi-stakeholder `PolicyEngine` remains Months
10-12 scope, unchanged).

## Motivation

`TradeIntentPayload` already carries `minValue`/`maxValue` (a *quantity*
range) and, since RFC-013, `minReputationRating` — but RFC-013's own text
explicitly deferred the actual matching/enforcement of that reputation
field ("OpenLiquidity reading this during matching is separate follow-up
work"). Nothing in the codebase reads any of these fields to actually find
a counterparty; `intent-handler.ts`'s `onCreated()` is a documented no-op,
and `liquidity.service.ts`'s real `getOffers()` already supports
`priceMin`/`priceMax` filters and already joins each offer's
`traderReputation` — both currently unused for this purpose. There is no
*price* limit field anywhere on the Intent today, which blocks the
reputation-matching follow-up RFC-013 deferred: a real proposal needs both
a price ceiling/floor and a reputation floor to be a meaningful "was this
found within the user's stated limits," not just one.

## Alternatives Considered

1. **Give the agent direct authority to call `createTrade()`/lock escrow
   once a match is found.** Rejected outright per the CTO's explicit
   instruction — this conflates two separable concerns (autonomous
   discovery vs. autonomous fund custody) that must ship as two different,
   independently-gated capabilities. This RFC is scoped to the first only.
2. **Reuse `minValue`/`maxValue` to also mean a price bound, instead of
   adding new fields.** Rejected — those fields are documented and used
   elsewhere as a *quantity* range (see `intent-handler.ts`'s `validate()`,
   `buyer-agent.ts`'s own goal-prompt text: "Proponha um intervalo de
   quantidade"). Repurposing an already-frozen field's meaning is exactly
   what this codebase's own conventions (and CLAUDE.md's engineering-loop
   contract) rule out; additive new fields, same as RFC-013's own precedent,
   are the correct move.
3. **Route the new endpoint under `/v1/liquidity/` (next to the existing
   `POST /v1/liquidity/match`) instead of `/v1/intents/:id/propose`.**
   Rejected. `/v1/liquidity/match` is deliberately unauthenticated and
   accepts `priceMin`/`priceMax` as raw caller-supplied body params — fine
   for a stateless price check, wrong for this feature, where the price/
   reputation limits must be read from the *persisted, ownership-checked*
   Intent, not re-trusted from whatever the request body claims.
4. **Persist a new `Proposal`/`Quote` Prisma model.** Rejected for V1 —
   no correctness need depends on it (the eventual `createTrade()` call
   re-validates the offer's live status/amount bounds regardless of what
   an earlier proposal said), and a real audit trail is already available
   for free: the matched offer id is written into the Intent's own
   hash-chained `IntentEvent.note` when it transitions `COORDINATED` →
   `DISCOVERING`.
5. **Build the governed `PolicyEngine` (`get`/`propose`/`activate`, still a
   stub) as part of this pass, since the CTO's own diagram shows a "Policy
   Engine" box.** Rejected, same scope-cut reasoning RFC-012 and RFC-013
   both already applied to this exact stub: the Intent's own already-real,
   already-validated fields (`maxPriceUsd`/`minPriceUsd`/
   `minReputationRating`) are sufficient policy for this feature. The
   governed, versioned, multi-stakeholder policy-storage system remains
   out of scope until Months 10-12 (`PROTOCOL_ECONOMY.md` §7), unchanged.

## Decision

**1. `TradeIntentPayload` gains two additive optional fields**
(`common/types/intent.ts`):

```typescript
maxPriceUsd?: string  // decimal string, RFC-009, USD-denominated (matches Offer.priceUsd)
minPriceUsd?: string
```

Validated for type (decimal string) in `intent-handler.ts`'s `validate()`
and for sanity (non-negative, sane ceiling, `min <= max`) in
`policy-engine.ts`'s `validateFinancialSanity()` — the same two gates
`maxValue`/`minValue` already go through, applied identically here.

**2. `liquidity.service.ts` gains `LiquidityRouter.proposeForIntent()`**:
given `asset`/`side`/`amount` plus the Intent's own `priceMin`/`priceMax`/
`minReputation`, calls the existing `getOffers()` (already supports price
bounds) with the full `MAX_PAGE_LIMIT`, then application-filters by
`traderReputation >= minReputation` (the join already exists, just unused
until now), returning the single best-priced match or `null`. No new
matching algorithm, no new Prisma model.

**3. `POST /v1/intents/:id/propose`** (new route, `intent.routes.ts`,
`docsOnlySchema()` pattern — not the file's two grandfathered hand-rolled-
schema routes): `requireAuth`, ownership-checked (only the Intent's creator
may propose against it), rejects an `amount` outside the Intent's own
declared `minValue`/`maxValue` range, calls `proposeForIntent()`, and — if
the Intent is still `COORDINATED` — transitions it to `DISCOVERING` (the
only valid forward transition per `state-machine.ts`) with the matched
offer id recorded in the hash-chained event `note`. Does **not** transition
further (`MATCHED`/`NEGOTIATING` mean "a real Trade now exists" elsewhere in
this codebase); this buyer-side Intent tops out at `DISCOVERING` and later
expires via its own `expiresAt` — fully unifying it with the *offer's own*
separate Intent (the one `createTrade()` walks to `MATCHED`) would mean
touching `createTrade()` itself, explicitly out of scope here.

**4. Approval is the existing, unmodified path.** The UI's "Aprovar" action
on a returned proposal calls the same `sailsClient.openp2p.trade(offerId,
amount)` → `POST /v1/openp2p/trades` → `trade.service.ts createTrade()`
flow already in production for a manually-selected offer (Corrected/Implemented 2026-11-27: "in production" here means the existing, unmodified code path, not evidence of a production deployment, and it does not establish that this RFC's proposal route is available in a production environment)
(`OfferDetail.tsx`). Nothing in `open-settlement` is touched by this RFC.

## Reference Implementation

`src/common/types/intent.ts`, `src/core/intent.routes.ts`,
`src/modules/open-p2p/intent-handler.ts`, `src/core/policy-engine.ts`,
`src/modules/open-liquidity/liquidity.service.ts`,
`packages/sails-sdk/src/modules/` (new typed client method),
`packages/sails-ui/src/components/agent/AgentIntentionPanel.tsx` (real
`handleDelegate()`, replacing `lib/aiNegotiator.ts`'s deleted simulation).

## Amendment (Missão 02, 2026-08-15) — authorization boundary + counterproposal

Two additive extensions to this RFC's own vertical slice, both confirmed
with the project owner before implementation (three explicit decisions —
see below) rather than decided unilaterally, per this codebase's own
"stop and report a real architectural inconsistency" discipline.

**1. `/propose` now goes through a named authorization boundary.**
Alternatives Considered #5 above correctly kept the *governed*
`PolicyEngine` (`get`/`propose`/`activate`) out of scope — that decision
is unchanged. What this amendment adds is narrower: the
ownership/expiry/status checks this route was already making inline are
now one function, `authorizeIntentAction()` (`core/policy-engine.ts` —
renamed `evaluateIntentPolicy()` by the Missão 03 amendment below, same
function, extended further),
plus a real `capabilityRegistry.check()` call this route never made
before (gated by `config.features.enforceCapabilities`, still off by
default — no behavior change while that flag stays off). Scope reuses
the existing `'trade-coordination'` capability and the real
`'intent.discovering'` event-name-as-scope convention `intent-engine.ts`'s
own `'intent.created'` check already set — no new capability, no new
scope vocabulary. Fails closed: every branch of that function explicitly
denies; `{ allowed: true }` is reached only once nothing objected.

**2. `proposeForIntent()` now returns a bounded counterproposal, not just
match-or-null.** When no real `Offer` clears every limit but one clears
amount + reputation and misses only on price, the response now also
carries a `counterProposal` (`referenceOfferId`, `listedPriceUsd`,
`suggestedPriceUsd`, `reasoning`) alongside the still-`null` `proposal`.
`suggestedPriceUsd` is always exactly the Intent's own already-declared
bound (`maxPriceUsd` for a BUY, `minPriceUsd` for a SELL) — never a
fabricated number, never worse than what the participant already
authorized themselves. Deliberately single-shot and informational only:
no automated back-and-forth with the counterparty (that would need the
real `NegotiationService`/chat channel, materially bigger scope, and
edges toward the "chatbot that negotiates" this mission explicitly
avoided), and `referenceOfferId` is not accepted by any trade-creation or
settlement call — trading against it directly still executes at its own
*listed* price, not the suggestion. This is the real, if narrow, sense in
which QVAC now "negotiates" rather than only discovering: it computes and
surfaces a counter-term, bounded by what the human already authorized,
for the human to act on — it does not act on it itself.

**Explicitly still not built, same as before this amendment:** iterative
negotiation with the counterparty, the governed `PolicyEngine`, and any
authority for this route (or anything it calls) to create a Trade or
touch escrow/settlement — `core/intent.routes.ts` still never imports
`open-settlement`.

**Reference implementation, additions:** `core/policy-engine.ts`
(`authorizeIntentAction`, superseded by `evaluateIntentPolicy` — see the
Missão 03 amendment below), `core/intent.routes.ts` (wiring),
`modules/open-liquidity/liquidity.service.ts` (`CounterProposal`, the
extended `proposeForIntent()`). Tests: `tests/evaluateIntentPolicy.test.ts`
(supersedes `tests/authorizeIntentAction.test.ts`),
`tests/liquidityProposeForIntent.test.ts`,
`tests/qvacAgentProviderAvailability.test.ts`, and the extended
"Intent API — propose (RFC-023)" block in `tests/routes.test.ts`.
**Not touched by this amendment, disclosed gap:** `packages/sails-sdk`'s
`proposeTrade()` still returns only `TradeProposal | null` — it does not
yet surface `counterProposal`. Left alone deliberately: that method's
return type is part of the SDK's frozen public API
(`docs/API_STABLE.md`), and changing it is a separate, explicitly-scoped
SDK pass, not an in-place change bundled into this backend amendment.
(Since resolved — see the Missão 02.5 amendment below.)

## Amendment (Missão 02.5, 2026-08-15) — SDK/UI closed, capability readiness audited

Closes the integration debt the two amendments above left open, without
touching this route's own logic. `proposeTradeOutcome(intentId, amount)`
added alongside `proposeTrade()` (`packages/sails-sdk/src/intent-facade.ts`)
— same route, additive, not a replacement — returning
`{ proposal, counterProposal }` so a caller can see the counterProposal
`proposeTrade()` itself still discards by design (its own frozen return
type cannot represent it). `packages/sails-ui`'s `AgentIntentionPanel.tsx`
now calls the new method and renders a real counterProposal instead of
showing the same "nothing found" message a true no-match gets.

A real, separate finding from the same pass: this codebase's capability
readiness was audited end to end (grants, seed data, active users,
production config) — **`ENFORCE_CAPABILITIES` is not ready to turn on**.
No real user holds a `CapabilityGrant` today; the only script that
pre-issues one (`examples/demo/pix-to-usdt-flow.ts`) had itself drifted
out of sync with the scope this route's own capability check (below)
introduced, fixed as part of this pass. Full findings in that mission's
own report, not duplicated here — this RFC only records that the flag
stays off, and why, since it's directly relevant to whether this route's
`requireCapability` branch is ever actually exercised in production
today (it is not).

## Amendment (Missão 03, 2026-08-15) — Capability vs. Policy made explicit

`authorizeIntentAction()` (added by the first amendment above) is renamed
`evaluateIntentPolicy()` and extended — same function, same file
(`core/policy-engine.ts`), not a new system. The rename exists to make a
distinction explicit that was previously only implicit in a comment:

- **Capability** answers "does this actor hold potential authority for
  this class of action?" — `capabilityRegistry.check()`, a pure grant
  lookup, no business context.
- **Policy** answers "given this actor, this specific resource, and the
  current contextual conditions, is this exact action permitted right
  now?" A valid capability is necessary but never sufficient.

The concrete, previously-missing proof of that second point: the
amount-vs-Intent's-own-`minValue`/`maxValue` bounds check this route was
already making (Decision §3 above, "amount is inherently per-request")
lived inline in the route, separate from the capability check — meaning
in practice, once ownership/expiry/status/capability all cleared,
nothing else stood between a request and a match. That check is now
folded into `evaluateIntentPolicy()` itself as a real policy condition,
so "capability granted" and "this specific request is authorized" are
never conflated even inside this one route.

**Reference implementation:** `core/policy-engine.ts`
(`evaluateIntentPolicy`, `PolicyDecision`, `PolicyEffect`),
`core/intent.routes.ts` (updated wiring, amount-bounds check removed
from the route body). Tests: `tests/evaluateIntentPolicy.test.ts` (19
tests — supersedes `tests/authorizeIntentAction.test.ts`), the updated
"policy-enforcement wiring" block in `tests/routes.test.ts`.

**Still unchanged, still correctly out of scope:** the governed
`get`/`propose`/`activate` `PolicyEngine` interface (Months 10-12);
settlement authorization (`escrow.service.ts`'s own ownership/RFC-014/
RFC-015 checks — `policy-engine.ts` never imports `open-settlement`,
proven directly by a source-scan test, not just asserted in a comment);
counterparty-reputation filtering (stays in `liquidityRouter`'s
discovery logic — a property of what a search finds, not of whether the
requester is authorized to search).
