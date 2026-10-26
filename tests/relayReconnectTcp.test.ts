import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'

const resolveTicket = jest.fn()
const budget = jest.fn()

jest.mock('../src/common/middleware/ws-auth', () => ({
  resolveParticipantFromTicket: (...args: unknown[]) => resolveTicket(...args),
}))
jest.mock('../src/infrastructure/p2p/relay-shared-budget', () => ({
  consumeSharedRelayBudget: (...args: unknown[]) => budget(...args),
}))

import { relayRoutes } from '../src/infrastructure/p2p/relay.routes'
import { webSocketRelayTransportProvider as relay } from '../src/infrastructure/p2p/websocket-relay.service'

it('replaces a live authenticated TCP socket and rejects stale frames without losing the new connection', async () => {
  const app = Fastify({ logger: false })
  const clients: WebSocket[] = []
  const received: string[] = []
  const participant = 'relay-reconnect-tcp-test'
  const waitUntil = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 3000
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(description)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    resolveTicket.mockReset().mockResolvedValue(participant)
    budget.mockReset().mockResolvedValue(true)
    relay.onMessage(participant, (_peerId, payload) => received.push(String(payload)))
    await app.register(websocket)
    await app.register(relayRoutes)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const connect = async (ticket: string) => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
      return client
    }
    const oldClient = await connect('ticket-one')
    await waitUntil(() => relay.isConnected(participant), 'Initial socket was not registered')
    const oldClosed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Superseded socket was not closed')), 3000)
      oldClient.once('close', code => { clearTimeout(timeout); resolve(code) })
    })
    const newClient = await connect('ticket-two')
    await oldClosed
    await waitUntil(() => relay.isConnected(participant), 'Replacement socket lost registration')
    newClient.send('new-connection-frame')
    await waitUntil(() => received.includes('new-connection-frame'), 'Replacement frame was not dispatched')
    expect(received).toEqual(['new-connection-frame'])
    expect(budget).toHaveBeenCalledWith(participant, Buffer.byteLength('new-connection-frame'))
    expect(resolveTicket).toHaveBeenCalledWith('ticket-one')
    expect(resolveTicket).toHaveBeenCalledWith('ticket-two')
  } finally {
    clients.forEach(client => client.terminate())
    await app.close()
    await relay.stop(participant)
  }
})
