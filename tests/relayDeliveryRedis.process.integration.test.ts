/**
 * Real Redis, two distinct OS processes. Test-only candidate proof:
 * not an authenticated backplane or production route.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Redis from 'ioredis'
import { RedisRelayDeliveryTransport } from '../src/infrastructure/p2p/relay-delivery-redis'
import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'

const url = process.env.RELAY_REDIS_INTEGRATION_URL
const integration = url ? describe : describe.skip

integration('two-process Redis relay candidate', () => {
  jest.setTimeout(20_000)

  it('forwards to a distinct process, rejects stale owner and missing destination', async () => {
    const suffix = randomUUID().replace(/-/g, '')
    const originChannel = 'sails:relay:delivery:origin_' + suffix
    const destinationChannel = 'sails:relay:delivery:dest_' + suffix
    const lease = randomUUID()
    const child = fork(join(__dirname, 'relayDeliveryRedis.child.cjs'), [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: { ...process.env, RELAY_TEST_CHANNEL: destinationChannel, RELAY_TEST_LEASE: lease },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const childErrors: string[] = []
    child.stderr?.on('data', chunk => childErrors.push(String(chunk)))
    const received: string[] = []
    child.on('message', (msg: unknown) => {
      const record = msg as { type?: string; payload?: string }
      if (record?.type === 'received' && typeof record.payload === 'string') received.push(record.payload)
    })
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child readiness timeout: ' + childErrors.join(''))), 10_000)
      const onMessage = (msg: unknown) => {
        const record = msg as { type?: string; message?: string }
        if (record?.type === 'ready' || record?.type === 'error') {
          clearTimeout(timer)
          child.off('message', onMessage)
          child.off('exit', onExit)
          if (record.type === 'ready') resolve()
          else reject(new Error(record.message || 'child startup error'))
        }
      }
      const onExit = (code: number | null) => {
        clearTimeout(timer)
        child.off('message', onMessage)
        reject(new Error('child exited ' + code + ': ' + childErrors.join('')))
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
    })
    const publisher = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const subscriber = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    const origin = new RedisRelayDeliveryTransport(publisher, subscriber, originChannel, new WebSocketRelayTransportProvider())
    try {
      await ready
      expect(child.pid).toBeDefined()
      expect(child.pid).not.toBe(process.pid)
      await Promise.all([publisher.connect(), subscriber.connect()])
      await origin.start()
      expect(await origin.deliver(destinationChannel, {
        destinationParticipantId: 'bob', destinationLeaseToken: lease,
        deadlineMs: Date.now() + 2500, payload: 'opaque-two-process',
      })).toBe(true)
      expect(received).toContain('opaque-two-process')
      expect(await origin.deliver(destinationChannel, {
        destinationParticipantId: 'bob', destinationLeaseToken: randomUUID(),
        deadlineMs: Date.now() + 2500, payload: 'stale',
      })).toBe(false)
      expect(received).not.toContain('stale')
      expect(await origin.deliver('sails:relay:delivery:absent_' + suffix, {
        destinationParticipantId: 'bob', destinationLeaseToken: lease,
        deadlineMs: Date.now() + 2500, payload: 'absent',
      })).toBe(false)
    } finally {
      await Promise.allSettled([origin.close()])
      publisher.disconnect()
      subscriber.disconnect()
      if (child.connected) child.send({ type: 'stop' })
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
  })
})
