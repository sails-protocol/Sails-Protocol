# RFC-010: Durable Event Store and Mandatory correlationId

**Status:** Accepted. Originated from the same external CISO/Chief
Architect audit as RFC-009 ("um evento de `escrow.released` que se perca
no NodeJS em memória causará perda de fundos"), refined through a second
external review (the project's CTO persona) that correctly flagged the
audit's specific recommendation — Redis Streams/BullMQ — as an
implementation choice that must not leak into the protocol specification.
Both points verified against the actual code before being accepted: the
event bus's non-durability was confirmed real (`event-bus.ts` used a bare
`EventEmitter`, in-memory only), and the "don't mandate Redis" critique
was confirmed consistent with the protocol's own existing Adapter
discipline (`SettlementProvider`, `EvidenceProvider`, `ArbitrationProvider`,
`TransportProvider` — none of which name a specific technology). Merged
into `PROTOCOL_SPECIFICATION.md`, `ARCHITECTURE.md`, `BACKLOG.md`, and the
event-bus code itself. No `DATABASE.md` change — this RFC adds no Prisma
model or column, unlike RFC-009.

## Summary

`common/events/event-bus.ts`'s `SailsEventBus` extended Node's built-in
`EventEmitter` directly — purely in-memory, no persistence, no
correlation id. A process crash between an event being emitted and its
handler completing loses that event permanently, which is a real risk for
a protocol whose events include `settlement.escrow.released` (fund
release) and `openp2p.trade.disputed`. This RFC introduces `EventStore`,
a new Adapter interface (same category as the existing four), requiring
every published event to be durable-capable and to carry a mandatory
`correlationId` end-to-end — through Timeline (RFC-008), logs, Events,
Proofs, Settlement, and Dispute, per both external reviews' explicit
request. The protocol requires durability and correlation; it does not
name Redis, BullMQ, or any other backend — that stays a Reference
Implementation choice, exactly as the CTO review insisted.

## Motivation

Two real findings, independently verified:

1. **No durability.** `event-bus.ts`'s `SailsEventBus extends EventEmitter`
   — confirmed by reading the file before accepting the audit's claim.
   Node's `EventEmitter` is purely in-process; nothing is written anywhere
   before a listener runs. `handlers.ts`'s `settlement.escrow.released`
   reaction updates `Trade.status` and increments `User.totalTrades`/
   `totalVolumeBtc` — if the process dies between `emit()` and that
   handler completing, the trade never settles in the read model and the
   volume increment never happens, with no record that anything was
   supposed to occur at all.
2. **No correlation id.** No event payload carried a consistent
   cross-cutting identifier. Debugging or auditing "everything that
   happened for trade X" required manually cross-referencing `tradeId`
   fields that happened to exist on some payloads and not others, with no
   single required field every event guarantees.

## Alternatives Considered

**Mandate Redis Streams or BullMQ at the protocol specification level**,
as the initial audit report suggested. Rejected — correctly flagged by
the CTO review: "O protocolo deve dizer apenas: 'Os eventos precisam ser
duráveis.' Não: 'Use Redis.' Redis é decisão da implementação." This is
not a new principle for this project — `SettlementProvider` (§1.5),
`EvidenceProvider` (RFC-007), `ArbitrationProvider` (RFC-007), and
`TransportProvider` (RFC-002) all already refuse to name a specific
technology at the protocol level for exactly this reason (Principle 6,
Infrastructure Neutral). Naming Redis here would have been the first
protocol-level exception to a rule the project has otherwise applied
consistently.

**Fold `correlationId` into every existing event payload interface**
(`OpenP2PTradeCreatedEvent`, `SettlementEscrowCreatedEvent`, etc.) as a
required field, instead of an envelope. Rejected — would require touching
roughly twenty payload interfaces across four RFCs' worth of established
event contracts for a concern (durability metadata) that is orthogonal to
what each event's payload actually describes. A `DurableEvent<K>` wrapper
carries `eventId`/`correlationId`/`publishedAt` around the existing,
unmodified payload — smaller diff, cleaner separation between "what
happened" (payload) and "how to trace it" (envelope).

**Require `correlationId` to literally always be `intentId`, including for
`peer.connected`/`peer.disconnected`.** Rejected — these are P2P transport
connectivity events (`infrastructure/p2p/pear.service.ts`) with no trade
or Intent to correlate to; forcing a synthetic id would be meaningless.
Decision below documents a per-event-family population rule instead of
one rigid field meaning for every event.

**Change `eventBus.on()`'s handler signature to receive the full
`DurableEvent` envelope**, not just the payload. Rejected for this pass —
none of the six existing handlers (`handlers.ts`) need `correlationId`
inside the handler body (they already have `payload.tradeId`); forcing
every handler to destructure `.payload` would touch call sites that don't
need to change for zero behavioral benefit. `correlationId` is captured
correctly in the durable record regardless of what the handler does with
it.

## Decision

### `EventStore` — new Adapter interface

```typescript
interface DurableEvent<K extends SailsEventName = SailsEventName> {
  eventId: string
  eventName: K
  correlationId: string
  payload: SailsEventMap[K]
  publishedAt: string
}

interface EventStore {
  readonly storeName: string
  readonly durable: boolean   // explicit — never inferred, so a non-durable
                                // store can't be mistaken for a durable one
  publish<K extends SailsEventName>(eventName: K, payload: SailsEventMap[K], correlationId: string): Promise<void>
  subscribe<K extends SailsEventName>(eventName: K, handler: (event: DurableEvent<K>) => void | Promise<void>): void
}
```

`SailsEventBus` (`event-bus.ts`) no longer extends `EventEmitter`
directly — it wraps an injected `EventStore` (`InMemoryEventStore` by
default) and delegates `emit()`/`on()` to it. `emit()` now requires a
third `correlationId: string` argument; `on()`'s handler signature is
**unchanged** — still receives the bare payload, per the alternative
above.

### correlationId population rule

- **Trade/negotiation/settlement-lifecycle events**
  (`openp2p.*`, `settlement.*`, `negotiation.*`, and future `claim.*`/
  `proof.*`/`verification.*`/`dispute.*`): `correlationId = tradeId`.
  This is a deliberate stand-in for `intentId` — Intent persistence isn't
  implemented yet (`PROTOCOL_SPECIFICATION.md` §2.6), and `Trade` already
  *is* the concrete implementation of `TradeIntent` (§2.3: "✅ implemented
  (as `Offer` today)" — extending to `Trade` for the executed form). Once
  Intent persistence ships, this becomes `intentId` for every Intent-scoped
  event without changing `DurableEvent.correlationId`'s name or type.
- **Peer/transport events** (`peer.connected`, `peer.disconnected`):
  `correlationId = userId` — the most specific trace identifier available
  when there is no trade to correlate to.

### `InMemoryEventStore` — the default, explicitly non-durable

Implemented and verified in this pass (`common/events/event-store.ts`):
wraps a private `EventEmitter`, generates `eventId`/`publishedAt`,
attaches `correlationId`. Functionally identical to the pre-RFC-010
behavior (events are still lost on a crash between publish and handler
completion) — `durable: false` says so explicitly, rather than letting
the class name alone carry that promise. This is what ships as the
default; nothing about existing behavior changes except that every event
now carries an id.

### `RedisStreamsEventStore` — designed, not shipped as working

A durable backend using Redis Streams (`XADD` to publish, a consumer
group + `XREADGROUP`/`XACK` to subscribe) is the natural next
implementation — `ioredis` is already a dependency
(`common/redis/index.ts`) and Streams give at-least-once delivery with
replay. This RFC does **not** ship a working implementation of it: no
live Redis instance was available to verify command sequences
(`XGROUP CREATE`, `XREADGROUP` argument order, consumer-group semantics)
against. `RedisStreamsEventStore` exists in `event-store.ts` implementing
the `EventStore` interface, but both methods throw `'not yet
implemented'` — the same pattern `escrow.service.ts`'s
`LightningHodlProvider`/`LiquidCovenantProvider` already use for
unverified providers, rather than shipping code that looks complete but
was never exercised.

**Historical correction (2026-09-10, Product Truth Sweep, F5).** The
reference to `LiquidCovenantProvider` above was already stale when
written and is preserved verbatim, not deleted. No file implementing a
`LiquidCovenantProvider` exists anywhere in this repository —
`LIQUID_COVENANT` is a reserved `EscrowType` value with zero
implementation (confirmed: no `*liquid*` file exists under
`src/modules/open-settlement/`; see `docs/DATABASE.md` and
`docs/BACKLOG.md` item 20). `LightningHodlProvider` is real and
testnet-evidenced (via the Ark/Arkade protocol, not plain Lightning);
`LiquidCovenantProvider` is not. Missing before this can be enabled for real:
`XCLAIM`-based recovery for a consumer that crashes mid-handler (a failed
handler today just leaves the message unacked, not yet redelivered by any
mechanism), and integration testing against a live Redis. See Reference
Implementation Plan.

## Primitives Used or Extended

No new primitive. `EventStore` is a new Adapter — same category as
`SettlementProvider`, `EvidenceProvider`, `ArbitrationProvider`,
`TransportProvider` — not a primitive; it has no participant-facing
lifecycle, it's infrastructure the Core's Event Bus component
(`ARCHITECTURE.md` §1B) is now built on. `correlationId` does not create
a new field on `Event` as a concept — `PROTOCOL_SPECIFICATION.md` §1.11
already established Event as "the mechanism by which state changes get
communicated," not a primitive itself; this RFC strengthens that
mechanism's contract (every event now durable-capable and correlated) 
without promoting it to anything more than it already was.

## Principle Alignment

- **Principle 6 (Infrastructure Neutral):** the entire point of this
  RFC — "events must be durable" is a protocol-level requirement, "how"
  (Redis Streams, BullMQ, a Postgres outbox table, ...) is never named at
  that level, correcting the one place the source audit's recommendation
  would have violated this principle.
- **Principle 1 (Protocol First):** `correlationId` is enforced at the
  `SailsEventBus`/`EventStore` interface level (Core), not left as a
  convention individual modules might or might not follow — every
  `emit()` call is a compile error without it.

## Specification

| Component | Change |
|---|---|
| `common/events/event-store.ts` (new file) | `DurableEvent`, `EventStore` interfaces; `InMemoryEventStore` (working, default); `RedisStreamsEventStore` (throws, not wired) |
| `common/events/event-bus.ts` | `SailsEventBus` no longer extends `EventEmitter`; wraps an injected `EventStore`. `emit()` requires `correlationId: string`. `once()`/`off()` removed (unused anywhere in the codebase, and semantically unclear once at-least-once/replay delivery is possible) |
| `escrow.service.ts`, `handlers.ts`, `negotiation.service.ts`, `pear.service.ts` | All 13 `eventBus.emit()` call sites updated with a `correlationId` argument (`tradeId` or `userId` per the rule above) |
| `ARCHITECTURE.md` §1B | Event Bus component description updated: durability now pluggable via `EventStore` |
| `PROTOCOL_SPECIFICATION.md` §1.11 | Event's "mechanism, not primitive" reasoning extended with the durability/correlationId requirement |

## Backward Compatibility

`protocolVersion` bump recommended. Zero live-data migration — this is a
code-shape/interface change, not a schema change; no new database columns.
Runtime behavior with the default `InMemoryEventStore` is unchanged from
before this RFC (still non-durable) — the only externally-visible change
is that `eventBus.emit()` now requires a third argument, a compile-time
break for any code calling it without one. Verified via `npm run build`
(zero errors after updating all 13 call sites) and two runtime smoke
tests: one exercising `publish()`/`subscribe()`/`on()` directly
(confirmed `on()` still receives the bare payload, confirmed the
`DurableEvent` envelope carries `eventId`/`correlationId`/`publishedAt`
correctly, confirmed `RedisStreamsEventStore` throws rather than silently
succeeding), and one booting the full `buildApp()` with
`registerEventHandlers()` wired in, no live DB/Redis required.

## Reference Implementation Plan

1. **Shipped in this pass:** `EventStore` interface, `InMemoryEventStore`
   (working, default), `correlationId` on all 13 existing `emit()` sites.
2. **Implemented for real, 2026-08-04** (`common/events/event-store.ts`,
   verified against a live Redis, not just written): `publish()` does a
   **dual XADD** — `sails:events:{eventName}` (consumer-group fan-out,
   matching this plan's original design) AND
   `sails:events:by-correlation:{correlationId}` (the real index
   `getEvents(correlationId)` needs — this plan had explicitly left that
   query shape "undecided," and a single per-eventName stream cannot
   answer it without scanning every stream). `subscribe()` runs a real
   `XGROUP CREATE ... $ MKSTREAM` (tolerating `BUSYGROUP`) plus an
   `XREADGROUP GROUP ... BLOCK 5000` poll loop, `XACK`-ing on success.
   **`$`, not `0`** — found the hard way in the first real integration-test
   run: a fresh consumer group starting at `0` replays a stream's entire
   historical backlog (including unrelated earlier runs against the same
   long-lived Redis instance), which is `getEvents()`'s job, not
   `subscribe()`'s — `InMemoryEventStore.subscribe()`'s real semantics
   (`EventEmitter.on()`, future events only) is the actual contract to
   match. `XCLAIM`-based recovery (this plan's other named gap) is closed
   too: before each blocking read, `XPENDING`/`XCLAIM` reclaims anything
   idle past 30s from any consumer (including a crashed one) onto the
   live one. RFC-008 D2's hash chain is computed here as well — see that
   RFC's own updated D2 section for why it lives on `DurableEvent`, not
   `EscrowEvent`/`ReputationEvent`. 5 new integration tests
   (`tests/integration/redisStreamsEventStore.test.ts`) against this
   repo's own docker-compose Redis — publish/getEvents round-trip, hash
   chaining, empty-correlationId handling, real consumer-group delivery,
   and a real handler-throws-then-gets-reclaimed-and-redelivered
   scenario, observed actually retrying against live Redis, not asserted
   from mocks. One disclosed remaining gap: `subscribe()` must stay
   synchronous (matching the `EventStore` interface), but `XGROUP CREATE`
   is inherently async — a `publish()` landing in that brief window could
   be missed by that specific subscription; real production use
   (subscribing once at startup, before publishing begins) makes this
   practically unreachable, but it is a real property `InMemoryEventStore`
   does not share (`EventEmitter.on()` registers synchronously).
3. Once Intent persistence ships (`PROTOCOL_SPECIFICATION.md` §2.6),
   `correlationId`'s population rule changes from `tradeId` to `intentId`
   for every Intent-scoped event family — no interface change required,
   only the value each call site passes.

## Amendment — 2026-10-26: processing guarantees (dated; text above preserved)

This RFC requires durability and a mandatory `correlationId`. It does not by itself guarantee that a durable event is processed, processed once, or processed in order. The default store is `PostgresEventStore` (since Missão 05.7): it persists the event and then emits to in-process subscribers, with no consumer checkpoint and no redelivery, so a handler failure or a crash between persistence and handler leaves the event durable but its effects possibly missing. `InMemoryEventStore` is a non-durable option for tests and is not the default (the Specification and Backward Compatibility sections above describe it as the default for historical reasons). Every handler of an economically relevant event is therefore required to satisfy four properties:

1. **Effect-level idempotency under a canonical economic identity.** The key of an economic effect is the canonical identity of the economic fact it records — for example the escrow, its terminal state or dispute/ruling generation, the projection name and the subject (participant) — not the `eventId`, because distinct events can represent the same economic conclusion. Persistence of the effect and of its key is transactional, and database uniqueness backs the key.
2. **Independence from arrival order.** An older or delayed event must never overwrite a newer economic state; conditional, state-aware writes replace unconditional ones.
3. **Crash convergence.** A persisted economic event must lead every required projection to converge exactly once or idempotently across crash and restart; a reconciler re-drives missing effects, and presence of the event record is not evidence that all downstream effects ran.
4. **Replay safety.** A replay or redelivery has no additional effect.

Owners: Issues #236 (audit of all handlers, ordering) and #253 (crash consistency and reconciliation), with #252, #245, #254 and #341 where they apply. The known-gap test that documents double counting of a duplicated `settlement.escrow.released` is to become a passing contract test once the property holds. Evidence required: duplication, reordering, replay and crash/restart tests against a real PostgreSQL. `RedisStreamsEventStore` remains off for production until these guarantees are closed and the Redis Gate 2 is independently homologated. This amendment states requirements; it does not state that any of them is implemented or homologated.
