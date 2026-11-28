# RFC-014: Capability Registry Enforcement — Real Callers for RFC-013's Registry

## Summary

RFC-013 made `core/capability-registry.ts` a real, persisted implementation
of RFC-005's `CapabilityGrant` — but nothing in the actual money-moving
path ever called `capabilityRegistry.check()`. This RFC adds the two real
enforcement points: `intentEngine.create()` (before a `TradeIntent` is
persisted) and `settlement-orchestrator.ts`'s `executeSettlement()`
(before the seller's agent triggers the real, signed USDT release). Both
are config-gated behind a new `config.features.enforceCapabilities` flag,
default `false`, following the exact precedent `AUTO_SETTLE_ON_MATCH`
already set for a dangerous-by-default action.

**Status:** Accepted. One of five gaps the project owner asked to have
closed before external technical review (Tether); this is the second
(after RFC-014's sibling infrastructure work, `docker-compose.yml` +
`DEPLOYMENT.md`).

## Current enforcement boundary (Issue #303)

The original activation policy below is historical. The ADR-004
amendment of 2026-09-21 supersedes it for production: `src/config/index.ts`
refuses to boot a production process unless `ENFORCE_CAPABILITIES` is
exactly `true`. Development, test and reference environments may still
run with enforcement disabled. This boot requirement is necessary, not
sufficient, for production eligibility.

The current canonical registry recognizes trade-coordination creation
and discovery scopes and settlement release/refund/split scopes. ADR-004
adds operation-bound execution authorization for asynchronous settlement;
ADR-005 separately governs disputed ruling authority. The public grant
registration path remains self-issued, not independent third-party
approval, and does not establish per-trade or monetary limits. Neither
the boot guard nor a valid grant proves complete endpoint coverage,
provider safety or formal production homologation. See RFC-013 and the
ADR-004 production amendment for the current authority boundaries.

## Motivation

A working, tested permission system with zero real callers is not a
security control — it's a component that happens to also have unit tests.
Before this RFC: `capabilityRegistry.grant()`/`check()`/`revoke()` were
only ever invoked by `capability.routes.ts` (letting a participant issue
themselves a grant) and by `tests/capabilityRegistry.test.ts`. Nothing in
`intent-engine.ts` or `settlement-orchestrator.ts` — the two places a real
participant actually does something with financial consequence — ever
asked the registry whether the actor was allowed to.

This was flagged directly (not found incidentally): a rigor pass across
the whole codebase, requested by the project owner ahead of a Tether
technical review, identified "the Capability Registry has zero real
callers or enforcement points anywhere in the money-moving path" as one
of five concrete gaps, alongside no live infra verification (RFC-014's
sibling `docker-compose.yml` work), single-seed custody (tracked
separately as RFC-015), no end-to-end transaction walkthrough doc
(tracked separately, not an RFC), and unmitigated rate limiting (closed
separately via `@fastify/rate-limit`, no RFC needed — infrastructure, not
a Core primitive).

## Alternatives Considered

1. **Enforce unconditionally, no config flag.** Rejected. Every existing
   test, the demo script (before this RFC), and any real deployment today
   has zero `CapabilityGrant` rows issued — turning enforcement on
   unconditionally would reject every `TradeIntent` and every settlement,
   everywhere, the moment this RFC merged. That is not "secure by
   default," it's "broken by default" — indistinguishable from a bug to
   an operator who hasn't read this RFC. `AUTO_SETTLE_ON_MATCH` already
   established the right shape for a behavior-changing flag in this
   codebase: default `false`, real logic behind it, opt-in once the
   caller has done the prerequisite setup (there: understanding the
   dispute-window implications; here: issuing grants).
2. **Enforce only at the HTTP route layer (a Fastify `preHandler`), not
   inside `intentEngine.create()`/`executeSettlement()` themselves.**
   Rejected. Both functions are called from more than one place —
   `intentEngine.create()` from `intent.routes.ts` and directly from
   `demo/pix-to-usdt-flow.ts`'s `BuyerAgent` path (no HTTP request
   involved at all); `executeSettlement()` from `escrow.routes.ts`,
   `common/events/handlers.ts`'s auto-settle reaction, and the demo
   script. A route-level guard would miss both non-HTTP callers entirely,
   leaving the actual protocol-level entrypoints unenforced — the same
   mistake as putting a lock on the front door of a building with an
   unlocked back door that most of the actual traffic uses.
3. **A single blanket `enforceCapabilities` check inside
   `capabilityRegistry` itself (e.g. a `requireCheck()` that throws by
   default).** Rejected. The registry is intentionally a passive
   grant/check/revoke store (RFC-013's own design) — it has no way to
   know what `capabilityName`/`scope` a given call site actually needs
   without the caller telling it. Baking a policy decision ("is
   enforcement on, and what does *this* action require") into the
   registry itself would conflate "store of grants" with "policy engine,"
   the exact distinction RFC-013's Alternatives Considered #5 already
   drew a line around (Policy Engine's governed-rule storage stays a
   separate, unstarted piece of work). Each call site owns its own
   `capabilityName`/scope choice; the registry only answers yes/no.
4. **Gate `executeSettlement()`'s entire function, not just the release
   step.** Rejected as unnecessarily broad. `escrowService.createEscrow()`
   /`lockFunds()`/`markPaymentSent()` are reversible, non-final operations
   (an escrow that's locked but never released can still be refunded via
   the existing dispute path) — the release call
   (`escrowService.releaseFunds()`) is the one irreversible action that
   actually sends signed funds. Checking only immediately before that
   call, rather than at function entry, means a caller without the
   capability still gets a real `Trade`/`Escrow` audit trail up to the
   point of rejection instead of the request being bounced before
   anything is recorded — useful for an operator debugging why a
   settlement never completed.

## Decision

**1. New config flag**, same shape as `AUTO_SETTLE_ON_MATCH`
(`src/config/index.ts`):

```typescript
features: {
  // ...
  enforceCapabilities: process.env.ENFORCE_CAPABILITIES === 'true',
}
```

Default `false`. `.env.example` documents it under a new section with the
same "off by default, here's exactly why" explanation `AUTO_SETTLE_ON_MATCH`
already has.

**2. `intentEngine.create()`** (`src/core/intent-engine.ts`) checks, only
for `TradeIntent` (the only real `IntentType` today) and only when the
flag is on, right after the existing CISO Byzantine/Economic checks and
before `prisma.intent.create()`:

```typescript
if (config.features.enforceCapabilities) {
  const capabilityName = CAPABILITY_IMPLEMENTATIONS[moduleId] // 'openp2p' -> 'trade-coordination'
  const allowed = await capabilityRegistry.check(participantId, capabilityName, 'intent.created')
  if (!allowed) {
    throw new ForbiddenError(
      `${participantId} has no active '${capabilityName}' capability grant covering 'intent.created'`
    )
  }
}
```

The required scope string is `'intent.created'` — the real event name
this action produces (`common/events/event-bus.ts`), not an invented
scope vocabulary. This matches RFC-013's own example grant
(`scope: ['openp2p.trade.created']`), which already used a real event
name as a scope string.

**3. `executeSettlement()`** (`src/modules/open-settlement/settlement-orchestrator.ts`)
checks immediately before `escrowService.releaseFunds()` — after escrow
creation, fund locking, and the (emulated) PIX confirmation have already
run (see Alternatives Considered #4):

```typescript
if (config.features.enforceCapabilities) {
  const capabilityName = CAPABILITY_IMPLEMENTATIONS.opensettlement // 'settlement'
  const allowed = await capabilityRegistry.check(sellerTriggeredBy, capabilityName, 'settlement.escrow.released')
  if (!allowed) {
    throw new ForbiddenError(
      `${sellerTriggeredBy} has no active '${capabilityName}' capability grant covering 'settlement.escrow.released'`
    )
  }
}
```

Checked against `sellerTriggeredBy` (the seller's agent id when one is
acting, else the seller's own `participantId` — the same value already
threaded through as `triggeredBy` on every escrow transition in this
function), not the buyer: releasing funds is the seller's action.

**4. `ForbiddenError` (403)** — already existed in `common/errors/index.ts`
(added during an earlier pass, never previously thrown anywhere real) —
is what both checks throw. No new error class needed.

**5. Demo script** (`examples/demo/pix-to-usdt-flow.ts`) issues both grants
right after identity registration, unconditionally (cheap and harmless
when enforcement is off — an unused `CapabilityGrant` row just sits in
the table):

```typescript
await capabilityRegistry.grant({
  grantedTo: buyer.id,
  capabilityName: CAPABILITY_IMPLEMENTATIONS.openp2p,
  scope: ['intent.created'],
  issuedBy: buyer.id,
})
await capabilityRegistry.grant({
  grantedTo: sellerAgent.agentId,
  capabilityName: CAPABILITY_IMPLEMENTATIONS.opensettlement,
  scope: ['settlement.escrow.released'],
  issuedBy: seller.id,
})
```

Without this, `ENFORCE_CAPABILITIES=true` would have had its first real
exercise be whichever production deployment flips it on first — the demo
script is the place this codebase already uses to prove a real flow
works end to end (`docs/HANDOFF.md`), so it should prove this one too.

## Primitives Used or Extended

No new primitive, no protocol surface change. This RFC adds *callers* of
an already-real Core component (RFC-013's `CapabilityGrant`/
`capabilityRegistry`) — the grant/check/revoke shape itself is unchanged.

## Principle Alignment

- **Principle 5 (Capability Based):** this is what actually makes the
  principle true in the running system, not just in the data model.
  RFC-013 built the mechanism; this RFC is the mechanism actually being
  consulted at the two points where it matters.

## Specification

| File | Change |
|---|---|
| `src/config/index.ts` | New `features.enforceCapabilities` flag |
| `src/core/intent-engine.ts` | Capability check before `prisma.intent.create()` for `TradeIntent` |
| `src/modules/open-settlement/settlement-orchestrator.ts` | Capability check before `escrowService.releaseFunds()` |
| `examples/demo/pix-to-usdt-flow.ts` | Issues the two grants the demo needs, so it keeps working with enforcement on |
| `.env.example` | `ENFORCE_CAPABILITIES` documented |
| `tests/intentCapabilityCheck.test.ts` (new) | Off-by-default, reject-without-grant, allow-with-grant |
| `tests/settlementCapabilityCheck.test.ts` (new) | Same three cases, plus: checks `sellerAgentId` not raw `sellerId` when an agent acts, and confirms `lockFunds`/`markPaymentSent` already ran before the rejection (Alternatives Considered #4) |

## Backward Compatibility

No `protocolVersion` bump — this is additive Core-component wiring behind
a flag defaulting to today's exact behavior (no enforcement). Every
existing caller of `intentEngine.create()`/`executeSettlement()`, every
existing test, and the pre-this-RFC demo script all continue to work
unmodified with `ENFORCE_CAPABILITIES` unset.

## Amendment — capability coverage completed for refund/split (Missão 06.9, 2026-08-16)

**Gap found (Missão 06.7's full route-authorization audit).** This RFC's
own Decision section only ever described one fund-movement action —
release ("the one irreversible action that actually sends signed
funds," Alternatives Considered #4) — and the real implementation
matched that literally: `escrowService.releaseFunds()` and
`escrow-pending-tx.ts`'s `initiateRelease()` both checked
`capabilityRegistry`, but `refundFunds()`, `splitFunds()`,
`initiateRefund()`, and `initiateSplit()` never did. `splitFunds()`'s own
code comment claimed "same authorization check" as `releaseFunds()`,
which was false. This was a real, exploitable inconsistency when
`ENFORCE_CAPABILITIES=true`: refund and split moved the identical class
of real, signed funds as release, through the identical Providers, with
zero capability gate.

**Determination: wiring gap, not a semantic gap.** This RFC's own stated
convention — "the required scope string is the real event name this
action produces" — already extends cleanly to refund
(`settlement.escrow.refunded`) and split (`settlement.escrow.split`),
both already-real event names in `common/events/event-bus.ts`'s
`SailsEventMap`. No new capability, no new scope vocabulary, no Policy
Engine involvement — the same `CAPABILITY_IMPLEMENTATIONS.opensettlement`
capability already used for release, checked against the same
`triggeredBy` value already threaded through every escrow transition in
this codebase.

**Actor for arbitrated rulings.** `dispute.service.ts`'s `applyRuling()`
already passes the assigned arbiter's own id as `triggeredBy` for
*every* ruling type, RELEASE included — meaning an arbitrated release
was already being capability-checked against the arbiter's own grant,
not the seller's, before this pass. Refund/split now inherit that exact
same existing behavior for arbitrated rulings; this amendment does not
introduce a new distinction between seller-triggered and
arbiter-triggered capability requirements — it did not exist for release
either, and this pass does not add it.

**Sweeper-triggered refund.** `sweepExpiredEscrows()` passes the trade's
real `sellerId` as `triggeredBy` (a deliberate, pre-existing design — see
that method's own comment, "never a fabricated 'system' actor... mirrors
`settlement-orchestrator.ts`'s own `sellerTriggeredBy` precedent for
automated calls"). It is therefore subject to the same capability
requirement a manual seller-initiated refund already is when
`ENFORCE_CAPABILITIES=true` — not a new rule invented for this
amendment, the direct consequence of a design decision already made
before it.

**Decision:** `refundFunds()`, `splitFunds()`, and (via the shared
`initiateSignatureCollectionCore()` skeleton, closing the same gap for
the pending-transaction path in one place) `initiateRefund()`/
`initiateSplit()` now call the identical check `releaseFunds()`/
`initiateRelease()` already did, extracted into one shared helper
(`checkFundMovementCapability()`, `escrow-lifecycle.ts`) specifically so
this class of drift — one call site protected, its siblings silently
not — cannot happen again the same way without also being visible as a
single, obviously-incomplete call graph. No new primitive, no new
Capability, no Policy Engine change, no schema change, no change to
`enforceCapabilities`'s own default (`false`) or to what "off" means.

**Verification:** `tests/fundMovementCapabilityCoverage.test.ts` — 12
scenarios covering release/refund/split (direct and initiate) with and
without a grant, `enforcement=false` preserving today's unchecked
behavior, wrong capability name, expired grant, and wrong actor.

## Reference Implementation Plan

1. Config flag (this pass).
2. `intentEngine.create()` check (this pass).
3. `executeSettlement()` check (this pass).
4. Demo script grants (this pass).
5. **Explicitly not this pass, tracked in `BACKLOG.md`:** a route or CLI
   for an operator to issue grants in bulk (today: one `POST
   /v1/capabilities/register` call per grant, self-issued only per
   RFC-013's own scope cut); enforcement for any future non-`TradeIntent`
   `IntentType`, once one exists; the dual-authorization/two-person
   control on the *same* release step this RFC gates (RFC-015) — that is
   a different, additive control (an approval count), not a replacement
   for this capability check. A real deployment turning both on would
   have the release require: a capability grant covering it (this RFC)
   *and* two independent approvals (RFC-015) — neither substitutes for
   the other.
