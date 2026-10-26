// Real-network sanity check against the PUBLIC HyperDHT (default bootstrap nodes), with throwaway random keys.
// It sends UDP to third-party bootstrap nodes and announces one random key for about a minute; nothing else leaves.
// Two containers on Docker's default NAT, behind this machine's home NAT: they share ONE public IP, so this proves
// "reaches the public DHT and connects", NOT that two different home networks can hole-punch each other.
//   node natlab/public.mjs
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const IMAGE = 'ppr-natlab:dev'
const DIR = path.resolve(import.meta.dirname)
const sh = (a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryDocker = (a) => { try { return sh(a) } catch { return null } }
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])

const script = `
import DHT from 'hyperdht'
import b4a from 'b4a'
const role = process.env.ROLE
const dht = new DHT()
await dht.ready()
const info = () => ({ nodes: dht.nodes.length, firewalled: dht.firewalled, host: dht.host })
if (role === 'server') {
  const kp = DHT.keyPair()
  const srv = dht.createServer((s) => { s.on('error', () => {}); s.on('data', (d) => s.write(b4a.concat([b4a.from('pong:'), d]))) })
  await srv.listen(kp)
  console.log(JSON.stringify({ role, key: b4a.toString(kp.publicKey, 'hex'), dht: info() }))
  setInterval(() => {}, 1 << 30)
} else {
  const t0 = Date.now()
  const s = dht.connect(b4a.from(process.env.KEY, 'hex'))
  const end = (o) => { console.log(JSON.stringify({ role, ...o, dht: info(), ms: Date.now() - t0 })); process.exit(0) }
  s.on('error', (e) => end({ ok: false, error: e.code ?? e.message }))
  s.on('open', () => { s.write(b4a.from('ping')); s.on('data', (d) => end({ ok: b4a.toString(d) === 'pong:ping', remoteHost: s.rawStream?.remoteHost })) })
  setTimeout(() => end({ ok: false, error: 'TIMEOUT' }), 50000)
}
`
for (const c of ['ppub-server', 'ppub-client']) tryDocker(['rm', '-f', c])
const mk = (name, env) => sh(['run', '-d', '--name', name, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '-v', `${DIR}:/w/natlab:ro`, '-w', '/w', IMAGE, 'node', '--input-type=module', '-e', script])
mk('ppub-server', { ROLE: 'server' })
let key = null
for (let i = 0; i < 60 && !key; i++) {
  sleep(1000)
  const l = (tryDocker(['logs', 'ppub-server']) ?? '').split('\n').find((x) => x.includes('"key"'))
  if (l) key = JSON.parse(l).key
}
console.log('server', tryDocker(['logs', 'ppub-server']))
sleep(5000)
mk('ppub-client', { ROLE: 'client', KEY: key })
let res = null
for (let i = 0; i < 70 && !res; i++) {
  sleep(1000)
  res = (tryDocker(['logs', 'ppub-client']) ?? '').split('\n').find((x) => x.includes('"role":"client"'))
}
console.log('client', res)
for (const c of ['ppub-server', 'ppub-client']) tryDocker(['rm', '-f', c])
