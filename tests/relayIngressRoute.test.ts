import { EventEmitter } from 'events'

const budget = jest.fn()
const resolveTicket = jest.fn()
const dispatch = jest.fn()
const register = jest.fn()
const unregister = jest.fn()
const owns = jest.fn()
const claimPresence = jest.fn()
const releasePresence = jest.fn()

jest.mock('../src/infrastructure/p2p/relay-presence', () => ({
  RELAY_PRESENCE_TTL_MS: 30_000,
  claimRelayPresence: (...args: unknown[]) => claimPresence(...args),
  renewRelayPresence: jest.fn().mockResolvedValue(true),
  releaseRelayPresence: (...args: unknown[]) => releasePresence(...args),
}))

jest.mock('../src/infrastructure/p2p/relay-shared-budget', () => ({
  consumeSharedRelayBudget: (...args: unknown[]) => budget(...args),
}))
jest.mock('../src/common/middleware/ws-auth', () => ({
  resolveParticipantFromTicket: (...args: unknown[]) => resolveTicket(...args),
}))
jest.mock('../src/infrastructure/p2p/websocket-relay.service', () => ({
  webSocketRelayTransportProvider: {
    registerSocket: (...args: unknown[]) => register(...args),
    unregisterSocket: (...args: unknown[]) => unregister(...args),
    ownsSocket: (...args: unknown[]) => owns(...args),
    dispatchIncoming: (...args: unknown[]) => dispatch(...args),
  },
}))

import { relayRoutes } from '../src/infrastructure/p2p/relay.routes'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

describe('relay authenticated WS ingress queue', () => {
  let route!: (socket: FakeSocket, request: { query: { ticket: string } }) => Promise<void>
  class FakeSocket extends EventEmitter {
    readyState = 1
    send = jest.fn()
    close = jest.fn(() => { this.readyState = 3; this.emit('close') })
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    resolveTicket.mockResolvedValue('participant')
    owns.mockReturnValue(true)
    budget.mockResolvedValue(true)
    claimPresence.mockResolvedValue(undefined)
    releasePresence.mockResolvedValue(true)
    await relayRoutes({ get: (_path: string, _opts: unknown, handler: typeof route) => { route = handler } } as never)
  })

  it('rejects frames arriving while ticket authentication is unresolved', async () => {
    let release!: (id: string) => void
    resolveTicket.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve }))
    const socket = new FakeSocket()
    const auth = route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.from('unauthenticated'))
    release('participant')
    await auth
    expect(socket.close).toHaveBeenCalledWith(1008, 'Relay authentication pending')
    expect(register).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('fails closed if the ticket store errors', async () => {
    resolveTicket.mockRejectedValueOnce(new Error('redis unavailable'))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    expect(socket.close).toHaveBeenCalledWith(1011, 'Relay authentication unavailable')
    expect(register).not.toHaveBeenCalled()
  })

  it('fails closed if the Redis presence claim rejects before socket registration', async () => {
    claimPresence.mockRejectedValueOnce(new Error('redis unavailable'))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    expect(socket.close).toHaveBeenCalledWith(1011, 'Relay presence unavailable')
    expect(register).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not register a socket closed while the Redis presence claim is pending', async () => {
    let completeClaim!: () => void
    claimPresence.mockImplementationOnce(() => new Promise<void>(resolve => { completeClaim = resolve }))
    const socket = new FakeSocket()
    const pending = route(socket, { query: { ticket: 'valid' } })
    await flush()
    expect(claimPresence).toHaveBeenCalledTimes(1)
    socket.close()
    completeClaim()
    await pending
    expect(register).not.toHaveBeenCalled()
    expect(releasePresence).toHaveBeenCalledTimes(1)
  })

  it('preserves order across delayed asynchronous Redis decisions', async () => {
    let release!: (value: boolean) => void
    budget.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.from('first'))
    socket.emit('message', Buffer.from('second'))
    await flush()
    expect(budget).toHaveBeenCalledTimes(1)
    release(true)
    await flush()
    await flush()
    expect(dispatch.mock.calls.map(call => call[1])).toEqual(['first', 'second'])
  })

  it('never dispatches queued frames after first budget denial', async () => {
    budget.mockResolvedValueOnce(false)
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.from('one'))
    socket.emit('message', Buffer.from('two'))
    await flush()
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledWith(1008, 'Relay resource budget exceeded')
    expect(budget).toHaveBeenCalledTimes(1)
  })

  it('fails closed on Redis budget errors without dispatching frames', async () => {
    budget.mockRejectedValueOnce(new Error('redis unavailable'))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.from('first'))
    socket.emit('message', Buffer.from('second'))
    await flush()
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledWith(1011, 'Relay unavailable')
    expect(budget).toHaveBeenCalledTimes(1)
  })

  it('rejects a frame after the authenticated socket has closed', async () => {
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.close()
    socket.emit('message', Buffer.from('late frame'))
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
    expect(budget).not.toHaveBeenCalled()
  })

  it('rejects frames from a replaced socket before querying Redis', async () => {
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    owns.mockReturnValue(false)
    socket.emit('message', Buffer.from('stale'))
    await flush()
    expect(budget).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch after participant socket replacement', async () => {
    let release!: (value: boolean) => void
    budget.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.from('stale'))
    await flush()
    owns.mockReturnValue(false)
    release(true)
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('admits exactly 64 KiB while still consulting the shared Redis budget', async () => {
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.alloc(65536))
    await flush()
    await flush()
    expect(budget).toHaveBeenCalledWith('participant', 65536)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('rejects an oversized frame before allocating queue buffers or querying Redis', async () => {
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    socket.emit('message', Buffer.alloc(65537))
    await flush()
    expect(socket.close).toHaveBeenCalledWith(1009, 'Relay frame exceeds maximum size')
    expect(budget).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects the 61st queued frame even when total queued bytes stay below 256 KiB', async () => {
    budget.mockImplementation(() => new Promise(() => undefined))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    for (let i = 0; i < 60; i++) socket.emit('message', Buffer.from('x'))
    expect(socket.close).not.toHaveBeenCalled()
    socket.emit('message', Buffer.from('x'))
    expect(socket.close).toHaveBeenCalledWith(1008, 'Relay pending byte budget exceeded')
    expect(dispatch).not.toHaveBeenCalled()
    await flush()
    // The 61st frame closes the socket synchronously; queued work must not
    // start Redis admission after the socket is already stopped.
    expect(budget).not.toHaveBeenCalled()
  })

  it('rejects unbounded queued bytes without waiting for Redis', async () => {
    budget.mockImplementation(() => new Promise(() => undefined))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    for (let i = 0; i < 5; i++) socket.emit('message', Buffer.alloc(65536))
    expect(socket.close).toHaveBeenCalledWith(1008, 'Relay pending byte budget exceeded')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('relay real TCP WebSocket transport', () => {
  it('closes a real TCP WebSocket on ticket-store failure without registering it', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockRejectedValue(new Error('redis unavailable'))
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=store-outage`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket remained open after ticket-store failure')), 3000)
        client!.once('close', code => { clearTimeout(timeout); resolve(code) })
        client!.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      expect(closeCode).toBe(1011)
      expect(resolveTicket).toHaveBeenCalledWith('store-outage')
      expect(register).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(budget).not.toHaveBeenCalled()
    } finally {
      client?.terminate()
      await app.close()
    }
  })

  it('rejects an invalid ticket over a real TCP WebSocket connection', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValue(null)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=invalid`)
      const received: string[] = []
      client.on('message', data => received.push(data.toString()))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Invalid-ticket socket did not close')), 3000)
        client!.once('close', () => { clearTimeout(timeout); resolve() })
        client!.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      expect(resolveTicket).toHaveBeenCalledWith('invalid')
      expect(received.some(message => message.includes('already-used ticket'))).toBe(true)
      expect(register).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(budget).not.toHaveBeenCalled()
    } finally {
      client?.terminate()
      await app.close()
    }
  })

  it('rejects two concurrent TCP connections presenting the same ticket after one claim', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    const clients: InstanceType<typeof WebSocket>[] = []
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValueOnce('participant').mockResolvedValueOnce(null)
      owns.mockReturnValue(true)
      budget.mockResolvedValue(true)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      const url = `ws://127.0.0.1:${address.port}/ws/relay?ticket=same-ticket`
      const observations = await Promise.all([0, 1].map(async () => {
        const client = new WebSocket(url)
        clients.push(client)
        const messages: string[] = []
        client.on('message', data => messages.push(data.toString()))
        await new Promise<void>((resolve, reject) => {
          client.once('open', resolve)
          client.once('error', reject)
        })
        return { client, messages }
      }))
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (resolveTicket.mock.calls.length === 2 && register.mock.calls.length === 1 &&
            observations.some(item => item.messages.some(message => message.includes('already-used ticket')))) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Expected exactly one TCP ticket claimant'))
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(resolveTicket.mock.calls).toEqual([['same-ticket'], ['same-ticket']])
      expect(register).toHaveBeenCalledTimes(1)
      expect(observations.filter(item => item.messages.some(message => message.includes('already-used ticket')))).toHaveLength(1)
    } finally {
      clients.forEach(client => client.terminate())
      await app.close()
    }
  })

  it('closes an oversized frame on real TCP before Redis admission', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValue('participant')
      owns.mockReturnValue(true)
      await app.register(websocket, { options: { maxPayload: 1048576 } })
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=oversized`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (register.mock.calls.length === 1) return resolve()
          if (Date.now() >= deadline) return reject(new Error('TCP relay was not authenticated'))
          setTimeout(poll, 10)
        }
        poll()
      })
      const closeCode = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Oversized TCP frame was not closed')), 3000)
        client!.once('close', code => { clearTimeout(timeout); resolve(code) })
        client!.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      client.send(Buffer.alloc(65537))
      expect(await closeCode).toBe(1009)
      expect(budget).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      client?.terminate()
      await app.close()
    }
  })

  it('rejects a 1 MiB relay frame at the application policy boundary without Redis admission', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValue('participant')
      owns.mockReturnValue(true)
      await app.register(websocket, { options: { maxPayload: 1048576 } })
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=app-oversized`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (register.mock.calls.length === 1) return resolve()
          if (Date.now() >= deadline) return reject(new Error('TCP relay was not authenticated'))
          setTimeout(poll, 10)
        }
        poll()
      })
      const closeCode = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Application oversized frame did not close')), 3000)
        client!.once('close', code => { clearTimeout(timeout); resolve(code) })
        client!.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      client.send(Buffer.alloc(1048576))
      expect(await closeCode).toBe(1009)
      expect(budget).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      client?.terminate()
      await app.close()
    }
  })

  it('rejects a frame above 1 MiB at the actual WebSocket transport boundary', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValue('participant')
      owns.mockReturnValue(true)
      await app.register(websocket, { options: { maxPayload: 1048576 } })
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=transport-oversized`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (register.mock.calls.length === 1) return resolve()
          if (Date.now() >= deadline) return reject(new Error('TCP relay was not authenticated'))
          setTimeout(poll, 10)
        }
        poll()
      })
      const closeCode = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Transport oversized frame did not close')), 3000)
        client!.once('close', code => { clearTimeout(timeout); resolve(code) })
        client!.once('error', err => { clearTimeout(timeout); reject(err) })
      })
      client.send(Buffer.alloc(1048577))
      expect(await closeCode).toBe(1009)
      expect(budget).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      client?.terminate()
      await app.close()
    }
  })

  it('dispatches a frame over a live Fastify WebSocket connection', async () => {
    const Fastify = (await import('fastify')).default
    const websocket = (await import('@fastify/websocket')).default
    const WebSocket = (await import('ws')).default
    const app = Fastify({ logger: false })
    let client: InstanceType<typeof WebSocket> | undefined
    try {
      jest.clearAllMocks()
      resolveTicket.mockResolvedValue('participant')
      owns.mockReturnValue(true)
      budget.mockResolvedValue(true)
      await app.register(websocket)
      await app.register(relayRoutes)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/relay?ticket=valid`)
      await new Promise<void>((resolve, reject) => {
        client!.once('open', resolve)
        client!.once('error', reject)
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      client.send('live-frame')
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (dispatch.mock.calls.length > 0) return resolve()
          if (Date.now() >= deadline) return reject(new Error('Live relay frame not dispatched'))
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(resolveTicket).toHaveBeenCalledWith('valid')
      expect(budget).toHaveBeenCalledWith('participant', Buffer.byteLength('live-frame'))
      expect(dispatch).toHaveBeenCalledWith('participant', 'live-frame')
    } finally {
      client?.terminate()
      await app.close()
    }
  })
})
