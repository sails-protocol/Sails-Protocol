import { randomUUID } from 'node:crypto'
import { parseRelayDeliveryCommand } from '../src/infrastructure/p2p/relay-delivery-command'
import { RELAY_FRAME_MAX_BYTES } from '../src/infrastructure/p2p/relay-ingress-budget'

describe('cross-instance relay command admission', () => {
  const now = 1_800_000_000_000
  const command = () => ({
    requestId: randomUUID(),
    destinationParticipantId: 'bob',
    destinationLeaseToken: randomUUID(),
    deadlineMs: now + 1000,
    payload: 'opaque',
  })

  it('accepts a bounded opaque command before its deadline', () => {
    expect(parseRelayDeliveryCommand(command(), now)).not.toBeNull()
  })

  it('fails closed for expiry, excess lifetime and non-integer deadlines', () => {
    for (const deadlineMs of [now, now - 1, now + 5001, NaN, Infinity, now + 0.5]) {
      expect(parseRelayDeliveryCommand({ ...command(), deadlineMs }, now)).toBeNull()
    }
  })

  it('rejects extra fields, malformed identity and lease tokens', () => {
    expect(parseRelayDeliveryCommand({ ...command(), extra: 'untrusted' }, now)).toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), destinationLeaseToken: 'not-a-token' }, now)).toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), requestId: 'bad' }, now)).toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), destinationParticipantId: '' }, now)).toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), destinationParticipantId: 'x'.repeat(257) }, now)).toBeNull()
  })

  it('enforces UTF-8 byte limits, not JavaScript string length', () => {
    expect(parseRelayDeliveryCommand({ ...command(), payload: 'a'.repeat(RELAY_FRAME_MAX_BYTES) }, now)).not.toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), payload: 'é'.repeat(RELAY_FRAME_MAX_BYTES) }, now)).toBeNull()
    expect(parseRelayDeliveryCommand({ ...command(), payload: 123 }, now)).toBeNull()
  })

  it('rejects arrays and missing fields', () => {
    expect(parseRelayDeliveryCommand([], now)).toBeNull()
    expect(parseRelayDeliveryCommand(null, now)).toBeNull()
    const { payload: _payload, ...withoutPayload } = command()
    expect(parseRelayDeliveryCommand(withoutPayload, now)).toBeNull()
  })
})
