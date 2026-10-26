// NAT lab: two peers, each behind its own Linux NAT router (iptables MASQUERADE), on isolated docker networks with a
// private HyperDHT (bootstrap + non-ephemeral nodes) and an optional blind relay on the "public" side (30.31.0.0/24 is NOT a real route here: the network is --internal; the prefix only has to look public because HyperDHT ignores private addresses). No egress.
//   node natlab/run.mjs build | matrix | down
// cone = MASQUERADE (keeps the source port when free: endpoint-independent mapping)
// symmetric = MASQUERADE --random (new source port per destination: endpoint-dependent mapping)
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const IMAGE = 'ppr-natlab:dev'
const NAT_DIR = path.resolve(import.meta.dirname)
const PUB = { name: 'pnat-pub', subnet: '30.31.0.0/24' }
const LAN = { a: { name: 'pnat-a', subnet: '10.31.1.0/24', gw: '10.31.1.2', peer: '10.31.1.10', pubIp: '30.31.0.2' }, b: { name: 'pnat-b', subnet: '10.31.2.0/24', gw: '10.31.2.2', peer: '10.31.2.10', pubIp: '30.31.0.3' } }
const sh = (args, o = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim()
const tryDocker = (args) => { try { return sh(args) } catch (e) { return null } }
const mount = ['-v', `${NAT_DIR}:/w/natlab:ro`]

function down () {
  for (const c of ['pnat-boot', 'pnat-relay', 'pnat-natA', 'pnat-natB', 'pnat-server', 'pnat-client']) tryDocker(['rm', '-f', c])
  for (const n of [PUB.name, LAN.a.name, LAN.b.name]) tryDocker(['network', 'rm', n])
}

function build () {
  const df = `FROM ppr-runner:dev\nRUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables procps && rm -rf /var/lib/apt/lists/*\n`
  execFileSync('docker', ['build', '-q', '-t', IMAGE, '-'], { input: df, stdio: ['pipe', 'inherit', 'inherit'] })
}

function infra () {
  down()
  sh(['network', 'create', '--internal', '--subnet', PUB.subnet, PUB.name])
  // LAN side is NOT --internal: Docker's isolation rules for internal networks drop packets whose destination is outside the subnet even when the next hop is our router.
  // The default route is replaced by the NAT router in each peer, and the public side stays --internal (no egress).
  for (const l of Object.values(LAN)) sh(['network', 'create', '--subnet', l.subnet, l.name])
  sh(['run', '-d', '--name', 'pnat-boot', '--network', PUB.name, '--ip', '30.31.0.10', '-e', 'ROLE=bootstrap', ...mount, IMAGE, 'node', '/w/natlab/peer.mjs'])
  sh(['run', '-d', '--name', 'pnat-relay', '--network', PUB.name, '--ip', '30.31.0.20', '-e', 'ROLE=relay', ...mount, IMAGE, 'node', '/w/natlab/peer.mjs'])
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},6000)'])
}

function router (name, lan, mode) {
  const rnd = mode === 'symmetric' ? ' --random' : ''
  sh(['create', '--name', name, '--network', PUB.name, '--ip', lan.pubIp, '--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.ip_forward=1', IMAGE, 'sh', '-c',
    `PUBIF=$(ip -o -4 addr show | awk '/${lan.pubIp}/ {print $2}'); iptables -t nat -A POSTROUTING -o $PUBIF -j MASQUERADE${rnd}; echo router-ready; sleep 100000`])
  sh(['network', 'connect', '--ip', lan.gw, lan.name, name])
  sh(['start', name])
}

function directPeer (name, ip, env) {
  return sh(['run', '-d', '--name', name, '--network', PUB.name, '--ip', ip, '-e', 'BOOT_HOST=30.31.0.10', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...mount, IMAGE, 'node', '/w/natlab/peer.mjs'])
}

function peer (name, lan, env) {
  return sh(['run', '-d', '--name', name, '--network', lan.name, '--ip', lan.peer, '--cap-add', 'NET_ADMIN', '-e', `BOOT_HOST=30.31.0.10`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...mount, IMAGE,
    'sh', '-c', `ip route replace default via ${lan.gw} && exec node /w/natlab/peer.mjs`])
}

function runCase(natA, natB, relayed) {
  for (const c of ['pnat-natA', 'pnat-natB', 'pnat-server', 'pnat-client']) tryDocker(['rm', '-f', c])
  if (natA !== 'none') router('pnat-natA', LAN.a, natA)
  if (natB !== 'none') router('pnat-natB', LAN.b, natB)
  const env = relayed ? { USE_RELAY: '1' } : {}
  if (natA === 'none') directPeer('pnat-server', '30.31.0.50', { ROLE: 'server', ...env }); else peer('pnat-server', LAN.a, { ROLE: 'server', ...env })
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},8000)']) // let the server announce on the DHT
  if (natB === 'none') directPeer('pnat-client', '30.31.0.51', { ROLE: 'client', TIMEOUT_MS: '45000', ...env }); else peer('pnat-client', LAN.b, { ROLE: 'client', TIMEOUT_MS: '45000', ...env })
  let line = null
  for (let i = 0; i < 70 && !line; i++) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'])
    const logs = tryDocker(['logs', 'pnat-client']) ?? ''
    line = logs.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((o) => o && 'ok' in o)
  }
  const serverLog = tryDocker(['logs', 'pnat-server']) ?? ''
  if (process.env.PNAT_VERBOSE) console.error(serverLog, '\n--- client\n', tryDocker(['logs', 'pnat-client']))
  for (const c of ['pnat-natA', 'pnat-natB', 'pnat-server', 'pnat-client']) tryDocker(['rm', '-f', c])
  return { natA, natB, relayed, result: line ?? { ok: false, error: 'NO-RESULT' }, serverSawPeer: /"peer":"connected"/.test(serverLog) }
}

const cmd = process.argv[2]
if (cmd === 'build') build()
else if (cmd === 'down') down()
else if (cmd === 'debug') {
  infra()
  router('pnat-natA', LAN.a, 'cone'); router('pnat-natB', LAN.b, 'cone')
  peer('pnat-server', LAN.a, { ROLE: 'server' })
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},12000)'])
  for (const c of ['pnat-boot', 'pnat-natA', 'pnat-server']) console.log(`--- ${c}\n${tryDocker(['logs', '--tail', '15', c])}`)
  console.log('--- route/ping from server:')
  console.log(tryDocker(['exec', 'pnat-server', 'sh', '-c', 'ip route; ip -o -4 addr; (command -v ping >/dev/null && ping -c1 -W2 30.31.0.10) || echo noping']))
  console.log('--- natA:')
  console.log(tryDocker(['exec', 'pnat-natA', 'sh', '-c', 'ip -o -4 addr; iptables -t nat -S; cat /proc/sys/net/ipv4/ip_forward']))
} else if (cmd === 'matrix') {
  infra()
  const out = []
  const all = [['none', 'cone', false], ['cone', 'none', false], ['cone', 'cone', false], ['cone', 'cone', true], ['cone', 'symmetric', false], ['symmetric', 'cone', false], ['symmetric', 'symmetric', false], ['symmetric', 'symmetric', true]]
  const only = process.env.PNAT_ONLY ? process.env.PNAT_ONLY.split(',').map(Number) : null
  for (const [a, b, r] of all.filter((_, i) => !only || only.includes(i))) {
    const row = runCase(a, b, r)
    console.log(JSON.stringify(row))
    out.push(row)
  }
  down()
} else { console.error('usage: build | matrix | down'); process.exit(2) }
