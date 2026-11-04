// Real HyperDHT / Hyperswarm over a LOCAL testnet (loopback only, no public DHT).
import test from 'node:test'
import assert from 'node:assert/strict'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { NOW, fixedSource, world } from './_helpers.mjs'

const AUD = 'market.example'
const within = (p, ms, label) => Promise.race([p, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout: ' + label)), ms))])

function lines (socket) {
  const queue = []
  const waiting = []
  let buf = ''
  socket.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      const w = waiting.shift()
      if (w) w(line); else queue.push(line)
    }
  })
  return () => new Promise((resolve) => { const q = queue.shift(); if (q) resolve(q); else waiting.push(resolve) })
}
const send = (socket, obj) => socket.write(JSON.stringify(obj) + '\n')

// Verifier role on the server side of a HyperDHT connection.
function verifierHandler (w, revocations, challenges, seen) {
  return async (socket) => {
    socket.on('error', () => {})
    const next = lines(socket)
    const ch = challenges.issue(AUD, NOW)
    send(socket, { challenge: ch })
    const msg = await next()
    const remote = w.kdf.hex(socket.remotePublicKey)
    let res
    if (remote !== msg.cert.body.pear) {
      res = { ok: false, reason: 'transport-key-mismatch' }
    } else {
      res = await w.verify.verifySession({ cert: msg.cert, pop: msg.pop, challenge: ch, audience: AUD, now: NOW, expectedSub: w.identity.z32, requiredScope: 'pear:connect', revocations, challenges })
    }
    seen.push({ remote, res })
    send(socket, res.ok ? { ok: true } : { ok: false, reason: res.reason })
    socket.end()
  }
}

async function setup (t, { statements = [] } = {}) {
  const w = await world()
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const seen = []
  const verifierKey = DHT.keyPair(b4a.alloc(32, 0xaa)) // verifier's own transport key: test only
  const serverDht = new DHT({ bootstrap: testnet.bootstrap })
  t.after(() => serverDht.destroy())
  const revocations = new w.verify.RevocationChecker({ source: fixedSource(statements) })
  const server = serverDht.createServer(verifierHandler(w, revocations, new w.verify.ChallengeStore(), seen))
  await server.listen(verifierKey)
  t.after(() => server.close())
  const connectAs = async (device, cert) => {
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    t.after(() => dht.destroy())
    const socket = dht.connect(verifierKey.publicKey, { keyPair: device.keyPair })
    socket.on('error', () => {})
    const next = lines(socket)
    const { challenge } = await within(next(), 15000, 'challenge')
    send(socket, { cert, pop: w.issue.makePop(device, cert, challenge) })
    const reply = await within(next(), 15000, 'reply')
    socket.destroy()
    return reply
  }
  return { w, testnet, seen, connectAs }
}

const authorize = (w, device, extra = {}) => w.issue.issueAuthorization(w.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: ['pear:connect', 'chat:send'], now: NOW, ttlSec: 3600, ...extra })

test('real HyperDHT: an authorized Pear session is accepted and the peer key seen on the wire is the authorized one', async (t) => {
  const { w, connectAs, seen } = await setup(t)
  const device = w.mkDevice('phone-1')
  const reply = await connectAs(device, authorize(w, device))
  assert.deepEqual(reply, { ok: true })
  assert.equal(seen[0].remote, w.kdf.hex(device.publicKey))
})

test('real HyperDHT: a revoked device is refused over a live connection', async (t) => {
  const w0 = await world()
  const device = w0.mkDevice('phone-1')
  const cert = authorize(w0, device)
  const rev = w0.issue.issueRevocation(w0.identity, { targets: { auth: cert.body.id }, now: NOW + 1 })
  const { connectAs, seen } = await setup(t, { statements: [rev] })
  const reply = await connectAs(device, cert)
  assert.deepEqual(reply, { ok: false, reason: 'revoked' })
  assert.equal(seen[0].res.ok, false)
})

test('real HyperDHT: presenting a victim certificate from an attacker transport key is refused', async (t) => {
  const { w, connectAs } = await setup(t)
  const victim = w.mkDevice('phone-1')
  const attacker = w.kdf.pearKeyPairFromSeed(b4a.alloc(32, 0x42))
  const reply = await connectAs(attacker, authorize(w, victim))
  assert.deepEqual(reply, { ok: false, reason: 'transport-key-mismatch' })
})

test('reinstall over the real transport: unified root keeps the same peer key; native (random) key does not', async (t) => {
  const { w, connectAs, seen } = await setup(t)
  const before = w.mkDevice('phone-1')
  await connectAs(before, authorize(w, before))
  // "Reinstall": drop every object, rebuild from the mnemonic only.
  const w2 = await world(w.kdf.mnemonicToRoot(w.kdf.rootToMnemonic(w.root)))
  const after = w2.mkDevice('phone-1')
  assert.deepEqual(await connectAs(after, w2.issue.issueAuthorization(w2.identity, { pearPublicKey: after.publicKey, deviceId: 'phone-1', scope: ['pear:connect'], now: NOW, ttlSec: 3600 })), { ok: true })
  assert.equal(seen[0].remote, seen[1].remote, 'unified: stable peer key across reinstall')
  const randomAfter = w.kdf.pearKeyPairFromSeed(new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(32))))
  assert.notEqual(w.kdf.hex(randomAfter.publicKey), seen[0].remote, 'native: a new random key is a different peer')
})

test('infrastructure unavailable: connecting with no reachable DHT fails within a bounded time', async (t) => {
  const w = await world()
  const dht = new DHT({ bootstrap: ['127.0.0.1:1'] })
  t.after(() => dht.destroy())
  const socket = dht.connect(DHT.keyPair(b4a.alloc(32, 0xaa)).publicKey, { keyPair: w.mkDevice('phone-1').keyPair })
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 12000)
    socket.on('error', () => { clearTimeout(timer); resolve('error') })
    socket.on('open', () => { clearTimeout(timer); resolve('open') })
    socket.on('close', () => { clearTimeout(timer); resolve('close') })
  })
  assert.notEqual(outcome, 'open')
  socket.destroy()
})

test('Hyperswarm accepts the derived Pear key as the swarm identity', async (t) => {
  const w = await world()
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const a = w.mkDevice('phone-1')
  const b = w.mkDevice('laptop-1')
  const swarmA = new Hyperswarm({ keyPair: a.keyPair, bootstrap: testnet.bootstrap })
  const swarmB = new Hyperswarm({ keyPair: b.keyPair, bootstrap: testnet.bootstrap })
  t.after(async () => { await swarmA.destroy(); await swarmB.destroy() })
  const topic = b4a.alloc(32, 0x07)
  const got = new Promise((resolve) => swarmB.on('connection', (socket) => { socket.on('error', () => {}); resolve(w.kdf.hex(socket.remotePublicKey)) }))
  swarmA.on('connection', (socket) => socket.on('error', () => {}))
  await swarmA.join(topic, { server: true, client: false }).flushed()
  swarmB.join(topic, { server: false, client: true })
  assert.equal(await within(got, 20000, 'swarm connection'), w.kdf.hex(a.publicKey))
})
