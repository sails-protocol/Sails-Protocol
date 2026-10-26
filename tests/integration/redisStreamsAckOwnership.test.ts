// tests/integration/redisStreamsAckOwnership.test.ts
//
// Redis Gate 2 (ACK ownership / fencing at the consumer): a consumer may ACK only an entry that is pending UNDER ITS OWN NAME.
//
// Redis accepts an XACK from anybody for any pending id. After an XCLAIM, the PREVIOUS owner (a slow, stale consumer) can therefore
// ACK the entry the NEW owner is still processing: the entry leaves the pending list while the new owner's handler runs, so if that
// handler then fails nothing is left to retry it. RedisStreamsEventStore now ACKs through a script that XACKs only when
// XPENDING lists the entry for this consumer, atomically. (A client with Redis credentials that is not one of our consumers can still
// call XACK itself: that needs Redis ACLs, a deployment decision, and is NOT closed here.)
//
// Skips gracefully without a reachable Redis, like redisStreamsEventStore.test.ts. REDIS_URL selects the instance.

import Redis from 'ioredis'
import { RedisStreamsEventStore, type DurableEvent } from '../../src/common/events/event-store'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await cond()) return; await sleep(25) }
  throw new Error('timed out waiting for condition')
}

describe('RedisStreamsEventStore: ACK only by the current owner of the entry (real Redis)', () => {
  jest.setTimeout(60_000)

  let admin: Redis
  const clients: Redis[] = []
  const stores: RedisStreamsEventStore[] = []
  let available = false

  const mk = () => { const c = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true, connectTimeout: 5000, disconnectTimeout: 10 }); clients.push(c); return c }

  beforeAll(async () => {
    admin = mk()
    try { await admin.connect(); await admin.ping(); available = true } catch { available = false }
  })

  afterEach(async () => {
    while (stores.length) await stores.pop()!.stop()
  })

  afterAll(async () => {
    for (const c of clients) { if (available) await c.quit().catch(() => c.disconnect()); else c.disconnect() }
  })

  const pending = async (stream: string, group: string) => {
    const summary = (await admin.xpending(stream, group)) as [number, string | null, string | null, Array<[string, string]> | null]
    return { count: Number(summary[0]), owners: Object.fromEntries((summary[3] ?? []).map(([name, n]) => [name, Number(n)])) }
  }

  it('a stale owner that finishes after the entry was claimed by another consumer does NOT remove the new owner\'s pending entry', async () => {
    if (!available) { console.warn('Skipping: no Redis reachable at ' + REDIS_URL); return }
    const group = `own-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const correlationId = `own-corr-${Date.now()}`
    // Two consumers of the same group, as two application instances. A reclaims nothing (long idle); B reclaims quickly.
    const storeA = new RedisStreamsEventStore(mk(), group, 60_000, 100)
    const storeB = new RedisStreamsEventStore(mk(), group, 400, 100)
    stores.push(storeA, storeB)

    let releaseA!: () => void; const aGate = new Promise<void>((r) => { releaseA = r })
    let releaseB!: () => void; const bGate = new Promise<void>((r) => { releaseB = r })
    const aStarted = jest.fn(); const bStarted = jest.fn()
    const handler = (name: 'A' | 'B') => async (_e: DurableEvent<any>) => { (name === 'A' ? aStarted : bStarted)(); await (name === 'A' ? aGate : bGate) }

    storeA.subscribe('openp2p.message.sent', handler('A'))
    await sleep(300) // the group exists before the first publish ('$')
    await storeA.publish('openp2p.message.sent', { messageId: 'm-own', tradeId: correlationId, senderId: 'u1', content: 'x', msgType: 'TEXT', timestamp: new Date().toISOString() } as any, correlationId)
    await until(async () => aStarted.mock.calls.length === 1) // A has the entry and is "slow"

    storeB.subscribe('openp2p.message.sent', handler('B'))
    await until(async () => bStarted.mock.calls.length === 1) // B reclaimed it after the idle threshold and is processing it
    const stream = 'sails:events:openp2p.message.sent'
    const owned = await pending(stream, group)
    expect(owned.count).toBe(1)
    expect(Object.keys(owned.owners)).toHaveLength(1)
    const [bName] = Object.keys(owned.owners)

    try {
      releaseA() // the STALE owner finishes and tries to ACK
      await sleep(500)
      const afterStaleAck = await pending(stream, group)
      expect({ count: afterStaleAck.count, owners: Object.keys(afterStaleAck.owners) }).toEqual({ count: 1, owners: [bName] }) // still B's

      releaseB() // the real owner finishes: now it is acknowledged
      await until(async () => (await pending(stream, group)).count === 0)
    } finally {
      releaseA(); releaseB() // never leave a handler blocked: stop() in afterEach waits for the poll loops
    }
  })
})
