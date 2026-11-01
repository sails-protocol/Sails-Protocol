import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'

const ticket = jest.fn()
const budget = jest.fn()

jest.mock('../src/common/middleware/ws-auth', () => ({
  resolveParticipantFromTicket: (...args: unknown[]) => ticket(...args),
}))
jest.mock('../src/infrastructure/p2p/relay-shared-budget', () => ({
  consumeSharedRelayBudget: (...args: unknown[]) => budget(...args),
}))

import { relayRoutes } from '../src/infrastructure/p2p/relay.routes'
import { webSocketRelayTransportProvider as relay } from '../src/infrastructure/p2p/websocket-relay.service'

describe('real relay provider with two live TCP WebSocket clients', () => {
  let app: ReturnType<typeof Fastify>
  let base: string
  const clients: WebSocket[] = []

  const connect = (name: string): Promise<WebSocket> => new Promise((resolve, reject) => {
    const client = new WebSocket(base + '/ws/relay?ticket=' + name)
    clients.push(client)
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })

  const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Timed out waiting for relay condition')
  }

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
    ticket.mockImplementation(async (name: string) => name === 'alice' || name === 'bob' ? name : null)
    budget.mockResolvedValue(true)
  })

  it('forwards opaque payload to Bob without echoing to Alice and keeps Bob connected after Alice leaves', async () => {
    const alice = await connect('alice')
    const bob = await connect('bob')
    await until(() => relay.isConnected('alice') && relay.isConnected('bob'))
    const aliceMessages: string[] = []
    alice.on('message', data => aliceMessages.push(data.toString()))
    const bobReceived = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bob did not receive payload')), 2000)
      bob.once('message', data => {
        clearTimeout(timeout)
        resolve(data.toString())
      })
    })
    const opaque = 'encrypted:opaque-payload-not-json'
    expect(await relay.sendToPeer('alice', 'bob', opaque)).toBe(true)
    expect(await bobReceived).toBe(opaque)
    expect(aliceMessages).toEqual([])
    const aliceClosed = new Promise<void>(resolve => alice.once('close', () => resolve()))
    alice.close()
    await aliceClosed
    await until(() => !relay.isConnected('alice'))
    expect(relay.isConnected('bob')).toBe(true)
    expect(await relay.sendToPeer('alice', 'bob', 'still-connected')).toBe(true)
    expect(await relay.sendToPeer('bob', 'alice', 'offline')).toBe(false)
  })
})
