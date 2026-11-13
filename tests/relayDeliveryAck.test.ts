import { randomUUID } from 'node:crypto'
import { correlateRelayDeliveryAck, parseRelayDeliveryAck } from '../src/infrastructure/p2p/relay-delivery-ack'

describe('cross-instance relay ACK admission', () => {
  it('accepts only a strict boolean ACK with a valid request ID', () => {
    const requestId = randomUUID()
    expect(parseRelayDeliveryAck({ requestId, accepted: true })).toEqual({ requestId, accepted: true })
    expect(parseRelayDeliveryAck({ requestId, accepted: false })).toEqual({ requestId, accepted: false })
    for (const raw of [
      { requestId, accepted: 'true' },
      { requestId, accepted: 1 },
      { requestId, accepted: true, payload: 'must-not-echo' },
      { requestId: 'not-uuid', accepted: true },
      { accepted: true },
      [],
      null,
    ]) {
      expect(parseRelayDeliveryAck(raw)).toBeNull()
    }
  })

  it('never accepts ACKs for another request or a negative ACK', () => {
    const requestId = randomUUID()
    expect(correlateRelayDeliveryAck(requestId, { requestId, accepted: true })).toBe(true)
    expect(correlateRelayDeliveryAck(requestId, { requestId: randomUUID(), accepted: true })).toBe(false)
    expect(correlateRelayDeliveryAck(requestId, { requestId, accepted: false })).toBe(false)
    expect(correlateRelayDeliveryAck(requestId, { requestId, accepted: true, unexpected: true })).toBe(false)
  })
})
