import { useState } from 'react'
import { isFavoriteTrader, toggleFavoriteTrader } from '../../lib/favorites'
import { Star } from 'lucide-react'

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

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsFav(toggleFavoriteTrader(userId))
      }}
      title={isFav ? 'Remover dos favoritos' : 'Favoritar este vendedor'}
      aria-label="Favoritar este vendedor"
      aria-pressed={isFav}
      // p-3.5 -m-3.5: expands the tap target to 44px without
      // shifting the visible icon or its layout position — the icon
      // alone was a 16px hit area, well under mobile's ~44px minimum
      // (found testing this same migration's other icon buttons live).
      className={`p-3.5 -m-3.5 transition-colors ${isFav ? 'text-brand-orange-accent' : 'text-brand-text-muted hover:text-brand-text'}`}
    >
      <Star className="h-4 w-4" fill={isFav ? 'currentColor' : 'none'} />
    </button>
  )
}
