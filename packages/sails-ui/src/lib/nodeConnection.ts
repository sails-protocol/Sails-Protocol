/**
 * Live reachability of the configured nó Sails, fed by every SDK request (lib/sailsClient.ts's fetchImpl wrapper).
 * Any HTTP response, 4xx/5xx included, proves the node answered: 'online'. Only a request that never got a
 * response (fetch rejected: offline, DNS, CORS, refused, timeout) is 'unreachable'. An AbortError is the app
 * cancelling its own request (unmount, superseded read), so it changes nothing. Pure and import-free for Node tests.
 */
export type NodeConnectionStatus = 'unknown' | 'online' | 'unreachable'

let status: NodeConnectionStatus = 'unknown'
const listeners = new Set<() => void>()

function set(next: NodeConnectionStatus): void {
  if (next === status) return
  status = next
  listeners.forEach((l) => l())
}

export function getNodeConnectionStatus(): NodeConnectionStatus {
  return status
}

export function subscribeNodeConnection(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A response arrived, whatever its HTTP status. */
export function recordNodeResponse(): void {
  set('online')
}

/** fetch rejected; aborts by the app itself are ignored. */
export function recordNodeFailure(error: unknown): void {
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return
  set('unreachable')
}

/** Test-only reset to the initial state. */
export function resetNodeConnection(): void {
  set('unknown')
}
