// P51 regtest CI: front proxy in front of electrs (Esplora REST). TEST INFRASTRUCTURE ONLY (outside src/).
//
// What it does:
//   * forwards exactly the 7 Esplora routes the MultisigProvider uses, 1:1 and byte-for-byte, to the electrs
//     REST API running on loopback; an upstream error stays an error (never turned into success);
//   * adds the ONE route electrs does not have, GET /v1/fees/recommended (a mempool.space route), answering with a
//     FIXED, DECLARED rate. That rate is an input (policy), not chain state. It is NOT market data.
//
// What it must never do (GK P51 checklist, section 2): invent a confirmation, a UTXO, a height or a broadcast
// status. It has no state of its own about the chain: every chain answer comes from electrs / bitcoind.
//
// Safe by construction: binds 127.0.0.1 only; upstream must be loopback; only the whitelisted routes exist;
// path parameters are validated before they are placed in the upstream URL; no query strings; request and
// response bodies are never logged (metadata only).
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HEX64 = /^[0-9a-fA-F]{64}$/
const ADDRESS = /^[A-Za-z0-9]{14,100}$/
const VOUT = /^[0-9]{1,6}$/
const MAX_BODY_BYTES = 1_000_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const FEE_MODES = new Set(['normal', 'fault500', 'empty'])

/** The fixed rate must be a plain positive integer in sat/vB. Anything else refuses to start. */
export function parseFixedFee(raw) {
  if (typeof raw !== 'string' || !/^[0-9]{1,5}$/.test(raw)) {
    throw new Error(`FIXED_FEE_SAT_PER_VB must be a positive integer (sat/vB), got ${JSON.stringify(raw)}`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) {
    throw new Error(`FIXED_FEE_SAT_PER_VB out of range 1..10000: ${raw}`)
  }
  return n
}

/** Returns { kind, upstreamPath } for a supported route, or null. */
export function matchRoute(method, rawUrl) {
  if (rawUrl.includes('?') || rawUrl.includes('#') || rawUrl.includes('%') || rawUrl.includes('..')) return null
  const parts = rawUrl.split('/') // ['', 'tx', '<id>', ...]
  if (parts[0] !== '') return null
  const seg = parts.slice(1)
  if (method === 'GET' && seg.length === 3 && seg[0] === 'blocks' && seg[1] === 'tip' && seg[2] === 'height') {
    return { kind: 'tip-height', upstreamPath: '/blocks/tip/height' }
  }
  if (method === 'GET' && seg.length === 3 && seg[0] === 'address' && seg[2] === 'utxo' && ADDRESS.test(seg[1])) {
    return { kind: 'address-utxo', upstreamPath: `/address/${seg[1]}/utxo` }
  }
  if (method === 'POST' && seg.length === 1 && seg[0] === 'tx') return { kind: 'post-tx', upstreamPath: '/tx' }
  if (method === 'GET' && seg[0] === 'tx' && seg.length >= 2 && HEX64.test(seg[1])) {
    if (seg.length === 2) return { kind: 'tx', upstreamPath: `/tx/${seg[1]}` }
    if (seg.length === 3 && seg[2] === 'status') return { kind: 'tx-status', upstreamPath: `/tx/${seg[1]}/status` }
    if (seg.length === 3 && seg[2] === 'hex') return { kind: 'tx-hex', upstreamPath: `/tx/${seg[1]}/hex` }
    if (seg.length === 4 && seg[2] === 'outspend' && VOUT.test(seg[3])) {
      return { kind: 'tx-outspend', upstreamPath: `/tx/${seg[1]}/outspend/${seg[3]}` }
    }
  }
  if (method === 'GET' && seg.length === 3 && seg[0] === 'v1' && seg[1] === 'fees' && seg[2] === 'recommended') {
    return { kind: 'fees-recommended', upstreamPath: null }
  }
  return null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    // Over the limit: keep draining (and discarding) so the client can still read our 413; do NOT destroy the socket.
    req.on('data', (c) => {
      size += c.length
      if (size <= MAX_BODY_BYTES) chunks.push(c)
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/**
 * @param {{ upstream: string, fixedFee: number, feeMode?: 'normal'|'fault500'|'empty', logFile?: string, upstreamTimeoutMs?: number }} opts
 * @returns {http.Server}
 */
export function createProxy({ upstream, fixedFee, feeMode = 'normal', logFile, upstreamTimeoutMs = 10_000 }) {
  const up = new URL(upstream)
  if (!LOOPBACK_HOSTS.has(up.hostname)) {
    throw new Error(`upstream must be loopback, got ${up.hostname} (public explorers are forbidden in this harness)`)
  }
  if (!Number.isSafeInteger(fixedFee) || fixedFee < 1) throw new Error('fixedFee must be a positive integer')
  if (!FEE_MODES.has(feeMode)) throw new Error(`unknown feeMode ${feeMode}`)
  const base = `${up.protocol}//${up.host}`

  const log = (entry) => {
    if (!logFile) return
    // Metadata only: never the body (a POST /tx body is a raw transaction).
    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }

  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    const route = matchRoute(method, url)
    if (!route) {
      log({ method, kind: 'unsupported', status: 404, forwarded: false })
      res.writeHead(404, { 'content-type': 'text/plain' }).end('route not supported by the regtest front proxy')
      return
    }

    if (route.kind === 'fees-recommended') {
      if (feeMode === 'fault500') {
        log({ method, kind: route.kind, status: 500, forwarded: false, feeMode })
        res.writeHead(500, { 'content-type': 'text/plain' }).end('fee estimation unavailable (fault injection)')
        return
      }
      if (feeMode === 'empty') {
        log({ method, kind: route.kind, status: 200, forwarded: false, feeMode })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      // mempool.space shape. FIXED, DECLARED, NOT MARKET DATA: one constant for every tier.
      const body = JSON.stringify({
        fastestFee: fixedFee, halfHourFee: fixedFee, hourFee: fixedFee, economyFee: fixedFee, minimumFee: fixedFee,
      })
      log({ method, kind: route.kind, status: 200, forwarded: false, feeMode })
      res.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }

    try {
      const init = { method, signal: AbortSignal.timeout(upstreamTimeoutMs), redirect: 'manual' }
      if (method === 'POST') {
        init.body = await readBody(req)
        init.headers = { 'content-type': req.headers['content-type'] ?? 'text/plain' }
      }
      const upstreamRes = await fetch(`${base}${route.upstreamPath}`, init)
      const buf = Buffer.from(await upstreamRes.arrayBuffer())
      const headers = {}
      const ct = upstreamRes.headers.get('content-type')
      if (ct) headers['content-type'] = ct
      log({ method, kind: route.kind, status: upstreamRes.status, forwarded: true })
      res.writeHead(upstreamRes.status, headers).end(buf)
    } catch (err) {
      const status = err && err.statusCode === 413 ? 413 : 502
      log({ method, kind: route.kind, status, forwarded: false, error: err instanceof Error ? err.name : 'error' })
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 413 ? 'body too large' : 'upstream unreachable')
    }
  })
}

// CLI: node server.mjs   (env: FIXED_FEE_SAT_PER_VB required; ESPLORA_UPSTREAM, PROXY_PORT, FEE_MODE, PROXY_LOG optional)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixedFee = parseFixedFee(process.env.FIXED_FEE_SAT_PER_VB)
  const port = Number(process.env.PROXY_PORT ?? '3003')
  const server = createProxy({
    upstream: process.env.ESPLORA_UPSTREAM ?? 'http://127.0.0.1:3002',
    fixedFee,
    feeMode: process.env.FEE_MODE ?? 'normal',
    logFile: process.env.PROXY_LOG,
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`regtest front proxy listening on 127.0.0.1:${port} feeMode=${process.env.FEE_MODE ?? 'normal'} fixedFee=${fixedFee}\n`)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
}
