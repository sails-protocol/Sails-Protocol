// tests/boundedFetchResponseSize.test.ts
//
// boundedFetch() bounds a response body in BYTES as well as in time: every call states maxResponseBytes,
// and the bytes actually received are counted before they reach the caller's .json()/.text()/.arrayBuffer(),
// so an oversized body fails with BoundedResponseTooLargeError instead of being accumulated in memory.
// Content-Length is only an early rejection; a missing, chunked or misleading one cannot bypass the count.
//
// Real clock, real Node fetch (undici), real HTTP servers on 127.0.0.1 that the test drives. No public internet.

import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { boundedFetch, BoundedRpcTimeoutError, BoundedResponseTooLargeError } from '../src/modules/open-settlement/bounded-rpc'

const LIMIT = 4096
const T = 300 // per-attempt timeout where the test needs the deadline to matter
const LONG_T = 60_000 // where it must not: anything that ends early here was ended by the byte bound
const SLACK = 250
const MB = 1024 * 1024
const CHUNK = Buffer.alloc(64 * 1024, 'a')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function heapAndBuffers() { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers }

describe('boundedFetch — response bodies are bounded in bytes, counted as received (real HTTP server)', () => {
  let server: http.Server
  let base: string
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void> = (_q, res) => { res.end('{}') }
  let attempts = 0
  const sockets = new Set<net.Socket>()
  const closed: Array<Promise<number>> = [] // per response: resolves with the bytes the server wrote, once its socket closed

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      attempts++
      res.setHeader('Connection', 'close')
      const socket = res.socket!
      closed.push(new Promise((r) => socket.once('close', () => r(socket.bytesWritten))))
      void handler(req, res)
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await Promise.all([...sockets].map((s) => new Promise<void>((r) => { s.once('close', () => r()); s.destroy() })))
    attempts = 0
    closed.length = 0
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  /** `bytes` of body as fast as the socket takes it (Infinity: until the client goes away). */
  function body(status: number, bytes: number, headers: Record<string, string> = {}) {
    return (_q: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(status, { 'Content-Type': 'text/plain', ...headers })
      let left = bytes
      const pump = () => {
        while (left > 0 && !res.destroyed) {
          const n = Math.min(left, CHUNK.length)
          left -= n
          if (!res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n))) { res.once('drain', pump); return }
        }
        if (!res.destroyed) res.end()
      }
      res.on('error', () => undefined)
      pump()
    }
  }
  /** A JSON document of exactly `bytes` bytes: {"pad":"aaa..."}. */
  const jsonOf = (bytes: number) => `{"pad":"${'a'.repeat(bytes - 10)}"}`

  async function timed<V>(op: () => Promise<V>): Promise<{ ms: number; value?: V; error?: unknown }> {
    const t0 = Date.now()
    try { const value = await op(); return { ms: Date.now() - t0, value } } catch (error) { return { ms: Date.now() - t0, error } }
  }
  const get = (path: string, maxResponseBytes = LIMIT, timeoutMs = LONG_T) => boundedFetch(`${base}${path}`, {}, { timeoutMs, maxResponseBytes })

  it('A. a small valid body is returned', async () => {
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"confirmed":true}') }
    expect(await (await get('/a')).json()).toEqual({ confirmed: true })
  })

  it('B. a body of exactly maxResponseBytes is accepted, with and without Content-Length', async () => {
    const doc = jsonOf(LIMIT)
    expect(Buffer.byteLength(doc)).toBe(LIMIT)
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(LIMIT) }); res.end(doc) }
    expect(((await (await get('/b1')).json()) as { pad: string }).pad.length).toBe(LIMIT - 10)
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(doc.slice(0, 100)); res.end(doc.slice(100)) } // chunked
    expect(((await (await get('/b2')).json()) as { pad: string }).pad.length).toBe(LIMIT - 10)
  })

  it('C. one byte more fails with BoundedResponseTooLargeError, with and without Content-Length', async () => {
    const doc = jsonOf(LIMIT + 1)
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(LIMIT + 1) }); res.end(doc) }
    await expect((await get('/c1')).json()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(doc.slice(0, 100)); res.end(doc.slice(100)) } // chunked
    await expect((await get('/c2')).json()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
  })

  it('D. a huge declared Content-Length is rejected before any body byte is taken', async () => {
    // declares 1 GiB, sends the first 64 KiB and then holds the connection: the read must not wait for any of it
    handler = (_q, res) => { res.writeHead(200, { 'Content-Length': String(1024 * MB) }); res.write(CHUNK) }
    const res = await get('/d')
    const reader = res.body!.getReader()
    const r = await timed(() => reader.read())
    expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(r.ms).toBeLessThan(SLACK)
  })

  it('E. no Content-Length and no chunking (body delimited by connection close): still bounded by the count', async () => {
    let rawSent = 0
    const raw = net.createServer((s) => {
      s.on('error', () => undefined)
      s.once('data', () => {
        s.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n')
        const pump = () => { while (!s.destroyed) { rawSent += CHUNK.length; if (!s.write(CHUNK)) { s.once('drain', pump); return } } }
        pump()
      })
    })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r))
    try {
      const r = await timed(async () => (await boundedFetch(`http://127.0.0.1:${(raw.address() as AddressInfo).port}/e`, {}, { timeoutMs: LONG_T, maxResponseBytes: LIMIT })).text())
      expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
      expect(r.ms).toBeLessThan(SLACK * 4)
      await sleep(50)
      expect(rawSent).toBeLessThan(16 * MB) // an endless body: the client went away, the server stopped
    } finally { await new Promise<void>((r) => raw.close(() => r())) }
  })

  it('F. a chunked endless body is bounded by the count and the connection is closed', async () => {
    handler = body(200, Infinity)
    const r = await timed(async () => (await get('/f')).text())
    expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(await closed[0]).toBeLessThan(16 * MB)
  })

  it('G. a misleading Content-Length cannot make the caller take more than the limit', async () => {
    // declares 100 bytes, sends 1 MiB: the HTTP client stops at the declared length, which is itself within the limit
    const raw = net.createServer((s) => {
      s.on('error', () => undefined)
      s.once('data', () => { s.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n'); for (let i = 0; i < 16; i++) s.write(CHUNK); s.end() })
    })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(raw.address() as AddressInfo).port}/g`
      const text = await (await boundedFetch(url, {}, { timeoutMs: LONG_T, maxResponseBytes: LIMIT })).text()
      expect(text.length).toBe(100)
      // declares less than it is and less than the limit, with a body that is really chunked and oversized: never more than the limit
      const lying = net.createServer((s) => {
        s.on('error', () => undefined)
        s.once('data', () => { s.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 10\r\nConnection: close\r\n\r\n'); for (let i = 0; i < 4; i++) s.write(`10000\r\n${CHUNK.toString()}\r\n`); s.end('0\r\n\r\n') })
      })
      await new Promise<void>((r) => lying.listen(0, '127.0.0.1', r))
      try {
        const r = await timed(async () => (await boundedFetch(`http://127.0.0.1:${(lying.address() as AddressInfo).port}/g2`, {}, { timeoutMs: LONG_T, maxResponseBytes: LIMIT })).text())
        if (r.error === undefined) expect((r.value as string).length).toBeLessThanOrEqual(LIMIT)
        else expect(r.value).toBeUndefined()
      } finally { await new Promise<void>((r) => lying.close(() => r())) }
    } finally { await new Promise<void>((r) => raw.close(() => r())) }
  })

  it('H/I. an oversized 2xx fails closed through .json(), .text() and .arrayBuffer() - never a partial value', async () => {
    handler = body(200, 64 * 1024)
    for (const read of [(r: Response) => r.json(), (r: Response) => r.text(), (r: Response) => r.arrayBuffer()]) {
      const r = await timed(async () => read(await get('/hi')))
      expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
      expect(r.value).toBeUndefined()
    }
  })

  it('J. an oversized error body (4xx) fails the read like any other', async () => {
    handler = body(400, 64 * 1024)
    const res = await boundedFetch(`${base}/tx`, { method: 'POST', body: '00' }, { timeoutMs: LONG_T, maxResponseBytes: LIMIT })
    expect(res.status).toBe(400)
    await expect(res.text()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
  })

  it('K. retries add no byte amplification: discarded retryable bodies are not read, the last one is bounded, an oversized 2xx is not re-issued', async () => {
    handler = body(503, 64 * MB)
    const res = await boundedFetch(`${base}/k`, {}, { timeoutMs: LONG_T, maxResponseBytes: LIMIT, retry: { attempts: 3, backoffMs: 10 } })
    expect(attempts).toBe(3)
    await expect(res.text()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
    const written = await Promise.all(closed)
    expect(written.length).toBe(3)
    for (const w of written) expect(w).toBeLessThan(16 * MB) // none of the three 64 MiB bodies was taken
    attempts = 0
    handler = body(200, 64 * MB)
    const r = await timed(async () => (await boundedFetch(`${base}/k2`, {}, { timeoutMs: LONG_T, maxResponseBytes: LIMIT, retry: { attempts: 3, backoffMs: 10 } })).text())
    expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(attempts).toBe(1)
  })

  it('M. concurrent endless bodies are each bounded independently; a normal call beside them succeeds; memory stays flat', async () => {
    handler = (q, res) => {
      if (q.url === '/ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":1}'); return }
      body(200, Infinity)(q, res)
    }
    const before = heapAndBuffers()
    let peak = before
    const iv = setInterval(() => { peak = Math.max(peak, heapAndBuffers()) }, 2)
    const results = await Promise.all([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(() => timed(async () => (await get('/big', 64 * 1024)).text())),
      timed(async () => (await get('/ok')).json()),
    ])
    clearInterval(iv)
    for (const r of results.slice(0, 8)) expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(results[8].value).toEqual({ ok: 1 })
    expect(peak - before).toBeLessThan(64 * MB) // eight endless bodies, unbounded before this change
  })

  it('N. time wins when the deadline comes before the limit', async () => {
    handler = async (_q, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); while (!res.destroyed) { res.write('x'); await sleep(20) } }
    const r = await timed(async () => (await get('/n', LIMIT, T)).text())
    expect(r.error).toBeInstanceOf(BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('O. size wins when the limit is crossed before the deadline', async () => {
    handler = body(200, Infinity)
    const r = await timed(async () => (await get('/o', LIMIT, LONG_T)).text())
    expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(r.ms).toBeLessThan(SLACK * 4)
  })

  it('P. an oversized body releases everything: its deadline timer is cleared and the connection is closed', async () => {
    const clear = jest.spyOn(global, 'clearTimeout')
    try {
      handler = body(200, Infinity)
      const res = await get('/p', LIMIT, LONG_T)
      const callsBefore = clear.mock.calls.length
      await expect(res.text()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
      expect(clear.mock.calls.length).toBeGreaterThan(callsBefore) // the 60 s timer is not left pending
      expect(await closed[0]).toBeGreaterThan(0) // the server sees the connection close
    } finally { clear.mockRestore() }
  })

  it('OTS calendar shape (POST, then res.arrayBuffer(), as PR #354 calls it): an oversized proof body yields no proof bytes; a proof-sized body is accepted', async () => {
    handler = body(200, Infinity, { 'Content-Type': 'application/octet-stream' })
    const post = () => boundedFetch(`${base}/digest`, { method: 'POST', body: Buffer.alloc(32) }, { timeoutMs: LONG_T, maxResponseBytes: LIMIT })
    const r = await timed(async () => Buffer.from(await (await post()).arrayBuffer()))
    expect(r.error).toBeInstanceOf(BoundedResponseTooLargeError)
    expect(r.value).toBeUndefined()
    handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(300, 1)) }
    expect(Buffer.from(await (await post()).arrayBuffer()).length).toBe(300)
  })
})
