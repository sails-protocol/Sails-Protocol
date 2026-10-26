// ROLE: HOSTILE / STALE homeserver. A reverse proxy in front of the real homeserver that a verifier is
// pointed at instead of the real one. It can record and replay old answers, tamper, withhold, lie about
// freshness headers, serve another account's data under the victim's name, or inject documents.
import http from 'node:http'
import { HOMESERVER_HTTP, serve } from './lib.mjs'

const PORT = 6290
let mode = 'pass'
let cfg = {}
const snapshots = new Map() // path -> { status, headers, body }
let recording = false

const server = http.createServer(async (req, res) => {
  const path = req.url
  const host = req.headers['pubky-host']
  const forwardHost = cfg.mapHost?.[host] ?? host
  const cachedKey = `${req.method} ${host}${path}`
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body) }

  if (mode === 'withhold' && path.startsWith('/pub/sails.market/pear/')) return send(404, {}, '')
  if (mode === 'inject' && cfg.inject?.[path]) {
    const now = new Date().toUTCString()
    return send(200, { 'content-type': 'application/json', 'last-modified': now, etag: '"injected"' }, req.method === 'HEAD' ? '' : JSON.stringify(cfg.inject[path]))
  }
  if (mode === 'replay' && snapshots.has(cachedKey)) {
    const s = snapshots.get(cachedKey)
    return send(s.status, s.headers, req.method === 'HEAD' ? '' : s.body)
  }
  const upstream = await fetch(HOMESERVER_HTTP + path, { method: req.method, headers: { 'pubky-host': forwardHost } }).catch(() => null)
  if (!upstream) return send(502, {}, '')
  let body = Buffer.from(await upstream.arrayBuffer())
  const headers = Object.fromEntries([...upstream.headers.entries()].filter(([k]) => /^(content-type|etag|last-modified)$/i.test(k)))
  if (mode === 'tamper' && req.method === 'GET' && upstream.status === 200 && path.endsWith('.json')) {
    const j = JSON.parse(body.toString())
    if (cfg.tamper === 'binding') j.pearSig = '00'.repeat(64)
    if (cfg.tamper === 'signature') j.cp.pop = j.cp.pop.slice(0, -4) + 'AAAA'
    if (cfg.tamper === 'grant') j.cp.grant = j.cp.grant.slice(0, -4) + 'AAAA'
    body = Buffer.from(JSON.stringify(j))
  }
  if (mode === 'fresh-headers') headers['last-modified'] = new Date().toUTCString()
  if (mode === 'old-headers') headers['last-modified'] = new Date(Date.now() - 3600_000).toUTCString()
  if (recording && upstream.status === 200) snapshots.set(cachedKey, { status: 200, headers, body: body.toString() })
  send(upstream.status, headers, req.method === 'HEAD' ? '' : body)
})

serve({
  async listen () { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); return { port: PORT } },
  async mode ({ name, config = {} }) { mode = name; cfg = config; return { mode } },
  async record ({ on }) { recording = on; return { recording } },
  async clear () { snapshots.clear(); return {} },
  async snapshotCount () { return snapshots.size }
})
