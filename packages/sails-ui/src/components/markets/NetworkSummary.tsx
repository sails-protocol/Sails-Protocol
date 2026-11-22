/**
 * Layer A: detail of the public network ("Rede Sails"): the set of nodes that keep the open market up, not a single
 * machine. Counts and wording come only from the node data (lib/sailsNode.ts summarizeNetwork, issue #361): several
 * nodes of one operator read as redundancy. Says nothing about nodes sharing state (unspecified). Copy from props.
 */
import type { ReactNode } from 'react'
import { summarizeNetwork, type NetworkSummary as Summary, type NetworkWording, type NodeView } from '../../lib/sailsNode'
import { NodeList, type NodeListCopy } from './NodeList'

export interface NetworkSummaryCopy {
  wording: Record<NetworkWording, (s: Summary) => string>
  /** "Boreal OTC: 2 nós" */
  operatorLine: (operator: string, nodes: number) => string
  operatorsLabel: string
  nodesTitle: string
  list: NodeListCopy
}

/** Active nodes per declared operator; empty when the operator data is incomplete. */
function nodesByOperator(nodes: readonly NodeView[], summary: Summary): [string, number][] {
  if (summary.wording === 'unknown') return []
  const map = new Map<string, number>()
  for (const n of nodes) {
    const op = n.operator?.trim()
    if ((n.status === 'online' || n.status === 'degraded') && op) map.set(op, (map.get(op) ?? 0) + 1)
  }
  return [...map]
}

export function NetworkSummary({ nodes, copy, children, className }: {
  nodes: readonly NodeView[]
  copy: NetworkSummaryCopy
  /** Extra notes under the counts (planned items, caveats). */
  children?: ReactNode
  className?: string
}) {
  const summary = summarizeNetwork(nodes)
  const byOperator = nodesByOperator(nodes, summary)
  return (
    <div className={className}>
      <p className="text-body-sm text-brand-text">{copy.wording[summary.wording](summary)}</p>
      {byOperator.length > 0 && (
        <ul aria-label={copy.operatorsLabel} className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-brand-text-secondary">
          {byOperator.map(([op, count]) => <li key={op}>{copy.operatorLine(op, count)}</li>)}
        </ul>
      )}
      {children && <div className="mt-3 space-y-3">{children}</div>}
      <h3 className="mt-4 text-sm font-medium text-brand-text">{copy.nodesTitle}</h3>
      <NodeList nodes={nodes} copy={copy.list} className="mt-2" />
    </div>
  )
}
