/**
 * Bounded blind-relay ingress budget. Deliberately counts raw bytes only:
 * inspecting or decrypting relay payloads would violate the privacy boundary.
 *
 * CANDIDATE: process-local enforcement only. A shared Redis-backed atomic
 * counter and multi-instance tests are required before public deployment.
 */
export const RELAY_FRAME_MAX_BYTES = 64 * 1024
export const RELAY_WINDOW_MS = 60_000
export const RELAY_WINDOW_MAX_MESSAGES = 60
export const RELAY_WINDOW_MAX_BYTES = 256 * 1024

type Budget = { startedAt: number; messages: number; bytes: number }
const budgets = new Map<string, Budget>()

/** No payload content is retained. An exhausted budget is not reset by reconnecting. */
export function consumeRelayBudget(participantId: string, bytes: number, now = Date.now()): boolean {
  if (!participantId || !Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(now)) return false
  if (bytes > RELAY_FRAME_MAX_BYTES) return false
  let state = budgets.get(participantId)
  if (!state || now < state.startedAt || now - state.startedAt >= RELAY_WINDOW_MS) {
    state = { startedAt: now, messages: 0, bytes: 0 }
    budgets.set(participantId, state)
  }
  if (state.messages >= RELAY_WINDOW_MAX_MESSAGES || state.bytes + bytes > RELAY_WINDOW_MAX_BYTES) return false
  state.messages++
  state.bytes += bytes
  return true
}

/** Test-only cleanup; not used on socket close or reconnect. */
export function resetRelayBudgetForTests(): void {
  budgets.clear()
}
