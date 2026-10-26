// One HyperDHT participant of the NAT lab. ROLE=bootstrap|relay|server|client
import DHT from 'hyperdht'
import relay from 'blind-relay'
import b4a from 'b4a'

const role = process.env.ROLE
const BOOT_HOST = process.env.BOOT_HOST ?? '30.31.0.10'
const BOOT = `${BOOT_HOST}:49737`
const serverKey = DHT.keyPair(b4a.alloc(32, 0xaa))
const relayKey = DHT.keyPair(b4a.alloc(32, 0xbb))
const log = (o) => console.log(JSON.stringify({ role, ...o }))

if (role === 'bootstrap') {
  const b = DHT.bootstrapper(49737, BOOT_HOST)
  await b.ready()
  const nodes = []
  for (let i = 0; i < 4; i++) { const n = new DHT({ bootstrap: [BOOT], ephemeral: false, firewalled: false }); await n.ready(); nodes.push(n) }
  log({ ready: true, bootstrap: BOOT, nodes: nodes.length })
  setInterval(() => {}, 1 << 30)
} else if (role === 'relay') {
  const dht = new DHT({ bootstrap: [BOOT], ephemeral: false, firewalled: false })
  const blind = new relay.Server({ createStream: (opts) => dht.createRawStream(opts) })
  const srv = dht.createServer((socket) => { blind.accept(socket, { id: socket.remotePublicKey }) })
  await srv.listen(relayKey)
  log({ ready: true, relayKey: b4a.toString(relayKey.publicKey, 'hex') })
  setInterval(() => {}, 1 << 30)
} else if (role === 'server') {
  const dht = new DHT({ bootstrap: [BOOT] })
  const srv = dht.createServer({ relayThrough: process.env.USE_RELAY ? relayKey.publicKey : undefined }, (socket) => {
    socket.on('error', () => {})
    socket.on('data', (d) => socket.write(b4a.concat([b4a.from('pong:'), d])))
    log({ peer: 'connected', remoteHost: socket.rawStream?.remoteHost })
  })
  await srv.listen(serverKey)
  log({ ready: true, serverKey: b4a.toString(serverKey.publicKey, 'hex'), dht: { nodes: dht.nodes.length, firewalled: dht.firewalled, host: dht.host, port: dht.port, randomized: dht.randomized } })
  setInterval(() => {}, 1 << 30)
} else if (role === 'client') {
  const dht = new DHT({ bootstrap: [BOOT] })
  await dht.ready()
  log({ dht: { nodes: dht.nodes.length, firewalled: dht.firewalled, host: dht.host, port: dht.port, randomized: dht.randomized } })
  const t0 = Date.now()
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 45000)
  const socket = dht.connect(serverKey.publicKey, { relayThrough: process.env.USE_RELAY ? relayKey.publicKey : undefined })
  let done = false
  const finish = (o) => { if (done) return; done = true; log({ ...o, ms: Date.now() - t0 }); dht.destroy().finally(() => process.exit(0)) }
  socket.on('error', (e) => finish({ ok: false, error: String(e.code ?? e.message), message: String(e.message), fw: dht.io?.firewalled }))
  socket.on('open', () => {
    socket.write(b4a.from('ping'))
    socket.on('data', (d) => finish({ ok: b4a.toString(d) === 'pong:ping', remoteHost: socket.rawStream?.remoteHost, remotePort: socket.rawStream?.remotePort, relayed: !!process.env.USE_RELAY }))
  })
  setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), timeoutMs)
}
