import { useState } from 'react'
import { isFavoriteTrader, toggleFavoriteTrader } from '../../lib/favorites'
import { Star } from 'lucide-react'
import { IconButton } from './icon-button'
import { useUiStrings } from './uiStrings'

// Airtm-inspired (its own "pick a cashier you trust" pattern) —
// lib/favorites.ts's own header comment has the full real-vs-UI-only
// scope note. Deliberately not wired into OfferCard/Marketplace's list
// rows: `lib/realOffers.ts`'s `summaryToOffer()` hardcodes every row's
// `user.id` to the literal string `'unknown'` (the real `discover()`
// route doesn't return the owning User row at all) — a favorite button
// there would "favorite" the same placeholder id for every single
// offer, not a real trader. Only shown where a real `user.id` exists:
// OfferDetail (its own richer single-offer fetch) and TradeParties (a
// real trade's real buyer/seller).
export function FavoriteButton({ userId }: { userId: string }) {
  const [isFav, setIsFav] = useState(() => isFavoriteTrader(userId))
  const strings = useUiStrings()

  return (
    <IconButton
      size="sm"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsFav(toggleFavoriteTrader(userId))
      }}
      // Constant name, the state is aria-pressed (on = brand blue: chosen, not orange: act).
      label={strings.favoriteSeller}
      pressed={isFav}
    >
      <Star aria-hidden="true" fill={isFav ? 'currentColor' : 'none'} />
    </IconButton>
  )
}
