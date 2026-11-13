// Redis Gate 2 probe: what Redis itself guarantees (and does not) for the facts the Streams event store (src/common/events/event-store.ts)
// relies on: who may ACK, what a claim does to the previous owner, and how a message's origin is identified.
// Throwaway Redis only. node ack-fencing-probe.js <redis-url> <path-to-a-node_modules-with-ioredis>
const path = require('path')
const Redis = require(path.join(process.argv[3], 'ioredis'))
const url = process.argv[2]
const out = []
const rec = (id, observed, meaning) => { out.push({ id, observed, meaning }); console.log(`${id}: ${observed}\n    -> ${meaning}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mk = () => new Redis(url, { maxRetriesPerRequest: 1 })
  const admin = mk(), consumerA = mk(), consumerB = mk(), stranger = mk()
  const stream = `gate2:probe:${Date.now()}`, group = 'sails-workers'
  await admin.xgroup('CREATE', stream, group, '$', 'MKSTREAM')
  const id1 = await admin.xadd(stream, '*', 'payload', 'event-1')

  // A1: A reads the message (it is pending under A). A client that never read it, and is not a consumer of the group at all,
  // ACKs it. Redis accepts: the ACK is authenticated by nothing but the group name and the message id.
  await consumerA.xreadgroup('GROUP', group, 'consumer-A', 'COUNT', 1, 'STREAMS', stream, '>')
  const pendingBefore = (await admin.xpending(stream, group))[0]
  const strangerAck = await stranger.xack(stream, group, id1)
  const pendingAfter = (await admin.xpending(stream, group))[0]
  rec('A1 ACK authenticity', `pending ${pendingBefore} -> ${pendingAfter}; XACK by a client that never read the entry returned ${strangerAck}`,
    'any client able to reach Redis with the group name can mark another consumer\'s in-flight message as done; the handler may still be running or may fail afterwards, and the message is then lost to recovery (no pending entry left)')

  // A2: stale owner after XCLAIM. A reads, goes idle, B claims it, then the STALE owner A ACKs.
  const id2 = await admin.xadd(stream, '*', 'payload', 'event-2')
  await consumerA.xreadgroup('GROUP', group, 'consumer-A', 'COUNT', 1, 'STREAMS', stream, '>')
  await sleep(150)
  const claimed = await consumerB.xclaim(stream, group, 'consumer-B', 100, id2)
  const owner = (await admin.xpending(stream, group, '-', '+', 10, 'consumer-B')).map(e => e[1])
  const staleAck = await consumerA.xack(stream, group, id2)
  const left = (await admin.xpending(stream, group))[0]
  rec('A2 fencing after XCLAIM', `B claimed ${claimed.length} entry (owner ${owner[0]}); the stale consumer A then ACKed it: returned ${staleAck}; pending left ${left}`,
    'XCLAIM moves ownership but gives the previous owner no fence: its late ACK still succeeds and drops B\'s in-flight entry. There is no fencing token, only a delivery counter, so "exactly one live owner" is not enforced by Redis')

  // A3: the delivery counter is the only per-delivery number Redis keeps.
  const id3 = await admin.xadd(stream, '*', 'payload', 'event-3')
  await consumerA.xreadgroup('GROUP', group, 'consumer-A', 'COUNT', 1, 'STREAMS', stream, '>')
  await sleep(120)
  await consumerB.xclaim(stream, group, 'consumer-B', 100, id3)
  const info = await admin.xpending(stream, group, '-', '+', 10)
  const row = info.find(e => e[0] === id3)
  rec('A3 what Redis records', `entry owner=${row[1]} idleMs=${row[2]} deliveries=${row[3]}`,
    'the owner is the consumer NAME the client chose (`${group}-${pid}-${uuid8}` in event-store.ts), not an authenticated identity; deliveries is a counter, not a token a handler could present')

  // A4: instance identity: the cross-instance channel carries the origin id inside the message, unauthenticated.
  const sub = mk(), pub = mk(); const seen = []
  await sub.subscribe('gate2:probe:channel'); sub.on('message', (_c, m) => seen.push(JSON.parse(m)))
  const victim = 'victim-instance-uuid'
  await pub.publish('gate2:probe:channel', JSON.stringify({ eventName: 'x', __originInstanceId: victim }))
  await pub.publish('gate2:probe:channel', JSON.stringify({ eventName: 'y', __originInstanceId: victim }))
  await sleep(200)
  rec('A4 instance identity', `${seen.length} messages published by a third client carried __originInstanceId="${victim}" unchallenged`,
    'event-store.ts drops any cross-instance message whose __originInstanceId equals its own random uuid (self-echo suppression); the id appears in every message, so a client with publish rights can copy it and make the victim instance ignore chosen events')

  for (const c of [admin, consumerA, consumerB, stranger, sub, pub]) await c.quit().catch(() => c.disconnect())
  require('fs').writeFileSync(path.join(__dirname, 'ack-fencing-probe.result.json'), JSON.stringify({ redisUrlHost: new URL(url).host, results: out }, null, 2))
})().catch(e => { console.error(e.message); process.exit(1) })
