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
import { WebSocketRelayTransportProvider, webSocketRelayTransportProvider as relay } from '../src/infrastructure/p2p/websocket-relay.service'

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

  it('rejects a live WebSocket upgrade without a ticket before registration', async () => {
    const denied = new WebSocket(base + '/ws/relay')
    clients.push(denied)
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Unauthenticated upgrade did not close')), 2000)
      denied.once('close', code => {
        clearTimeout(timeout)
        resolve(code)
      })
      denied.once('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    expect(closeCode).toBe(1008)
    expect(ticket).not.toHaveBeenCalled()
  })

  it('rejects an invalid ticket without registering a relay socket', async () => {
    const denied = new WebSocket(base + '/ws/relay?ticket=invalid')
    clients.push(denied)
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Invalid ticket socket did not close')), 2000)
      denied.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      denied.once('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    await closed
    expect(ticket).toHaveBeenCalledWith('invalid')
    expect(relay.isConnected('invalid')).toBe(false)
  })

  it('rejects unsupported topic discovery instead of silently succeeding', async () => {
    await expect(relay.joinTopic('alice', 'marketplace')).rejects.toThrow('does not support topic discovery')
    await expect(relay.broadcast('alice', { kind: 'offer_announce' })).resolves.toBe(0)
  })

  it('does not claim delivery to a socket registered in another provider instance', async () => {
    const serverA = new WebSocketRelayTransportProvider()
    const serverB = new WebSocketRelayTransportProvider()
    const bobSocket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    serverB.registerSocket('bob', bobSocket)
    try {
      expect(serverB.isConnected('bob')).toBe(true)
      expect(serverA.isConnected('bob')).toBe(false)
      await expect(serverA.sendToPeer('alice', 'bob', 'opaque')).resolves.toBe(false)
      expect(bobSocket.send).not.toHaveBeenCalled()
    } finally {
      await serverB.stop('bob')
    }
  })

  it('returns false if an OPEN socket throws during send without evicting its owner', async () => {
    const fakeSocket = { readyState: 1, send: jest.fn(() => { throw new Error('socket failed') }), close: jest.fn() }
    relay.registerSocket('failed-send-test', fakeSocket)
    try {
      await expect(relay.sendToPeer('alice', 'failed-send-test', 'opaque')).resolves.toBe(false)
      expect(fakeSocket.send).toHaveBeenCalledWith('opaque')
      expect(relay.ownsSocket('failed-send-test', fakeSocket)).toBe(true)
    } finally {
      relay.unregisterSocket('failed-send-test', fakeSocket)
    }
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
