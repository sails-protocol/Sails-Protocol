# RFC-011: P2P Reconciliation on Peer Reconnect

**Status:** Accepted. Third and final finding from the same external
CISO/Chief Architect audit that produced RFC-009 (Float precision) and
RFC-010 (durable Event Store): "Ataques de 'Eclipse' ou instabilidade de
rede podem fazer com que um nó execute um `TradeIntent` no Postgres,
enquanto a outra ponta nunca recebeu a mensagem no Secretstream." Verified
against the actual code before being treated as fact — confirmed real,
and confirmed that the fix does not require peer-to-peer replay logic, a
smaller and more tractable problem than initially framed once the actual
architecture (centralized Postgres as the authoritative source, HyperDHT/
Pears as a real-time notification layer on top of it) was accounted for.
Merged into `ARCHITECTURE.md` and `BACKLOG.md`.

## Summary

`negotiation.service.ts`'s `HumanChatChannel.sendEvent()` already
persists every negotiation message to Postgres's `Message` table
regardless of whether the HyperDHT/Pears send actually reached the
counterparty (its own comment: "a failed send is persisted for
redelivery — not silently dropped"). What was missing was the
redelivery itself — nothing re-synced a client once the P2P connection
that dropped a message came back. This RFC adds that: `pear.service.ts`'s
`peer.connected` event, when it represents a real two-party handshake,
now triggers a `ReconciliationService` that reads current `Trade`/
`Escrow`/`Message` state from Postgres — the same authoritative source
both counterparties' clients already depend on via the HTTP API — for
every trade the two reconnecting peers share, and emits
`negotiation.reconciled` with what changed.

## Current implementation boundary

The reference reconciliation service reads Trade, Escrow and Message
state from its available PostgreSQL database. Its message query returns
at most 100 rows ordered by creation time ascending; the optional
creation-time cursor is not a complete paginated replay protocol.
This is local trade-state catch-up, not peer-to-peer replication of
independent databases or a guarantee of complete message delivery.

Portable signed offer revision selection and cancellation are separate
from RFC-011. DHT topic announcements and generic broadcast primitives
do not by themselves establish signed-offer propagation, offline
revision/tombstone delivery, late-join anti-entropy, partition healing
or stale-resurrection prevention after compaction. These remain separate
evidence requirements under ADR-001 §26.1 and Issue #105. Do not infer
shared-market convergence from the existence of local reconciliation.

## Motivation

The audit's scenario, concretely: buyer marks payment sent (an HTTP call
that writes `Escrow.status = PAYMENT_PENDING` to Postgres and, via
`HumanChatChannel.sendEvent()`, attempts to notify the seller over
HyperDHT). If the seller's P2P connection is down at that moment
(network instability, an eclipse attack isolating them from the buyer's
peer, or just the seller's app being closed), the HyperDHT send fails —
`delivered: false` — while the `Message` row and the `Escrow.status`
change both land in Postgres regardless. Today, when the seller's client
reconnects, nothing tells it "you missed something" — it only receives
*new* messages from that point forward (`node.on('message', ...)` in
`HumanChatChannel.onEvent()`), never a catch-up of what happened while it
was gone.

**A related but explicitly separate finding, surfaced while investigating
this:** `NegotiationService`'s status tracking (`CREATED`/`NEGOTIATING`/
`TERMS_AGREED`/`ABANDONED`) is an in-memory `Map<string, NegotiationStatus>`
— not persisted anywhere, lost on every server restart, independent of
this RFC's fix (which reconciles `Trade`/`Escrow`/`Message`, all real
Postgres tables). Not fixed here — flagged in Principle Alignment below
rather than folded into this RFC's scope, since it's a different kind of
state (server-process-local negotiation-phase tracking, not
peer-to-peer message delivery) with a different fix shape.

## Alternatives Considered

**Peer-to-peer replay: each side asks the other "what did I miss?" over
HyperDHT directly, comparing local message logs.** Rejected — this is the
right design *if* each peer held their own independent local database
with no shared source of truth (a fully decentralized model). That is not
this architecture: `app.ts` boots one shared Fastify/Postgres backend
both trade counterparties' clients already call (`API_REFERENCE.md`'s
`GET /v1/openp2p/chat/:tradeId/messages`, etc.) — Postgres already has
the complete, ordered history, since every `sendEvent()` persists there
first regardless of P2P delivery. Reconciling against the shared
authoritative source is simpler, doesn't require new P2P protocol
messages, and doesn't create a second "who's actually right" question
between two peers' independently-replayed logs.

**Build reconciliation on top of Timeline (RFC-008 D5) from the start,
comparing `entryHash` chain tips.** Rejected for this pass — Timeline's
read-model isn't implemented in code yet (`BACKLOG.md`: 🔲 Not started).
Building it as a prerequisite would have blocked this fix on unrelated,
larger, unbuilt infrastructure. This RFC reconciles directly against
`Trade`/`Escrow`/`Message` — the same tables Timeline would eventually
project over — and notes explicitly in Reference Implementation Plan that
switching to Timeline-based reconciliation once it exists is a natural
upgrade, not a redesign.

**Trigger reconciliation on every `peer.connected`, including a user's
own node starting up (no counterparty yet).** Rejected — that event
carries no remote peer to reconcile against; running a no-op reconcile
pass for every node start wastes a Postgres round-trip for nothing.
Decision below distinguishes the two `peer.connected` emission sites.

## Decision

**`PeerConnectedEvent` gains `localUserId?: string`** (`event-bus.ts`),
set only at the real two-party-handshake emission site
(`pear.service.ts`'s `handleNewConnection`, on receiving `HANDSHAKE`) —
left unset at the self-node-start site, since that has no counterparty.
This is what lets a global `handlers.ts` reaction know *both* sides of a
reconnection, needed to look up trades between that specific pair.

```typescript
export interface PeerConnectedEvent {
  userId: string
  peerId: string
  publicKey: string
  localUserId?: string   // RFC-011 — set only for a real two-party handshake
}
```

**`ReconciliationService`** (new file,
`modules/open-p2p/reconciliation.service.ts`):

```typescript
export interface ReconciliationResult {
  tradeId: string
  currentTradeStatus: string
  currentEscrowStatus: string | null
  missedMessages: Array<{ id: string; senderId: string; content: string; msgType: string; createdAt: Date }>
}

export class ReconciliationService {
  async reconcileTrade(tradeId: string, sinceMessageCreatedAt?: Date | null): Promise<ReconciliationResult>
  async reconcilePeerPair(localUserId: string, remoteUserId: string): Promise<ReconciliationResult[]>
}
```

`reconcilePeerPair` finds every `Trade` with `status IN ('PENDING',
'ACTIVE')` between the two reconnecting users (either direction —
buyer/seller) and reconciles each. `reconcileTrade`'s `sinceMessageCreatedAt`
parameter is unused by the automatic trigger below (the server doesn't
know what a given client already cached) but exists for a future HTTP
endpoint (`POST /v1/openp2p/trades/:id/reconcile`) where the client
supplies its own last-seen cursor and gets back the true delta instead of
full recent history.

**Wired in `handlers.ts`** — a new `peer.connected` reaction, guarded on
`localUserId` being present:

```typescript
eventBus.on('peer.connected', async (payload) => {
  if (!payload.localUserId) return
  const results = await reconciliationService.reconcilePeerPair(payload.localUserId, payload.userId)
  for (const result of results) {
    await eventBus.emit('negotiation.reconciled', {
      tradeId: result.tradeId,
      currentTradeStatus: result.currentTradeStatus,
      currentEscrowStatus: result.currentEscrowStatus,
      missedMessageCount: result.missedMessages.length,
    }, result.tradeId)   // correlationId (RFC-010)
  }
})
```

`negotiation.reconciled` (new event, `NegotiationReconciledEvent`) is
what a client-facing layer would subscribe to once one exists — today it
mainly makes the reconciliation observable in logs/telemetry via its
`correlationId`.

## Primitives Used or Extended

No new primitive. Extends the Negotiation primitive's event surface
(`PROTOCOL_SPECIFICATION.md` §1.4) with one new event
(`negotiation.reconciled`) — per `GOVERNANCE.md` §3, "a new event within
an existing module's namespace" needs no RFC on its own, documented here
only because it's part of this RFC's larger change. `ReconciliationService`
is a module-level service (OpenP2P), not a Core component or Adapter —
unlike RFC-010's `EventStore`, there's no pluggable backend here to
abstract; it reads the one Postgres schema this Reference Implementation
already has.

## Principle Alignment

- **Principle 1 (Protocol First):** the fix works because Postgres was
  already the authoritative source before this RFC — this RFC adds the
  missing *reaction* to reconnection, not a new source of truth.
- **Principle 6 (Infrastructure Neutral):** deliberately does not touch
  `TransportProvider` (RFC-002) or invent a P2P-level reconciliation
  protocol — reconciliation happens against the module's own Postgres
  read, the same access pattern the HTTP API already uses, so it works
  regardless of which `TransportProvider` implementation is active.
- **Risk flagged, not resolved by this RFC:** `NegotiationService`'s
  in-memory `NegotiationStatus` map (Motivation, above) has the same
  "lost on restart/disconnect" shape this RFC just fixed for
  `Trade`/`Escrow`/`Message`, but isn't covered by `reconcilePeerPair`
  because it isn't in Postgres at all. Whether that status needs to move
  into persisted state (and if so, whether it's a `Trade`-column addition
  or its own table) is a separate design question — flagged here rather
  than silently left as if this RFC covers all reconnection-sensitive
  state in the negotiation path.

## Specification

| Component | Change |
|---|---|
| `event-bus.ts` | `PeerConnectedEvent` gains `localUserId?: string`; new `NegotiationReconciledEvent` + `'negotiation.reconciled'` map entry |
| `pear.service.ts` | `handleNewConnection`'s `HANDSHAKE` branch now emits `localUserId: this.ownerUserId` alongside the existing `peer.connected` fields |
| `modules/open-p2p/reconciliation.service.ts` (new file) | `ReconciliationService`: `reconcileTrade()`, `reconcilePeerPair()` |
| `handlers.ts` | New `eventBus.on('peer.connected', ...)` reaction, guarded on `localUserId`, calls `reconciliationService.reconcilePeerPair()` and emits `negotiation.reconciled` per trade |

## Backward Compatibility

`protocolVersion` bump recommended, consistent with RFC-009/010. Zero
schema changes — reads existing `Trade`/`Escrow`/`Message` columns only.
Zero live blast radius on existing behavior: the self-node-start
`peer.connected` emission is unchanged (still no `localUserId`, still a
no-op for this new reaction); only the real-handshake emission site
gained one additional field and one new downstream reaction. Verified
with `npm run build` (zero errors) and a runtime test exercising the full
path — `buildApp()` with `registerEventHandlers()`, a real `peer.connected`
event with `localUserId` set, no live Postgres available: confirmed the
handler runs, confirmed `reconcilePeerPair()` reaches
`prisma.trade.findMany()` and fails against the unreachable database
exactly as expected, confirmed that failure is caught and logged by
`InMemoryEventStore`'s existing handler-error path (RFC-010) rather than
crashing the process — the same graceful-degradation behavior RFC-009's
`LiquidityRouter` test already established for this codebase.

## Reference Implementation Plan

Shipped and verified in this pass, against no live Postgres (structural
correctness confirmed; actual query results unverified against real data
— same limitation RFC-009's migration and RFC-010's `RedisStreamsEventStore`
already disclosed for this environment). Natural next steps, tracked in
`BACKLOG.md`:

1. Wire `reconcileTrade()`'s `sinceMessageCreatedAt` parameter to a real
   HTTP endpoint once trade/chat routes are restored (`app.ts`'s own
   comments confirm they aren't wired up yet), so a client can request a
   precise delta instead of the automatic trigger's full recent history.
2. (**Corrected/Implemented 2026-11-27:** Timeline has since shipped, RFC-017, `core/timeline.ts`; whether `reconcileTrade()` was switched to compare `entryHash` chain tips is not established here, and this item is historical.) Once Timeline (RFC-008 D5) ships, switch `reconcileTrade()` to compare
   `entryHash` chain tips instead of `Message.createdAt` — same
   `ReconciliationService` interface, different internal query.
3. Decide, separately, whether `NegotiationService`'s in-memory status
   needs to persist (Principle Alignment, above) — out of scope here.
