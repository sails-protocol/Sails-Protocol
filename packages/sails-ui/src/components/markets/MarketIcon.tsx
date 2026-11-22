/**
 * Layer A: the icon of a market or of a portal action (DECISIONS.md "Modelo mundo aberto": icons are mandatory).
 * Mercado aberto = Globe, a public market with its own brand = Store, a private market = UsersRound (a group of
 * admitted people; deliberately no lock, no security claim). A market's brand image, when it exists, replaces the
 * generic icon. Tokens only.
 */
import { Compass, Globe, PlusCircle, Store, Ticket, UsersRound, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { MarketView } from '../../lib/myMarkets'

export const MARKET_ACTION_ICON = { explore: Compass, invite: Ticket, create: PlusCircle } as const satisfies Record<string, LucideIcon>

export function marketIconOf(market: Pick<MarketView, 'relation' | 'visibility'>): LucideIcon {
  return market.relation === 'default' ? Globe : market.visibility === 'public' ? Store : UsersRound
}

const SIZE = { sm: 'h-8 w-8', md: 'h-9 w-9', lg: 'h-11 w-11' } as const

/** A tonal tile with the market's brand image or its generic icon (decorative: the name is always next to it). */
export function MarketIcon({ market, size = 'md', className }: { market: Pick<MarketView, 'relation' | 'visibility' | 'brandImage'>; size?: keyof typeof SIZE; className?: string }) {
  const Icon = marketIconOf(market)
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-elevated text-brand-text-secondary', SIZE[size], className)}>
      {market.brandImage
        ? <img src={market.brandImage} alt="" width={44} height={44} className="h-full w-full object-cover" />
        : <Icon className={size === 'lg' ? 'h-5 w-5' : 'h-4 w-4'} />}
    </span>
  )
}

/** A tonal tile for a portal action icon. */
export function ActionIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-elevated text-brand-text-secondary', className)}>
      <Icon className="h-4 w-4" />
    </span>
  )
}
