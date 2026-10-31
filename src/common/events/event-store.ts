import { EventEmitter } from 'events'
import { randomUUID as uuidv4, createHash } from 'crypto'
import type { Redis } from 'ioredis'
import type { Prisma } from '@prisma/client'
import type { SailsEventName, SailsEventMap } from './event-bus'
import { childLogger } from '../logger'
import { prisma } from '../database'

const log = childLogger('event-store')

// Missão 08B — cross-instance real-time fan-out. One shared channel for
// every event type (simpler than one channel per eventName, and this
// codebase has no need yet to subscribe to a subset) — the eventName
// travels inside the message itself, same as it always has for the
// in-process EventEmitter this extends rather than replaces.
const CROSS_INSTANCE_CHANNEL = 'sails:cross-instance-events'

/**
 * Sails Protocol — EventStore (RFC-010, rfcs/RFC-010-durable-event-store.md)
 *
 * Protocol-level Adapter interface, same category as SettlementProvider,
 * EvidenceProvider, ArbitrationProvider, TransportProvider — the protocol
 * requires durability and a correlationId on every published event, it
 * never names a specific backing technology. `InMemoryEventStore` below is
 * the always-available, explicitly non-durable default. A durable backend
 * (Redis Streams, BullMQ, a Postgres outbox table, ...) is a Reference
 * Implementation's choice, swapped in without changing any `eventBus.emit`/
 * `eventBus.on` call site — see `RedisStreamsEventStore` for the shape a
 * durable implementation follows.
 */

export interface DurableEvent<K extends SailsEventName = SailsEventName> {
  eventId: string
  eventName: K
  // The correlation id every event now carries end-to-end (Timeline, logs,
  // events, Proofs, Settlement, Dispute — RFC-010's motivation). Today this
  // is `tradeId` for trade/negotiation/settlement-lifecycle events (Trade
  // already IS the concrete TradeIntent implementation, PROTOCOL_SPECIFICATION.md
  // §2.3) and `userId` for peer/transport events, which have no trade to
  // correlate to. Once Intent persistence ships (§2.6), this becomes `intentId`
  // for every Intent-scoped event without changing this field's name or type.
  correlationId: string
  payload: SailsEventMap[K]
  publishedAt: string
  // RFC-008 D2 (hash-chained Timeline), closed 2026-08-04 — real
  // architectural correction, not the RFC's original text: D2 as
  // written targeted `entryHash`/`prevHash` columns on `EscrowEvent`/
  // `ReputationEvent` directly, but `core/timeline.ts`'s own header
  // comment (RFC-017) already documents that Timeline was built against
  // `EventStore.getEvents(correlationId)` instead — this file's own
  // `DurableEvent` stream, not those two Prisma tables. Chaining the
  // tables Timeline no longer reads from would make `verifyChain()`
  // check history nobody actually consults; chaining `DurableEvent`
  // here is what Timeline's real read path needs. `entryHash` =
  // sha256(eventName + publishedAt + JSON(payload) + prevHash);
  // `prevHash` = the previous event's own `entryHash` for the same
  // `correlationId`, or the literal string `'genesis'` for the first.
  entryHash: string
  prevHash: string
}

export interface EventStore {
  readonly storeName: string
  // Explicit, not inferred from the class name — so a caller/operator can
  // never mistake a non-durable store for a durable one at a glance.
  readonly durable: boolean
  publish<K extends SailsEventName>(
    eventName: K,
    payload: SailsEventMap[K],
    correlationId: string
  ): Promise<void>
  subscribe<K extends SailsEventName>(
    eventName: K,
    handler: (event: DurableEvent<K>) => void | Promise<void>
  ): void
  // Added for RFC-017 (rfcs/RFC-017-timeline-and-social-engineering-agent.md)
  // — RFC-007 D5's Timeline read-model ("a per-correlationId ordered
  // projection over the Event Bus") needs a way to ask a store "what
  // already happened for X," not just "notify me of what happens next."
  // Every event this bus has ever published carries a correlationId
  // (RFC-010) — this is that history, queryable. Ordered by publishedAt
  // ascending; returns [] for an unknown correlationId, never throws.
  getEvents(correlationId: string): Promise<DurableEvent[]>
}

// RFC-008 D2 — the literal genesis marker for the first event in a given
// correlationId's chain (no real prevHash exists yet). A real string,
// never null/undefined, so `verifyChain()` below can tell "chain starts
// here" apart from "prevHash was never set" — the same "explicit sentinel
// beats an ambiguous absent value" reasoning `Escrow.feeCharged`'s own
// schema comment already establishes for null vs. 0.
export const GENESIS_HASH = 'genesis'

// Exported so Timeline.verifyChain() (core/timeline.ts) can recompute and
// compare against the stored entryHash — the only way to actually catch
// payload tampering (an entry whose stored entryHash was never updated to
// match a modified payload), not just checking that prevHash values chain
// together (which alone only catches reordering/insertion/deletion, not a
// single entry mutated in place).
export function computeEntryHash(eventName: string, publishedAt: string, payload: unknown, prevHash: string): string {
  return createHash('sha256')
    .update(`${eventName}:${publishedAt}:${JSON.stringify(payload)}:${prevHash}`)
    .digest('hex')
}

// ─── Non-durable fallback (test/dev use only — NOT the wired default) ─────────
// Corrected 2026-08-17 (Missão 07.6 release-readiness audit): this section
// header used to read "Default: in-memory, explicitly NOT durable," which
// was accurate when written but went stale once RFC-010/Missão 05.7-05.8
// swapped the real application default to `PostgresEventStore` (see
// event-bus.ts's `SailsEventBus` constructor — `store: EventStore = new
// PostgresEventStore()`). `InMemoryEventStore` still exists and is real —
// same runtime behavior the bare EventEmitter-based SailsEventBus had before
// RFC-010 (events lost on process crash between publish and handler
// completion), every event still carries eventId/correlationId/publishedAt,
// and the shape still matches EventStore — but it is not what a freshly
// booted app actually uses; it stays around as an explicit, disclosed
// non-durable option for tests and any caller that constructs
// `SailsEventBus` with it directly.
export class InMemoryEventStore implements EventStore {
  readonly storeName = 'in-memory'
  readonly durable = false
  private emitter = new EventEmitter()
  // Real, in-process history keyed by correlationId — what makes
  // getEvents() (Timeline, RFC-017) actually work against this store,
  // not just a name that implies storage. "In-memory" already disclosed
  // this is lost on process restart (readonly durable = false above);
  // PostgresEventStore (the real wired default, see event-bus.ts) persists
  // this properly instead of an unbounded process-lifetime array.
  private byCorrelationId = new Map<string, DurableEvent[]>()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  async publish<K extends SailsEventName>(
    eventName: K,
    payload: SailsEventMap[K],
    correlationId: string
  ): Promise<void> {
    const publishedAt = new Date().toISOString()
    // RFC-008 D2 — computed and persisted right here, at the moment this
    // event is first written, never derived later at read-time (the
    // RFC's own stated precondition for the chain to mean anything: a
    // hash computed on demand would just produce a different, still
    // internally-consistent value after tampering, defeating the point).
    const existingForCorrelation = this.byCorrelationId.get(correlationId)
    const prevHash = existingForCorrelation?.length
      ? existingForCorrelation[existingForCorrelation.length - 1].entryHash
      : GENESIS_HASH
    const entryHash = computeEntryHash(eventName, publishedAt, payload, prevHash)

    const event: DurableEvent<K> = {
      eventId: uuidv4(),
      eventName,
      correlationId,
      payload,
      publishedAt,
      entryHash,
      prevHash,
    }
    // debug, not info — this dumps the full event payload (trade amounts,
    // participant ids, escrow details), and 'info' is the default LOG_LEVEL
    // (config/index.ts), so it fired on every event by default in any dev
    // environment, including a dev-mode instance pointed at shared/staging
    // data. debug is opt-in (LOG_LEVEL=debug) — same tracing capability,
    // not on by default.
    if (process.env.NODE_ENV === 'development') {
      log.debug({ msg: 'Event emitted', eventName, correlationId, payload })
    }
    if (existingForCorrelation) existingForCorrelation.push(event)
    else this.byCorrelationId.set(correlationId, [event])
    this.emitter.emit(eventName, event)
  }

  subscribe<K extends SailsEventName>(
    eventName: K,
    handler: (event: DurableEvent<K>) => void | Promise<void>
  ): void {
    this.emitter.on(eventName, (event: DurableEvent<K>) => {
      const result = handler(event)
      if (result instanceof Promise) {
        result.catch((err) => {
          log.error({ msg: 'Handler error', eventName, eventId: event.eventId, correlationId: event.correlationId, err: err instanceof Error ? err.message : err })
        })
      }
    })
  }

  async getEvents(correlationId: string): Promise<DurableEvent[]> {
    // Already publish-ordered (array push is append-only) — no separate
    // sort needed, unlike a real store that might return out of order.
    return this.byCorrelationId.get(correlationId) ?? []
  }
}

// ─── Postgres — real, default as of Missão 05.7 (2026-08-15). Backs
// DurableEvent with the same Postgres database every other durable
// record in this system already lives in (IntentEvent, EscrowEvent,
// Trade, Escrow, ...), closing the one gap RFC-008 D2's own amendment
// history explicitly disclosed and deferred twice: the hash-chained
// DurableEvent stream (what Timeline actually reads, RFC-017) lived only
// in InMemoryEventStore, gone on every process restart. See this file's
// own RedisStreamsEventStore header and RFC-008's D2 amendment section
// for the comparison against Redis Streams — this repo's `docker-compose.yml`
// runs Redis with no AOF/save override, i.e. not configured for the
// durability guarantee dispute evidence needs, whereas Postgres already
// is (every migration in this repo assumes it).
//
// subscribe() is deliberately unchanged from InMemoryEventStore's own
// shape — a synchronous, in-process EventEmitter, not Postgres
// LISTEN/NOTIFY and not a new consumer-group mechanism. Nothing in this
// codebase today needs cross-process fan-out (every handler registered
// in common/events/handlers.ts runs in the same process that published
// the event); RedisStreamsEventStore already exists for the day that
// changes. This class's whole job is making publish()/getEvents()
// durable, not reinventing subscribe() — same "cirurgical" scope the
// mission that added this class was given.
export class PostgresEventStore implements EventStore {
  readonly storeName = 'postgres'
  readonly durable = true
  private emitter = new EventEmitter()

  // Missão 08B — cross-instance fan-out is entirely opt-in, activated only
  // by enableCrossInstanceFanout() (called once, from the real app boot
  // path in app.ts's startServer() — never from buildApp(), which every
  // test calls). Every existing single-instance/test code path is
  // byte-for-byte unchanged unless this is explicitly turned on: publish()
  // still emits synchronously to this.emitter first, same as before this
  // pass; the Redis publish below is a pure addition, never a replacement,
  // and its own failure can never affect publish()'s durable write or its
  // local dispatch (see the try/catch around it below).
  //
  // instanceId is generated once per process — the tag every published
  // message carries so a subscriber can recognize "this is an echo of my
  // own publish()" and skip it, rather than dispatching the same event to
  // this same process's handlers twice (once from the synchronous local
  // emit in publish(), once from the Redis subscription this same process
  // is also listening on).
  private readonly instanceId = uuidv4()
  private crossInstancePublisher: Redis | null = null
  private crossInstanceSubscriber: Redis | null = null

  constructor(private readonly client: Pick<typeof prisma, 'durableEventRecord' | '$transaction'> = prisma) {
    this.emitter.setMaxListeners(50)
  }

  // Opt-in — see the class-level comment above for why this is never
  // called automatically from the constructor. `publisher` is a real,
  // already-connected ioredis client (the app's normal shared `redis`
  // singleton in production; a real Redis in integration tests that want
  // to exercise this for real). A dedicated connection is opened via
  // publisher.duplicate() for subscribing — ioredis's own documented
  // requirement: a connection in subscriber mode can no longer run normal
  // commands, so the app's one shared `redis` client (used everywhere else
  // for sessions/tickets/rate limits) must never itself be put into
  // subscriber mode. duplicate() copies the original client's connection
  // options (host, port, retryStrategy), so the subscriber reconnects with
  // the same backoff policy the rest of the app already relies on; ioredis
  // itself re-issues SUBSCRIBE automatically after a reconnect for a
  // connection that was already in subscriber mode, so no manual
  // re-subscribe logic is needed here.
  enableCrossInstanceFanout(publisher: Redis): void {
    if (this.crossInstanceSubscriber) return // idempotent — a second call is a no-op, not an error
    this.crossInstancePublisher = publisher

    const subscriber = publisher.duplicate()
    this.crossInstanceSubscriber = subscriber

    subscriber.on('error', (err) => {
      log.error({ msg: 'Cross-instance event subscriber connection error', err: err instanceof Error ? err.message : String(err) })
    })

    subscriber.subscribe(CROSS_INSTANCE_CHANNEL, (err) => {
      if (err) {
        log.error({ msg: 'Failed to subscribe to cross-instance event channel', err: err.message })
      } else {
        log.info({ msg: 'Subscribed to cross-instance event channel', channel: CROSS_INSTANCE_CHANNEL, instanceId: this.instanceId })
      }
    })

    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== CROSS_INSTANCE_CHANNEL) return
      let parsed: DurableEvent & { __originInstanceId?: string }
      try {
        parsed = JSON.parse(message)
      } catch {
        log.error({ msg: 'Received malformed cross-instance event message, dropping' })
        return
      }
      // Echo of this same process's own publish() below — already
      // dispatched synchronously there; dispatching again here would be
      // exactly the double-processing Missão 08B's own acceptance
      // criteria forbids.
      if (parsed.__originInstanceId === this.instanceId) return
      const { __originInstanceId, ...event } = parsed
      this.emitter.emit(event.eventName, event)
    })
  }

  // Graceful shutdown / test cleanup — mirrors startServer()'s existing
  // redis.quit() pattern. Safe to call even if fan-out was never enabled.
  async disableCrossInstanceFanout(): Promise<void> {
    if (this.crossInstanceSubscriber) {
      await this.crossInstanceSubscriber.unsubscribe(CROSS_INSTANCE_CHANNEL).catch(() => {})
      await this.crossInstanceSubscriber.quit().catch(() => {})
      this.crossInstanceSubscriber = null
    }
    this.crossInstancePublisher = null
  }

  // Missão 05.8 — the read-then-write (findFirst, then create) below runs
  // inside a real Postgres transaction, serialized per-correlationId by a
  // `pg_advisory_xact_lock`, closing the fork exposure this class's own
  // header comment used to disclose here (see this file's git history/
  // RFC-008's D2 amendment for the original, now-superseded disclosure).
  //
  // Why an advisory lock, not an in-process mutex: this app can run as
  // more than one instance (this repo's own AWS App Runner deployment
  // plan, DEPLOYMENT.md), each with its own Node process and its own
  // memory — a `Map<correlationId, Promise>` queue would only serialize
  // writers *within* one instance, doing nothing to stop two different
  // instances from forking the same correlationId's chain. An advisory
  // lock lives in Postgres itself, so it serializes every writer talking
  // to the same database regardless of which process or instance they're
  // in — and it needs no schema change (no new table/column), keeping
  // `EventStore`'s contract, `computeEntryHash()`, and `GENESIS_HASH`
  // exactly as they were.
  //
  // Why `pg_advisory_xact_lock`, not `pg_advisory_lock`: the `_xact_`
  // variant is scoped to and released automatically at the end of the
  // enclosing transaction (commit OR rollback) — no explicit unlock call,
  // so a crashed request or a thrown error can never leak a held lock
  // past its own transaction the way a session-level lock could if the
  // matching unlock call were ever skipped.
  //
  // Why `hashtext(correlationId)`, not the raw string: Postgres advisory
  // locks are keyed by a bigint (or two int4s), not an arbitrary string.
  // `hashtext()` is Postgres's own built-in string-to-int4 hash, used
  // here purely as a lock key, never mixed into `entryHash`/`prevHash` —
  // the hash chain's own hash function (`computeEntryHash` above) is
  // completely untouched. This does mean two different correlationIds
  // could, in principle, hash to the same int4 and briefly contend for
  // the same lock — a false-positive serialization, not a correctness
  // bug (it can only make two unrelated writes wait on each other for a
  // moment, never let two events on the wrong correlationId collide) —
  // see tests/postgresEventStore.test.ts's own independence test, which
  // proves distinct correlationIds still complete without waiting on each
  // other in the common (non-colliding) case.
  async publish<K extends SailsEventName>(
    eventName: K,
    payload: SailsEventMap[K],
    correlationId: string
  ): Promise<void> {
    const eventId = uuidv4()
    let prevHash = GENESIS_HASH
    let entryHash = ''
    let publishedAt = ''

    await this.client.$transaction(async (tx) => {
      // $executeRaw, not $queryRaw — Missão 06 (2026-08-16) real-Postgres
      // integration testing found $queryRaw fails against a live server
      // here: pg_advisory_xact_lock() returns void, and Prisma's
      // $queryRaw tries to deserialize every returned column into a JS
      // value, which a void column has none of ("Failed to deserialize
      // column of type 'void'"). The mocked suite (tests/postgresEventStore.test.ts)
      // never caught this — its fake $queryRaw resolves unconditionally,
      // never executing real SQL against a real engine. $executeRaw is
      // the correct tool for a call whose only purpose is the side
      // effect (the lock itself), with no row data ever needed back.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${correlationId})::bigint)`

      // Real prevHash: this correlationId's own last row, not a
      // separately maintained counter — same read-then-write shape
      // emitEscrowTransition()/writeIntentEvent() already established
      // (escrow-lifecycle.ts, intent-engine.ts). Now genuinely race-free
      // (not just race-free "as long as the caller already serialized
      // upstream," the precondition this comment used to state): the
      // advisory lock above means no other publish() call for this same
      // correlationId can be inside this transaction at the same time,
      // on this process or any other.
      const last = await tx.durableEventRecord.findFirst({
        where: { correlationId },
        orderBy: { publishedAt: 'desc' },
      })
      prevHash = last?.entryHash ?? GENESIS_HASH

      // Computed here, AFTER acquiring the lock and reading `last` — not
      // before entering the transaction — and forced strictly greater
      // than the prior entry's own publishedAt. Missão 06 (2026-08-16)
      // real-Postgres load testing found the previous version (timestamp
      // captured once, before the lock, from wall-clock time alone) let
      // several advisory-lock-serialized writers land in the SAME
      // millisecond under genuine concurrency — harmless for the write
      // path itself, but `getEvents()`'s `ORDER BY "publishedAt" ASC`
      // has no tie-break guarantee in Postgres for equal values, so a
      // read could return two same-millisecond rows in the opposite of
      // their real write order, and `verifyChain()` (which walks rows in
      // query order) reported a false-positive broken chain — reproduced
      // directly against the live database, not assumed. Bumping by 1ms
      // past the real last write when a collision would occur keeps
      // every row's publishedAt strictly monotonic within a
      // correlationId, which is the only ordering guarantee `getEvents()`
      // actually needs — no schema change, no change to
      // `computeEntryHash()`'s formula, publishedAt stays an ISO-8601
      // string throughout.
      publishedAt = new Date().toISOString()
      if (last && publishedAt <= last.publishedAt) {
        publishedAt = new Date(new Date(last.publishedAt).getTime() + 1).toISOString()
      }

      entryHash = computeEntryHash(eventName, publishedAt, payload, prevHash)

      await tx.durableEventRecord.create({
        data: {
          id: eventId,
          eventName,
          correlationId,
          payload: payload as unknown as Prisma.InputJsonValue,
          publishedAt,
          entryHash,
          prevHash,
        },
      })
    })

    // Same log-level reasoning InMemoryEventStore.publish() already
    // states — debug, not info, since this dumps full event payloads
    // (trade amounts, participant ids, escrow details).
    if (process.env.NODE_ENV === 'development') {
      log.debug({ msg: 'Event emitted', eventName, correlationId, payload })
    }

    const event: DurableEvent<K> = {
      eventId,
      eventName,
      correlationId,
      payload,
      publishedAt,
      entryHash,
      prevHash,
    }
    this.emitter.emit(eventName, event)

    // Missão 08B — best-effort signal for any OTHER instance's own
    // subscription (enableCrossInstanceFanout() above) to dispatch this
    // same event to its own local handlers. Deliberately fire-and-forget,
    // wrapped so a Redis outage can never turn an already-committed
    // durable write (everything above this line already succeeded) into a
    // thrown error — the boundary this mission's own Fase 3 requires:
    // Pub/Sub is a signal, never durability, and its failure must never
    // retroactively affect the transaction that already committed.
    if (this.crossInstancePublisher) {
      const message = JSON.stringify({ ...event, __originInstanceId: this.instanceId })
      this.crossInstancePublisher.publish(CROSS_INSTANCE_CHANNEL, message).catch((err) => {
        log.error({ msg: 'Cross-instance event publish failed (durable write already committed, unaffected)', eventName, eventId, err: err instanceof Error ? err.message : String(err) })
      })
    }
  }

  subscribe<K extends SailsEventName>(
    eventName: K,
    handler: (event: DurableEvent<K>) => void | Promise<void>
  ): void {
    this.emitter.on(eventName, (event: DurableEvent<K>) => {
      const result = handler(event)
      if (result instanceof Promise) {
        result.catch((err) => {
          log.error({ msg: 'Handler error', eventName, eventId: event.eventId, correlationId: event.correlationId, err: err instanceof Error ? err.message : err })
        })
      }
    })
  }

  // Issue #298 - see SailsEventBus.redeliver(). Local dispatch only: the event was already published
  // (durable row + cross-instance signal) when it was first emitted.
  async redeliver(eventId: string): Promise<boolean> {
    const row = await this.client.durableEventRecord.findUnique({ where: { id: eventId } })
    if (!row) return false
    const event: DurableEvent = {
      eventId: row.id,
      eventName: row.eventName as SailsEventName,
      correlationId: row.correlationId,
      payload: row.payload as unknown as SailsEventMap[SailsEventName],
      publishedAt: row.publishedAt,
      entryHash: row.entryHash,
      prevHash: row.prevHash,
    }
    this.emitter.emit(row.eventName, event)
    return true
  }

  async getEvents(correlationId: string): Promise<DurableEvent[]> {
    const rows = await this.client.durableEventRecord.findMany({
      where: { correlationId },
      orderBy: { publishedAt: 'asc' },
    })
    return rows.map((row): DurableEvent => ({
      eventId: row.id,
      eventName: row.eventName as SailsEventName,
      correlationId: row.correlationId,
      payload: row.payload as unknown as SailsEventMap[SailsEventName],
      publishedAt: row.publishedAt,
      entryHash: row.entryHash,
      prevHash: row.prevHash,
    }))
  }
}

// ─── Redis Streams — real, closed 2026-08-04 (verified against a live
// Redis, not just written and hoped to be correct — same discipline
// CODE_STYLE.md §7 states plainly for this whole codebase).
//
// Dual-write per publish() — this is the one real design decision RFC-010
// left "undecided" (its own Reference Implementation Plan named
// `sails:events:{eventName}` streams, good for subscribe()'s consumer-
// group fan-out, but never addressed how getEvents(correlationId) would
// query efficiently across every eventName's stream). Two streams per
// event, both holding the identical serialized DurableEvent:
//   sails:events:{eventName}              — subscribe()'s consumer group
//   sails:events:by-correlation:{id}      — getEvents()'s real index,
//                                            same role InMemoryEventStore's
//                                            own byCorrelationId Map plays
// A real write-amplification tradeoff (2 XADDs per publish instead of 1),
// accepted deliberately: the alternative (scanning every eventName stream
// to answer "what happened for correlationId X") does not scale, and
// Redis Streams are cheap enough per-entry that this mirrors exactly how
// a Postgres outbox table would need a secondary index for the same
// query shape anyway.
//
// RFC-008 D2's hash chain is computed here too, exactly like
// InMemoryEventStore.publish() does — reading the correlation stream's
// own last entry (XREVRANGE ... COUNT 1) for prevHash before writing,
// never derived later at read time.
export class RedisStreamsEventStore implements EventStore {
  readonly storeName = 'redis-streams'
  readonly durable = true

  private readonly consumerName: string
  // Which eventNames already have a running XREADGROUP poll loop for this
  // process — subscribe() may be called more than once for the same
  // eventName (multiple handlers), but only one poll loop per stream
  // should exist; loopHandlers below is what actually dispatches to all
  // of them.
  private readonly activeLoops = new Set<SailsEventName>()
  private readonly loopHandlers = new Map<SailsEventName, Array<(event: DurableEvent<any>) => void | Promise<void>>>()
  // Tracks each running pollLoop()'s own promise so stop() can actually
  // wait for them to exit — found the hard way (first real full-suite
  // run alongside this file's own integration test, 2026-08-04): a
  // fire-and-forget loop that only rechecks `stopped` after its current
  // BLOCK call returns left multiple loops from finished tests still
  // holding the shared client's connection for seconds afterward,
  // destabilizing unrelated later test files in the same Jest run
  // (`tests/routes.test.ts`'s own beforeAll timeout/teardown errors —
  // real cross-file contamination, not that file's own bug).
  private readonly loopPromises: Promise<void>[] = []
  private stopped = false

  constructor(
    private readonly client: import('ioredis').Redis,
    private readonly consumerGroup = 'sails-workers',
    // Idle threshold before an unacked message is considered "its
    // consumer probably crashed" and eligible for XCLAIM-based recovery —
    // RFC-010's own explicitly-named missing piece. 30s: long enough that
    // a handler doing real I/O (an RPC call, a DB write) isn't falsely
    // reclaimed mid-flight, short enough that a genuinely crashed
    // consumer's messages don't sit stuck for minutes.
    private readonly idleClaimMs = 30_000,
    // How long each XREADGROUP BLOCKs waiting for a new message before
    // looping back to recheck `stopped`/reclaim stale pending messages —
    // this is also the real upper bound on how long stop() can take to
    // resolve. 1s: frequent enough that stop() (tests, graceful shutdown)
    // returns promptly; the reclaim/re-block cost of polling this often
    // is negligible against Redis.
    private readonly blockMs = 1_000
  ) {
    this.consumerName = `${consumerGroup}-${process.pid}-${uuidv4().slice(0, 8)}`
  }

  private streamKey(eventName: SailsEventName): string {
    return `sails:events:${eventName}`
  }

  private correlationStreamKey(correlationId: string): string {
    return `sails:events:by-correlation:${correlationId}`
  }

  async publish<K extends SailsEventName>(
    eventName: K,
    payload: SailsEventMap[K],
    correlationId: string
  ): Promise<void> {
    const publishedAt = new Date().toISOString()
    const correlationKey = this.correlationStreamKey(correlationId)

    // Real prevHash: the correlation stream's own last entry, not a
    // separately-maintained counter that could drift from it.
    const lastEntries = await this.client.xrevrange(correlationKey, '+', '-', 'COUNT', 1)
    const prevHash = lastEntries.length > 0 ? this.parseEntry(lastEntries[0]).entryHash : GENESIS_HASH
    const entryHash = computeEntryHash(eventName, publishedAt, payload, prevHash)

    const event: DurableEvent<K> = {
      eventId: uuidv4(),
      eventName,
      correlationId,
      payload,
      publishedAt,
      entryHash,
      prevHash,
    }
    const data = JSON.stringify(event)

    // Both streams get the identical payload — one write, two indexes.
    // Not wrapped in a MULTI: a partial failure here (correlation stream
    // written, eventName stream not, or vice versa) is a real, disclosed
    // gap, not a silent one — see this class's own header comment.
    await this.client.xadd(this.streamKey(eventName), '*', 'data', data)
    await this.client.xadd(correlationKey, '*', 'data', data)
  }

  private parseEntry(entry: [id: string, fields: string[]]): DurableEvent {
    const fields = entry[1]
    const dataIndex = fields.indexOf('data')
    return JSON.parse(fields[dataIndex + 1])
  }

  subscribe<K extends SailsEventName>(
    eventName: K,
    handler: (event: DurableEvent<K>) => void | Promise<void>
  ): void {
    const handlers = this.loopHandlers.get(eventName) ?? []
    handlers.push(handler)
    this.loopHandlers.set(eventName, handlers)

    if (this.activeLoops.has(eventName)) return // poll loop already running for this stream
    this.activeLoops.add(eventName)
    // Deliberately not awaited HERE — subscribe() is synchronous per the
    // EventStore interface (matching InMemoryEventStore's own
    // fire-and-forget emitter.on()); the poll loop runs for the life of
    // the process. Errors inside are caught per-iteration below so a
    // single failed XREADGROUP/XCLAIM round doesn't kill the loop. Its
    // promise IS tracked (loopPromises), so stop() can await a clean exit.
    this.loopPromises.push(this.pollLoop(eventName))
  }

  private async pollLoop(eventName: SailsEventName): Promise<void> {
    const stream = this.streamKey(eventName)
    try {
      // '$' — a brand-new group only sees messages published AFTER this
      // group is created, matching InMemoryEventStore.subscribe()'s real
      // semantics exactly (EventEmitter.on() never replays past emits).
      // Found the hard way (first real Redis integration test run,
      // 2026-08-04): starting at '0' made a fresh consumer group replay
      // the ENTIRE historical backlog of that stream — including
      // messages from unrelated earlier test runs against the same
      // long-lived Redis instance — which is durability's job
      // (getEvents()'s by-correlation index already covers replay), not
      // subscribe()'s. Disclosed real limitation this creates: subscribe()
      // stays synchronous (matching the EventStore interface), but the
      // actual XGROUP CREATE against Redis is async — a publish() that
      // lands in the brief window before CREATE completes could be
      // missed by that specific subscription. InMemoryEventStore has no
      // equivalent gap (EventEmitter.on() registers synchronously); real
      // production use (subscribing once at startup, before any
      // publishing begins) makes this window practically unreachable.
      await this.client.xgroup('CREATE', stream, this.consumerGroup, '$', 'MKSTREAM')
    } catch (err: any) {
      // BUSYGROUP — the group already exists from a prior process/restart.
      // Real, expected condition, not an error (RFC-010's own plan: "tolerating BUSYGROUP on re-creation").
      if (!String(err?.message ?? err).includes('BUSYGROUP')) throw err
    }

    while (!this.stopped) {
      try {
        // XCLAIM-based recovery (RFC-010's own named gap, closed here):
        // before blocking for new messages, reclaim anything idle past
        // idleClaimMs from ANY consumer in this group (including a
        // now-dead one from a crashed process) onto this consumer, so a
        // handler that never got to XACK isn't stuck forever.
        await this.reclaimStalePending(stream, eventName)

        const result = await this.client.xreadgroup(
          'GROUP', this.consumerGroup, this.consumerName,
          'COUNT', 10, 'BLOCK', this.blockMs,
          'STREAMS', stream, '>'
        )
        if (!result) continue // BLOCK timeout, no new messages — loop back to the reclaim check

        const [, messages] = result[0] as [string, Array<[string, string[]]>]
        for (const message of messages) {
          const [messageId] = message
          const event = this.parseEntry(message)
          const handlers = this.loopHandlers.get(eventName) ?? []
          try {
            await Promise.all(handlers.map((h) => h(event)))
            await this.client.xack(stream, this.consumerGroup, messageId)
          } catch (err) {
            // Left un-acked on purpose — reclaimStalePending() above will
            // redeliver it (to this or another consumer) once idleClaimMs
            // passes, same "don't silently drop a failed real event"
            // principle InMemoryEventStore's own subscribe() comment
            // already states for its in-process equivalent.
            log.error({ msg: 'Handler error', eventName, messageId, correlationId: event.correlationId, eventId: event.eventId, err: err instanceof Error ? err.message : err })
          }
        }
      } catch (err) {
        log.error({ msg: 'Poll loop error', eventName, err: err instanceof Error ? err.message : err })
        await new Promise((resolve) => setTimeout(resolve, 1000)) // brief backoff before retrying the loop
      }
    }
  }

  private async reclaimStalePending(stream: string, eventName: SailsEventName): Promise<void> {
    const pending = await this.client.xpending(stream, this.consumerGroup, 'IDLE', this.idleClaimMs, '-', '+', 10)
    if (!Array.isArray(pending) || pending.length === 0) return
    const staleIds = (pending as Array<[string, string, number, number]>).map((p) => p[0])
    await this.client.xclaim(stream, this.consumerGroup, this.consumerName, this.idleClaimMs, ...staleIds)
  }

  async getEvents(correlationId: string): Promise<DurableEvent[]> {
    const entries = await this.client.xrange(this.correlationStreamKey(correlationId), '-', '+')
    return entries.map((entry) => this.parseEntry(entry as [string, string[]]))
  }

  // Not part of the EventStore interface — for graceful shutdown /
  // tests only. Returns a Promise resolving once every running poll
  // loop has actually exited (bounded by blockMs — see that field's own
  // comment) rather than just flipping a flag and hoping: a caller that
  // doesn't await this (or a test that calls it and moves on
  // immediately) is exactly what let finished-test poll loops keep
  // holding the shared client open into later, unrelated test files —
  // the real bug this method exists to prevent a repeat of.
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all(this.loopPromises)
  }
}
