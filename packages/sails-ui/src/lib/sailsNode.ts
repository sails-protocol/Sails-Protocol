/**
 * Sails node view-model (DECISIONS.md "Nó não é mercado", ADR-001). A node is infrastructure: it hosts and relays
 * without economic authority, and connecting to one never grants access to the markets it hosts. Today the app knows
 * only the node fixed by its build config and none of its metadata (LOOSE_WIRES.nodeCatalog), so every field below
 * except `name` is optional and the screen shows "Em breve" for what is missing. Pure types.
 */

/**
 * The two official deployment profiles of the one Sails Node software (DECISIONS.md "Distribuições oficiais do Sails
 * Node"). A deployment detail shown only in the advanced node details, never tied to a market's visibility.
 */
export type NodeProfile = 'public' | 'private'
export type NodeStatus = 'online' | 'degraded' | 'offline'

export interface NodeView {
  id: string
  name: string
  /** Shown only when the data says it; never a "verified distribution" claim (no verification data exists). */
  profile?: NodeProfile
  /** A Public Node that offers shared hosting for private markets (the third path). */
  sharedHosting?: boolean
  /** The node the app talks to now. */
  current?: boolean
  operator?: string
  region?: string
  status?: NodeStatus
  fee?: string
  limits?: string
  /** As declared by the operator; the protocol does not verify it from the screen. */
  custodyModel?: string
  /** Demo/illustrative entry: marked on screen so it is never read as a real node. */
  illustrative?: boolean
}

/**
 * How the public network may be described, derived only from the data (DECISIONS.md "Como a rede aparece em
 * Configurações → Nó Sails", issue #361): several nodes of one operator are redundancy, never decentralization, and
 * nothing is claimed about operators or activity the app does not know.
 */
export type NetworkWording = 'unknown' | 'single' | 'redundant' | 'multiOperator'

export interface NetworkSummary {
  /** Nodes this app knows about. */
  known: number
  /** Nodes reported online or degraded (only nodes with a status count). */
  active: number
  /** Distinct declared operators among the active nodes. */
  operators: number
  wording: NetworkWording
}

export function summarizeNetwork(nodes: readonly NodeView[]): NetworkSummary {
  const active = nodes.filter((n) => n.status === 'online' || n.status === 'degraded')
  const operators = new Set(active.map((n) => n.operator?.trim()).filter(Boolean)).size
  // Any active node without a declared operator makes the operator count incomplete, so no wording is derived from it.
  const complete = active.length > 0 && active.every((n) => n.operator?.trim())
  const wording: NetworkWording = !complete ? 'unknown' : operators === 1 ? (active.length > 1 ? 'redundant' : 'single') : 'multiOperator'
  return { known: nodes.length, active: active.length, operators, wording }
}
