# RFC-004: Negotiation State Machine — Events Are the Abstraction, Channel Is the Implementation

## Summary

Formalizes the `Negotiation` primitive fix already made during Protocol
Freeze: `NegotiationEvent` (a typed state transition) is the actual
abstraction, and `NegotiationChannel` is a pluggable transport for those
events. Chat is one channel implementation, not the definition of
negotiation.

## Motivation

The original `NegotiationChannel` interface — `send(message: Message)`,
`onMessage(handler)` — modeled negotiation as chat. That works today
(human ↔ human, exactly how Bisq and HodlHodl operate) but silently
assumed a human-readable message on both ends, which doesn't hold for
agent ↔ agent negotiation — a scenario `LONG_TERM_VISION.md` already
describes as a plausible mid-term future. This was flagged directly in
the Protocol Quality Review as a 10-year relevance risk.

## Alternatives Considered

1. **Replace chat with a JSON-only, AI-native negotiation model.**
   Rejected — this was explicitly the wrong framing. The problem was never
   that chat exists (it's the correct, primary mode for human ↔ human
   negotiation today); the problem was modeling chat *as* the primitive.
   Replacing it with an AI-native model would repeat the same mistake in
   the opposite direction.
2. **Mandate a formal 4-layer split (Negotiation → Events → Transport →
   Presentation) as separate protocol-level interfaces.** Considered.
   Rejected as over-specified: the protocol only needs to guarantee that
   every channel carries structured `NegotiationEvent`s. Whether a
   concrete channel internally separates "how bytes move" from "how
   events are rendered" is a quality-of-implementation choice for whoever
   builds that channel, not a contract the Core needs to enforce with two
   more formal interfaces.
3. **`NegotiationEvent` as the abstraction, `NegotiationChannel` as a
   pluggable transport for it.** **Accepted.**

## Decision

```typescript
type NegotiationEvent =
  | { type: 'OFFER_PROPOSED';    by: string; terms: ProposedTerms; at: Timestamp }
  | { type: 'COUNTER_OFFERED';   by: string; terms: ProposedTerms; at: Timestamp }
  | { type: 'TERMS_ACCEPTED';    by: string; at: Timestamp }
  | { type: 'TERMS_REJECTED';    by: string; reason?: string; at: Timestamp }
  | { type: 'MESSAGE_EXCHANGED'; by: string; content: unknown; at: Timestamp }

interface NegotiationChannel {
  sendEvent(event: NegotiationEvent): Promise<void>
  onEvent(handler: (event: NegotiationEvent) => void): void
}
```

**Amendment (v8.7):** `Negotiation.status` was refined from `'OPEN' |
'AGREED' | 'ABANDONED'` to `'CREATED' | 'NEGOTIATING' | 'TERMS_AGREED' |
'ABANDONED'` — the original three states were too coarse for third-party
implementers to build against unambiguously. A further extension into
`AwaitingSettlement`/`Settled`/`Completed` was proposed and **rejected**:
those states describe what happens after negotiation, not negotiation
itself, and already exist in the Settlement primitive's `EscrowStatus`
(§1.5) and the Intent Engine's generic lifecycle (§2.4) — reconciled in
§3.1. Adding them here would have reintroduced the exact two-primitives-
describing-one-moment ambiguity §3.1 was written to eliminate.

Two valid implementations of the identical primitive, neither requiring a
Core change: `HumanChatChannel` (today, renders events as a chat UI,
`MESSAGE_EXCHANGED` carries free text) and a future `StructuredChannel`
(agent ↔ agent, JSON only, no human-readable rendering, human only
approves via `AgentScope.requiresApprovalAbove`).

## Primitives Used or Extended

**Negotiation** (§1.4) — revised, not replaced. No new primitive; this
RFC formalizes a correction to an existing one, following the same
discipline as RFC-001 and RFC-003.

## Principle Alignment

- **Principle 9 (Interface Agnostic):** this fix is the concrete example
  the principle itself cites in `PRINCIPLES.md`.
- **Principle 4 (Fiat Off-Protocol):** unaffected — `MESSAGE_EXCHANGED`
  still carries payment-proof exchange for human channels exactly as
  before; only the surrounding structure changed.

## Specification

See `PROTOCOL_SPECIFICATION.md` §1.4 for the full interface and the two
worked implementation examples.

## Backward Compatibility

`protocolVersion` bump recommended for any persisted `Negotiation` record
shape, since `events: NegotiationEvent[]` is a new required field not
present in the pre-RFC interface. No reference implementation has shipped
this yet (Sails OpenP2P's chat module is listed as missing in `TODO.md`
section 1), so no live migration is required — this is a pre-build
correction.

## Current reference implementation boundary

`negotiation.service.ts` implements `HumanChatChannel`. Inbound Pears
messages are filtered by negotiation kind, trade ID and the connected
peer ID associated with the expected counterparty. Persistence attributes
`senderId` to that counterparty rather than trusting the event's `by`
field; this does not authenticate every embedded event field or timestamp.
The WebSocket chat route separately checks trade participation on join
and send and attributes messages to the ticket-authenticated participant.

Inbound wiring avoids duplicate listeners per PearNode instance and trade,
and suppresses the inbound copy when the counterparty has a node in the
same registry. These are process-local duplicate-suppression mechanisms,
not durable message replay protection or cross-operator exactly-once
delivery. Persisted message IDs identify local rows, not a shared signed
wire-event identity. Negotiation messages alone do not authorize economic
commitment or settlement. Independent cross-operator delivery and
convergence require separate Day-0 evidence (ADR-001 / Issue #105).

## Reference Implementation Plan (historical)

Sails OpenP2P's chat/negotiation module (`TODO.md` §1, not yet built)
implements `HumanChatChannel` directly against this corrected interface —
it is never built against the old `send(message)` shape.
