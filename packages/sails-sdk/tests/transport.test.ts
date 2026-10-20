/**
 * SailsTransport — the SDK's only network boundary. Every test injects a
 * fake `fetchImpl` (the constructor param this file was specifically
 * designed to accept for exactly this) rather than mocking the global
 * `fetch`, so these tests never depend on jsdom/node-fetch internals.
 */
import { SailsTransport } from '../src/transport'
import { SailsAuthError, SailsForbiddenError, SailsTransportError, SailsValidationError, SailsNotFoundError } from '../src/errors'

function fakeFetch(status: number, body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('SailsTransport', () => {
  it('builds a GET request with query params appended, dropping undefined values', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { ok: true } })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await transport.get('/v1/liquidity/offers', { asset: 'BTC', side: undefined, limit: 5 })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/liquidity/offers?asset=BTC&limit=5')
    expect(init.method).toBe('GET')
  })

  it('sends a JSON body with content-type on POST', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'x' } })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await transport.post('/v1/identity/participants', { publicKey: 'abc' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/identity/participants')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ publicKey: 'abc' })
  })

  it('attaches the Bearer session token only when auth=true and a token is set', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: {} })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken('session-abc')

    await transport.get('/v1/identity/me', undefined, true)

    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('throws SailsTransportError instead of calling fetch when auth=true but no session token is set', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: {} })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsTransportError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns the unwrapped `data` field on a successful envelope', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'trade-1', amount: '20.5' } })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await transport.get('/v1/openp2p/trades/trade-1')
    expect(result).toEqual({ id: 'trade-1', amount: '20.5' })
  })

  it('maps a VALIDATION_ERROR response to SailsValidationError with its details', async () => {
    const fetchImpl = fakeFetch(400, {
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: [{ path: ['asset'], message: 'Required' }],
    })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(transport.post('/v1/liquidity/offers', {})).rejects.toThrow(SailsValidationError)
  })

  it('maps a NOT_FOUND response to SailsNotFoundError', async () => {
    const fetchImpl = fakeFetch(404, { success: false, error: 'NOT_FOUND', message: 'Trade nope not found', details: [] })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(transport.get('/v1/openp2p/trades/nope')).rejects.toThrow(SailsNotFoundError)
  })

  it('throws SailsTransportError when the response body is not JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(transport.get('/health')).rejects.toThrow(SailsTransportError)
  })

  it('throws SailsTransportError when the network request itself fails (no retry configured here — see the dedicated retry describe block below)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 0 })

    await expect(transport.get('/health')).rejects.toThrow(SailsTransportError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

/**
 * Mission 3 Slice 1 (docs/PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md
 * §15/§16) — closes P3-F08.1. Proves the generic session-expiry signal
 * fires ONLY for the real case it's meant to represent (an authenticated
 * call's own session genuinely going stale), never for adjacent cases
 * that would misrepresent what happened (an unauthenticated call, or a
 * different error class entirely) — the same "don't collapse distinct
 * failure classes into one signal" discipline this codebase's error
 * taxonomy already enforces server-side, applied here to a client-side
 * signal for the first time.
 */
describe('SailsTransport — onSessionExpired (Mission 3 Slice 1, P3-F08.1)', () => {
  it('fires exactly once, with the real SailsAuthError, when an authenticated call receives a 401', async () => {
    const fetchImpl = fakeFetch(401, { success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] })
    const onSessionExpired = jest.fn()
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })
    transport.setSessionToken('session-abc')

    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsAuthError)

    expect(onSessionExpired).toHaveBeenCalledTimes(1)
    expect(onSessionExpired.mock.calls[0][0]).toBeInstanceOf(SailsAuthError)
    expect(onSessionExpired.mock.calls[0][0].message).toBe('Session expired')
  })

  it('Mission 3 R1 — auth:true with NO session token never reaches a 401 at all, and the hook never fires: "no session ≠ expired session"', async () => {
    const fetchImpl = fakeFetch(401, { success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] })
    const onSessionExpired = jest.fn()
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })
    // Deliberately never calling setSessionToken() — this request was
    // never carrying an established session to begin with.

    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsTransportError)

    expect(fetchImpl).not.toHaveBeenCalled() // the transport's own pre-flight guard rejected this before any network call
    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('Mission 3 R1 — reasons from the token state captured AT DISPATCH time, not a later read: a token cleared WHILE this request is still in flight does not suppress the signal for the request that genuinely carried one', async () => {
    const onSessionExpired = jest.fn()
    let transport!: SailsTransport
    // The fake fetch itself simulates "the token was cleared by a
    // CONCURRENT logout()/onSessionExpired reaction elsewhere" partway
    // through this SAME request's own network round-trip — proving the
    // hook still fires correctly for THIS request (it dispatched with a
    // real token) despite `this.sessionToken` being null by the time the
    // response is actually processed.
    const fetchImpl = jest.fn().mockImplementation(async () => {
      transport.setSessionToken(null)
      return { ok: false, status: 401, json: async () => ({ success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] }) }
    })
    transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })
    transport.setSessionToken('session-abc')

    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsAuthError)

    expect(onSessionExpired).toHaveBeenCalledTimes(1) // still fires — this request genuinely dispatched with a real token
    expect(transport.getSessionToken()).toBeNull() // confirms the race actually happened, not a no-op
  })

  it('does NOT fire for an unauthenticated call\'s error — there was no session to lose in the first place', async () => {
    const fetchImpl = fakeFetch(401, { success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] })
    const onSessionExpired = jest.fn()
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })

    // auth=false (the default) — this call was never carrying a session.
    await expect(transport.get('/v1/liquidity/offers')).rejects.toThrow(SailsAuthError)

    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('does NOT fire for a different error class on an authenticated call (e.g. SailsForbiddenError) — only a real session expiry qualifies', async () => {
    const fetchImpl = fakeFetch(403, { success: false, error: 'FORBIDDEN', message: 'Not your trade', details: [] })
    const onSessionExpired = jest.fn()
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })
    transport.setSessionToken('session-abc')

    await expect(transport.get('/v1/openp2p/trades/x', undefined, true)).rejects.toThrow(SailsForbiddenError)

    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('a handler that itself throws never breaks the real request\'s own error propagation', async () => {
    const fetchImpl = fakeFetch(401, { success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] })
    const onSessionExpired = jest.fn(() => { throw new Error('a broken handler') })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, onSessionExpired })
    transport.setSessionToken('session-abc')

    // The caller must still see the REAL SailsAuthError, not the
    // handler's own internal failure.
    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsAuthError)
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('setOnSessionExpired() registers a handler after construction, and passing undefined clears it', async () => {
    const fetchImpl = fakeFetch(401, { success: false, error: 'AUTH_ERROR', message: 'Session expired', details: [] })
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken('session-abc')

    const onSessionExpired = jest.fn()
    transport.setOnSessionExpired(onSessionExpired)
    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsAuthError)
    expect(onSessionExpired).toHaveBeenCalledTimes(1)

    transport.setOnSessionExpired(undefined)
    await expect(transport.get('/v1/identity/me', undefined, true)).rejects.toThrow(SailsAuthError)
    expect(onSessionExpired).toHaveBeenCalledTimes(1) // unchanged — the cleared handler was never called again
  })
})

// PRODUCTION_READINESS_REVIEW.md's High-severity finding #1, closed
// 2026-08-02 — real timeout (AbortController) on every request, real
// exponential-backoff retry for GET only. retryDelayMs is set tiny in
// every test below so these stay fast — the backoff math itself doesn't
// depend on the delay's magnitude, only on the attempt count.
describe('SailsTransport — network reliability (timeout + retry, RFC PRODUCTION_READINESS_REVIEW.md)', () => {
  it('retries a GET on network failure up to maxRetries, then succeeds', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) })
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    const result = await transport.get('/health')

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('gives up after maxRetries and throws the last error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    await expect(transport.get('/health')).rejects.toThrow(SailsTransportError)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('retries a GET on a retryable 503 status, then succeeds', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ success: false, error: 'UNAVAILABLE' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) })
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    const result = await transport.get('/health')

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-retryable 4xx status (e.g. 404) — retrying identical input changes nothing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({ success: false, error: 'NOT_FOUND', message: 'nope', details: [] }),
    })
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    await expect(transport.get('/health')).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never retries a mutating request (POST) on network failure — no idempotency-key mechanism to make that safe', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    await expect(transport.post('/v1/settlement/escrow', { foo: 'bar' })).rejects.toThrow(SailsTransportError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never retries a mutating request (POST) on a retryable 503 either', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ success: false, error: 'UNAVAILABLE' }) })
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, retryDelayMs: 1,
    })

    await expect(transport.post('/v1/settlement/escrow', {})).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('aborts and throws a clear timeout error when a request hangs past timeoutMs', async () => {
    // fetchImpl that never resolves on its own — only settles if its
    // AbortSignal actually fires, proving the real AbortController wiring
    // (not just a Promise.race timer racing an unrelated fetch).
    const fetchImpl = jest.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20, maxRetries: 0,
    })

    await expect(transport.get('/health')).rejects.toThrow(/timed out after 20ms/)
  })
})

describe('SDK relay ticket wiring', () => {
  it('requires a session and obtains a new ticket for every relay connection', async () => {
    const { SailsPeersModule } = await import('../src/modules/peers')
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ticket: 'one', expiresIn: 30 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ticket: 'two', expiresIn: 30 } }) })
    // URL wiring only; the READY handshake itself is proven over real TCP in
    // tests/sdkRelayReadyHandshake.test.ts and tests/integration/relaySdkRealE2E.test.ts.
    const socketCtor = jest.fn().mockImplementation(function (this: EventTarget) {
      const target = new EventTarget()
      setTimeout(() => target.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'READY' }) })), 0)
      return Object.assign(target, { readyState: 1, close: () => undefined })
    })
    const transport = new SailsTransport({
      baseUrl: 'https://relay.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketImpl: socketCtor as unknown as typeof WebSocket,
    })
    const peers = new SailsPeersModule(transport)
    await expect(peers.connectRelay()).rejects.toBeInstanceOf(SailsTransportError)
    expect(fetchImpl).not.toHaveBeenCalled()
    transport.setSessionToken('session')
    await peers.connectRelay()
    await peers.connectRelay()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'https://relay.example/v1/identity/ws-ticket',
      'https://relay.example/v1/identity/ws-ticket',
    ])
    expect(fetchImpl.mock.calls.every(call => call[1].headers.authorization === 'Bearer session')).toBe(true)
    expect(socketCtor.mock.calls.map(call => call[0])).toEqual([
      'wss://relay.example/ws/relay?ticket=one',
      'wss://relay.example/ws/relay?ticket=two',
    ])
  })
})
