/**
 * bounded-rpc.ts (F1, docs/TECHNICAL_DEBT_AUDIT.md #51) — proves the
 * property this fix exists for: every live chain/RPC call resolves or
 * fails within a bounded time, and only a call explicitly marked safe
 * (read-only) ever retries. These tests exercise the shared helper
 * directly rather than through a specific provider, since both
 * multisig.provider.ts and safe-guard-evm.provider.ts delegate to it
 * identically.
 */
import * as net from 'net'
import { FetchRequest, JsonRpcProvider } from 'ethers'
import { boundedFetch, withBoundedRetry, BoundedRpcTimeoutError } from '../src/modules/open-settlement/bounded-rpc'

const MAX_BYTES = 16 * 1024 // every boundedFetch call declares its response-size bound; these mocked bodies are a few bytes

// A fetch stand-in that genuinely never resolves on its own — it only
// settles if its AbortSignal fires, exactly like a real hung TCP
// connection under a real AbortController-backed fetch. This is what
// distinguishes "the caller gave up waiting" (a real property this
// mission requires) from "the caller merely raced a promise that kept
// running in the background forever."
function hangingFetch(): jest.Mock {
  return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  })
}

describe('boundedFetch() — raw fetch() calls (multisig explorer, EVM bundler)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  it('1. a hung request actually aborts and times out, rather than hanging forever', async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch
    await expect(
      boundedFetch('https://explorer.example/tx/abc/status', {}, { maxResponseBytes: MAX_BYTES, timeoutMs: 30 })
    ).rejects.toThrow(BoundedRpcTimeoutError)
  })

  it('2. a safe (read-only) request retries only a bounded number of times, then gives up', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 })
    global.fetch = fetchMock as unknown as typeof fetch
    const res = await boundedFetch('https://explorer.example/tx/abc/status', {}, {
      maxResponseBytes: MAX_BYTES,
      timeoutMs: 100,
      retry: { attempts: 3, backoffMs: 1 },
    })
    expect(res.status).toBe(503) // final, still-failing response is returned — never silently upgraded to success
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('3. a successful read does not retry, even when retry is authorized', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    const res = await boundedFetch('https://explorer.example/tx/abc/status', {}, {
      maxResponseBytes: MAX_BYTES,
      timeoutMs: 100,
      retry: { attempts: 3, backoffMs: 1 },
    })
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('4. a deterministic client error (404) is never retried, even when retry is authorized', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    global.fetch = fetchMock as unknown as typeof fetch
    const res = await boundedFetch('https://explorer.example/tx/abc/status', {}, {
      maxResponseBytes: MAX_BYTES,
      timeoutMs: 100,
      retry: { attempts: 3, backoffMs: 1 },
    })
    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('5. a broadcast/submission call (no retry authorized) times out but is NEVER retried', async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch
    await expect(
      boundedFetch('https://explorer.example/tx', { method: 'POST', body: 'deadbeef' }, { maxResponseBytes: MAX_BYTES, timeoutMs: 30 })
    ).rejects.toThrow(BoundedRpcTimeoutError)
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1) // exactly once — no automatic retry of a submission
  })

  it('6. a broadcast/submission call that gets a transient 503 is NOT retried (retry is opt-in, never inferred)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 })
    global.fetch = fetchMock as unknown as typeof fetch
    const res = await boundedFetch('https://explorer.example/tx', { method: 'POST', body: 'deadbeef' }, { maxResponseBytes: MAX_BYTES, timeoutMs: 100 })
    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('7. the final error remains visible to the caller after retries are exhausted', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(
      boundedFetch('https://explorer.example/tx/abc/status', {}, { maxResponseBytes: MAX_BYTES, timeoutMs: 100, retry: { attempts: 2, backoffMs: 1 } })
    ).rejects.toThrow('ECONNRESET')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('8. no fake success is produced — a timeout never resolves, it always rejects', async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch
    const outcome = await boundedFetch('https://explorer.example/tx/abc/status', {}, { maxResponseBytes: MAX_BYTES, timeoutMs: 20 }).then(
      () => 'resolved',
      () => 'rejected'
    )
    expect(outcome).toBe('rejected')
  })
})

describe('withBoundedRetry() — ethers JsonRpcProvider calls (SAFE_GUARD_EVM), timeout handled natively by ethers itself (see below)', () => {
  it('2. a safe (read-only) call retries only a bounded number of times, then gives up', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(
      withBoundedRetry(attempt, { attempts: 3, backoffMs: 1 })
    ).rejects.toThrow('ECONNRESET')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('3. a successful call does not retry, even when retry is authorized', async () => {
    const attempt = jest.fn().mockResolvedValue(123n)
    const result = await withBoundedRetry(attempt, { attempts: 3, backoffMs: 1 })
    expect(result).toBe(123n)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('7. the final error remains visible to the caller after retries are exhausted', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('rpc unreachable'))
    await expect(
      withBoundedRetry(attempt, { attempts: 2, backoffMs: 1 })
    ).rejects.toThrow('rpc unreachable')
  })

  it('8. no fake success is produced — a persistently failing call never resolves', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('down'))
    const outcome = await withBoundedRetry(attempt, { attempts: 2, backoffMs: 1 }).then(
      () => 'resolved',
      () => 'rejected'
    )
    expect(outcome).toBe('rejected')
  })
})

// CTO Gate correction (2026-09-06) — the earlier Promise.race()-based
// wrapper was rejected because it only bounded the CALLER's wait, not
// the underlying ethers call itself. These tests prove the REAL,
// evidence-backed replacement directly against `ethers`: a plain TCP
// server that accepts a connection and never responds — no
// application-level mock — and a real `ethers.FetchRequest`/
// `JsonRpcProvider` pointed at it. This is the exact mechanism
// safe-guard-evm.provider.ts's `provider()` now configures.
describe('ethers.FetchRequest.timeout — real transport-level bound (not Promise.race)', () => {
  // Root-cause finding (2026-09-06, CTO Gate correction investigation):
  // an earlier version of this helper did not track accepted sockets,
  // and close() (a plain server.close(cb)) hung indefinitely in every
  // test below. net.Server.close()'s callback does not fire until every
  // connected socket has ended — and it never did, because `ethers`'
  // own timeout handler (node_modules/ethers/lib.commonjs/utils/geturl.js)
  // rejects its JS-level promise on timeout but never calls
  // request.destroy() on the underlying client socket. That hang is
  // itself direct, reproducible evidence for the exact gap the CTO Gate
  // flagged: the promise settling is not the same as the network
  // operation being torn down. This test file's own cleanup now tracks
  // and destroys the abandoned server-side socket explicitly — a
  // test-hygiene fix, not a claim that safe-guard-evm.provider.ts's
  // production code does this too (it does not, and does not attempt
  // to — see provider()'s own comment).
  function hungServer(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer((socket) => {
        // Accept the connection, then do nothing — never write a
        // response, never close it. Genuinely hung, not a mock.
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        resolve({
          port,
          close: () =>
            new Promise((r) => {
              for (const socket of sockets) socket.destroy()
              server.close(() => r())
            }),
        })
      })
    })
  }

  it('1. a genuinely hung connection (real TCP server, no mock) times out at the configured bound with a distinguishable error', async () => {
    const { port, close } = await hungServer()
    try {
      const connection = new FetchRequest(`http://127.0.0.1:${port}/`)
      connection.timeout = 300
      // staticNetwork requires an explicit network alongside the boolean
      // (confirmed directly — passing staticNetwork:true with no network
      // arg is a no-op) so this test isn't slowed/noised by ethers' own
      // background eth_chainId network-detection retry loop; chainId is
      // arbitrary, this test never reaches a real chain.
      const provider = new JsonRpcProvider(connection, 1, { staticNetwork: true })
      const start = Date.now()
      await expect(provider.getBalance('0x0000000000000000000000000000000000000001')).rejects.toMatchObject({ code: 'TIMEOUT' })
      const elapsed = Date.now() - start
      // Bounded, not instant and not indefinite — proves this settled at
      // the configured timeout, not immediately and not never.
      expect(elapsed).toBeGreaterThanOrEqual(250)
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await close()
    }
  }, 10_000)

  it('8. no fake success is produced against a genuinely hung connection', async () => {
    const { port, close } = await hungServer()
    try {
      const connection = new FetchRequest(`http://127.0.0.1:${port}/`)
      connection.timeout = 250
      // staticNetwork requires an explicit network alongside the boolean
      // (confirmed directly — passing staticNetwork:true with no network
      // arg is a no-op) so this test isn't slowed/noised by ethers' own
      // background eth_chainId network-detection retry loop; chainId is
      // arbitrary, this test never reaches a real chain.
      const provider = new JsonRpcProvider(connection, 1, { staticNetwork: true })
      const outcome = await provider.getBalance('0x0000000000000000000000000000000000000001').then(
        () => 'resolved',
        () => 'rejected'
      )
      expect(outcome).toBe('rejected')
    } finally {
      await close()
    }
  }, 10_000)
})
