import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'

const ticket = jest.fn()
const budget = jest.fn()
const dispatch = jest.fn()
const sockets = new Map<string, unknown>()

jest.mock('../src/common/middleware/ws-auth', () => ({
  resolveParticipantFromTicket: (...args: unknown[]) => ticket(...args),
}))
jest.mock('../src/infrastructure/p2p/relay-shared-budget', () => ({
  consumeSharedRelayBudget: (...args: unknown[]) => budget(...args),
}))
jest.mock('../src/infrastructure/p2p/websocket-relay.service', () => ({
  webSocketRelayTransportProvider: {
    registerSocket: (id: string, socket: unknown) => sockets.set(id, socket),
    ownsSocket: (id: string, socket: unknown) => sockets.get(id) === socket,
    unregisterSocket: (id: string, socket: unknown) => {
      if (sockets.get(id) === socket) sockets.delete(id)
    },
    dispatchIncoming: (...args: unknown[]) => dispatch(...args),
    // #307 Phase B provider API; no router here, so no delivery ownership.
    prepareRegistration: async () => undefined,
    abandonRegistration: () => undefined,
  },
}))

import { relayRoutes } from '../src/infrastructure/p2p/relay.routes'

describe('relay live WebSocket upgrade and ingress', () => {
  let app: ReturnType<typeof Fastify>
  let base: string
  const clients: WebSocket[] = []

  const connect = (token = 'valid'): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const client = new WebSocket(base + '/ws/relay?ticket=' + token)
      clients.push(client)
      client.once('open', () => resolve(client))
      client.once('error', reject)
    })

  const waitRegistered = async () => {
    for (let i = 0; i < 200; i++) {
      if (sockets.has('participant')) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Relay socket not registered after authentication')
  }

  const closeEvent = (client: WebSocket): Promise<number> =>
    new Promise(resolve => client.once('close', code => resolve(code)))

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(relayRoutes)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Unexpected listener address')
    base = 'ws://127.0.0.1:' + address.port
  })

  afterAll(async () => {
    for (const client of clients) client.terminate()
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    sockets.clear()
    ticket.mockResolvedValue('participant')
    budget.mockResolvedValue(true)
  })

  it('rejects a missing ticket before attempting Redis-backed resolution', async () => {
    const client = await connect('')
    const closed = closeEvent(client)
    expect(await closed).toBe(1008)
    expect(ticket).not.toHaveBeenCalled()
    expect(sockets.size).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('closes an unauthenticated live socket after ticket resolution exceeds its deadline', async () => {
    ticket.mockImplementation(() => new Promise<string | null>(() => {}))
    const client = await connect('stalled-ticket')
    const closed = closeEvent(client)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      expect(await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error('Authentication timeout not enforced')), 7000)
        }),
      ])).toBe(1011)
    } finally {
      if (watchdog) clearTimeout(watchdog)
    }
    expect(sockets.size).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  }, 10000)

  it('authenticates a real upgrade and forwards accepted frames in order', async () => {
    const client = await connect()
    await waitRegistered()
    client.send('first')
    client.send('second')
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('No dispatch')), 2000)
      const poll = () => {
        if (dispatch.mock.calls.length === 2) {
          clearTimeout(deadline)
          resolve()
        } else setTimeout(poll, 10)
      }
      poll()
    })
    expect(dispatch.mock.calls).toEqual([
      ['participant', 'first'],
      ['participant', 'second'],
    ])
  })

  it('closes a real socket with policy violation when budget is denied', async () => {
    budget.mockResolvedValue(false)
    const client = await connect()
    await waitRegistered()
    const closed = closeEvent(client)
    client.send('blocked')
    expect(await closed).toBe(1008)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('enforces the frame cap on a real WebSocket before Redis or dispatch', async () => {
    const client = await connect()
    await waitRegistered()
    const closed = closeEvent(client)
    client.send(Buffer.alloc(64 * 1024 + 1))
    expect(await closed).toBe(1009)
    expect(budget).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reconnects with a fresh ticket and retires the previous socket without losing the new owner', async () => {
    const first = await connect('ticket-one')
    await waitRegistered()
    const second = await connect('ticket-two')
    for (let i = 0; i < 200 && sockets.get('participant') === first; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(sockets.get('participant')).not.toBe(first)
    const firstClosed = closeEvent(first)
    first.close()
    await firstClosed
    expect(sockets.has('participant')).toBe(true)
    second.send('after-reconnect')
    for (let i = 0; i < 200 && dispatch.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(dispatch.mock.calls).toEqual([['participant', 'after-reconnect']])
    expect(ticket).toHaveBeenCalledWith('ticket-one')
    expect(ticket).toHaveBeenCalledWith('ticket-two')
  })

  it('opens the live relay through the SDK with a fresh authenticated ticket', async () => {
    const { SailsClient } = await import('../packages/sails-sdk/src/client')
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ticket: 'sdk-ticket', expiresIn: 30 } }),
    })
    const sdk = new SailsClient({
      baseUrl: base.replace(/^ws/, 'http'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    })
    sdk.setSessionToken('sdk-session')
    const client = await sdk.peers.connectRelay() as unknown as WebSocket
    clients.push(client)
    if (client.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
    }
    await waitRegistered()
    client.send('sdk-relay-e2e')
    for (let i = 0; i < 200 && dispatch.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(dispatch.mock.calls).toEqual([['participant', 'sdk-relay-e2e']])
    expect(ticket).toHaveBeenCalledWith('sdk-ticket')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(base.replace(/^ws/, 'http') + '/v1/identity/ws-ticket')
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer sdk-session')
  })

  it('keeps two distinct authenticated participants isolated on real sockets', async () => {
    ticket.mockImplementation(async (value: string) => value === 'alice-ticket' ? 'alice' : value === 'bob-ticket' ? 'bob' : null)
    const alice = await connect('alice-ticket')
    const bob = await connect('bob-ticket')
    for (let i = 0; i < 200 && (!sockets.has('alice') || !sockets.has('bob')); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(sockets.size).toBe(2)
    expect(sockets.get('alice')).not.toBe(sockets.get('bob'))
    alice.send('from-alice')
    bob.send('from-bob')
    for (let i = 0; i < 200 && dispatch.mock.calls.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(dispatch.mock.calls).toEqual(expect.arrayContaining([
      ['alice', 'from-alice'],
      ['bob', 'from-bob'],
    ]))
    expect(dispatch).toHaveBeenCalledTimes(2)
    const aliceClosed = closeEvent(alice)
    alice.close()
    await aliceClosed
    for (let i = 0; i < 200 && sockets.has('alice'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(sockets.has('alice')).toBe(false)
    expect(sockets.has('bob')).toBe(true)
  })

  it('rejects invalid tickets without registering the participant', async () => {
    ticket.mockResolvedValue(null)
    const client = await connect('invalid')
    const closed = closeEvent(client)
    expect([1000, 1005]).toContain(await closed)
    expect(sockets.size).toBe(0)
  })
})
