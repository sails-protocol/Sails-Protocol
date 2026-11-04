/**
 * Destination-side delivery admission for a future distributed relay.
 *
 * This is intentionally transport-independent. A Redis publication is NOT
 * an acknowledgment. The destination must fence ownership and attempt the
 * local socket write before returning local-send-accepted.
 */
import { parseRelayDeliveryCommand } from './relay-delivery-command'
import type { WebSocketRelayTransportProvider } from './websocket-relay.service'

export type RelayDeliveryDecision =
  | { requestId: string; accepted: true }
  | { requestId: string; accepted: false }

/**
 * Reject malformed or expired commands without touching a socket.
 * Never log, parse or echo the opaque payload.
 */
export async function acceptRelayDeliveryAtDestination(
  provider: WebSocketRelayTransportProvider,
  raw: unknown,
  now = Date.now(),
): Promise<RelayDeliveryDecision | null> {
  const command = parseRelayDeliveryCommand(raw, now)
  if (!command) return null
  const accepted = await provider.sendToPeerIfOwner(
    command.destinationParticipantId,
    command.destinationLeaseToken,
    command.payload,
  )
  return { requestId: command.requestId, accepted }
}
