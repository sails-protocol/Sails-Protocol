import { EventEmitter } from 'events'

const budget = jest.fn()
const resolveTicket = jest.fn()
const dispatch = jest.fn()
const register = jest.fn()
const unregister = jest.fn()
const owns = jest.fn()

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

  it('rejects unbounded queued bytes without waiting for Redis', async () => {
    budget.mockImplementation(() => new Promise(() => undefined))
    const socket = new FakeSocket()
    await route(socket, { query: { ticket: 'valid' } })
    for (let i = 0; i < 5; i++) socket.emit('message', Buffer.alloc(65536))
    expect(socket.close).toHaveBeenCalledWith(1008, 'Relay pending byte budget exceeded')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
