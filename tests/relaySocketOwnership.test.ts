import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'

describe('relay socket replacement ownership', () => {
  it('does not unregister a newer connection when an older one closes', () => {
    const provider = new WebSocketRelayTransportProvider()
    const oldSocket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const newSocket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    provider.registerSocket('p', oldSocket)
    provider.registerSocket('p', newSocket)
    provider.unregisterSocket('p', oldSocket)
    expect(provider.isConnected('p')).toBe(true)
    provider.unregisterSocket('p', newSocket)
    expect(provider.isConnected('p')).toBe(false)
  })
})
