// P51: the proxy's OWN tests (GK P51 checklist, section 2). Self-contained: a fake upstream on loopback, no chain, no network.
// Run: node --test tests/regtest/esplora-front/proxy.check.mjs
// Deliberately NOT named *.test.ts so the root Jest run (testMatch **/tests/**/*.test.ts) never picks it up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy, parseFixedFee, matchRoute } from './server.mjs'

const TXID = 'a'.repeat(64)
const ADDR = 'bcrt1qexampleexampleexampleexampleexample0'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
const close = (server) => new Promise((resolve) => server.close(resolve))

/** Fake electrs: records every request and answers from a table; behaviour can be switched per test. */
function fakeUpstream() {
  const seen = []
  const table = new Map()
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method, url: req.url, body })
      const hit = table.get(`${req.method} ${req.url}`)
      if (!hit) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Transaction not found')
      res.writeHead(hit.status, hit.headers ?? {}).end(hit.body)
    })
  })
  return { server, seen, table }
}

async function withStack(fn, { feeMode = 'normal', fixedFee = 7 } = {}) {
  const up = fakeUpstream()
  const upPort = await listen(up.server)
  const dir = mkdtempSync(join(tmpdir(), 'p51-proxy-'))
  const logFile = join(dir, 'proxy.log')
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, fixedFee, feeMode, logFile })
  const proxyPort = await listen(proxy)
  try {
    await fn({ base: `http://127.0.0.1:${proxyPort}`, up, logFile })
  } finally {
    await close(proxy)
    await close(up.server)
  }
}
const readLog = (logFile) => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

test('forwards the 7 Esplora routes 1:1: same status, same bytes, same content-type', async () => {
  await withStack(async ({ base, up }) => {
    const hex = '02000000000101' + 'ab'.repeat(40)
    up.table.set('GET /blocks/tip/height', { status: 200, headers: { 'content-type': 'text/plain' }, body: '123' })
    up.table.set(`GET /address/${ADDR}/utxo`, { status: 200, headers: { 'content-type': 'application/json' }, body: '[{"txid":"x","vout":0,"status":{"confirmed":true},"value":5000}]' })
    up.table.set(`GET /tx/${TXID}`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"txid":"x"}' })
    up.table.set(`GET /tx/${TXID}/status`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"confirmed":false}' })
    up.table.set(`GET /tx/${TXID}/hex`, { status: 200, headers: { 'content-type': 'text/plain' }, body: hex })
    up.table.set(`GET /tx/${TXID}/outspend/1`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"spent":false}' })
    up.table.set('POST /tx', { status: 200, headers: { 'content-type': 'text/plain' }, body: TXID })
    for (const [method, path, expectBody, expectCt] of [
      ['GET', '/blocks/tip/height', '123', 'text/plain'],
      ['GET', `/address/${ADDR}/utxo`, '[{"txid":"x","vout":0,"status":{"confirmed":true},"value":5000}]', 'application/json'],
      ['GET', `/tx/${TXID}`, '{"txid":"x"}', 'application/json'],
      ['GET', `/tx/${TXID}/status`, '{"confirmed":false}', 'application/json'],
      ['GET', `/tx/${TXID}/hex`, hex, 'text/plain'],
      ['GET', `/tx/${TXID}/outspend/1`, '{"spent":false}', 'application/json'],
      ['POST', '/tx', TXID, 'text/plain'],
    ]) {
      const res = await fetch(base + path, { method, body: method === 'POST' ? hex : undefined })
      assert.equal(res.status, 200, `${method} ${path}`)
      assert.equal(await res.text(), expectBody, `${method} ${path} body`)
      assert.equal(res.headers.get('content-type'), expectCt, `${method} ${path} content-type`)
    }
    const post = up.seen.find((r) => r.method === 'POST')
    assert.equal(post.body.toString('utf8'), hex, 'POST body forwarded byte-exact')
  })
})

test('an upstream error stays an error: 404 and 400 and 500 are relayed, never turned into success', async () => {
  await withStack(async ({ base, up }) => {
    up.table.set('POST /tx', { status: 400, headers: { 'content-type': 'text/plain' }, body: 'sendrawtransaction RPC error: bad-txns-inputs-missingorspent' })
    up.table.set(`GET /tx/${TXID}/hex`, { status: 500, body: 'boom' })
    const missing = await fetch(`${base}/tx/${'b'.repeat(64)}`)
    assert.equal(missing.status, 404, 'a transaction that does not exist is 404')
    const rejected = await fetch(`${base}/tx`, { method: 'POST', body: 'zz' })
    assert.equal(rejected.status, 400, 'a node rejection is 400, not 200')
    assert.match(await rejected.text(), /bad-txns-inputs-missingorspent/)
    const broken = await fetch(`${base}/tx/${TXID}/hex`)
    assert.equal(broken.status, 500)
  })
})

test('upstream down => 502, never 200', async () => {
  const proxy = createProxy({ upstream: 'http://127.0.0.1:9', fixedFee: 5, upstreamTimeoutMs: 1500 })
  const port = await listen(proxy)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/blocks/tip/height`)
    assert.equal(res.status, 502)
  } finally { await close(proxy) }
})

test('a route outside the whitelist is 404 from the proxy and NEVER reaches the upstream', async () => {
  await withStack(async ({ base, up }) => {
    for (const path of ['/blocks', '/mempool', `/tx/${TXID}/merkleblock-proof`, '/address/bcrt1qexampleexampleexampleexampleexample0/txs', '/v1/prices']) {
      const res = await fetch(base + path)
      assert.equal(res.status, 404, path)
    }
    const del = await fetch(`${base}/tx/${TXID}`, { method: 'DELETE' })
    assert.equal(del.status, 404)
    assert.equal(up.seen.length, 0, 'the upstream received nothing')
  })
})

test('path injection and query strings are rejected before the upstream URL is built', async () => {
  for (const m of ['GET']) {
    assert.equal(matchRoute(m, `/tx/${TXID}/../../blocks/tip/height`), null)
    assert.equal(matchRoute(m, `/tx/${TXID}?x=1`), null)
    assert.equal(matchRoute(m, `/tx/%2e%2e/blocks`), null)
    assert.equal(matchRoute(m, '/tx/nothex'), null)
    assert.equal(matchRoute(m, `/tx/${TXID}/outspend/abc`), null)
    assert.equal(matchRoute(m, '/address/bad%20addr/utxo'), null)
  }
  // fetch() would normalise ".." on the client side, so send the raw path with http.request.
  await withStack(async ({ base, up }) => {
    const { port } = new URL(base)
    const status = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/tx/${TXID}/../../blocks/tip/height` }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      r.on('error', reject)
      r.end()
    })
    assert.equal(status, 404, 'the raw ".." path is refused by the proxy')
    assert.equal(up.seen.length, 0, 'and it never reaches the upstream')
  })
})

test('fee route: mempool.space shape, one FIXED constant, integers, content-type json', async () => {
  await withStack(async ({ base, up }) => {
    const res = await fetch(`${base}/v1/fees/recommended`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const fees = await res.json()
    for (const k of ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee']) {
      assert.equal(fees[k], 7, k)
      assert.ok(Number.isInteger(fees[k]))
    }
    assert.equal(up.seen.length, 0, 'the fee route is answered locally: the upstream is not asked')
  }, { fixedFee: 7 })
})

test('fee fault modes: 500 and {} (the provider must refuse on both; checked in fee-negative.check.ts)', async () => {
  await withStack(async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/fees/recommended`)).status, 500)
  }, { feeMode: 'fault500' })
  await withStack(async ({ base }) => {
    const res = await fetch(`${base}/v1/fees/recommended`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {})
  }, { feeMode: 'empty' })
})

test('the log carries metadata only (no request or response body) and counts forwarded POST /tx', async () => {
  await withStack(async ({ base, up, logFile }) => {
    const secretLikeBody = '0200000001deadbeef'
    up.table.set('POST /tx', { status: 200, body: TXID })
    await fetch(`${base}/tx`, { method: 'POST', body: secretLikeBody })
    const raw = readFileSync(logFile, 'utf8')
    assert.ok(!raw.includes(secretLikeBody), 'the raw transaction must not be logged')
    const entries = readLog(logFile)
    assert.equal(entries.filter((e) => e.kind === 'post-tx' && e.forwarded === true).length, 1)
  })
})

test('startup refuses a missing, non-integer or absurd fixed fee, and a non-loopback upstream', () => {
  for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', '100000', '1e3']) {
    assert.throws(() => parseFixedFee(bad), /FIXED_FEE_SAT_PER_VB/, String(bad))
  }
  assert.equal(parseFixedFee('12'), 12)
  assert.throws(() => createProxy({ upstream: 'https://mempool.space/api', fixedFee: 5 }), /loopback/)
  assert.throws(() => createProxy({ upstream: 'http://blockstream.info', fixedFee: 5 }), /loopback/)
})

test('a body above the limit is refused with 413 and is not forwarded', async () => {
  await withStack(async ({ base, up }) => {
    const res = await fetch(`${base}/tx`, { method: 'POST', body: 'a'.repeat(1_100_000) })
    assert.equal(res.status, 413)
    assert.equal(up.seen.filter((r) => r.method === 'POST').length, 0)
  })
})
