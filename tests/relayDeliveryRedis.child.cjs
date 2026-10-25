/* Test-only destination in a separate OS process. Never production wiring. */
const Redis = require('ioredis')
const { WebSocketRelayTransportProvider } = require('../src/infrastructure/p2p/websocket-relay.service')
const { RedisRelayDeliveryTransport } = require('../src/infrastructure/p2p/relay-delivery-redis')

let publisher, subscriber, transport
async function main() {
  const { RELAY_REDIS_INTEGRATION_URL: url, RELAY_TEST_CHANNEL: channel, RELAY_TEST_LEASE: lease } = process.env
  if (!url || !channel || !lease || !process.send) throw new Error('missing test configuration')
  publisher = new Redis(url, { maxRetriesPerRequest: 1, retryStrategy: () => null })
  subscriber = new Redis(url, { maxRetriesPerRequest: 1, retryStrategy: () => null })
  const provider = new WebSocketRelayTransportProvider()
  provider.registerSocket('bob', {
    readyState: 1,
    send: payload => process.send({ type: 'received', payload }),
    close: () => {},
  }, lease)
  transport = new RedisRelayDeliveryTransport(publisher, subscriber, channel, provider)
  await transport.start()
  process.send({ type: 'ready' })
}
async function stop() {
  try { if (transport) await transport.close() } finally {
    if (publisher) publisher.disconnect()
    if (subscriber) subscriber.disconnect()
    process.exit(0)
  }
}
process.on('message', msg => { if (msg && msg.type === 'stop') void stop().catch(() => process.exit(1)) })
main().catch(err => {
  process.send?.({ type: 'error', message: String(err) })
  process.exitCode = 1
  if (publisher) publisher.disconnect()
  if (subscriber) subscriber.disconnect()
})
