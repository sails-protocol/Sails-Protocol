import { useSyncExternalStore } from 'react'
import { getNodeConnectionStatus, subscribeNodeConnection, type NodeConnectionStatus } from '../lib/nodeConnection'

/** Live reachability of the configured nó Sails (lib/nodeConnection.ts). */
export function useNodeConnection(): NodeConnectionStatus {
  return useSyncExternalStore(subscribeNodeConnection, getNodeConnectionStatus, getNodeConnectionStatus)
}
