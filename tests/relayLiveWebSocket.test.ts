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

  it('rejects invalid tickets without registering the participant', async () => {
    ticket.mockResolvedValue(null)
    const client = await connect('invalid')
    const closed = closeEvent(client)
    expect([1000, 1005]).toContain(await closed)
    expect(sockets.size).toBe(0)
  })
})
