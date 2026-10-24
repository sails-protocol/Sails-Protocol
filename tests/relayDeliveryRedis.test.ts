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
  it('fails closed after Redis publisher disconnects', async () => {
    const bus = new RedisBus()
    const publisher = new MockRedis(bus)
    const subscriber = new MockRedis(bus)
    const transport = new RedisRelayDeliveryTransport(
      publisher as never, subscriber as never,
      'sails:relay:delivery:publisher_drop', new WebSocketRelayTransportProvider(),
    )
    await transport.start()
    publisher.emit('close')
    expect(await transport.deliver('sails:relay:delivery:destination', {
      destinationParticipantId: 'bob',
      destinationLeaseToken: randomUUID(),
      deadlineMs: Date.now() + 2500,
      payload: 'never-publish',
    })).toBe(false)
    await expect(transport.start()).rejects.toThrow('relay transport is closed')
    expect(publisher.listenerCount('close')).toBe(0)
    expect(subscriber.listenerCount('message')).toBe(0)
    expect(subscriber.listenerCount('close')).toBe(0)
  })

  it('fails closed after Redis subscriber disconnects instead of silently reconnecting', async () => {
    const bus = new RedisBus()
    const subscriber = new MockRedis(bus)
    const publisher = new MockRedis(bus)
    const transport = new RedisRelayDeliveryTransport(
      publisher as never, subscriber as never,
      'sails:relay:delivery:disconnect', new WebSocketRelayTransportProvider(),
    )
    await transport.start()
    subscriber.emit('close')
    expect(await transport.deliver('sails:relay:delivery:destination', {
      destinationParticipantId: 'bob',
      destinationLeaseToken: randomUUID(),
      deadlineMs: Date.now() + 2500,
      payload: 'never-publish',
    })).toBe(false)
    await expect(transport.start()).rejects.toThrow('relay transport is closed')
    expect(subscriber.listenerCount('message')).toBe(0)
    expect(subscriber.listenerCount('close')).toBe(0)
  })

  it('does not revive a transport closed while Redis subscription is pending', async () => {
    const bus = new RedisBus()
    const subscriber = new MockRedis(bus)
    const originalSubscribe = subscriber.subscribe.bind(subscriber)
    let finishSubscription!: () => void
    jest.spyOn(subscriber, 'subscribe').mockImplementation(async channel => {
      await new Promise<void>(resolve => { finishSubscription = resolve })
      return originalSubscribe(channel)
    })
    const transport = new RedisRelayDeliveryTransport(
      new MockRedis(bus) as never, subscriber as never,
      'sails:relay:delivery:closing', new WebSocketRelayTransportProvider(),
    )
    const starting = transport.start()
    const closing = transport.close()
    finishSubscription()
    await Promise.all([starting, closing])
    expect(await transport.deliver('sails:relay:delivery:missing', {
      destinationParticipantId: 'bob',
      destinationLeaseToken: randomUUID(),
      deadlineMs: Date.now() + 2500,
      payload: 'never-publish',
    })).toBe(false)
    await expect(transport.start()).rejects.toThrow('relay transport is closed')
    expect(bus.publish('sails:relay:delivery:closing', 'ignored')).toBe(0)
  })

  it('contains destination send rejection without acknowledging success', async () => {
    const bus = new RedisBus()
    const destinationProvider = new WebSocketRelayTransportProvider()
    const lease = randomUUID()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    destinationProvider.registerSocket('bob', socket, lease)
    const originalSend = destinationProvider.sendToPeerIfOwner.bind(destinationProvider)
    jest.spyOn(destinationProvider, 'sendToPeerIfOwner')
      .mockRejectedValueOnce(new Error('simulated destination failure'))
    const make = (name: string, provider: WebSocketRelayTransportProvider) =>
      new RedisRelayDeliveryTransport(new MockRedis(bus) as never, new MockRedis(bus) as never,
        'sails:relay:delivery:' + name, provider)
    const alice = make('alice', new WebSocketRelayTransportProvider())
    const bob = make('bob', destinationProvider)
    await Promise.all([alice.start(), bob.start()])
    try {
      expect(await alice.deliver('sails:relay:delivery:bob', {
        destinationParticipantId: 'bob', destinationLeaseToken: lease,
        deadlineMs: Date.now() + 2500, payload: 'must-not-send',
      })).toBe(false)
      expect(socket.send).not.toHaveBeenCalled()
      expect(await originalSend('bob', lease, 'subsequent-local-send')).toBe(true)
      expect(socket.send).toHaveBeenCalledWith('subsequent-local-send')
    } finally {
      await Promise.all([alice.close(), bob.close()])
    }
  })

  it('does not accept forged positive ACKs from a different request ID', async () => {
    const bus = new RedisBus()
    const publisher = new MockRedis(bus)
    const alice = new RedisRelayDeliveryTransport(
      publisher as never, new MockRedis(bus) as never,
      'sails:relay:delivery:origin', new WebSocketRelayTransportProvider(),
    )
    const blackhole = new MockRedis(bus)
    await alice.start()
    await blackhole.subscribe('sails:relay:delivery:blackhole')
    try {
      const delivery = alice.deliver('sails:relay:delivery:blackhole', {
        destinationParticipantId: 'bob',
        destinationLeaseToken: randomUUID(),
        deadlineMs: Date.now() + 2500,
        payload: 'opaque',
      })
      bus.publish('sails:relay:delivery:origin', JSON.stringify({
        requestId: randomUUID(), accepted: true,
      }))
      // An unmatched ACK cannot complete delivery; only its timeout can.
      expect(await delivery).toBe(false)
    } finally {
      await alice.close()
      await blackhole.unsubscribe('sails:relay:delivery:blackhole')
    }
  })

  it('fails closed without a subscribed destination and leaves no pending request', async () => {
    const bus = new RedisBus()
    const alice = new RedisRelayDeliveryTransport(
      new MockRedis(bus) as never, new MockRedis(bus) as never,
      'sails:relay:delivery:origin', new WebSocketRelayTransportProvider(),
    )
    await alice.start()
    try {
      expect(await alice.deliver('sails:relay:delivery:missing', {
        destinationParticipantId: 'bob',
        destinationLeaseToken: randomUUID(),
        deadlineMs: Date.now() + 2000,
        payload: 'opaque',
      })).toBe(false)
    } finally {
      await alice.close()
    }
  })

  it('rejects stale owner commands even with a live destination subscriber', async () => {
    const bus = new RedisBus()
    const provider = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    provider.registerSocket('bob', socket, randomUUID())
    const make = (name: string, destination: WebSocketRelayTransportProvider) =>
      new RedisRelayDeliveryTransport(new MockRedis(bus) as never, new MockRedis(bus) as never,
        'sails:relay:delivery:' + name, destination)
    const alice = make('alice', new WebSocketRelayTransportProvider())
    const bob = make('bob', provider)
    await Promise.all([alice.start(), bob.start()])
    try {
      expect(await alice.deliver('sails:relay:delivery:bob', {
        destinationParticipantId: 'bob',
        destinationLeaseToken: randomUUID(),
        deadlineMs: Date.now() + 2000,
        payload: 'never-send',
      })).toBe(false)
      expect(socket.send).not.toHaveBeenCalled()
    } finally {
      await Promise.all([alice.close(), bob.close()])
    }
  })

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
