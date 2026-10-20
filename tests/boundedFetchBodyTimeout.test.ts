// tests/boundedFetchBodyTimeout.test.ts
//
// boundedFetch()'s timeout must bound the WHOLE external call a caller depends on: connecting, waiting
// for headers, and reading the response body (.json()/.text()/.arrayBuffer()). Headers received is not the
// call completed: a server can answer with headers and then stall the body.
//
// Real clock, real Node fetch (undici), a real HTTP server on 127.0.0.1 that the test drives: each
// response is released by the test, never by a sleep that happens to be long enough. No public internet.

import http from 'http'
import type { AddressInfo } from 'net'
import { boundedFetch, BoundedRpcTimeoutError } from '../src/modules/open-settlement/bounded-rpc'

const T = 300 // test timeout per attempt (production explorer default: 8000 ms)
const SLACK = 250 // scheduler tolerance on a loaded machine
const MAX_BYTES = 16 * 1024 // every boundedFetch call declares its response-size bound; these bodies are a few bytes

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, attempt: number) => void | Promise<void>

describe('boundedFetch — one bounded lifetime per attempt, headers AND body (real HTTP server)', () => {
  let server: http.Server
  let base: string
  let handler: Handler = (_q, res) => { res.end('{}') }
  let attempts = 0
  const releases: Deferred[] = []
  const sockets = new Set<import('net').Socket>()

  beforeAll(async () => {
    // Connection: close — each test destroys the sockets it left stalled, so none may be reused by the next test.
    server = http.createServer((req, res) => { attempts++; res.setHeader('Connection', 'close'); void handler(req, res, attempts) })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    for (const r of releases.splice(0)) r.resolve()
    // wait until every socket this test left open is really closed, so the next test starts clean
    await Promise.all([...sockets].map((s) => new Promise<void>((r) => { s.once('close', () => r()); s.destroy() })))
    attempts = 0
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  /** A barrier the server waits on; the test releases it (afterEach releases every one left). */
  function barrier(): Deferred { const d = deferred(); releases.push(d); return d }

  /** Runs `op`, returning how long it took and how it ended. */
  async function timed<T>(op: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
    const t0 = Date.now()
    try { const value = await op(); return { ms: Date.now() - t0, value } } catch (error) { return { ms: Date.now() - t0, error } }
  }

  it('A. headers and body complete normally: the JSON is returned', async () => {
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"confirmed":true}') }
    const r = await timed(async () => (await boundedFetch(`${base}/a`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.value).toEqual({ confirmed: true })
  })

  it('B. no headers until the timeout: fails with BoundedRpcTimeoutError within T', async () => {
    const hold = barrier()
    handler = async (_q, res) => { await hold.promise; res.end('{}') }
    const r = await timed(() => boundedFetch(`${base}/b`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T }))
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('C. headers at once, body never completes: reading the body fails within T of the call, it does not wait for the server', async () => {
    const hold = barrier()
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); await hold.promise; res.end('{}') }
    const r = await timed(async () => (await boundedFetch(`${base}/c`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('D. headers and part of the body, then a stall: fails within T', async () => {
    const hold = barrier()
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"confirmed":'); await hold.promise; res.end('true}') }
    const r = await timed(async () => (await boundedFetch(`${base}/d`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('D2. a body that keeps trickling forever cannot extend the deadline', async () => {
    const hold = barrier()
    let stop = false
    void hold.promise.then(() => { stop = true })
    handler = async (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      while (!stop && !res.destroyed) { res.write('x'); await sleep(20) }
      res.end()
    }
    const r = await timed(async () => (await boundedFetch(`${base}/d2`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).text())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('E. a slow body that completes before the deadline succeeds', async () => {
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"a":'); await sleep(T / 3); res.end('1}') }
    const r = await timed(async () => (await boundedFetch(`${base}/e`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.value).toEqual({ a: 1 })
  })

  it('F. a body that would complete after the deadline fails at the deadline, not when it completes', async () => {
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"a":'); await sleep(T * 4); if (!res.destroyed) res.end('1}') }
    const r = await timed(async () => (await boundedFetch(`${base}/f`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('G. connection reset mid-body: the read fails (not a timeout, not a value)', async () => {
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"a":'); setTimeout(() => res.socket?.destroy(), 20) }
    const r = await timed(async () => (await boundedFetch(`${base}/g`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect(r.error).toBeDefined()
    expect(r.error).not.toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.value).toBeUndefined()
  })

  it('H. malformed JSON after valid headers: a parse error, never a value', async () => {
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json') }
    const r = await timed(async () => (await boundedFetch(`${base}/h`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json())
    expect((r.error as Error).name).toBe('SyntaxError') // by name: undici's SyntaxError comes from another realm than jest's
  })

  it('I/K. a request-phase timeout is retried (reads only), and a later attempt can succeed', async () => {
    const hold = barrier()
    handler = async (_q, res, n) => { if (n === 1) { await hold.promise; return } res.end('{"ok":1}') }
    const r = await timed(async () => (await boundedFetch(`${base}/i`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T, retry: { attempts: 3, backoffMs: 10 } })).json())
    expect(r.value).toEqual({ ok: 1 })
    expect(attempts).toBe(2)
  })

  it('J. a body-phase timeout fails the call: the body belongs to the attempt that returned it, and boundedFetch does not re-issue it', async () => {
    const hold = barrier()
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); await hold.promise; res.end('{}') }
    const r = await timed(async () => (await boundedFetch(`${base}/j`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T, retry: { attempts: 3, backoffMs: 10 } })).json())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(attempts).toBe(1)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('L. every attempt times out: fails after attempts x T + backoff, not later', async () => {
    const hold = barrier()
    handler = async () => { await hold.promise }
    const r = await timed(() => boundedFetch(`${base}/l`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T, retry: { attempts: 3, backoffMs: 10 } }))
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(attempts).toBe(3)
    expect(r.ms).toBeLessThan(3 * T + 10 + 20 + SLACK)
  })

  it('M. nothing outlives the call: after a read completes, fails or is abandoned, no deadline timer is left pending past T', async () => {
    jest.spyOn(global, 'setTimeout')
    const clear = jest.spyOn(global, 'clearTimeout')
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"a":1}') }
    const before = clear.mock.calls.length
    await (await boundedFetch(`${base}/m`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: 60_000 })).json()
    expect(clear.mock.calls.length).toBeGreaterThan(before) // cleared at body completion, not left for 60 s
    // a caller that never reads the body: the response is released at the deadline at the latest
    const res = await boundedFetch(`${base}/m2`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })
    await sleep(T + SLACK)
    await expect(res.text()).rejects.toBeDefined()
    jest.restoreAllMocks()
  })

  it('O. the OpenTimestamps calendar shape (POST, then res.arrayBuffer(), as PR #354 calls it): a stalled proof body fails with BoundedRpcTimeoutError, so no anchor can be built from it', async () => {
    const hold = barrier()
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write(Buffer.from([0x00, 0x4f, 0x70])); await hold.promise; res.end() }
    const r = await timed(async () => Buffer.from(await (await boundedFetch(`${base}/digest`, { method: 'POST', body: Buffer.alloc(32) }, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).arrayBuffer()))
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.value).toBeUndefined()
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('N. concurrent calls have independent deadlines: one stalled body does not abort another', async () => {
    const hold = barrier()
    handler = async (q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (q.url === '/slow') { res.flushHeaders(); await hold.promise; res.end('{}') } else res.end('{"fast":1}')
    }
    const [slow, fast] = await Promise.all([
      timed(async () => (await boundedFetch(`${base}/slow`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json()),
      timed(async () => (await boundedFetch(`${base}/fast`, {}, { maxResponseBytes: MAX_BYTES, timeoutMs: T })).json()),
    ])
    expect(slow.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(fast.value).toEqual({ fast: 1 })
  })
})
