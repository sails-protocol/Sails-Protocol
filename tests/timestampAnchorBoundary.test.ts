// tests/timestampAnchorBoundary.test.ts
//
// OpenTimestampsAnchor.anchor() — the one Sails-owned OpenTimestamps HTTP call (POST /digest). It must be
// bounded in time (OTS_CALENDAR_TIMEOUT_MS, connection + headers + the whole proof body) and in bytes
// (OTS_CALENDAR_MAX_RESPONSE_BYTES, counted as received), must make exactly one attempt, and must never
// turn a failed or unknown answer into an anchor: only a 2xx answer read completely within both bounds
// becomes an AnchorProof.
//
// `fetch` is a stand-in that behaves like Node's (undici): the request and the response body both fail
// when the request's AbortSignal fires. Timeouts are driven with fake timers, never by sleeping.

import { createHash } from 'crypto'
import { BoundedRpcTimeoutError, BoundedResponseTooLargeError } from '../src/modules/open-settlement/bounded-rpc'
import { OpenTimestampsAnchor, OTS_CALENDAR_TIMEOUT_MS, OTS_CALENDAR_MAX_RESPONSE_BYTES } from '../src/modules/open-proof/timestamp-anchor'

const CALENDAR = 'https://calendar.example'
const digestHex = createHash('sha256').update('sails-ots-boundary').digest('hex')
const LIMIT = OTS_CALENDAR_MAX_RESPONSE_BYTES

type BodySource = (signal: AbortSignal) => ReadableStream<Uint8Array>

/** A body that fails with an AbortError when the request is aborted, like undici's. */
function abortableBody(signal: AbortSignal, pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>): ReadableStream<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c }, pull }, { highWaterMark: 0 })
  signal.addEventListener('abort', () => { try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } catch { /* already closed */ } }, { once: true })
  return stream
}
const never = new Promise<void>(() => undefined)

describe('OpenTimestampsAnchor — bounded calendar submission, one attempt, no anchor unless the answer is complete and valid', () => {
  const originalFetch = global.fetch
  let calls: Array<{ url: string; init: RequestInit }>

  /** Installs a calendar that answers with `status`, `headers` and the body `source` builds. */
  function calendar(status: number, source: BodySource | null, headers: Record<string, string> = {}) {
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(source ? source(init!.signal!) : null, { status, headers })
    }) as typeof fetch
  }
  const anchor = () => new OpenTimestampsAnchor(CALENDAR).anchor(digestHex)

  beforeEach(() => { calls = [] })
  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  // ─── success ────────────────────────────────────────────────────────────────────────────────────────────

  it('1/12. a valid answer becomes the same AnchorProof as before: one POST of the raw digest, the body as base64, not upgraded', async () => {
    const proofBytes = Buffer.from(Array.from({ length: 180 }, (_, i) => i % 256))
    calendar(200, (signal) => abortableBody(signal, (c) => { c.enqueue(proofBytes); c.close() }), { 'Content-Type': 'application/vnd.opentimestamps.v1' })
    const proof = await anchor()
    expect(proof).toEqual({ anchorType: 'opentimestamps', anchorId: proofBytes.toString('base64'), submittedAt: expect.any(String), upgraded: false })
    expect(new Date(proof.submittedAt).toISOString()).toBe(proof.submittedAt)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${CALENDAR}/digest`)
    expect(calls[0].init).toEqual(expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }))
    expect(Buffer.from(calls[0].init.body as Uint8Array)).toEqual(Buffer.from(digestHex, 'hex'))
  })

  it('a proof of exactly the byte bound is accepted; one byte more is not an anchor', async () => {
    calendar(200, (signal) => abortableBody(signal, (c) => { c.enqueue(new Uint8Array(LIMIT)); c.close() }))
    expect(Buffer.from((await anchor()).anchorId, 'base64')).toHaveLength(LIMIT)
    calendar(200, (signal) => abortableBody(signal, (c) => { c.enqueue(new Uint8Array(LIMIT + 1)); c.close() }))
    await expect(anchor()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
  })

  // ─── time ───────────────────────────────────────────────────────────────────────────────────────────────

  it('2. no headers: fails with BoundedRpcTimeoutError at exactly OTS_CALENDAR_TIMEOUT_MS, one attempt, no anchor', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
    }) as typeof fetch
    let settled = false
    const result = anchor().finally(() => { settled = true })
    const outcome = expect(result).rejects.toBeInstanceOf(BoundedRpcTimeoutError)
    await jest.advanceTimersByTimeAsync(OTS_CALENDAR_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await outcome
    expect(calls).toHaveLength(1)
  })

  it('3. headers arrive, the proof body never finishes: the same 30 s bound ends the read with BoundedRpcTimeoutError, no anchor', async () => {
    jest.useFakeTimers()
    calendar(200, (signal) => abortableBody(signal, async (c) => { c.enqueue(new Uint8Array(10)); await never }))
    let settled = false
    const result = anchor().finally(() => { settled = true })
    const outcome = expect(result).rejects.toBeInstanceOf(BoundedRpcTimeoutError)
    await jest.advanceTimersByTimeAsync(OTS_CALENDAR_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await outcome
    expect(calls).toHaveLength(1)
  })

  // ─── bytes ──────────────────────────────────────────────────────────────────────────────────────────────

  it('4/6. an endless proof body (no Content-Length) fails once the bytes received pass the bound; the rest is never read', async () => {
    let pulled = 0
    calendar(200, (signal) => abortableBody(signal, (c) => { pulled++; c.enqueue(new Uint8Array(4096)) }))
    await expect(anchor()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
    expect(pulled).toBeLessThanOrEqual(LIMIT / 4096 + 2) // stopped at the bound, not at the end of the stream
    expect(calls).toHaveLength(1)
  })

  it('5. a declared Content-Length above the bound fails before any body byte is read', async () => {
    let pulled = 0
    calendar(200, (signal) => abortableBody(signal, (c) => { pulled++; c.enqueue(new Uint8Array(16)); c.close() }), { 'Content-Length': String(10 * 1024 * 1024) })
    await expect(anchor()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
    expect(pulled).toBeLessThanOrEqual(1)
    expect(calls).toHaveLength(1)
  })

  it('6. a Content-Length that claims less than is sent cannot get past the byte count', async () => {
    calendar(200, (signal) => abortableBody(signal, (c) => { c.enqueue(new Uint8Array(4 * LIMIT)); c.close() }), { 'Content-Length': '100' })
    await expect(anchor()).rejects.toBeInstanceOf(BoundedResponseTooLargeError)
    expect(calls).toHaveLength(1)
  })

  // ─── failures ───────────────────────────────────────────────────────────────────────────────────────────

  it('8. a non-2xx answer is refused, whatever its body, one attempt, no anchor', async () => {
    for (const status of [500, 503, 404, 400]) {
      calls = []
      calendar(status, (signal) => abortableBody(signal, (c) => { c.enqueue(new TextEncoder().encode('busy')); c.close() }))
      await expect(anchor()).rejects.toThrow(new RegExp(`returned ${status}.*refusing to fabricate an anchor`))
      expect(calls).toHaveLength(1)
    }
  })

  it('7/9. a body that breaks mid-read (connection reset, a corrupted stream) fails the anchor, one attempt, no partial proof', async () => {
    calendar(200, (signal) => abortableBody(signal, (() => {
      let sent = false
      return (c: ReadableStreamDefaultController<Uint8Array>) => { if (!sent) { sent = true; c.enqueue(new Uint8Array(10)) } else c.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } })) }
    })()))
    await expect(anchor()).rejects.toThrow('terminated')
    expect(calls).toHaveLength(1)
  })

  it('a network failure before any answer fails the anchor, one attempt', async () => {
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(anchor()).rejects.toThrow('fetch failed')
    expect(calls).toHaveLength(1)
  })
})
