/**
 * Real Redis integration regression for the relay's atomic distributed budget.
 * Opt-in: RELAY_REDIS_INTEGRATION_URL must point at a disposable Redis instance.
 * Never FLUSHDB: keys are uniquely namespaced and removed in finally.
 */
import Redis from 'ioredis'
import { randomUUID } from 'crypto'
import { RELAY_BUDGET_SCRIPT } from '../src/infrastructure/p2p/relay-shared-budget'
import { RELAY_PRESENCE_CLAIM_SCRIPT, RELAY_PRESENCE_RELEASE_SCRIPT, RELAY_PRESENCE_RENEW_SCRIPT, RELAY_PRESENCE_SNAPSHOT_SCRIPT } from '../src/infrastructure/p2p/relay-presence'
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

  it('rejects malformed presence snapshot replies instead of treating them as absence', async () => {
    const { redis } = await import('../src/common/redis')
    const { snapshotRelayPresence } = await import('../src/infrastructure/p2p/relay-presence')
    const spy = jest.spyOn(redis, 'eval')
    try {
      for (const malformed of [[false, 30000], [false, 'invalid'], ['', 30000], ['owner', -2], ['owner', 0], ['owner', 'invalid'], 'invalid']) {
        spy.mockResolvedValueOnce(malformed as never)
        await expect(snapshotRelayPresence('snapshot-malformed-' + randomUUID())).rejects.toThrow('Invalid relay presence snapshot')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('treats an expired or missing lease snapshot as absence without inventing ownership', async () => {
    const key = 'test:relay:presence:snapshot-expiry:' + randomUUID()
    try {
      await a.set(key, randomUUID(), 'PX', 100)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(await b.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, key)).toEqual([null, -2])
      expect(await a.get(key)).toBeNull()
    } finally {
      await a.del(key)
    }
  })

  it('reads an atomic presence token and TTL snapshot across Redis clients', async () => {
    const key = 'test:relay:presence:snapshot:' + randomUUID()
    const oldToken = randomUUID()
    const currentToken = randomUUID()
    try {
      expect(await a.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, key)).toEqual([null, -2])
      await a.set(key, oldToken, 'PX', 30_000)
      const oldSnapshot = await b.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, key) as [string, number]
      expect(oldSnapshot[0]).toBe(oldToken)
      expect(oldSnapshot[1]).toBeGreaterThan(0)
      await b.set(key, currentToken, 'PX', 30_000)
      const currentSnapshot = await a.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, key) as [string, number]
      expect(currentSnapshot[0]).toBe(currentToken)
      expect(currentSnapshot[1]).toBeGreaterThan(0)
      await a.del(key)
      expect(await b.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, key)).toEqual([null, -2])
    } finally {
      await a.del(key)
    }
  })

  it('rejects missing or malformed presence deadlines without mutating Redis', async () => {
    const key = 'test:relay:presence:invalid-deadline:' + randomUUID()
    const token = randomUUID()
    try {
      expect(await a.eval(RELAY_PRESENCE_CLAIM_SCRIPT, 1, key, token, 30_000)).toBe(0)
      expect(await a.eval(RELAY_PRESENCE_CLAIM_SCRIPT, 1, key, token, 30_000, 'invalid')).toBe(0)
      expect(await b.get(key)).toBeNull()
      await a.set(key, token, 'PX', 30_000)
      const before = await a.pttl(key)
      expect(await b.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1, key, token, 30_000)).toBe(0)
      expect(await b.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1, key, token, 30_000, 'invalid')).toBe(0)
      expect(await a.pttl(key)).toBeLessThanOrEqual(before)
      expect(await b.get(key)).toBe(token)
    } finally {
      await a.del(key)
    }
  })

  it('rejects a delayed renewal without extending an existing Redis lease', async () => {
    const key = 'test:relay:presence:renew-deadline:' + randomUUID()
    const token = randomUUID()
    try {
      await a.set(key, token, 'PX', 30_000)
      const ttlBefore = await a.pttl(key)
      expect(await b.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1, key, token, 30_000, Date.now() - 60_000)).toBe(0)
      const ttlAfter = await a.pttl(key)
      expect(ttlAfter).toBeLessThanOrEqual(ttlBefore)
      expect(await b.get(key)).toBe(token)
    } finally {
      await a.del(key)
    }
  })

  it('rejects a presence claim delayed beyond its deadline on the Redis server', async () => {
    const key = 'test:relay:presence:deadline:' + randomUUID()
    try {
      const expired = Date.now() - 60_000
      expect(await a.eval(RELAY_PRESENCE_CLAIM_SCRIPT, 1, key, randomUUID(), 30_000, expired)).toBe(0)
      expect(await b.get(key)).toBeNull()
      expect(await b.eval(RELAY_PRESENCE_CLAIM_SCRIPT, 1, key, randomUUID(), 30_000, Date.now() + 60_000)).toBe(1)
      expect(await a.pttl(key)).toBeGreaterThan(0)
    } finally {
      await a.del(key)
    }
  })

  it('fences stale presence release and renewal across independent Redis clients', async () => {
    const key = 'test:relay:presence:' + randomUUID()
    const oldToken = randomUUID()
    const newToken = randomUUID()
    try {
      await a.set(key, oldToken, 'PX', 5000)
      await b.set(key, newToken, 'PX', 5000)
      expect(await a.eval(RELAY_PRESENCE_RELEASE_SCRIPT, 1, key, oldToken)).toBe(0)
      expect(await a.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1, key, oldToken, 5000, Date.now() + 60_000)).toBe(0)
      expect(await b.get(key)).toBe(newToken)
      expect(await b.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1, key, newToken, 5000, Date.now() + 60_000)).toBe(1)
      expect(await a.eval(RELAY_PRESENCE_RELEASE_SCRIPT, 1, key, newToken)).toBe(1)
      expect(await b.get(key)).toBeNull()
    } finally {
      await a.del(key)
    }
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

  it('delivers through the real provider between two live TCP clients authenticated with real Redis tickets', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider: relay } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const suffix = randomUUID()
    const aliceId = 'redis-alice-' + suffix
    const bobId = 'redis-bob-' + suffix
    const aliceTicket = 'redis-alice-ticket-' + suffix
    const bobTicket = 'redis-bob-ticket-' + suffix
    const keys = ['auth:ws-ticket:' + aliceTicket, 'auth:ws-ticket:' + bobTicket]
    const app = Fastify({ logger: false })
    const clients: InstanceType<typeof WebSocket>[] = []
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    try {
      await a.set(keys[0], aliceId, 'PX', 5000)
      await a.set(keys[1], bobId, 'PX', 5000)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      const connect = (ticket: string) => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
        clients.push(client)
        client.once('open', () => resolve(client))
        client.once('error', reject)
      })
      const [alice, bob] = await Promise.all([connect(aliceTicket), connect(bobTicket)])
      for (let i = 0; i < 200 && !(relay.isConnected(aliceId) && relay.isConnected(bobId)); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(relay.isConnected(aliceId)).toBe(true)
      expect(relay.isConnected(bobId)).toBe(true)
      const payload = 'opaque-redis-provider-' + suffix
      const delivered = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Real Redis relay delivery timed out')), 3000)
        bob.once('message', data => { clearTimeout(timer); resolve(data.toString()) })
      })
      expect(await relay.sendToPeer(aliceId, bobId, payload)).toBe(true)
      expect(await delivered).toBe(payload)
      expect(await a.exists(...keys)).toBe(0)
      expect(alice.readyState).toBe(WebSocket.OPEN)
    } finally {
      clients.forEach(client => client.terminate())
      evalSpy.mockRestore()
      await app.close()
      await a.del(...keys)
      relay.unregisterSocket(aliceId)
      relay.unregisterSocket(bobId)
    }
  })

  it('issues an HTTP ticket with production auth and consumes it on a real TCP relay', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { identityRoutes } = await import('../src/modules/open-identity/identity.routes')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider: relay } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const suffix = randomUUID()
    const participantId = 'http-ticket-' + suffix
    const bobId = 'http-bob-' + suffix
    const session = 'http-session-' + suffix
    const bobSession = 'http-bob-session-' + suffix
    const sessionKey = 'auth:session:' + session
    const bobSessionKey = 'auth:session:' + bobSession
    const app = Fastify({ logger: false })
    const clients: InstanceType<typeof WebSocket>[] = []
    const ticketKeys: string[] = []
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    const getSpy = jest.spyOn(redis, 'get').mockImplementation(
      ((key: string) => a.get(key)) as typeof redis.get,
    )
    const setSpy = jest.spyOn(redis, 'set').mockImplementation(
      ((...args: unknown[]) => (a.set as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.set,
    )
    try {
      await a.set(sessionKey, participantId, 'EX', 30)
      await a.set(bobSessionKey, bobId, 'EX', 30)
      await app.register(websocket)
      await app.register(identityRoutes)
      await app.register(relayRoutes)
      const denied = await app.inject({ method: 'POST', url: '/v1/identity/ws-ticket' })
      expect(denied.statusCode).toBe(401)
      const issue = async (sessionToken: string, expectedId: string): Promise<string> => {
        const response = await app.inject({ method: 'POST', url: '/v1/identity/ws-ticket', headers: { authorization: 'Bearer ' + sessionToken } })
        expect(response.statusCode).toBe(200)
        const ticket = response.json().data.ticket as string
        const key = 'auth:ws-ticket:' + ticket
        ticketKeys.push(key)
        expect(await a.get(key)).toBe(expectedId)
        return ticket
      }
      const aliceTicket = await issue(session, participantId)
      const bobTicket = await issue(bobSession, bobId)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      const connect = (ticket: string) => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
        clients.push(client)
        client.once('open', () => resolve(client))
        client.once('error', reject)
      })
      const [alice, bob] = await Promise.all([connect(aliceTicket), connect(bobTicket)])
      for (let i = 0; i < 200 && !(relay.isConnected(participantId) && relay.isConnected(bobId)); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(relay.isConnected(participantId)).toBe(true)
      expect(relay.isConnected(bobId)).toBe(true)
      const payload = 'opaque-http-to-redis-to-provider-' + suffix
      const delivered = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP-issued ticket relay delivery timed out')), 3000)
        bob.once('message', data => { clearTimeout(timer); resolve(data.toString()) })
      })
      expect(await relay.sendToPeer(participantId, bobId, payload)).toBe(true)
      expect(await delivered).toBe(payload)
      expect(await a.exists(...ticketKeys)).toBe(0)
      expect(alice.readyState).toBe(WebSocket.OPEN)
    } finally {
      clients.forEach(client => client.terminate())
      evalSpy.mockRestore()
      getSpy.mockRestore()
      setSpy.mockRestore()
      await app.close()
      await a.del(sessionKey, bobSessionKey, ...ticketKeys)
      relay.unregisterSocket(participantId)
      relay.unregisterSocket(bobId)
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

  it('fails closed with infrastructure code when real Redis budget evaluation fails', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const ticket = 'budget-failure-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const participant = 'participant-' + randomUUID()
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => {
        if (String(args[0]).includes('HINCRBY')) return Promise.reject(new Error('Redis budget unavailable'))
        return (a.eval as (...params: unknown[]) => Promise<unknown>)(...args)
      }) as typeof redis.eval,
    )
    const registerSpy = jest.spyOn(webSocketRelayTransportProvider, 'registerSocket')
    try {
      await a.set(key, participant, 'PX', 5000)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (registerSpy.mock.calls.some(call => call[0] === participant)) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Relay authentication did not complete'))
          setTimeout(poll, 10)
        }
        poll()
      })
      const closeCode = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Relay did not fail closed')), 3000)
        client!.once('close', code => { clearTimeout(timer); resolve(code) })
        client!.once('error', err => { clearTimeout(timer); reject(err) })
      })
      client.send('frame-requiring-budget')
      expect(await closeCode).toBe(1011)
      expect(evalSpy.mock.calls.some(call => String(call[0]).includes('HINCRBY'))).toBe(true)
      expect(await b.exists(key)).toBe(0)
    } finally {
      client?.terminate()
      registerSpy.mockRestore()
      evalSpy.mockRestore()
      await app.close()
      await a.del(key)
    }
  })

  it('closes a live authenticated TCP relay on real Redis client disconnection', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const { redis } = await import('../src/common/redis')
    const { relayRoutes } = await import('../src/infrastructure/p2p/relay.routes')
    const { webSocketRelayTransportProvider } = await import('../src/infrastructure/p2p/websocket-relay.service')
    const ticket = 'disconnect-failure-' + randomUUID()
    const key = 'auth:ws-ticket:' + ticket
    const participant = 'participant-' + randomUUID()
    const app = Fastify({ logger: false })
    const transient = new Redis(url!, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
    let client: InstanceType<typeof WebSocket> | undefined
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (transient.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    const registerSpy = jest.spyOn(webSocketRelayTransportProvider, 'registerSocket')
    try {
      await new Promise<void>((resolve, reject) => {
        if (transient.status === 'ready') return resolve()
        transient.once('ready', resolve)
        transient.once('error', reject)
      })
      await transient.ping()
      await a.set(key, participant, 'PX', 5000)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=${ticket}`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (registerSpy.mock.calls.some(call => call[0] === participant)) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Relay authentication did not complete'))
          setTimeout(poll, 10)
        }
        poll()
      })
      transient.disconnect()
      const closeCode = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Relay remained open after Redis disconnect')), 3000)
        client!.once('close', code => { clearTimeout(timer); resolve(code) })
        client!.once('error', err => { clearTimeout(timer); reject(err) })
      })
      client.send('frame-after-redis-disconnect')
      expect(await closeCode).toBe(1011)
      expect(await b.exists(key)).toBe(0)
      expect(await b.exists('ratelimit:ws-relay:' + participant)).toBe(0)
    } finally {
      client?.terminate()
      registerSpy.mockRestore()
      evalSpy.mockRestore()
      transient.disconnect()
      await app.close()
      await a.del(key, 'ratelimit:ws-relay:' + participant)
    }
  })

  it('preserves a consumed ticket and prior budget when Redis client fails then recovers', async () => {
    const { redis } = await import('../src/common/redis')
    const { consumeSharedRelayBudget } = await import('../src/infrastructure/p2p/relay-shared-budget')
    const ticket = 'recovery-' + randomUUID()
    const ticketKey = 'auth:ws-ticket:' + ticket
    const participant = 'participant-' + randomUUID()
    const budgetKey = 'ratelimit:ws-relay:' + participant
    const transient = new Redis(url!, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(
      ((...args: unknown[]) => (transient.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
    )
    try {
      await new Promise<void>((resolve, reject) => {
        if (transient.status === 'ready') return resolve()
        transient.once('ready', resolve)
        transient.once('error', reject)
      })
      await a.set(ticketKey, participant, 'PX', 5000)
      expect(await resolveParticipantFromTicket(ticket)).toBe(participant)
      expect(await consumeSharedRelayBudget(participant, 100)).toBe(true)
      transient.disconnect()
      await expect(consumeSharedRelayBudget(participant, 1)).rejects.toThrow()
      expect(await b.exists(ticketKey)).toBe(0)
      expect(await b.hgetall(budgetKey)).toMatchObject({ messages: '1', bytes: '100' })
      evalSpy.mockImplementation(
        ((...args: unknown[]) => (b.eval as (...params: unknown[]) => Promise<unknown>)(...args)) as typeof redis.eval,
      )
      expect(await resolveParticipantFromTicket(ticket)).toBeNull()
      expect(await consumeSharedRelayBudget(participant, 1)).toBe(true)
      expect(await a.hgetall(budgetKey)).toMatchObject({ messages: '2', bytes: '101' })
    } finally {
      evalSpy.mockRestore()
      transient.disconnect()
      await a.del(ticketKey, budgetKey)
    }
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

  it('keeps Redis counters unchanged on repeated concurrent budget denials', async () => {
    const key = 'test:relay:denied-concurrent:' + randomUUID()
    const evalBudget = (client: Redis, bytes: number) =>
      client.eval(RELAY_BUDGET_SCRIPT, 1, key, bytes, 3, 100, 5000)
    try {
      expect(await evalBudget(a, 40)).toBe(1)
      expect(await evalBudget(b, 40)).toBe(1)
      const denials = await Promise.all(
        Array.from({ length: 40 }, (_, i) => evalBudget(i % 2 ? a : b, 30)),
      )
      expect(denials).toEqual(Array(40).fill(0))
      expect(await b.hgetall(key)).toMatchObject({ messages: '2', bytes: '80' })
      expect(await evalBudget(b, 20)).toBe(1)
      expect(await a.hgetall(key)).toMatchObject({ messages: '3', bytes: '100' })
      expect(await evalBudget(a, 1)).toBe(0)
    } finally {
      await a.del(key)
    }
  })

  it('recovers after a real Redis client disconnect without resetting the distributed budget', async () => {
    const key = 'test:relay:recovered-client:' + randomUUID()
    const transient = new Redis(url!, { maxRetriesPerRequest: 1 })
    let recovered: Redis | undefined
    try {
      expect(await transient.eval(RELAY_BUDGET_SCRIPT, 1, key, 40, 3, 100, 5000)).toBe(1)
      transient.disconnect()
      await expect(
        transient.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 3, 100, 5000),
      ).rejects.toThrow()
      recovered = new Redis(url!, { maxRetriesPerRequest: 1 })
      expect(await recovered.eval(RELAY_BUDGET_SCRIPT, 1, key, 60, 3, 100, 5000)).toBe(1)
      expect(await b.hgetall(key)).toMatchObject({ messages: '2', bytes: '100' })
      expect(await recovered.eval(RELAY_BUDGET_SCRIPT, 1, key, 1, 3, 100, 5000)).toBe(0)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '100' })
    } finally {
      transient.disconnect()
      if (recovered) await recovered.quit()
      await a.del(key)
    }
  })

  it('never over-admits a shared relay byte budget across independent Node processes', async () => {
    const { fork } = await import('child_process')
    const { join } = await import('path')
    const key = 'test:relay:process-budget:' + randomUUID()
    const workerPath = join(__dirname, 'helpers', 'relayRedisBudgetWorker.cjs')
    const workers = Array.from({ length: 12 }, () => fork(workerPath, [], {
      env: {
        ...process.env,
        RELAY_REDIS_INTEGRATION_URL: url!,
        RELAY_BUDGET_KEY: key,
        RELAY_BUDGET_SCRIPT,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }))
    try {
      const outcomes = await Promise.all(workers.map(worker => new Promise<{ accepted?: number; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis budget worker timed out')), 10000)
        worker.once('message', message => { clearTimeout(timer); resolve(message as { accepted?: number; error?: string }) })
        worker.once('error', err => { clearTimeout(timer); reject(err) })
        worker.send('go')
      })))
      expect(outcomes.every(item => !item.error)).toBe(true)
      expect(outcomes.filter(item => item.accepted === 1)).toHaveLength(10)
      expect(outcomes.filter(item => item.accepted === 0)).toHaveLength(2)
      expect(await a.hgetall(key)).toMatchObject({ messages: '10', bytes: '100' })
    } finally {
      workers.forEach(worker => worker.kill())
      await a.del(key)
    }
  })

  it('enforces the message cap across independent Node processes even with bytes remaining', async () => {
    const { fork } = await import('child_process')
    const { join } = await import('path')
    const key = 'test:relay:process-message-cap:' + randomUUID()
    const workerPath = join(__dirname, 'helpers', 'relayRedisBudgetWorker.cjs')
    const workers = Array.from({ length: 8 }, () => fork(workerPath, [], {
      env: {
        ...process.env,
        RELAY_REDIS_INTEGRATION_URL: url!,
        RELAY_BUDGET_KEY: key,
        RELAY_BUDGET_SCRIPT,
        RELAY_BUDGET_MAX_MESSAGES: '3',
        RELAY_BUDGET_MAX_BYTES: '1000',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }))
    try {
      const outcomes = await Promise.all(workers.map(worker => new Promise<{ accepted?: number; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis message-cap worker timed out')), 10000)
        worker.once('message', message => { clearTimeout(timer); resolve(message as { accepted?: number; error?: string }) })
        worker.once('error', err => { clearTimeout(timer); reject(err) })
        worker.send('go')
      })))
      expect(outcomes.every(item => !item.error)).toBe(true)
      expect(outcomes.filter(item => item.accepted === 1)).toHaveLength(3)
      expect(outcomes.filter(item => item.accepted === 0)).toHaveLength(5)
      expect(await a.hgetall(key)).toMatchObject({ messages: '3', bytes: '30' })
    } finally {
      workers.forEach(worker => worker.kill())
      await a.del(key)
    }
  })

  it('keeps independent participants isolated under concurrent Redis budget pressure', async () => {
    const first = 'test:relay:isolated-a:' + randomUUID()
    const second = 'test:relay:isolated-b:' + randomUUID()
    const evalBudget = (client: Redis, key: string) =>
      client.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 5, 50, 5000)
    try {
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        evalBudget(i % 2 ? a : b, i % 4 < 2 ? first : second),
      ))
      expect(results.filter(value => value === 1)).toHaveLength(10)
      expect(results.filter(value => value === 0)).toHaveLength(30)
      expect(await a.hgetall(first)).toMatchObject({ messages: '5', bytes: '50' })
      expect(await b.hgetall(second)).toMatchObject({ messages: '5', bytes: '50' })
      expect(await evalBudget(a, first)).toBe(0)
      expect(await evalBudget(b, second)).toBe(0)
    } finally {
      await Promise.all([a.del(first), b.del(second)])
    }
  })

  it('does not extend a denied participant budget window under sustained pressure', async () => {
    const key = 'test:relay:denial-expiry:' + randomUUID()
    const windowMs = 1200
    const evalBudget = () => b.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 1, 10, windowMs)
    try {
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 1, 10, windowMs)).toBe(1)
      const initialTtl = await a.pttl(key)
      expect(initialTtl).toBeGreaterThan(0)
      await new Promise(resolve => setTimeout(resolve, 200))
      const denials = await Promise.all(Array.from({ length: 30 }, () => evalBudget()))
      expect(denials).toEqual(Array(30).fill(0))
      const remainingTtl = await a.pttl(key)
      expect(remainingTtl).toBeGreaterThan(0)
      expect(remainingTtl).toBeLessThan(initialTtl)
      expect(await a.hgetall(key)).toMatchObject({ messages: '1', bytes: '10' })
      await new Promise(resolve => setTimeout(resolve, windowMs + 150))
      expect(await evalBudget()).toBe(1)
      expect(await b.hgetall(key)).toMatchObject({ messages: '1', bytes: '10' })
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
