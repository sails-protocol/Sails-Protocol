/**
 * Layer A: one market as a card (Explorar mercados, Meus mercados in grid): 3:1 banner, square icon, name, category,
 * profile badge, participants, an illustrative tag for demo entries and the caller's action (a link to its page).
 * The whole card is one target through the action link (stretched); nothing else inside is interactive.
 * Copy from props, tokens only.
 */
import type { ReactNode } from 'react'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import type { MarketView } from '../../lib/myMarkets'
import { MarketBanner } from './MarketBanner'
import { MarketIcon } from './MarketIcon'

export interface MarketCardCopy {
  illustrative: string
  ownedByYou: string
  /** Category label, or null when the market has none. */
  category: (m: MarketView) => string | null
  /** Profile badge ("P2P", "Empresa / OTC"), or null. */
  profile: (m: MarketView) => string | null
  /** Second line under the name (participants, relation). */
  meta: (m: MarketView) => string
}

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

export function MarketCard({ market: m, copy, action, badges, className }: {
  market: MarketView
  copy: MarketCardCopy
  /** A link whose `after:` overlay makes the whole card clickable (caller adds the stretched class). */
  action?: ReactNode
  /** Extra badges after the profile badge (e.g. a demo-only seal). */
  badges?: ReactNode
  className?: string
}) {
  const category = copy.category(m)
  const profile = copy.profile(m)
  return (
    <article className={cn('relative flex flex-col overflow-hidden rounded-lg bg-brand-surface transition-colors duration-short has-[a:hover]:bg-brand-elevated', className)}>
      <MarketBanner market={m} image={m.bannerImage} className="rounded-none" />
      <div className="flex flex-1 flex-col gap-2 p-4 pt-0">
        <MarketIcon market={m} size="lg" className="relative -mt-5 bg-brand-surface shadow-elevation-1" />
        <div className="min-w-0">
          <h3 className="break-words text-sm font-medium text-brand-text">{m.name}</h3>
          {category && <p className="text-caption text-brand-text-secondary">{category}</p>}
        </div>
        {m.description && <p className="line-clamp-2 text-caption text-brand-text-secondary">{m.description}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {profile && <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{profile}</Badge>}
          {badges}
          {m.ownedByYou ? <Badge variant="outline" className={TAG}>{copy.ownedByYou}</Badge> : m.illustrative && <Badge variant="outline" className={TAG}>{copy.illustrative}</Badge>}
        </div>
        <p className="tabular-nums text-caption text-brand-text-muted">{copy.meta(m)}</p>
        {action && <div className="mt-auto pt-1">{action}</div>}
      </div>
    </article>
  )
}
