/**
 * Transport fallback — 03-implementation_plan.md section 3.
 *
 * Unlike PearsTransportProvider (wraps live HyperDHT/Hyperswarm — cannot
 * be verified without a real P2P network, same limitation RFC-010's
 * RedisStreamsEventStore already disclosed for this environment),
 * FallbackTransportProvider's race/timeout logic and
 * WebSocketRelayTransportProvider's blind-relay logic are pure enough to
 * verify for real, with fake in-memory TransportProvider/socket doubles —
 * so they are, here, rather than left as "it type-checks."
 */
import { FallbackTransportProvider, type TransportProvider, type PeerHandle } from '../src/infrastructure/p2p/transport-provider'
import { WebSocketRelayTransportProvider, type RelaySocket } from '../src/infrastructure/p2p/websocket-relay.service'

function fakeProvider(name: string, opts: { startDelayMs?: number; shouldFail?: boolean } = {}): TransportProvider {
  return {
    name,
    async start(participantId: string): Promise<PeerHandle> {
      if (opts.startDelayMs) await new Promise((r) => setTimeout(r, opts.startDelayMs))
      if (opts.shouldFail) throw new Error(`${name} failed to connect`)
      return { peerId: `${name}:${participantId}` }
    },
    async stop() { },
    async joinTopic() { },
    async broadcast() { return 0 },
    async sendToPeer() { return true },
    onMessage() { },
    isConnected() { return true },
  }
}

describe('FallbackTransportProvider (03-implementation_plan.md section 3)', () => {
  it('uses the primary provider when it connects within the timeout', async () => {
    const primary = fakeProvider('pears', { startDelayMs: 10 })
    const secondary = fakeProvider('websocket-relay')
    const fallback = new FallbackTransportProvider(primary, secondary, 100)

    const handle = await fallback.start('user-1')
    expect(handle.peerId).toBe('pears:user-1')
  })

  it('falls back to the secondary provider when the primary exceeds the timeout', async () => {
    const primary = fakeProvider('pears', { startDelayMs: 200 }) // slower than the 50ms timeout below
    const secondary = fakeProvider('websocket-relay')
    const fallback = new FallbackTransportProvider(primary, secondary, 50)

    const handle = await fallback.start('user-1')
    expect(handle.peerId).toBe('websocket-relay:user-1')
  })

  it('cleans up a late primary completion after relay fallback', async () => {
    let completePrimary!: (handle: PeerHandle) => void
    const primaryStart = jest.fn(() => new Promise<PeerHandle>(resolve => { completePrimary = resolve }))
    const primaryStop = jest.fn().mockResolvedValue(undefined)
    const primary = { ...fakeProvider('pears'), start: primaryStart, stop: primaryStop }
    const secondary = fakeProvider('websocket-relay')
    const fallback = new FallbackTransportProvider(primary, secondary, 5)

    expect((await fallback.start('late-primary')).peerId).toBe('websocket-relay:late-primary')
    expect(fallback.activeTransportName('late-primary')).toBe('websocket-relay')
    completePrimary({ peerId: 'pears:late-primary' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(primaryStop).toHaveBeenCalledWith('late-primary')
    expect(fallback.activeTransportName('late-primary')).toBe('websocket-relay')
  })

  it('does not stop a newer primary when an older timed-out start completes', async () => {
    let completeOld!: (handle: PeerHandle) => void
    let calls = 0
    const primaryStop = jest.fn().mockResolvedValue(undefined)
    const primary = {
      ...fakeProvider('pears'),
      start: jest.fn(async () => {
        calls++
        if (calls === 1) return new Promise<PeerHandle>(resolve => { completeOld = resolve })
        return { peerId: 'pears:new' }
      }),
      stop: primaryStop,
    }
    const fallback = new FallbackTransportProvider(primary, fakeProvider('websocket-relay'), 5)
    expect((await fallback.start('same-user')).peerId).toBe('websocket-relay:same-user')
    expect((await fallback.start('same-user')).peerId).toBe('pears:new')
    completeOld({ peerId: 'pears:old' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(primaryStop).not.toHaveBeenCalled()
    expect(fallback.activeTransportName('same-user')).toBe('pears')
  })

  it('does not let a stale fallback completion replace the newer primary', async () => {
    let releaseRelay!: (handle: PeerHandle) => void
    let primaryCalls = 0
    const primary = {
      ...fakeProvider('pears'),
      start: jest.fn(async () => {
        primaryCalls++
        if (primaryCalls === 1) throw new Error('primary temporarily unavailable')
        return { peerId: 'pears:new' }
      }),
    }
    const secondary = {
      ...fakeProvider('websocket-relay'),
      start: jest.fn(() => new Promise<PeerHandle>(resolve => { releaseRelay = resolve })),
    }
    const fallback = new FallbackTransportProvider(primary, secondary, 100)
    const older = fallback.start('same-user')
    for (let i = 0; i < 20 && !releaseRelay; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(releaseRelay).toBeDefined()
    expect((await fallback.start('same-user')).peerId).toBe('pears:new')
    releaseRelay({ peerId: 'websocket-relay:old' })
    expect((await older).peerId).toBe('websocket-relay:old')
    expect(fallback.activeTransportName('same-user')).toBe('pears')
  })

  it('does not clean up a late primary while relay fallback is still starting', async () => {
    let releasePrimary!: (handle: PeerHandle) => void
    let releaseRelay!: (handle: PeerHandle) => void
    const primaryStop = jest.fn().mockResolvedValue(undefined)
    const primary = {
      ...fakeProvider('pears'),
      start: jest.fn(() => new Promise<PeerHandle>(resolve => { releasePrimary = resolve })),
      stop: primaryStop,
    }
    const secondary = {
      ...fakeProvider('websocket-relay'),
      start: jest.fn(() => new Promise<PeerHandle>(resolve => { releaseRelay = resolve })),
    }
    const fallback = new FallbackTransportProvider(primary, secondary, 5)
    const pending = fallback.start('race-user')
    for (let i = 0; i < 20 && !releaseRelay; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(releaseRelay).toBeDefined()
    releasePrimary({ peerId: 'pears:late' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(primaryStop).not.toHaveBeenCalled()
    releaseRelay({ peerId: 'websocket-relay:race-user' })
    await pending
    expect(fallback.activeTransportName('race-user')).toBe('websocket-relay')
  })

  it('falls back to the secondary provider when the primary rejects outright', async () => {
    const primary = fakeProvider('pears', { shouldFail: true })
    const secondary = fakeProvider('websocket-relay')
    const fallback = new FallbackTransportProvider(primary, secondary, 100)

    const handle = await fallback.start('user-1')
    expect(handle.peerId).toBe('websocket-relay:user-1')
  })

  it('routes subsequent calls (sendToPeer) through whichever provider actually connected', async () => {
    const primarySend = jest.fn().mockResolvedValue(true)
    const secondarySend = jest.fn().mockResolvedValue(true)
    const primary = { ...fakeProvider('pears', { shouldFail: true }), sendToPeer: primarySend }
    const secondary = { ...fakeProvider('websocket-relay'), sendToPeer: secondarySend }
    const fallback = new FallbackTransportProvider(primary, secondary, 100)

    await fallback.start('user-1')
    await fallback.sendToPeer('user-1', 'user-2', { hello: 'world' })

    expect(secondarySend).toHaveBeenCalledWith('user-1', 'user-2', { hello: 'world' })
    expect(primarySend).not.toHaveBeenCalled()
  })
})

describe('WebSocketRelayTransportProvider — CISO Privacy Rule (Blind Relay)', () => {
  function fakeSocket(): RelaySocket & { sent: string[] } {
    const sent: string[] = []
    return {
      sent,
      readyState: 1, // OPEN
      send(data: string) { sent.push(data) },
      close() { },
    }
  }

  it('forwards a payload verbatim between two registered participants', async () => {
    const relay = new WebSocketRelayTransportProvider()
    const buyerSocket = fakeSocket()
    const sellerSocket = fakeSocket()
    relay.registerSocket('buyer', buyerSocket)
    relay.registerSocket('seller', sellerSocket)

    const encryptedBlob = 'ENCRYPTED:opaque-secretstream-bytes-not-json'
    const delivered = await relay.sendToPeer('buyer', 'seller', encryptedBlob)

    expect(delivered).toBe(true)
    expect(sellerSocket.sent).toEqual([encryptedBlob]) // forwarded verbatim — never parsed, never re-encoded
    expect(buyerSocket.sent).toEqual([]) // never echoed back to the sender
  })

  it('returns false (not an error) when the target participant has no registered socket', async () => {
    const relay = new WebSocketRelayTransportProvider()
    const delivered = await relay.sendToPeer('buyer', 'nobody-connected', 'payload')
    expect(delivered).toBe(false)
  })

  it('dispatches an incoming frame to the correct participant-specific handler only', () => {
    const relay = new WebSocketRelayTransportProvider()
    const buyerHandler = jest.fn()
    const sellerHandler = jest.fn()
    relay.onMessage('buyer', buyerHandler)
    relay.onMessage('seller', sellerHandler)

    relay.dispatchIncoming('seller', 'incoming-blob')

    expect(sellerHandler).toHaveBeenCalledWith('seller', 'incoming-blob')
    expect(buyerHandler).not.toHaveBeenCalled()
  })

  it('closes a superseded socket without unregistering or disconnecting its replacement', async () => {
    const relay = new WebSocketRelayTransportProvider()
    const oldSocket = fakeSocket()
    const newSocket = fakeSocket()
    const closeOld = jest.spyOn(oldSocket, 'close')
    relay.registerSocket('buyer', oldSocket)
    relay.registerSocket('buyer', newSocket)
    expect(closeOld).toHaveBeenCalledTimes(1)
    expect(relay.ownsSocket('buyer', oldSocket)).toBe(false)
    expect(relay.ownsSocket('buyer', newSocket)).toBe(true)
    relay.unregisterSocket('buyer', oldSocket)
    expect(relay.isConnected('buyer')).toBe(true)
    expect(await relay.sendToPeer('seller', 'buyer', 'after-reconnect')).toBe(true)
    expect(newSocket.sent).toEqual(['after-reconnect'])
    expect(oldSocket.sent).toEqual([])
  })

  it('keeps the authenticated replacement registered if closing the stale socket throws', async () => {
    const relay = new WebSocketRelayTransportProvider()
    const stale = fakeSocket()
    stale.close = () => { throw new Error('transport already broken') }
    const replacement = fakeSocket()
    relay.registerSocket('buyer', stale)
    expect(() => relay.registerSocket('buyer', replacement)).not.toThrow()
    expect(relay.ownsSocket('buyer', replacement)).toBe(true)
    expect(await relay.sendToPeer('seller', 'buyer', 'healthy')).toBe(true)
    expect(replacement.sent).toEqual(['healthy'])
  })

  it('reports a participant as connected only while their socket is registered and open', async () => {
    const relay = new WebSocketRelayTransportProvider()
    expect(relay.isConnected('buyer')).toBe(false)

    relay.registerSocket('buyer', fakeSocket())
    expect(relay.isConnected('buyer')).toBe(true)

    await relay.stop('buyer')
    expect(relay.isConnected('buyer')).toBe(false)
  })
})
