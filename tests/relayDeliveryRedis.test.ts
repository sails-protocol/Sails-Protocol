import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { RedisRelayDeliveryTransport } from '../src/infrastructure/p2p/relay-delivery-redis'
import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'

class RedisBus {
  private readonly subscriptions = new Map<string, Set<MockRedis>>()
  subscribe(client: MockRedis, channel: string): number {
    const clients = this.subscriptions.get(channel) ?? new Set<MockRedis>()
    clients.add(client)
    this.subscriptions.set(channel, clients)
    return clients.size
  }
  unsubscribe(client: MockRedis, channel: string): void {
    this.subscriptions.get(channel)?.delete(client)
  }
  publish(channel: string, payload: string): number {
    const clients = this.subscriptions.get(channel)
    if (!clients) return 0
    for (const client of clients) queueMicrotask(() => client.emit('message', channel, payload))
    return clients.size
  }
}
class MockRedis extends EventEmitter {
  constructor(private readonly bus: RedisBus) { super() }
  async subscribe(channel: string): Promise<number> { return this.bus.subscribe(this, channel) }
  async unsubscribe(channel: string): Promise<void> { this.bus.unsubscribe(this, channel) }
  async publish(channel: string, payload: string): Promise<number> { return this.bus.publish(channel, payload) }
}

describe('Redis relay delivery transport with independent provider instances', () => {
  it('delivers concurrent commands to the correct destination and correlates ACKs', async () => {
    const bus = new RedisBus()
    const aliceProvider = new WebSocketRelayTransportProvider()
    const bobProvider = new WebSocketRelayTransportProvider()
    const carolProvider = new WebSocketRelayTransportProvider()
    const bobSocket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const carolSocket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const bobLease = randomUUID()
    const carolLease = randomUUID()
    bobProvider.registerSocket('bob', bobSocket, bobLease)
    carolProvider.registerSocket('carol', carolSocket, carolLease)
    const make = (channel: string, provider: WebSocketRelayTransportProvider) =>
      new RedisRelayDeliveryTransport(new MockRedis(bus) as never, new MockRedis(bus) as never, channel, provider)
    const alice = make('sails:relay:delivery:alice', aliceProvider)
    const bob = make('sails:relay:delivery:bob', bobProvider)
    const carol = make('sails:relay:delivery:carol', carolProvider)
    await Promise.all([alice.start(), bob.start(), carol.start()])
    const deadlineMs = Date.now() + 2500
    try {
      const results = await Promise.all([
        alice.deliver('sails:relay:delivery:bob', {
          destinationParticipantId: 'bob', destinationLeaseToken: bobLease, deadlineMs, payload: 'for-bob',
        }),
        alice.deliver('sails:relay:delivery:carol', {
          destinationParticipantId: 'carol', destinationLeaseToken: carolLease, deadlineMs, payload: 'for-carol',
        }),
      ])
      expect(results).toEqual([true, true])
      expect(bobSocket.send).toHaveBeenCalledWith('for-bob')
      expect(carolSocket.send).toHaveBeenCalledWith('for-carol')
      expect(bobSocket.send).not.toHaveBeenCalledWith('for-carol')
      expect(carolSocket.send).not.toHaveBeenCalledWith('for-bob')
    } finally {
      await Promise.all([alice.close(), bob.close(), carol.close()])
    }
  })
})
