/**
 * P4 / Gate 3 - what a failed settlement broadcast does and does not prove.
 *
 * A failure raised BEFORE the transaction was handed to the explorer (round validation, signature checks, the
 * existence/outpoint reads) is a definite pre-broadcast failure: no external effect can have happened. A failure
 * raised by the broadcast request itself (timeout, lost response, HTTP error, unreadable body) is not: the
 * explorer may already have accepted and relayed the transaction, so its outcome is UNKNOWN until chain truth says
 * otherwise. The marker only classifies; it never changes control flow - every caller still relies on the round's
 * deterministic txid and chain truth (reconcilePendingSettlement) rather than on the error.
 *
 * Leaf module (no imports): importable from the provider and the lifecycle without a cycle.
 */

const BROADCAST_ATTEMPTED = 'broadcastAttempted'

/** Marks `err` as raised by a broadcast request that was (or may have been) transmitted. Returns the same error. */
export function markBroadcastAttempted<E>(err: E): E {
  if (err !== null && typeof err === 'object') (err as Record<string, unknown>)[BROADCAST_ATTEMPTED] = true
  return err
}

/** True when `err` came from a broadcast request whose acceptance by the network is not disproven. */
export function isBroadcastOutcomeUnknown(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as Record<string, unknown>)[BROADCAST_ATTEMPTED] === true
}
