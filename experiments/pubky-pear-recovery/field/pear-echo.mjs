// FIELD KIT - Pear connectivity probe for two machines on DIFFERENT networks (home / mobile hotspot / office).
// Throwaway keys. Default mode talks to the PUBLIC HyperDHT bootstrap nodes (third-party infrastructure: use only with the
// operator's authorization; the CTO's decision on #545 authorizes the experiment, not abuse).
//   node field/pear-echo.mjs --role server                      -> prints the server key
//   node field/pear-echo.mjs --role client --key <hex> [--pings 20] [--interval 2000] [--relay <hex>] [--reconnect 3]
//   --local-testnet : self-test on loopback (no public network)
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const flag = (k) => process.argv.includes(`--${k}`)
const role = arg('role')
const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), role, ...o }))
let testnet = null
let bootstrap = arg('bootstrap')?.split(',')
if (flag('local-testnet')) { testnet = await createTestnet(3); bootstrap = testnet.bootstrap }
const relay = arg('relay') ? b4a.from(arg('relay'), 'hex') : undefined
const mkDht = () => new DHT(bootstrap ? { bootstrap } : {})

const kind = (h) => !h ? 'unknown' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h) ? 'private/LAN' : 'public'

async function server (dht, keyPair) {
  const srv = dht.createServer({ relayThrough: relay }, (s) => {
    out({ event: 'connection', remoteHostClass: kind(s.rawStream?.remoteHost) })
    s.on('error', (e) => out({ event: 'conn-error', error: e.code ?? e.message }))
    s.on('close', () => out({ event: 'conn-closed' }))
    s.on('data', (d) => s.write(b4a.concat([b4a.from('pong:'), d])))
  })
  await srv.listen(keyPair)
  out({ event: 'listening', key: b4a.toString(keyPair.publicKey, 'hex'), nodes: dht.nodes.length, firewalled: dht.firewalled })
}

async function client (dht, key) {
  const pings = Number(arg('pings', 20)); const interval = Number(arg('interval', 2000)); let reconnects = Number(arg('reconnect', 3))
  const t0 = Date.now()
  while (true) {
    const s = dht.connect(key, { relayThrough: relay })
    const result = await new Promise((resolve) => {
      let sent = 0; let rtts = []
      s.on('error', (e) => resolve({ ok: false, error: e.code ?? e.message }))
      s.on('close', () => resolve({ ok: sent > 0, closed: true, rtts }))
      s.on('open', () => {
        out({ event: 'open', ms: Date.now() - t0, remoteHostClass: kind(s.rawStream?.remoteHost), relayed: !!relay })
        const tick = setInterval(() => { if (sent >= pings) { clearInterval(tick); s.end(); return } sent++; s.write(b4a.from(String(Date.now()))) }, interval)
      })
      s.on('data', (d) => { const sentAt = Number(b4a.toString(d).split(':')[1]); rtts.push(Date.now() - sentAt); if (rtts.length >= pings) resolve({ ok: true, rtts }) })
      setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 60000)
    })
    if (result.rtts) { const r = result.rtts.sort((a, b) => a - b); out({ event: 'summary', pings: r.length, rttMs: { min: r[0], median: r[r.length >> 1], max: r[r.length - 1] } }) } else out({ event: 'failed', ...result })
    s.destroy()
    if (result.ok || reconnects-- <= 0) break
    out({ event: 'reconnecting' })
  }
}

const dht = mkDht()
await dht.ready()
out({ event: 'dht-ready', nodes: dht.nodes.length, firewalled: dht.firewalled, publicHostSeen: !!dht.host })
if (role === 'server') { await server(dht, DHT.keyPair(arg('seed') ? b4a.from(arg('seed'), 'hex') : undefined)); if (!flag('local-testnet')) setInterval(() => {}, 1 << 30) }
else if (role === 'client') { await client(dht, b4a.from(arg('key'), 'hex')); await dht.destroy(); process.exit(0) }
else if (flag('local-testnet')) {
  const kp = DHT.keyPair()
  await server(dht, kp)
  const c = new DHT({ bootstrap })
  await client(c, kp.publicKey); await c.destroy(); await dht.destroy(); await testnet.destroy(); process.exit(0)
}
