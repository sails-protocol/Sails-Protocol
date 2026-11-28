/**
 * Cross-instance relay command envelope validation (not a transport).
 * The Redis backplane must validate before touching a socket. Never log
 * opaque payloads or treat publication as proof of delivery.
 */
import { RELAY_FRAME_MAX_BYTES } from './relay-ingress-budget'

export interface RelayDeliveryCommand {
  requestId: string
  destinationParticipantId: string
  destinationLeaseToken: string
  deadlineMs: number
  payload: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Strictly reject unknown fields and malformed commands before forwarding. */
export function parseRelayDeliveryCommand(value: unknown, now = Date.now()): RelayDeliveryCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(now)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 5 || keys.some(key => ![
    'requestId', 'destinationParticipantId', 'destinationLeaseToken', 'deadlineMs', 'payload',
  ].includes(key))) return null
  if (typeof record.requestId !== 'string' || !UUID_RE.test(record.requestId)) return null
  if (typeof record.destinationParticipantId !== 'string' || !record.destinationParticipantId ||
      record.destinationParticipantId.length > 256) return null
  if (typeof record.destinationLeaseToken !== 'string' || !UUID_RE.test(record.destinationLeaseToken)) return null
  if (typeof record.deadlineMs !== 'number' || !Number.isSafeInteger(record.deadlineMs) ||
      record.deadlineMs <= now || record.deadlineMs > now + 5000) return null
  if (typeof record.payload !== 'string' || Buffer.byteLength(record.payload, 'utf8') > RELAY_FRAME_MAX_BYTES) return null
  return record as unknown as RelayDeliveryCommand
}
