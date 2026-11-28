/**
 * Optional real-Redis Pub/Sub acceptance test. Run with
 * RELAY_REDIS_INTEGRATION_URL=redis://127.0.0.1:6379
 * against a dedicated disposable Redis instance.
 *
 * This validates separate Redis TCP clients and local provider instances,
 * NOT separate OS processes, authenticated channels, or production wiring.
 */
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { RedisRelayDeliveryTransport } from '../src/infrastructure/p2p/relay-delivery-redis'
import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'

const url = process.env.RELAY_REDIS_INTEGRATION_URL
const integration = url ? describe : describe.skip

integration('real Redis relay Pub/Sub integration', () => {
  jest.setTimeout(15_000)

  it('delivers across separate Redis connections, rejects stale owner and absent subscriber', async () => {
    const suffix = randomUUID().replace(/-/g, '')
    const originChannel = 'sails:relay:delivery:origin_' + suffix
    const destinationChannel = 'sails:relay:delivery:destination_' + suffix
    const originPublisher = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const originSubscriber = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const destPublisher = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const destSubscriber = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const destinationProvider = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const lease = randomUUID()
    destinationProvider.registerSocket('bob', socket, lease)
    const origin = new RedisRelayDeliveryTransport(originPublisher, originSubscriber,
      originChannel, new WebSocketRelayTransportProvider())
    const destination = new RedisRelayDeliveryTransport(destPublisher, destSubscriber,
      destinationChannel, destinationProvider)
    try {
      await Promise.all([originPublisher.connect(), originSubscriber.connect(),
        destPublisher.connect(), destSubscriber.connect()])
      await Promise.all([origin.start(), destination.start()])
      const deadlineMs = Date.now() + 2500
      expect(await origin.deliver(destinationChannel, {
        destinationParticipantId: 'bob', destinationLeaseToken: lease,
        deadlineMs, payload: 'opaque-real-redis',
      })).toBe(true)
      expect(socket.send).toHaveBeenCalledWith('opaque-real-redis')
      expect(await origin.deliver(destinationChannel, {
        destinationParticipantId: 'bob', destinationLeaseToken: randomUUID(),
        deadlineMs: Date.now() + 2500, payload: 'stale',
      })).toBe(false)
      expect(socket.send).not.toHaveBeenCalledWith('stale')
      expect(await origin.deliver('sails:relay:delivery:missing_' + suffix, {
        destinationParticipantId: 'bob', destinationLeaseToken: lease,
        deadlineMs: Date.now() + 2500, payload: 'absent',
      })).toBe(false)
      expect(socket.send).not.toHaveBeenCalledWith('absent')
    } finally {
      await Promise.allSettled([origin.close(), destination.close()])
      await Promise.allSettled([originPublisher.quit(), originSubscriber.quit(),
        destPublisher.quit(), destSubscriber.quit()])
      for (const client of [originPublisher, originSubscriber, destPublisher, destSubscriber]) {
        client.disconnect()
      }
    }
  })
})
