/**
 * Strict acknowledgment admission for a future cross-instance relay channel.
 * Acknowledgments only mean a destination process attempted an accepted local
 * socket write, never client receipt. No payloads are reflected in responses.
 */
export interface RelayDeliveryAck {
  requestId: string
  accepted: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseRelayDeliveryAck(value: unknown): RelayDeliveryAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('accepted')) return null
  if (typeof record.requestId !== 'string' || !UUID_RE.test(record.requestId)) return null
  if (typeof record.accepted !== 'boolean') return null
  return { requestId: record.requestId, accepted: record.accepted }
}

/**
 * Correlate an ACK to exactly the outstanding request. A random, well-formed
 * ACK from another request must never turn a delivery into success.
 */
export function correlateRelayDeliveryAck(requestId: string, raw: unknown): boolean {
  const ack = parseRelayDeliveryAck(raw)
  return ack !== null && ack.requestId === requestId && ack.accepted
}
