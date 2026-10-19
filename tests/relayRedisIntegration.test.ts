/**
 * Real Redis integration regression for the relay's atomic distributed budget.
 * Opt-in: RELAY_REDIS_INTEGRATION_URL must point at a disposable Redis instance.
 * Never FLUSHDB: keys are uniquely namespaced and removed in finally.
 */
import Redis from 'ioredis'
import { randomUUID } from 'crypto'
import { RELAY_BUDGET_SCRIPT } from '../src/infrastructure/p2p/relay-shared-budget'
import { ATOMIC_CONSUME_SCRIPT, atomicConsume } from '../src/common/redis/atomic-consume'
import { resolveParticipantFromTicket } from '../src/common/middleware/ws-auth'

const url = process.env.RELAY_REDIS_INTEGRATION_URL
const suite = url ? describe : describe.skip

suite('relay shared budget — real Redis concurrent instances', () => {
  let a: Redis
  let b: Redis

  beforeAll(() => {
    a = new Redis(url!, { maxRetriesPerRequest: 1 })
    b = new Redis(url!, { maxRetriesPerRequest: 1 })
  })
  afterAll(async () => {
    await Promise.all([a?.quit(), b?.quit()])
  })

  it('rejects a missing ticket through the production resolver without Redis access', async () => {
    await expect(resolveParticipantFromTicket(undefined)).resolves.toBeNull()
    await expect(resolveParticipantFromTicket('')).resolves.toBeNull()
  })

  it('exposes the production Redis consume primitive as a function', () => {
    expect(typeof atomicConsume).toBe('function')
  })

  it('fails closed when the production ticket Redis evaluation is unavailable', async () => {
    const { redis } = await import('../src/common/redis')
    const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('redis unavailable'))
    try {
      await expect(resolveParticipantFromTicket('unavailable-' + randomUUID())).rejects.toThrow('redis unavailable')
      expect(evalSpy).toHaveBeenCalledTimes(1)
    } finally {
      evalSpy.mockRestore()
    }
  })

  it('accepts exactly one of two live TCP WebSocket upgrades using a real Redis ticket', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const ticket = 'tcp-integration-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const app = Fastify({ logger: false })
    const clients: InstanceType<typeof WebSocket>[] = []
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    const registerSpy = jest.spyOn(webSocketRelayTransportProvider, 'registerSocket')
    try {
      await a.set(key, 'participant-' + randomUUID(), 'PX', 5000)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      const endpoint = `ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`
      const results = await Promise.all([0, 1].map(async () => {
        const client = new WebSocket(endpoint)
        clients.push(client)
        const messages: string[] = []
        client.on('message', data => messages.push(data.toString()))
        await new Promise<void>((resolve, reject) => {
          client.once('open', resolve)
          client.once('error', reject)
        })
        return { messages }
      }))
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (registerSpy.mock.calls.length === 1 &&
            results.some(result => result.messages.some(message => message.includes('already-used ticket')))) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Real Redis TCP replay invariant not observed'))
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(results.filter(result => result.messages.some(message => message.includes('already-used ticket')))).toHaveLength(1)
      expect(await a.exists(key)).toBe(0)
    } finally {
      clients.forEach(client => client.terminate())
      registerSpy.mockRestore()
      evalSpy.mockRestore()
      await app.close()
      await a.del(key)
    }
  })

  it('keeps a Redis ticket single-use across independent Node child processes', async () => {
    const { fork } = await import('child_process')
    const { join } = await import('path')
    const ticket = 'multiprocess-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const workerPath = join(__dirname, 'helpers', 'relayRedisTicketWorker.cjs')
    const workers = [0, 1].map(() => fork(workerPath, [], {
      env: { ...process.env, RELAY_REDIS_INTEGRATION_URL: url!, RELAY_TICKET_KEY: key, RELAY_ATOMIC_SCRIPT: ATOMIC_CONSUME_SCRIPT },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }))
    try {
      await a.set(key, 'participant-' + randomUUID(), 'PX', 5000)
      const results = await Promise.all(workers.map(worker => new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis child process timed out')), 5000)
        worker.once('message', message => {
          clearTimeout(timer)
          resolve(String(message))
        })
        worker.once('error', err => { clearTimeout(timer); reject(err) })
        worker.send('go')
      })))
      expect(results.sort()).toEqual(['claimed', 'rejected'])
      expect(await b.exists(key)).toBe(0)
    } finally {
      workers.forEach(worker => worker.kill())
      await a.del(key)
    }
  })

  it('allows only one Redis ticket claim across two independent TCP listeners', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const ticket = 'two-listeners-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const apps = [Fastify({ logger: false }), Fastify({ logger: false })]
    const clients: InstanceType<typeof WebSocket>[] = []
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    const registerSpy = jest.spyOn(webSocketRelayTransportProvider, 'registerSocket')
    try {
      await a.set(key, 'participant-' + randomUUID(), 'PX', 5000)
      for (const app of apps) {
        await app.register(websocket)
        await app.register(relayRoutes)
        await app.listen({ host: '127.0.0.1', port: 0 })
      }
      const observations = await Promise.all(apps.map(async app => {
        const address = app.server.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP listener address')
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
        clients.push(client)
        const messages: string[] = []
        client.on('message', data => messages.push(data.toString()))
        await new Promise<void>((resolve, reject) => {
          client.once('open', resolve)
          client.once('error', reject)
        })
        return { messages }
      }))
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (registerSpy.mock.calls.length === 1 &&
            observations.some(item => item.messages.some(message => message.includes('already-used ticket')))) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Cross-listener Redis ticket claim was not exclusive'))
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(observations.filter(item => item.messages.some(message => message.includes('already-used ticket')))).toHaveLength(1)
      expect(await b.exists(key)).toBe(0)
    } finally {
      clients.forEach(client => client.terminate())
      registerSpy.mockRestore()
      evalSpy.mockRestore()
      await Promise.all(apps.map(app => app.close()))
      await a.del(key)
    }
  })

  it('rejects a replay after a successful TCP connection has disconnected', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const ticket = 'reconnect-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const participant = 'participant-' + randomUUID()
    const app = Fastify({ logger: false })
    const clients: InstanceType<typeof WebSocket>[] = []
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    const registerSpy = jest.spyOn(webSocketRelayTransportProvider, 'registerSocket')
    try {
      await a.set(key, participant, 'PX', 5000)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      const endpoint = `ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`
      const first = new WebSocket(endpoint)
      clients.push(first)
      await new Promise<void>((resolve, reject) => {
        first.once('open', resolve)
        first.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (registerSpy.mock.calls.length === 1) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Initial connection was not registered'))
          setTimeout(poll, 10)
        }
        poll()
      })
      const firstClosed = new Promise<void>((resolve, reject) => {
        first.once('close', () => resolve())
        first.once('error', reject)
      })
      first.close()
      await firstClosed
      const replay = new WebSocket(endpoint)
      clients.push(replay)
      const messages: string[] = []
      replay.on('message', data => messages.push(data.toString()))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Replayed ticket did not close')), 3000)
        replay.once('close', () => { clearTimeout(timeout); resolve() })
        replay.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(messages.some(message => message.includes('already-used ticket'))).toBe(true)
      expect(await a.exists(key)).toBe(0)
    } finally {
      clients.forEach(client => client.terminate())
      registerSpy.mockRestore()
      evalSpy.mockRestore()
      await app.close()
      await a.del(key)
    }
  })

  it('calls the production ticket resolver with a real Redis client and rejects replay', async () => {
    const ticket = 'integration-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const { redis } = await import('../src/common/redis')
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    try {
      await a.set(key, 'participant', 'PX', 5000)
      const results = await Promise.all(Array.from({ length: 20 }, () => resolveParticipantFromTicket(ticket)))
      expect(results.filter(value => value === 'participant')).toHaveLength(1)
      expect(results.filter(value => value === null)).toHaveLength(19)
      expect(await a.exists(key)).toBe(0)
      expect(evalSpy).toHaveBeenCalledTimes(20)
    } finally {
      evalSpy.mockRestore()
      await a.del(key)
    }
  })

  it('atomically burns a single-use WebSocket ticket across concurrent Redis clients', async () => {
    const key = 'auth:ws-ticket:test-' + randomUUID()
    try {
      await a.set(key, 'participant', 'PX', 5000)
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).eval(ATOMIC_CONSUME_SCRIPT, 1, key)),
      )
      expect(results.filter(value => value === 'participant')).toHaveLength(1)
      expect(results.filter(value => value === null)).toHaveLength(19)
      expect(await a.exists(key)).toBe(0)
    } finally {
      await a.del(key)
    }
  })

  it('enforces message-count limits independently of byte limits', async () => {
    const key = 'test:relay:messages:' + randomUUID()
    try {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          (i % 2 ? a : b).eval(RELAY_BUDGET_SCRIPT, 1, key, 1, 7, 1000, 5000),
        ),
      )
      expect(results.filter(x => x === 1)).toHaveLength(7)
      expect(results.filter(x => x === 0)).toHaveLength(33)
      expect(await a.hgetall(key)).toMatchObject({ messages: '7', bytes: '7' })
    } finally {
      await a.del(key)
    }
  })

  it('does not mutate counters when the byte budget denies a frame', async () => {
    const key = 'test:relay:bytes:' + randomUUID()
    try {
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 60, 10, 100, 5000)).toBe(1)
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 41, 10, 100, 5000)).toBe(0)
      expect(await a.hgetall(key)).toMatchObject({ messages: '1', bytes: '60' })
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 40, 10, 100, 5000)).toBe(1)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '100' })
    } finally {
      await a.del(key)
    }
  })

  it('rejects budget evaluation when the Redis connection is unavailable', async () => {
    const disconnected = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    disconnected.disconnect()
    await expect(
      disconnected.eval(RELAY_BUDGET_SCRIPT, 1, 'test:relay:offline:' + randomUUID(), 1, 2, 100, 5000),
    ).rejects.toThrow()
  })

  it('keeps the distributed byte budget intact after a client disconnects', async () => {
    const key = 'test:relay:client-disconnect:' + randomUUID()
    const transient = new Redis(url!, { maxRetriesPerRequest: 1 })
    try {
      expect(await transient.eval(RELAY_BUDGET_SCRIPT, 1, key, 80, 10, 100, 5000)).toBe(1)
      transient.disconnect()
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 21, 10, 100, 5000)).toBe(0)
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 20, 10, 100, 5000)).toBe(1)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '100' })
    } finally {
      transient.disconnect()
      await a.del(key)
    }
  })

  it('does not resurrect an expired single-use ticket after a Redis client reconnects', async () => {
    const ticket = 'expired-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const transient = new Redis(url!, { maxRetriesPerRequest: 1 })
    try {
      await transient.set(key, 'participant', 'PX', 150)
      await new Promise(resolve => setTimeout(resolve, 250))
      transient.disconnect()
      expect(await b.eval(ATOMIC_CONSUME_SCRIPT, 1, key)).toBeNull()
      expect(await a.exists(key)).toBe(0)
    } finally {
      transient.disconnect()
      await a.del(key)
    }
  })

  it('retains exhausted budget across independent client reconnections', async () => {
    const key = 'test:relay:reconnect:' + randomUUID()
    try {
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(1)
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(1)
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(0)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '20' })
    } finally {
      await a.del(key)
    }
  })

  it('never over-admits across concurrent clients, expires, then resets', async () => {
    const key = 'test:relay:atomic:' + randomUUID()
    const evalBudget = (client: Redis, bytes: number) =>
      client.eval(RELAY_BUDGET_SCRIPT, 1, key, bytes, 20, 100, 250)
    try {
      const results = await Promise.all(
        Array.from({ length: 80 }, (_, i) => evalBudget(i % 2 ? a : b, 10)),
      )
      expect(results.filter(x => x === 1)).toHaveLength(10)
      expect(results.filter(x => x === 0)).toHaveLength(70)
      expect(await a.hgetall(key)).toMatchObject({ messages: '10', bytes: '100' })
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(await evalBudget(b, 10)).toBe(1)
      expect(await b.hgetall(key)).toMatchObject({ messages: '1', bytes: '10' })
    } finally {
      await a.del(key)
    }
  })
})
