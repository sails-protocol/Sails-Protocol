/**
 * Layer A: a list of markets (Explorar mercados, Meus mercados). One row per market: name, visibility, the person's
 * relation and the participation preset; the infrastructure is a technical detail on its own muted line (it never
 * defines who belongs, ADR-001 §1). Illustrative entries are marked. Order comes from the caller
 * (lib/myMarkets.ts composeMyMarkets). An optional trailing action per row. Copy from props, tokens only.
 */
import type { ReactNode } from 'react'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import type { MarketInfrastructure, MarketRelation, MarketView, MarketVisibility, ParticipationPreset } from '../../lib/myMarkets'
import { MarketIcon } from './MarketIcon'

export interface MarketListCopy {
  label: string
  visibility: Record<MarketVisibility, string>
  relation: Record<MarketRelation, string>
  preset: Record<ParticipationPreset, string>
  presetLabel: string
  infrastructure: Record<MarketInfrastructure, string>
  infrastructureLabel: string
  illustrative: string
  /** Tag for a market the person created (instead of the illustrative tag). */
  ownedByYou?: string
}

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

export function MarketList({ markets, copy, action, compact = false, className }: {
  markets: readonly MarketView[]
  copy: MarketListCopy
  /** Trailing control for a row (e.g. a link to open it); null for none. */
  action?: (market: MarketView) => ReactNode
  /** Meus mercados: no technical hosting line, and no participation model on private markets. */
  compact?: boolean
  className?: string
}) {
  return (
    <ul aria-label={copy.label} className={cn('divide-y divide-brand-border-subtle', className)}>
      {markets.map((m) => {
        const trailing = action?.(m)
        return (
          <li key={m.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <MarketIcon market={m} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-brand-text">{m.name}</span>
                {m.ownedByYou && copy.ownedByYou ? <Badge variant="outline" className={TAG}>{copy.ownedByYou}</Badge> : m.illustrative && <Badge variant="outline" className={TAG}>{copy.illustrative}</Badge>}
              </div>
              <p className="mt-0.5 text-caption text-brand-text-secondary">
                {/* The open market is the whole network, not one of the public markets: no "Público" label. */}
                {m.relation === 'default' ? copy.relation.default : <>{copy.visibility[m.visibility]}{m.relation !== 'none' && <> · {copy.relation[m.relation]}</>}</>}
                {m.preset && !(compact && m.visibility === 'private') && <> · {copy.presetLabel} {copy.preset[m.preset]}</>}
              </p>
              {!compact && <p className="text-caption text-brand-text-muted">{copy.infrastructureLabel} {copy.infrastructure[m.infrastructure]}</p>}
            </div>
            {trailing && <div className={compact ? 'max-w-[55%] self-center' : 'shrink-0 self-center'}>{trailing}</div>}
          </li>
        )
      })}
    </ul>
  )
}
