/**
 * Missao 05.7 - PostgresEventStore, the durable backing store for
 * EventStore's DurableEvent stream (RFC-008 D2's own deferred gap,
 * closed here - see the RFC's "D2 amendment - durable_events" section).
 *
 * Missao 05.8 - publish()'s read-then-write now runs inside a real
 * Postgres transaction serialized per-correlationId by
 * `pg_advisory_xact_lock(hashtext(correlationId))`. The fake `$transaction`/
 * `$executeRaw` below don't just no-op through the call - they model the
 * real locking semantics with a genuine per-key async mutex queue (see
 * `acquireLock`/`lockQueue`), so the concurrency tests in this file prove
 * something real about serialization, not just that a trivial passthrough
 * mock happens not to race.
 *
 * Missao 06 (2026-08-16) - the call uses $executeRaw, not $queryRaw:
 * found running this for real against live Postgres (tests/integration/
 * postgresProductionReadiness.test.ts) that pg_advisory_xact_lock()
 * returns void, which $queryRaw cannot deserialize against a real
 * server - the mock below never caught this because it never executed
 * real SQL. See event-store.ts's own comment on the fix.
 *
 * Same in-memory-fake-standing-in-for-Postgres pattern
 * tests/escrowEventHashChain.test.ts already established for
 * EscrowEvent's own chain: a small fake backing prisma.durableEventRecord
 * (create/findFirst/findMany operating on a real, shared, mutable array),
 * letting the write path (publish) and the verifier (Timeline's own
 * verifyChain(), unchanged by this mission) be exercised for real, tamper
 * scenarios included, without a live Postgres.
 *
 * Because `../src/common/database` is mocked here, the real `eventBus`
 * singleton (event-bus.ts's default is now `new PostgresEventStore()`)
 * transparently uses this same fake store - most tests below exercise it
 * exactly the way tests/timeline.test.ts exercises the in-memory default,
 * just against the durable backend instead.
 */
let durableEvents: any[] = []

function sortByPublishedAt(rows: any[]): any[] {
  // Array.prototype.sort is stable in V8 - ties (same millisecond
  // publishedAt) keep insertion order, matching what a real Postgres
  // `ORDER BY "publishedAt" ASC` would do for genuinely concurrent writes
  // landing in the same millisecond, and letting the reordering-attack
  // test below reorder rows deterministically by editing publishedAt.
  return [...rows].sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0))
}

const mockCreate = jest.fn(async (args: any) => {
  const row = { ...args.data }
  durableEvents.push(row)
  return row
})
const mockFindFirst = jest.fn(async (args: any) => {
  const matching = durableEvents.filter((e) => e.correlationId === args.where.correlationId)
  if (matching.length === 0) return null
  return sortByPublishedAt(matching)[matching.length - 1]
})
const mockFindMany = jest.fn(async (args: any) => {
  return sortByPublishedAt(durableEvents.filter((e) => e.correlationId === args.where.correlationId))
})
const mockDurableEventRecordDelegate = {
  create: (...args: unknown[]) => mockCreate(...(args as [any])),
  findFirst: (...args: unknown[]) => mockFindFirst(...(args as [any])),
  findMany: (...args: unknown[]) => mockFindMany(...(args as [any])),
}

// Models `pg_advisory_xact_lock` for the mock: a real per-key async mutex
// queue, not a trivial passthrough. `acquireLock(key)` resolves once every
// earlier `acquireLock(key)` call for the SAME key has had its release
// function invoked - a genuine FIFO queue per key, matching how Postgres
// blocks a second `pg_advisory_xact_lock` call for a held key until the
// holder's transaction ends. Different keys never wait on each other.
const lockQueue = new Map<string, Promise<void>>()
async function acquireLock(key: string): Promise<() => void> {
  const previous = lockQueue.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  lockQueue.set(key, previous.then(() => held))
  await previous
  return release
}

const mockTransaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => {
  // A no-op default (instead of `null`) sidesteps a TS control-flow
  // narrowing quirk where a `let` reassigned only inside a nested
  // closure gets narrowed to `never` at the `finally` block below.
  let releaseLock: () => void = () => {}
  const tx = {
    durableEventRecord: mockDurableEventRecordDelegate,
    // Real PostgresEventStore.publish() calls this as a tagged template:
    // `` tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${correlationId})::bigint)` ``
    // - so `values[0]` here is the real correlationId, not something this
    // mock has to parse out of SQL text.
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = String(values[0])
      releaseLock = await acquireLock(key)
      return 0
    }),
  }
  try {
    return await callback(tx)
  } finally {
    // Released only once the transaction body (findFirst + create) has
    // fully settled - matching `pg_advisory_xact_lock`'s own release
    // point (commit or rollback), not `$executeRaw`'s own return.
    releaseLock()
  }
})

jest.mock('../src/common/database', () => ({
  prisma: {
    durableEventRecord: mockDurableEventRecordDelegate,
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

import { eventBus } from '../src/common/events/event-bus'
import { SailsEventBus } from '../src/common/events/event-bus'
import { PostgresEventStore, GENESIS_HASH, computeEntryHash } from '../src/common/events/event-store'
import { getTimeline } from '../src/core/timeline'

function messagePayload(messageId: string, tradeId: string, content: string) {
  return { messageId, tradeId, senderId: 'u1', content, msgType: 'TEXT', timestamp: new Date().toISOString() }
}

// publishedAt is real wall-clock time (`new Date().toISOString()`,
// millisecond resolution) - unlike tests/escrowEventHashChain.test.ts,
// which controls its own fake createdAt values directly, here the
// timestamp is generated inside the real PostgresEventStore.publish()
// being tested, so it can't be stubbed without also desyncing entryHash
// from it. A real, small delay between sequential emits is what actually
// guarantees two events land in different milliseconds - needed for
// every test below where relative order must be deterministic (the
// reorder/insert tamper tests, in particular, would otherwise land on
// whichever millisecond the fast mock happened to resolve in).
function tick(ms = 2): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  durableEvents = []
  lockQueue.clear()
  jest.clearAllMocks()
})

describe('PostgresEventStore - identity and metadata (Missao 05.7)', () => {
  it('reports durable: true and storeName: "postgres" - the default eventBus now inherits this', () => {
    expect(eventBus.durable).toBe(true)
    expect(eventBus.storeName).toBe('postgres')
  })
})

describe('PostgresEventStore - write path', () => {
  it('the first event for a correlationId gets prevHash = GENESIS_HASH', async () => {
    const correlationId = `pg-${Date.now()}-a`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'hi'), correlationId)

    expect(durableEvents[0].prevHash).toBe(GENESIS_HASH)
    expect(durableEvents[0].entryHash).toBe(
      computeEntryHash('openp2p.message.sent', durableEvents[0].publishedAt, durableEvents[0].payload, GENESIS_HASH)
    )
  })

  it('each subsequent event chains off the real previous entryHash', async () => {
    const correlationId = `pg-${Date.now()}-b`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId)
    await tick()
    await eventBus.emit('openp2p.message.sent', messagePayload('m2', correlationId, 'b'), correlationId)
    await tick()
    await eventBus.emit('openp2p.message.sent', messagePayload('m3', correlationId, 'c'), correlationId)

    expect(durableEvents[1].prevHash).toBe(durableEvents[0].entryHash)
    expect(durableEvents[2].prevHash).toBe(durableEvents[1].entryHash)
    expect(new Set(durableEvents.map((e) => e.entryHash)).size).toBe(3)
  })

  it('two different correlationIds never chain into each other', async () => {
    const a = `pg-${Date.now()}-c1`
    const b = `pg-${Date.now()}-c2`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', a, 'a'), a)
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', b, 'b'), b)

    expect(durableEvents[0].prevHash).toBe(GENESIS_HASH)
    expect(durableEvents[1].prevHash).toBe(GENESIS_HASH) // NOT durableEvents[0].entryHash
  })

  it('the row written matches the row read back by getEvents() - no lossy round-trip through Postgres storage', async () => {
    const correlationId = `pg-${Date.now()}-d`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'roundtrip'), correlationId)

    const [entry] = await eventBus.getEvents(correlationId)
    expect(entry.entryHash).toBe(durableEvents[0].entryHash)
    expect(entry.prevHash).toBe(durableEvents[0].prevHash)
    expect(entry.publishedAt).toBe(durableEvents[0].publishedAt)
    expect(entry.payload).toEqual(durableEvents[0].payload)
    // Recomputing from what getEvents() returned must independently
    // match - proves the stored publishedAt string is exactly what was
    // hashed, not a value that drifted through a Date round-trip.
    expect(computeEntryHash(entry.eventName, entry.publishedAt, entry.payload, entry.prevHash)).toBe(entry.entryHash)
  })
})

describe('Timeline.verifyChain() against PostgresEventStore - a genuine, untampered chain', () => {
  it('reports valid: true for a real, untampered chain', async () => {
    const correlationId = `pg-${Date.now()}-e`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId)
    await eventBus.emit('openp2p.message.sent', messagePayload('m2', correlationId, 'b'), correlationId)

    const result = await getTimeline(correlationId).verifyChain()
    expect(result).toEqual({ valid: true })
  })

  it('reports valid: true for a correlationId with no events', async () => {
    const result = await getTimeline(`pg-never-used-${Date.now()}`).verifyChain()
    expect(result).toEqual({ valid: true })
  })
})

describe('Timeline.verifyChain() against PostgresEventStore - tamper detection', () => {
  let correlationId: string

  beforeEach(async () => {
    correlationId = `pg-tamper-${Date.now()}`
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId)
    await tick()
    await eventBus.emit('openp2p.message.sent', messagePayload('m2', correlationId, 'b'), correlationId)
    await tick()
    await eventBus.emit('openp2p.message.sent', messagePayload('m3', correlationId, 'c'), correlationId)
  })

  it('detects a payload mutated in place - entryHash left untouched', async () => {
    durableEvents[2].payload = { ...durableEvents[2].payload, content: 'TAMPERED' }
    const result = await getTimeline(correlationId).verifyChain()
    expect(result).toEqual({ valid: false, brokenAtIndex: 2 })
  })

  it('detects a directly-tampered entryHash', async () => {
    durableEvents[1].entryHash = '0'.repeat(64)
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1)
  })

  it('detects a tampered prevHash - an entry rewritten to point at a different ancestor', async () => {
    durableEvents[2].prevHash = 'some-other-hash-entirely'
    durableEvents[2].entryHash = computeEntryHash('openp2p.message.sent', durableEvents[2].publishedAt, durableEvents[2].payload, 'some-other-hash-entirely')
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(2)
  })

  it('detects a deleted (removed) event - the link to the next real entry breaks', async () => {
    durableEvents.splice(1, 1)
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1)
  })

  it('detects a reordered chain - same entries, publishedAt swapped so the real query order changes', async () => {
    // getEvents() queries orderBy: { publishedAt: 'asc' }, the same way a
    // real Postgres-backed findMany() would - a real reordering attack
    // has to rewrite publishedAt, not just array position, matching the
    // exact reasoning tests/escrowEventHashChain.test.ts already
    // established for EscrowEvent's own createdAt-based ordering.
    const [, b, c] = durableEvents
    const swap = b.publishedAt
    b.publishedAt = c.publishedAt
    c.publishedAt = swap
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
  })

  it('detects an inserted forged entry not part of the real chain', async () => {
    durableEvents.splice(1, 0, {
      id: 'forged-id',
      eventName: 'openp2p.message.sent',
      correlationId,
      payload: messagePayload('forged', correlationId, 'forged'),
      publishedAt: new Date(new Date(durableEvents[0].publishedAt).getTime() + 1).toISOString(),
      entryHash: 'forged-hash',
      prevHash: durableEvents[0].entryHash,
    })
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1)
  })

  it('detects a broken genesis - the first entry does not actually point at GENESIS_HASH', async () => {
    durableEvents[0].prevHash = 'not-genesis'
    durableEvents[0].entryHash = computeEntryHash('openp2p.message.sent', durableEvents[0].publishedAt, durableEvents[0].payload, 'not-genesis')
    const result = await getTimeline(correlationId).verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(0)
  })
})

describe('PostgresEventStore - concurrency (Missao 05.8: no fork, per-correlationId serialization)', () => {
  // Before Missao 05.8, this exact scenario (two publish() calls with no
  // intervening await for the SAME correlationId) produced a real fork -
  // both reads landed on the same "last row" and wrote conflicting
  // entries off the same ancestor. `pg_advisory_xact_lock` (see
  // PostgresEventStore.publish()'s own comment) now serializes the two
  // transactions, so the second one's findFirst only runs after the
  // first one's create has committed.
  it('two publish() calls with no intervening await for the SAME correlationId never fork - a real chain results, proven by verifyChain()', async () => {
    const correlationId = `pg-concurrent-${Date.now()}`
    const store = new PostgresEventStore()

    await Promise.all([
      store.publish('openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId),
      store.publish('openp2p.message.sent', messagePayload('m2', correlationId, 'b'), correlationId),
    ])

    expect(durableEvents).toHaveLength(2)
    // Exactly one of the two events is genesis-rooted; the other chains
    // off the first's real entryHash - never both genesis-rooted (that
    // would be the fork this mission exists to eliminate).
    const genesisRooted = durableEvents.filter((e) => e.prevHash === GENESIS_HASH)
    expect(genesisRooted).toHaveLength(1)
    const chained = durableEvents.find((e) => e.prevHash !== GENESIS_HASH)
    expect(chained.prevHash).toBe(genesisRooted[0].entryHash)

    const result = await getTimeline(correlationId).verifyChain()
    expect(result).toEqual({ valid: true })
  })

  it('ten concurrent publish() calls for the SAME correlationId all land in one unbroken chain, no forks, no lost writes', async () => {
    const correlationId = `pg-concurrent-many-${Date.now()}`
    const store = new PostgresEventStore()

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.publish('openp2p.message.sent', messagePayload(`m${i}`, correlationId, `msg-${i}`), correlationId)
      )
    )

    expect(durableEvents).toHaveLength(10)
    const result = await getTimeline(correlationId).verifyChain()
    expect(result).toEqual({ valid: true })
    // Exactly one genesis root, no matter how many writers raced for it.
    expect(durableEvents.filter((e) => e.prevHash === GENESIS_HASH)).toHaveLength(1)
  })

  it('the advisory-lock mock genuinely serializes the SAME key - proof the fixture itself isn\'t just trivially fast (a sanity check on the test double, not on production code)', async () => {
    const key = `lock-sanity-${Date.now()}`
    const order: string[] = []

    const first = acquireLock(key).then((release) => {
      order.push('first-acquired')
      return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
        order.push('first-released')
        release()
      })
    })
    // Give `first` a tick's head start so it acquires before `second` even
    // tries - otherwise both would race for the initial `lockQueue.get()`
    // read with no guaranteed winner, which isn't what this sanity check
    // is verifying (JS's synchronous-until-first-await semantics already
    // guarantee that for the real store.publish() case above; here we
    // only need to prove the queue mechanism itself blocks correctly).
    await tick(1)
    const second = acquireLock(key).then((release) => {
      order.push('second-acquired')
      release()
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first-acquired', 'first-released', 'second-acquired'])
  })
})

describe('PostgresEventStore - correlationId isolation (Missao 05.8: different correlationIds never wait on each other)', () => {
  it('a slow write for correlationId X does not block a concurrent write for a different correlationId Y', async () => {
    const correlationIdX = `pg-iso-x-${Date.now()}`
    const correlationIdY = `pg-iso-y-${Date.now()}`
    const store = new PostgresEventStore()

    let releaseX!: () => void
    const xGate = new Promise<void>((resolve) => { releaseX = resolve })
    const realCreateImpl = mockCreate.getMockImplementation()!
    mockCreate.mockImplementation(async (args: any) => {
      if (args.data.correlationId === correlationIdX) await xGate
      return realCreateImpl(args)
    })

    const xPromise = store.publish('openp2p.message.sent', messagePayload('mx', correlationIdX, 'blocked'), correlationIdX)
    const yPromise = store.publish('openp2p.message.sent', messagePayload('my', correlationIdY, 'unblocked'), correlationIdY)

    // Y must resolve on its own - if the lock were accidentally global
    // (not keyed per-correlationId), Y would hang on X's still-open gate
    // and this race would time out instead of resolving with yPromise.
    const winner = await Promise.race([
      yPromise.then(() => 'y'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ])
    expect(winner).toBe('y')

    releaseX()
    await xPromise
    mockCreate.mockImplementation(realCreateImpl)

    expect(durableEvents.find((e) => e.correlationId === correlationIdX)).toBeDefined()
    expect(durableEvents.find((e) => e.correlationId === correlationIdY)).toBeDefined()
    expect((await getTimeline(correlationIdX).verifyChain())).toEqual({ valid: true })
    expect((await getTimeline(correlationIdY).verifyChain())).toEqual({ valid: true })
  })

  it('many correlationIds writing concurrently all complete independently, none forked', async () => {
    const store = new PostgresEventStore()
    const correlationIds = Array.from({ length: 8 }, (_, i) => `pg-iso-many-${Date.now()}-${i}`)

    await Promise.all(
      correlationIds.flatMap((correlationId) => [
        store.publish('openp2p.message.sent', messagePayload('a', correlationId, 'first'), correlationId),
        store.publish('openp2p.message.sent', messagePayload('b', correlationId, 'second'), correlationId),
      ])
    )

    for (const correlationId of correlationIds) {
      const events = durableEvents.filter((e) => e.correlationId === correlationId)
      expect(events).toHaveLength(2)
      const result = await getTimeline(correlationId).verifyChain()
      expect(result).toEqual({ valid: true })
    }
  })
})

describe('PostgresEventStore - restart survival (Missao 05.7, the definitive proof)', () => {
  // The whole point of the original mission: prove the chain's integrity
  // survives not just "while this process is alive" (already covered by
  // every test above, which all share the process-lifetime `eventBus`
  // singleton) but "after the process died and a brand new one started."
  // Missao 05.8's advisory lock doesn't change this: it's acquired and
  // released entirely within a single publish() call's own transaction,
  // so it carries no state across a restart either.
  //
  // A literal process restart isn't reachable from inside a Jest run, so
  // this simulates the one thing that actually matters architecturally:
  // discarding every in-process JS object that held any state (the old
  // SailsEventBus, the old PostgresEventStore instance, any of their
  // internal fields) and constructing entirely fresh ones that share
  // NOTHING with the old objects except the durable backing store - here,
  // the mocked prisma.durableEventRecord table (in production, the real
  // Postgres database, which persists independently of any Node
  // process's lifetime). PostgresEventStore itself holds no in-process
  // cache (unlike InMemoryEventStore's own byCorrelationId Map) - every
  // publish()/getEvents() call already goes straight to the client, so a
  // fresh instance has no way to "remember" anything except by reading it
  // back from that shared store, which is exactly what this proves.
  it('a fresh SailsEventBus, sharing no in-process state with the one that wrote the events, reads back the same events with a valid chain', async () => {
    const correlationId = `pg-restart-${Date.now()}`

    // "Before restart" - the original bus (the module singleton) writes.
    await eventBus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'first'), correlationId)
    await tick()
    await eventBus.emit('openp2p.message.sent', messagePayload('m2', correlationId, 'second'), correlationId)
    const beforeRestart = await eventBus.getEvents(correlationId)

    // "Restart" - a brand new SailsEventBus, constructed the same way
    // event-bus.ts's own module scope constructs the real singleton (no
    // arguments - its default parameter builds a fresh PostgresEventStore()),
    // sharing zero references with the bus/store objects used above.
    const revivedBus = new SailsEventBus()
    expect(revivedBus).not.toBe(eventBus)

    const afterRestart = await revivedBus.getEvents(correlationId)

    expect(afterRestart).toEqual(beforeRestart)
    expect(afterRestart).toHaveLength(2)

    // verifyChain()'s own logic, run against the revived bus directly
    // (not through core/timeline.ts's getTimeline(), which is hardwired
    // to the module singleton - out of this mission's scope to change).
    // Same two checks Timeline.verifyChain() performs, reused here via
    // the same exported computeEntryHash()/GENESIS_HASH this mission was
    // explicitly told to reuse rather than reinvent.
    let expectedPrevHash = GENESIS_HASH
    for (const event of afterRestart) {
      const recomputed = computeEntryHash(event.eventName, event.publishedAt, event.payload, event.prevHash)
      expect(event.prevHash).toBe(expectedPrevHash)
      expect(event.entryHash).toBe(recomputed)
      expectedPrevHash = event.entryHash
    }

    // And the same proof through the real, unmodified getTimeline() API
    // the CTO's own spec named literally - reaching into the singleton's
    // own store field to substitute a freshly constructed store is the
    // same `as any` pattern tests/timeline.test.ts already established
    // for this exact class of test, applied here to prove the identical
    // property one layer up, through Timeline's real code path.
    const originalStore = (eventBus as any).store
    ;(eventBus as any).store = new PostgresEventStore()
    try {
      const timelineResult = await getTimeline(correlationId).verifyChain()
      expect(timelineResult).toEqual({ valid: true })
      const timelineEntries = await getTimeline(correlationId).getEvents()
      expect(timelineEntries).toHaveLength(2)
      expect(timelineEntries[0].payload).toMatchObject({ content: 'first' })
      expect(timelineEntries[1].payload).toMatchObject({ content: 'second' })
    } finally {
      ;(eventBus as any).store = originalStore
    }
  })
})

// E21 slice 1 (CTO 24 6811766719) - the additive transactional API. Real PostgreSQL proof (lock held to the caller's
// commit, rollback, one chain) lives in tests/integration/tradeAdmissionAtomicity.test.ts; these pin the contract.
describe('PostgresEventStore.publishInTransaction() / dispatchCommitted() and the fail-closed facade (E21 slice 1)', () => {
  it('writes through the CALLER transaction with the same lock and chain as publish(), and dispatches nothing until dispatchCommitted()', async () => {
    const store = new PostgresEventStore()
    const bus = new SailsEventBus(store)
    const correlationId = `e21-${Date.now()}`
    const received: string[] = []
    bus.onDurable('openp2p.message.sent', (e) => { received.push(e.eventId) })

    // The caller's transaction client. PostgreSQL's transaction-level advisory lock is re-entrant for the same
    // transaction (this file's FIFO lock double is not), so this one only records the lock calls.
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0), durableEventRecord: mockDurableEventRecordDelegate } as any
    const first: any = await bus.publishInTransaction(tx, 'openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId)
    await tick()
    const second: any = await bus.publishInTransaction(tx, 'openp2p.message.sent', messagePayload('m2', correlationId, 'b'), correlationId)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2) // pg_advisory_xact_lock(hashtext(correlationId)) per event
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([correlationId])
    expect(mockTransaction).not.toHaveBeenCalled() // never a transaction of its own
    expect(received).toEqual([])
    expect(first.prevHash).toBe(GENESIS_HASH)
    expect(second.prevHash).toBe(first.entryHash)
    expect(second.entryHash).toBe(computeEntryHash('openp2p.message.sent', second.publishedAt, second.payload, first.entryHash))
    expect(await bus.getEvents(correlationId)).toEqual([first, second])

    bus.dispatchCommitted(first)
    bus.dispatchCommitted(second)
    expect(received).toEqual([first.eventId, second.eventId])
  })

  it('publish() keeps its contract: it opens its own transaction and dispatches after it', async () => {
    const bus = new SailsEventBus(new PostgresEventStore())
    const correlationId = `e21-plain-${Date.now()}`
    const received: string[] = []
    bus.onDurable('openp2p.message.sent', (e) => { received.push(e.correlationId) })
    await bus.emit('openp2p.message.sent', messagePayload('m1', correlationId, 'a'), correlationId)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(received).toEqual([correlationId])
  })

  it('a store that cannot join a PostgreSQL transaction fails closed: nothing is written and nothing is dispatched', async () => {
    const { InMemoryEventStore } = jest.requireActual('../src/common/events/event-store')
    const bus = new SailsEventBus(new InMemoryEventStore())
    const received: unknown[] = []
    bus.on('openp2p.message.sent', (p) => { received.push(p) })
    const tx = { $executeRaw: jest.fn(), durableEventRecord: mockDurableEventRecordDelegate } as any

    await expect(bus.publishInTransaction(tx, 'openp2p.message.sent', messagePayload('m1', 'c1', 'a'), 'c1'))
      .rejects.toThrow(/cannot publish inside a database transaction/)
    expect(() => bus.dispatchCommitted({ eventId: 'e', eventName: 'openp2p.message.sent', correlationId: 'c1', payload: messagePayload('m1', 'c1', 'a'), publishedAt: '', entryHash: '', prevHash: '' }))
      .toThrow(/cannot publish inside a database transaction/)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(received).toEqual([])
  })
})
