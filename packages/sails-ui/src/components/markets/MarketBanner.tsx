/**
 * Layer A: a market's 3:1 banner. With `image` (a local preview the person chose, never a remote link) it shows that
 * image; otherwise token-only art: a tonal band in one of three tones picked from the id, with the market's icon. No
 * stock image, no raw color. A remote banner (an admin's link) is never loaded here: see AdminImage. Decorative.
 */
import { cn } from '../../lib/utils'
import type { MarketView } from '../../lib/myMarkets'
import { marketIconOf } from './MarketIcon'

const TONES = [
  'from-brand-blue/20 via-brand-elevated to-brand-info/10',
  'from-brand-info/15 via-brand-elevated to-brand-blue/15',
  'from-brand-tonal via-brand-elevated to-brand-blue/20',
] as const

/** Same id, same tone (stable across renders and devices). */
export function bannerTone(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % TONES.length
}

export function MarketBanner({ market, image, className }: {
  market: Pick<MarketView, 'id' | 'relation' | 'visibility'>
  image?: string | null
  className?: string
}) {
  const Icon = marketIconOf(market)
  return (
    <div aria-hidden="true" className={cn('relative aspect-[3/1] w-full overflow-hidden rounded-lg bg-brand-elevated', className)}>
      {image ? (
        <img src={image} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className={cn('flex h-full w-full items-center justify-end bg-gradient-to-br pr-[8%]', TONES[bannerTone(market.id)])}>
          <Icon className="h-1/2 w-auto text-brand-text-muted opacity-40" strokeWidth={1.25} />
        </div>
      )}
    </div>
  )
}
