import { randomUUID } from 'node:crypto'
import { acceptRelayDeliveryAtDestination } from '../src/infrastructure/p2p/relay-delivery-destination'
import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'

describe('relay destination command admission', () => {
  const make = (lease: string, deadlineMs: number) => ({
    requestId: randomUUID(),
    destinationParticipantId: 'bob',
    destinationLeaseToken: lease,
    deadlineMs,
    payload: 'opaque-no-parse',
  })

  it('accepts only the current owner and rejects stale owners without writing', async () => {
    const provider = new WebSocketRelayTransportProvider()
    const previous = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const current = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const oldLease = randomUUID()
    const newLease = randomUUID()
    const now = Date.now()
    provider.registerSocket('bob', previous, oldLease)
    provider.registerSocket('bob', current, newLease)
    const stale = make(oldLease, now + 1000)
    expect(await acceptRelayDeliveryAtDestination(provider, stale, now)).toEqual({ requestId: stale.requestId, accepted: false })
    expect(previous.send).not.toHaveBeenCalled()
    expect(current.send).not.toHaveBeenCalled()
    const valid = make(newLease, now + 1000)
    expect(await acceptRelayDeliveryAtDestination(provider, valid, now)).toEqual({ requestId: valid.requestId, accepted: true })
    expect(current.send).toHaveBeenCalledWith('opaque-no-parse')
  })

  it('rejects expired and malformed commands without invoking socket send', async () => {
    const provider = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const lease = randomUUID()
    const now = Date.now()
    provider.registerSocket('bob', socket, lease)
    expect(await acceptRelayDeliveryAtDestination(provider, make(lease, now), now)).toBeNull()
    expect(await acceptRelayDeliveryAtDestination(provider, { ...make(lease, now + 1000), payload: 1 }, now)).toBeNull()
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('reports failure when the current owner socket throws', async () => {
    const provider = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(() => { throw new Error('broken') }), close: jest.fn() }
    const lease = randomUUID()
    const now = Date.now()
    provider.registerSocket('bob', socket, lease)
    const command = make(lease, now + 1000)
    expect(await acceptRelayDeliveryAtDestination(provider, command, now)).toEqual({ requestId: command.requestId, accepted: false })
  })
})
