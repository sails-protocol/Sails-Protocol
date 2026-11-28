import { randomUUID } from 'node:crypto'
import { RelayDeliveryOrigin } from '../src/infrastructure/p2p/relay-delivery-origin'
import { acceptRelayDeliveryAtDestination } from '../src/infrastructure/p2p/relay-delivery-destination'
import { WebSocketRelayTransportProvider } from '../src/infrastructure/p2p/websocket-relay.service'
import type { RelayDeliveryCommand } from '../src/infrastructure/p2p/relay-delivery-command'

describe('relay origin/destination in-memory transport contract', () => {
  const input = (token: string) => ({
    destinationParticipantId: 'bob',
    destinationLeaseToken: token,
    deadlineMs: Date.now() + 2500,
    payload: 'opaque',
  })

  it('correlates a destination local-send ACK across distinct provider instances', async () => {
    const sourceProvider = new WebSocketRelayTransportProvider()
    const destinationProvider = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    const token = randomUUID()
    destinationProvider.registerSocket('bob', socket, token)
    expect(await sourceProvider.sendToPeer('alice', 'bob', 'opaque')).toBe(false)
    let origin!: RelayDeliveryOrigin
    origin = new RelayDeliveryOrigin(async (command: RelayDeliveryCommand) => {
      const ack = await acceptRelayDeliveryAtDestination(destinationProvider, command)
      if (ack) origin.acknowledge(ack)
    })
    expect(await origin.deliver(input(token))).toBe(true)
    expect(socket.send).toHaveBeenCalledWith('opaque')
    expect(origin.pendingCount).toBe(0)
    origin.close()
  })

  it('fails closed when the publisher throws', async () => {
    const origin = new RelayDeliveryOrigin(async () => { throw new Error('channel down') })
    expect(await origin.deliver(input(randomUUID()))).toBe(false)
    expect(origin.pendingCount).toBe(0)
    origin.close()
  })

  it('fails closed on a stale destination lease', async () => {
    const destination = new WebSocketRelayTransportProvider()
    const socket = { readyState: 1, send: jest.fn(), close: jest.fn() }
    destination.registerSocket('bob', socket, randomUUID())
    let origin!: RelayDeliveryOrigin
    origin = new RelayDeliveryOrigin(async command => {
      const ack = await acceptRelayDeliveryAtDestination(destination, command)
      if (ack) origin.acknowledge(ack)
    })
    expect(await origin.deliver(input(randomUUID()))).toBe(false)
    expect(socket.send).not.toHaveBeenCalled()
    origin.close()
  })
})
