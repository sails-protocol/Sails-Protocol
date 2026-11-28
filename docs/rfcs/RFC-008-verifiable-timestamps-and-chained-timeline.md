# RFC-008: Verifiable Timestamps and a Hash-Chained Timeline

**Status:** Accepted. Provenance, stated plainly rather than implied:
this RFC did not originate from a CTO directive the way RFC-007 did — it
originated from a design critique raised during RFC-007's own review
(the Nostr-inspired `EvidenceProvider`/`Timeline` pattern is well-suited
to social content but under-specifies non-repudiation and tamper-evidence
for a financial protocol), drafted, then explicitly authorized for
acceptance and merge by the repository owner after a second technical
review pass tightened the hash-chain persistence mechanics (see D2 below).
Recorded this way, rather than borrowing RFC-007's "CTO directive"
framing, so the RFC's own history stays accurate. This RFC amends two
constructs RFC-007 introduced (`EvidenceReference`, decision D2;
`TimelineEntry`, decision D5) — it does not reopen or re-litigate
RFC-007's other seven decisions, which stay as accepted. Merged into
`PROTOCOL_SPECIFICATION.md`, `ARCHITECTURE.md`, `DATABASE.md`, and
`BACKLOG.md` as of this acceptance.

## Summary

RFC-007's `EvidenceProvider` interface was explicitly modeled on Nostr's
pointer-and-hash pattern (protocol never stores media, only a signed
reference). That pattern is a strong fit for a coordination protocol — but
Sails is a *financial* protocol, where evidence backs real money moving in
a dispute, and two gaps that are acceptable for social content are not
acceptable here: (1) `EvidenceReference.timestamp` is self-declared by the
submitting participant's own signature, which proves *assertion*, not
*existence-at-a-time* — nothing stops backdating; (2) RFC-007's `Timeline`
(D5) is a flat, unlinked read-projection over each module's event tables —
structurally identical to a stream of Nostr events, meaning an entry can
be silently inserted, reordered, or deleted by anyone with write access to
the underlying tables, with no way to detect it after the fact. This RFC
proposes closing both gaps: a new `TimestampAnchor` adapter interface for
provable, third-party-anchored timestamps, and hash-chaining
`TimelineEntry` so the Timeline becomes tamper-evident, the same technique
append-only logs (Certificate Transparency, Secure Scuttlebutt) use
without requiring a blockchain or any new consensus mechanism.

## Motivation

Two concrete failure modes, both direct consequences of following the
Nostr model as-is rather than adapting it to a financial context:

1. **Backdatable evidence.** `EvidenceReference.signature` (RFC-007 D2)
   proves the submitting Participant's key signed a claimed `timestamp` —
   it does not prove the evidence existed at that time. A participant
   preparing fraudulent evidence for a dispute can sign any timestamp they
   want; nothing independent checks it. This matters specifically because
   Settlement outcomes and Reputation scores (RFC-007 D8) now hang on
   dispute evidence being trustworthy, not just present.
2. **Rewritable history.** `Timeline.getEvents()` (RFC-007 D5) returns
   rows from each module's own audit tables (`EscrowEvent`,
   `ReputationEvent`, a future `DisputeEvent`) with no cryptographic link
   between them. An operator with database access — or an attacker who
   gains it — can delete or reorder an inconvenient entry (e.g. a
   `PaymentInstructionChanged` event the Social Engineering Agent, RFC-007
   D7, would otherwise have flagged) and no part of the system would
   notice. A Timeline that can be quietly edited after the fact is a weak
   foundation for the Evidence Bundle (RFC-007 D6) that disputes and
   `ArbitrationProvider`s (RFC-007 D4) are built on.

Both gaps exist precisely because Nostr's trust model is calibrated for
public social content, where "who said what, self-timestamped" is
sufficient. A financial protocol coordinating real settlement needs the
stronger guarantee: evidence and history that cannot be forged or edited
without detection.

## Alternatives Considered

**Anchor every `EvidenceReference` on a blockchain, always.** Rejected —
cost and latency make this impractical for high-volume, low-value P2P
trades (`PRINCIPLES.md` principle 6, Infrastructure Neutral, and the
existing precedent that `SettlementProvider` itself is pluggable/tiered
by cost, `MOCK → MULTISIG → LIGHTNING_HODL → LIQUID_COVENANT`). Accepted
alternative: policy-gated, opt-in per application/dispute-value threshold,
the same pattern RFC-007 D8 already established for
`trustedSettlementAcceleration`.

**Historical correction (2026-09-10, Product Truth Sweep, F5).** The
cost-tiered ladder above is preserved verbatim as illustrative of the
*design pattern* (pluggable, cost-tiered providers), not as a claim that
every named rung is implemented. `LIQUID_COVENANT` is a reserved
`EscrowType` value with zero implementation file in this repository — no
`LiquidCovenantProvider` exists (see `docs/BACKLOG.md` item 20). `MOCK`,
`MULTISIG`, and `LIGHTNING_HODL` are real; `LIQUID_COVENANT` is not, as
of this date.

**A single global Merkle tree over all evidence in the system, one root
for everyone.** Rejected — couples unrelated Intents into one growing
structure, is a scalability bottleneck (verification requires a proof
against an ever-growing global root), and leaks structure about total
system activity across participants who have no relationship to each
other, in tension with Principle 8 (Privacy Preserving). Accepted
alternative: a hash chain scoped to one `intentId` at a time — mirrors how
RFC-007 D5 already scoped `Timeline` per-Intent, not globally.

**Trust the `EvidenceProvider`'s own storage metadata (e.g. an S3 object's
upload timestamp) instead of a dedicated anchor.** Rejected — the
`EvidenceProvider` is chosen and configured by the submitting party's own
Reference Implementation (RFC-007 D2: "each Reference Implementation
chooses its own `EvidenceProvider`"), so its metadata sits inside the same
trust boundary as the participant submitting evidence — it doesn't add
independent assurance, it just relocates the same self-reported claim.

**Require `TimestampAnchor` for every `EvidenceReference`, unconditionally.**
Rejected for the same cost/latency reason as blockchain-always above —
made policy-gated instead.

## Decision

### D1 — `TimestampAnchor`: a new Adapter interface

**Implemented 2026-08-04** (`src/modules/open-proof/timestamp-anchor.ts`),
real `anchor()` verified against a live public OpenTimestamps calendar
server before writing the file — `POST .../digest` with a raw 32-byte
digest, real 200 response with a real binary proof, confirmed directly,
not assumed from documentation. Uses plain `fetch()` rather than the
`opentimestamps`/`javascript-opentimestamps` npm packages: both depend on
long-deprecated, vulnerable `request`/`request-promise` for the exact one
HTTP call this needs — the calendar wire protocol itself is simple and
stable enough not to need a client library. Real, disclosed gap:
`verify()` (this section calls it that; the shipped interface calls it
`upgrade()`) throws a specific "not implemented" error rather than faking
a result — confirming a pending proof against a real Bitcoin block needs
a real OTS binary-format parser (walking the proof's Merkle path), which
this codebase does not have. `anchor()` itself is fully real, not a stub.
`AnchorProof.upgraded` (`false`, always, for now) is this implementation's
stand-in for this section's `anchoredAt?` — set once/if `upgrade()` is
ever built.

Same category as `SettlementProvider`, `TransportProvider`,
`EvidenceProvider`, and `ArbitrationProvider` — a new Adapter, which is
why this needs an RFC rather than shipping as a silent implementation
detail (`GOVERNANCE.md` §3).

```typescript
interface TimestampAnchor {
  anchorName: string                       // 'opentimestamps' | 'rfc3161' | ...
  anchor(hash: string): Promise<AnchorProof>
  verify(proof: AnchorProof): Promise<{ verified: boolean; notAfter: Timestamp }>
}
interface AnchorProof {
  hash: string             // the sha256 being anchored
  anchorType: 'opentimestamps' | 'rfc3161' | string   // open, like Proof.claimType (§1.8)
  anchorData: unknown       // opaque — an .ots file, a TSA token, etc.
  anchoredAt?: Timestamp    // set once confirmed (e.g. OpenTimestamps' Bitcoin confirmation)
}
```

`EvidenceReference` (RFC-007 D2) gains one optional field — additive, does
not change its existing shape or break anything already specified:

```typescript
interface EvidenceReference {
  proofId: string
  provider: string
  uri: string
  sha256: string
  mimeType: 'image' | 'video' | 'document' | 'ocr' | 'external_reference'
  timestamp: Timestamp      // unchanged — self-declared, cheap, always present
  signature: string         // unchanged
  anchorProof?: AnchorProof  // new (RFC-008 D1) — present only when Policy requires it
}
```

Policy-gated, not mandatory: the Policy Engine decides when an anchor is
required (e.g. dispute value above a threshold, or specific `claimType`s
per `Proof`, §1.8) — the same division of labor RFC-007 D8/D10 already
established between what Core enforces and what Policy configures.
Without a required anchor, evidence behaves exactly as RFC-007 specified;
`TimestampAnchor` raises the assurance level, it doesn't replace the
existing path.

### D2 — Hash-chained `TimelineEntry`

**Implemented 2026-08-04 — real architectural correction to where the
hash chain actually lives.** This section, as originally written below,
targeted `entryHash`/`prevHash` columns on `EscrowEvent`/`ReputationEvent`
directly (see the Specification table's still-unedited historical
wording). That premise was already stale by the time this was built:
RFC-017 (`core/timeline.ts`) had already corrected `Timeline` itself to
be a projection over `EventStore.getEvents(correlationId)` — the Event
Bus's own `DurableEvent` stream (RFC-010) — rather than reading
`EscrowEvent`/`ReputationEvent` directly, precisely because trade-lifecycle
events correlate by `tradeId` today, not `intentId`, and live across
several modules' event types, not just those two tables. Chaining tables
Timeline no longer reads from would make `verifyChain()` check history
nobody actually consults. The real implementation instead adds
`entryHash`/`prevHash` to `DurableEvent` itself
(`common/events/event-store.ts`), computed by `EventStore.publish()` at
write time (`InMemoryEventStore` at the time of writing, `PostgresEventStore` by default now (Corrected/Implemented 2026-11-27); `RedisStreamsEventStore` inherits
the same obligation once built) — `EscrowEvent`/`ReputationEvent` are
unchanged, no migration needed (**this specific claim corrected below,
2026-08-15 — it traded away durability+tamper-evidence together without
saying so at the time**). `Timeline.verifyChain()` does two
independent checks per entry: `prevHash` matches the running chain
(catches reordering/insertion/deletion) AND recomputing `entryHash` from
the entry's own stored fields matches what was stored (catches a single
entry mutated in place with its hash left untouched) — see
`core/timeline.ts`'s own comments. 9 new tests
(`tests/timeline.test.ts`), including two that tamper with the real
shared `InMemoryEventStore` directly (mutating a payload in place;
deleting a middle entry) and confirm `verifyChain()` catches both.

`Timeline` (RFC-007 D5) stays a Core-level, per-`intentId` read
projection — this does not reopen that decision. What changes is that
each `TimelineEntry`, at write time, includes a hash of itself and a
reference to the previous entry's hash for the same `intentId`:

```typescript
interface TimelineEntry {
  eventType: string
  occurredAt: Timestamp
  payload: unknown
  entryHash: string     // sha256(eventType + occurredAt + payload + prevHash)
  prevHash: string       // previous TimelineEntry's entryHash for this intentId; 'genesis' for the first
}
interface Timeline {
  intentId: string
  getEvents(): Promise<TimelineEntry[]>
  verifyChain(): Promise<{ valid: boolean; brokenAtIndex?: number }>
}
```

**A precision that matters for this to actually work:** `entryHash`/
`prevHash` must be computed and persisted at the moment each underlying
event is first written, never derived later at read-time. `Timeline` is a
projection over each module's own audit tables (`EscrowEvent` and
`ReputationEvent` today, per `DATABASE.md`; a future `DisputeEvent`) — if
the hash were computed on the fly whenever `getEvents()` runs, tampering
with an underlying row would simply produce a different, still
internally-consistent hash on the next read, defeating the entire point.
Concretely, this means each of those per-module event tables gains two
columns (`entryHash`, `prevHash`), written once by the same code path
that already writes `EscrowEvent`/`ReputationEvent` today — not a new
table, but not free of schema changes either, which is a slightly
stronger claim than RFC-007 D5's original "no new write path."
`Timeline.getEvents()` reads the already-computed hashes; it does not
compute them, and neither should any other caller.

`verifyChain()` walks the chain and fails at the first broken link,
telling a Dispute UI or `ArbitrationProvider` exactly where tampering (an
inserted, reordered, or deleted entry) occurred, rather than a bare
yes/no. This is a hash chain, not a blockchain — no consensus, no new
network dependency, the same technique Certificate Transparency logs and
Secure Scuttlebutt use for tamper-evident, append-only history.

**Where D1 and D2 connect:** periodically anchoring the Timeline's
*current tip hash* (not every entry) via `TimestampAnchor` — e.g. on
`DisputeOpened` or `SettlementCompleted` — means even an attacker with
full database access cannot rewrite history from before that anchor point
without the rewrite being detectable against the anchored hash. This is
the natural point where D1's external assurance and D2's internal
tamper-evidence reinforce each other; it is not a new mechanism, just
applying D1 to D2's chain tip instead of to a single `EvidenceReference`.

### D2 amendment — EscrowEvent gets its own chain too (Missão 05.5, 2026-08-15)

**The gap, found by direct audit, not assumed:** D2's real implementation
(above) correctly chains `DurableEvent` because that's what `Timeline`
actually reads — but the 2026-08-04 note's "`EscrowEvent`/
`ReputationEvent` are unchanged, no migration needed" traded away a
property D2's own motivation explicitly cares about, without saying so at
the time. `EscrowEvent` is the durable (Postgres) record of every real
fund-movement transition — who locked, who released, who refunded, who
disputed — and it had no tamper-evidence at all: an operator or attacker
with database write access could edit or delete a row with nothing
detecting it. Meanwhile the chained `DurableEvent` stream lives in
`InMemoryEventStore` by default at the time (**Corrected/Implemented 2026-11-27:** the default is now `PostgresEventStore`, which is durable; `InMemoryEventStore` remains for tests), which is explicitly non-durable — gone
on restart. Neither store alone gave settlement's own audit trail both
properties D2 exists to guarantee together.

**Decision:** `EscrowEvent` gains its own `entryHash`/`prevHash`,
independent of `DurableEvent`'s chain — not a second copy of the same
chain, a second chain scoped to a different, already-existing table that
needed the same property. Same composition IntentEvent already
established for the identical situation (`IntentEvent` already has both
durability and this exact chain — this amendment brings `EscrowEvent` to
parity with it, not a new pattern): `entryHash =
sha256(fromStatus|toStatus|triggeredBy|prevHash)`. Scope is per-`escrowId`
— the natural aggregate boundary this whole module's authorization model
(`isSellerOrAssignedArbiter`, `claimEscrowTransition`) already uses, same
reasoning D2's own per-`intentId` scoping decision already gives for
`Timeline` (Alternatives Considered: reject a single global structure).

**Write path:** `escrow-lifecycle.ts`'s `emitEscrowTransition()` — the
single function every mutating `EscrowService` method already funnels
through — computes and persists both fields; no caller can supply them.
Race-free for the same reason `IntentEvent`'s identical read-then-write
pattern already is: this function is only ever called after the caller's
own `claimEscrowTransition()` atomic claim (a conditional `updateMany`)
has already succeeded for that `escrowId`, so there is no concurrent
writer left to race against by the time it reads "the last event."
Proven, not just asserted: `tests/escrowEventHashChain.test.ts`'s
concurrency test calls `emitEscrowTransition()` directly, bypassing that
discipline on purpose, and shows the fork that would result if it were
ever violated — the atomic claim upstream is load-bearing, not
decorative.

**Verification:** `verifyEscrowEventChain(escrowId)`
(`escrow-lifecycle.ts`), same explanatory shape as `Timeline.verifyChain()`
(`{ valid, brokenAtIndex?, reason? }`, not a bare boolean). 17 tests
(`tests/escrowEventHashChain.test.ts`) prove it catches: an entry mutated
in place, a directly-tampered `entryHash`, a tampered `prevHash`, a
deleted entry, a reordered chain (real `createdAt` timestamps swapped —
the actual attack a Postgres `orderBy: createdAt` query is exposed to,
not just array order), an inserted forged entry, a broken genesis
pointer, and two entries forking off the same ancestor.

**Historical rows (pre-migration) — same policy D2 already specified for
`DurableEvent`, applied here, not a new decision:** `entryHash`/`prevHash`
ship as nullable columns; existing rows keep `entryHash = null` with no
backfill. A deterministic hash needs the exact historical
`(fromStatus, toStatus, triggeredBy)` triple in true write order, which
these rows do have — but computing a chain over them now would assert a
tamper-evidence guarantee that was never actually enforced at the time
they were written, the same reasoning D2's own Backward Compatibility
section already gives for why `Timeline`'s guarantee "only covers entries
written after this RFC ships, not retroactively." `verifyEscrowEventChain()`
skips a leading run of null-hash rows (never treats them as a break) and
requires the first real-hash row's `prevHash` to be `'genesis'`
regardless of what unchained history precedes it — proven to match the
write path exactly, not just asserted to (the write path's own
`last?.entryHash ?? 'genesis'` already evaluates to `'genesis'` when the
most recent predecessor is a null-hash row, by construction of nullish
coalescing, so verifier and writer enforce the identical rule).

**Not done, disclosed, matches this mission's own scope:** `DurableEvent`
(the `Timeline`/`InMemoryEventStore` chain, unaffected by this amendment)
is still not durable by default — that gap (durability, not
tamper-evidence) is a separate, larger infrastructure/deployment decision
(swapping the default `EventStore`), reported and explicitly deferred,
not decided here.

### D2 amendment — `DurableEvent` becomes durable by default: `PostgresEventStore` (Missão 05.7, 2026-08-15)

**The gap this closes:** the amendment directly above disclosed and
deferred it explicitly — `Timeline`'s hash chain lived only in
`InMemoryEventStore`, gone on every process restart. Every other durable
record this protocol relies on for dispute evidence (`IntentEvent`,
`EscrowEvent` since the Missão 05.5 amendment above, `Claim`/`Proof`/
`Verification`) survives a restart; `Timeline` — the one D2 exists for —
did not. A preceding architecture-comparison pass (Missão 05.6, not
itself a code change) evaluated Postgres against Redis Streams
(`RedisStreamsEventStore`, already real, see this file's own D2
implementation note above) as the default durable backend and chose
Postgres: this repo's `docker-compose.yml` runs Redis with no
`appendonly`/`--save` override, i.e. not configured for the durability
guarantee dispute evidence needs, whereas every migration in this repo
already assumes Postgres is. Redis Streams stays available and real for
the day cross-process fan-out is actually needed — nothing about this
decision removes it, it simply isn't the default.

**Decision:** a new `PostgresEventStore` (`common/events/event-store.ts`)
implements `EventStore`, backed by a new table, `durable_events`
(Prisma model `DurableEventRecord`, `prisma/schema.prisma`). It is now
`SailsEventBus`'s default backing store (`common/events/event-bus.ts`) —
`InMemoryEventStore` remains available and is still what several test
files construct directly when they want a fast, zero-infrastructure
store. No call site (`eventBus.emit`/`eventBus.on`/`getTimeline`)
changed — this is the same "swap the backend, not the contract"
adapter substitution D1/D2's own Reference Implementation Plan already
anticipated for `EvidenceProvider`/`ArbitrationProvider`-style adapters.

**Reused, not reinvented, on purpose:** `PostgresEventStore.publish()`
calls the exact same `computeEntryHash()`/`GENESIS_HASH` this D2 section
already defines and `InMemoryEventStore`/`RedisStreamsEventStore` already
call — `entryHash = sha256(eventName:publishedAt:JSON(payload):prevHash)`,
unchanged. `Timeline.verifyChain()` (`core/timeline.ts`) required zero
code changes: it already only ever calls `eventBus.getEvents()` and
recomputes via the same exported `computeEntryHash()`, so a
`PostgresEventStore`-backed bus produces byte-identical `entryHash`
values to what `InMemoryEventStore` always did — this is precisely why
D2's earlier architectural correction (chaining `DurableEvent` itself,
not `EscrowEvent`/`ReputationEvent`) mattered: it is what made the
backend swappable without touching the verifier at all.

**`publishedAt` is stored as `TEXT`, not `TIMESTAMPTZ`, on purpose:**
`computeEntryHash()` hashes the exact ISO-8601 string produced at
`publish()` time; a native timestamp column read back through Prisma
would round-trip through a JS `Date` object first, a real and avoidable
risk of the recomputed hash silently disagreeing with what was stored.
Storing the literal string removes that risk entirely — ISO-8601's own
format still sorts correctly under a plain lexicographic `ORDER BY`.

**A genuinely new, disclosed exposure `InMemoryEventStore` never had:**
`InMemoryEventStore.publish()`'s body has no internal `await` — in
Node's single-threaded event loop, two "concurrent" calls to it can
never actually interleave. `PostgresEventStore.publish()` needs real
I/O (`findFirst` then `create`), so two calls for the *same*
`correlationId` issued without an intervening `await` genuinely can
both read the same "last row" and fork the chain — the identical
exposure the Missão 05.5 `EscrowEvent` amendment above already disclosed
and left unfixed, for the identical reason: today's dominant callers
(escrow/intent transitions) are already serialized per-correlationId by
their own atomic claim *before* they ever call `eventBus.emit()`, and a
new serialization mechanism was explicitly out of this mission's scope.
Proven, not just asserted: `tests/postgresEventStore.test.ts`'s own
concurrency test calls `publish()` twice with no intervening `await` and
shows the resulting fork, same precedent `tests/escrowEventHashChain.test.ts`
already set for `EscrowEvent`.

> **Corrected/Implemented 2026-11-27 (protection added later; historical text preserved):** the concurrent-fork exposure described above is protected today: `PostgresEventStore.publish()` runs inside a transaction serialized per `correlationId` by `pg_advisory_xact_lock` (`common/events/event-store.ts`), so two concurrent writers for the same `correlationId` no longer fork the chain. The paragraph above describes the state at the time of this amendment.

**Verification — the restart proof.** Beyond the same tamper-detection
matrix `tests/escrowEventHashChain.test.ts` established (mutated
payload, tampered `entryHash`/`prevHash`, deleted entry, reordered
chain, inserted forged entry, broken genesis), `tests/postgresEventStore.test.ts`
proves the actual property this mission exists for: a **freshly
constructed `SailsEventBus`**, sharing no in-process state whatsoever
with the bus that originally wrote the events (not the same object, no
shared fields — `PostgresEventStore` itself holds no in-process cache,
unlike `InMemoryEventStore`'s own `byCorrelationId` Map), reads back the
identical events for a `correlationId` and reports `verifyChain(): {
valid: true }` — the closest a single Jest process can get to proving
survival across an actual process restart, since the only thing the
fresh instance shares with the old one is the durable backing store
itself (the mocked `durable_events` table in the test; the real Postgres
database in production, which persists independently of any Node
process's lifetime).

**Historical rows:** none — `durable_events` is a brand-new table, no
backfill question applies (unlike the Missão 05.5 `EscrowEvent`
amendment, which had to account for pre-migration rows).

**Not done, disclosed, matches this mission's own scope:** Redis's own
persistence configuration was not touched (no `appendonly`/`--save`
change to `docker-compose.yml`); no new Redis consumer groups; the
Evidence Bundle (`proof.service.ts`'s `getEvidenceBundleForTrade()`,
Missão 05) needed no code change — it already reads `eventBus.durable`/
`eventBus.storeName` directly, so `timelineDurable`/`timelineStore` now
correctly report `true`/`'postgres'` automatically, exactly the
"swapping in a durable backend flips it automatically" design that
disclosure was built for; no retention policy; no archival system;
`subscribe()` stays a synchronous in-process `EventEmitter`, not
Postgres `LISTEN`/`NOTIFY` — nothing in this codebase today needs
cross-process fan-out, and `RedisStreamsEventStore` already exists for
the day that changes.

### D2 amendment — three real bugs found only by testing against a live Postgres (Missão 06, 2026-08-16)

**Every claim above (05.7/05.8) was verified only against the mocked
suite** (`tests/postgresEventStore.test.ts`'s fake `prisma.durableEventRecord`).
Missão 06's own explicit mandate — "testes contra Postgres real, não
apenas mocks" — is what surfaced these; neither is theoretical, both are
reproduced with a live `docker-compose` Postgres in
`tests/integration/postgresProductionReadiness.test.ts`.

**Bug 1 — `pg_advisory_xact_lock()` cannot go through `$queryRaw`.**
`PostgresEventStore.publish()`'s advisory-lock call used
`` tx.$queryRaw`SELECT pg_advisory_xact_lock(...)` ``. Against a real
server this throws: `pg_advisory_xact_lock()` returns `void`, and
Prisma's `$queryRaw` tries to deserialize every returned column into a
JS value — a `void` column has none. The mock never caught this because
it never executes real SQL. Fixed by switching to `$executeRaw` (the
correct tool for a call whose only purpose is the side effect, no row
data ever needed back) — `event-store.ts`'s own comment on the call site
has the detail. Zero change to `EventStore`'s contract, `computeEntryHash()`,
or `GENESIS_HASH`.

**Bug 2 — `jsonb` does not preserve payload key order, breaking
`entryHash` verification.** `DurableEventRecord.payload` (`prisma/schema.prisma`)
was `Json`, which maps to Postgres `jsonb` by default. `jsonb` is a
binary format with no order guarantee — confirmed directly, not assumed:
a payload written as `{escrowId, tradeId, from, to, triggeredBy}` read
back as `{to, from, tradeId, escrowId, triggeredBy}`. Since `entryHash`
hashes `JSON.stringify(payload)`, a reordered payload recomputes to a
different hash than the one stored at write time — `verifyChain()`
reported a false-positive tamper (`brokenAtIndex: 0`) on every fresh,
genuine, untampered chain written against a real database. Fixed at the
storage layer only: `payload Json @db.Json` forces Postgres's plain
`json` type (stores the exact submitted text verbatim, never
reparsed/reordered) instead of `jsonb` — migration
`20260816000000_durable_events_payload_json_not_jsonb`. **`computeEntryHash()`
itself and this RFC's own hash formula are untouched** — this was a
storage bug, never a protocol one, and the CTO explicitly confirmed this
was the right boundary before it was implemented (schema/protocol
changes are this mission's own designated stop-and-report trigger).
Costs `jsonb`'s native indexing/query operators on this one column,
unused today (every reader takes the whole payload, never queries into
its structure).

**Bug 3 — `publishedAt` ties under real concurrent load broke read-order,
not write-order.** Fixing Bug 1 made the advisory lock actually take
effect, and the write path itself was already correct (each writer
genuinely serialized, each correctly reading the true prior entry) — but
`tests/integration/postgresProductionReadiness.test.ts`'s 5-real-connection
concurrency test still failed intermittently (reproduced directly,
~30-40% of runs, `brokenAtIndex: 0`), even after Bug 1's fix. Root cause:
`publishedAt` was computed once, from wall-clock time, *before* entering
the transaction — several advisory-lock-serialized writers, each fast
enough, could land in the *same millisecond*. `getEvents()`'s `ORDER BY
"publishedAt" ASC` has no tie-break guarantee in Postgres for equal
values, so a read could return two same-millisecond rows in the opposite
of their real write order. `verifyChain()` walks rows in *query* order,
not *write* order, so a tie could make a genuinely correct chain read
back as broken. Fixed by moving `publishedAt`'s computation inside the
transaction, after acquiring the lock and reading the prior entry, and
forcing it strictly greater than that entry's own `publishedAt` (bumping
by 1ms when a real-time collision would otherwise occur) —
`event-store.ts`'s own comment on the call site has the detail. No
schema change (`publishedAt` stays the same `String` column), no change
to `computeEntryHash()`'s formula — `publishedAt` is still a plain
ISO-8601 string throughout, just guaranteed monotonic per-`correlationId`
now instead of merely "usually distinct."

**Verification:** `tests/integration/postgresProductionReadiness.test.ts`,
7 tests, all against a live `docker-compose` Postgres — real concurrent
writers (multiple independent `PrismaClient` connections) for the same
correlationId never fork, real concurrent writers for different
correlationIds never wait on each other, a transaction that acquires the
advisory lock and then aborts leaves no row and does not leak the lock,
an independently-constructed `PrismaClient`/`SailsEventBus` reads back
identical data with a valid chain, and — reusing the same live database —
`EscrowEvent`'s own chain (Missão 05.5) verified valid and its real
tamper-detection path (`UPDATE escrow_events SET ...`, a genuine SQL
statement, not a mock array mutation) both proven for real too. The
concurrency test specifically was re-run 10 consecutive times after Bug
3's fix with zero failures — the whole reason it's called out separately
here rather than folded into Bug 1's own verification note above, which
was written before Bug 3 was found and does not, on its own, mean the
concurrency guarantee was actually reliable yet.

## Primitives Used or Extended

No new primitive. Extends two RFC-007 constructs that were themselves
already ruled non-primitives — `EvidenceReference` (D2 of RFC-007, part
of OpenProof) and `TimelineEntry` (D5 of RFC-007, Core-level read
projection). `TimestampAnchor` is a new Adapter, not a primitive — same
category as the four existing Adapters, evaluated the same way RFC-007
evaluated `EvidenceProvider` and `ArbitrationProvider`: it has no
participant-facing lifecycle of its own, it is infrastructure consulted
by OpenProof and the Event Bus.

## Principle Alignment

- **Principle 6 (Infrastructure Neutral):** `TimestampAnchor` is pluggable
  (`opentimestamps`, `rfc3161`, or an open string for others) — the
  protocol defines the interface, never a specific anchoring service,
  same as every other Adapter.
- **Principle 8 (Privacy Preserving):** the per-`intentId` scoping for
  both the hash chain (D2) and anchoring (D1) — rejecting the global
  Merkle tree alternative above — keeps unrelated participants' activity
  from being linkable through a shared structure.
- **Principle 1 (Protocol First):** policy-gating D1 rather than making it
  mandatory keeps the Core minimal and lets applications decide the
  cost/assurance tradeoff, consistent with how `SettlementProvider`'s tiers
  and RFC-007 D8's Liquidity Provider policies are already structured.
- **Risk flagged, not resolved by this RFC:** `TimestampAnchor` implementations
  that rely on a centralized TSA (RFC 3161) reintroduce a trusted third
  party the OpenTimestamps/Bitcoin-anchored path avoids — Discussion
  should weigh whether the protocol should recommend one anchor type as
  the default for financial disputes specifically, rather than treating
  all `anchorType`s as equivalent.

## Specification

| Component | Change |
|---|---|
| OpenProof (`EvidenceReference`, RFC-007 D2) | + optional `anchorProof?: AnchorProof` field |
| New Adapter | `TimestampAnchor` / `AnchorProof` interfaces |
| Core (`Timeline`/`TimelineEntry`, RFC-007 D5) | `TimelineEntry` gains `entryHash`/`prevHash`; `Timeline` gains `verifyChain()` |
| `EscrowEvent`, `ReputationEvent` (`DATABASE.md`) | + nullable `entryHash`, `prevHash` columns on each — written going forward, `null` on rows that predate this RFC (see Backward Compatibility) |
| Policy Engine | + policy for when `TimestampAnchor` is required (dispute value threshold, `claimType`, or `OperationalProfile`-based, per RFC-007 D8/D10's existing pattern) |

## Backward Compatibility

`protocolVersion` bump recommended, same as RFC-006 and RFC-007.
`TimestampAnchor`/`EvidenceReference.anchorProof` carry the same zero-risk
profile RFC-007 already established for D1/D2/D6 (OpenProof has no
service layer yet — nothing to migrate). D2's chaining is the one
exception worth being precise about: it touches `EscrowEvent`, which
backs `escrow.service.ts` — real, already-written code (`BACKLOG.md`:
"🟢 Most complete module today"), unlike OpenProof or OpenReputation's
service layers. Concretely: `entryHash`/`prevHash` ship as **nullable**
columns, so existing `EscrowEvent` rows are unaffected and remain valid
with `entryHash = null`; `verifyChain()` treats a `null` as "chain starts
here" rather than a break, meaning the tamper-evidence guarantee only
covers entries written after this RFC ships, not retroactively — a
limitation worth stating plainly rather than implying `verifyChain()`
protects history it cannot possibly cover.

## Reference Implementation Plan

Sequenced against RFC-007's own plan, which this RFC depends on rather
than replaces:

1. Build alongside RFC-007 D5 (Timeline) — `entryHash`/`prevHash`
   computation belongs in the same Core Event Bus code that RFC-007 D5
   already scoped as the next piece of work, not a separate pass.
2. Build alongside RFC-007 D1/D2/D6 (OpenProof's first service layer) —
   `TimestampAnchor` sits next to `EvidenceProvider` in the same
   `modules/open-proof/` work RFC-007 already sequenced first.
3. `TimestampAnchor`'s first concrete implementation should be
   `opentimestamps` (Bitcoin-anchored, no trusted third party) rather than
   `rfc3161` (centralized TSA) — consistent with `PRINCIPLES.md` principle
   3 (Self Custody Always) and the risk flagged above; an `rfc3161`
   adapter can be added later by any Reference Implementation without a
   protocol change, the same way any `SettlementProvider` can be added.

As with RFC-007, acceptance is not a commitment that Satsails builds both
D1 and D2 immediately — each can stabilize independently before being
merged into `PROTOCOL_SPECIFICATION.md` / `ARCHITECTURE.md` / `DATABASE.md`.
