import { Link } from 'react-router'
import type { Offer } from '../../types'
import { AssetBadge, PaymentBadge } from '../ui/StatusBadges'
import { UserAvatar } from '../ui/UserAvatar'
import { formatAmount } from '../../lib/format'
import { formatPrice } from '../../lib/currency'
import { ASSET_LABELS, ASSET_SHORT_LABELS } from '../../lib/labels'
import { formatReputation } from '../../lib/reputation'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { Check } from 'lucide-react'

// Dense list-row layout (2026-07-28 visual redesign) replacing the
// bordered-card-in-a-grid shape — matches Marketplace.tsx's switch from
// a card grid to a single hairline-divided list (Binance P2P/Airtm/El
// Dorado's actual offer-listing layout). Side reads instantly off the
// left accent border instead of only a badge; the fixed-width columns
// below only take effect at md+ (mobile keeps the old stacked reading
// order via .offer-row's own flex-col default).
export function OfferCard({ offer }: { offer: Offer }) {
  const sideAccent = offer.side === 'BUY' ? 'border-l-green-500' : 'border-l-red-500'

  return (
    <Link to={`/offer/${offer.id}`} className={`offer-row ${sideAccent}`}>
      {/* Mobile: 2 paired rows (trader+payment, asset/side+price) instead of
          5 stacked full-width blocks — the original one-column-per-line
          layout was technically responsive but way too tall per offer once
          actually viewed on a phone. `xl:contents` drops these wrapper divs
          from the desktop layout entirely so their children become direct
          flex items of `.offer-row` (xl:flex-row) again, same as before —
          `xl:order-*` on each child then restores the original desktop
          left-to-right sequence, since grouping for mobile changes DOM
          order (payment now sits right after trader, not last). */}
      <div className="flex items-center justify-between gap-2 xl:contents">
        <div className="flex items-center gap-2 xl:order-1 xl:w-44 xl:shrink-0">
          <UserAvatar user={offer.user} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              {/* Impeccable critique P0 (2026-08-24): GET /v1/liquidity/offers
                  doesn't return the owning User row — realOffers.ts's own
                  summaryToOffer() comment discloses this — so displayName is
                  always null and userId is the literal sentinel 'unknown' for
                  every real offer today. A blank name and a real-looking
                  "0 trades" both read as actual data on a marketplace whose
                  whole trust model is evaluating the trader before sending
                  money; this is the honest placeholder instead. */}
              <span className="text-sm font-medium text-brand-text truncate">{offer.user.displayName ?? 'Anunciante'}</span>
              {offer.user.verified && (
                <span title="Verificado" className="shrink-0">
                  <Check className="h-3.5 w-3.5 text-brand-orange-accent" />
                </span>
              )}
            </div>
            <div className="text-xs text-brand-text-muted tabular-nums">
              {formatReputation(offer.user.reputationScore)} · {offer.user.id === 'unknown' ? '—' : `${offer.user.totalTrades} trades`}
            </div>
          </div>
        </div>
        <div className="xl:order-5 xl:w-40 xl:shrink-0">
          <PaymentBadge method={offer.paymentMethod} />
        </div>
      </div>

      {/* No side badge: it named the advertiser's side ("COMPRAR") next to
          a CTA naming the viewer's action ("Vender"). The CTA alone says
          what the viewer does; the left accent keeps the side colour. */}
      <div className="flex items-center justify-between gap-3 xl:contents">
        <div className="shrink-0 xl:order-2 xl:w-36">
          <AssetBadge asset={offer.asset} />
        </div>
        <div className="min-w-0 text-right xl:order-3 xl:text-left xl:flex-1">
          <div className="text-xl font-bold text-brand-text tabular-nums leading-tight whitespace-nowrap">
            {formatPrice(offer.priceFiat, offer.fiatCurrency)}
          </div>
          <div className="text-xs text-brand-text-muted">
            por {ASSET_LABELS[offer.asset]}
            {offer.fiatCurrency !== 'USD' && ` · ≈ $${offer.priceUsd} USD`}
          </div>
        </div>
      </div>

      {/* Explicit per-row CTA (Binance P2P/HodlHodl/El Dorado all put a
          "Buy"/"Sell" button directly on the row, not just a clickable
          card) — visual affordance only, not a real nested control: the
          whole row is already the actual `<Link>`, and a real `<button>`
          nested inside it would be invalid HTML (the exact bug this
          codebase's own AgentIntentionPanel fix, see sails-ui/README,
          already ran into once with a button-in-button). Label is the
          viewer's action, the inverse of `offer.side` — same computation
          OfferDetail.tsx already uses for its own amount-field label. */}
      <div className="flex items-center justify-between gap-2 xl:contents">
        <div className="min-w-0 text-xs text-brand-text-muted tabular-nums xl:order-4 xl:w-36 xl:shrink-0">
          <span className="sr-only">Limites: </span>
          {formatAmount(offer.minAmount)}–{formatAmount(offer.maxAmount)} {ASSET_SHORT_LABELS[offer.asset]}
        </div>
        <span className={cn(buttonVariants({ className: 'xl:order-6 w-28 px-4 shrink-0' }))}>
          {offer.side === 'SELL' ? 'Comprar' : 'Vender'}
        </span>
      </div>

      {offer.description && (
        <p className="text-xs text-brand-text-muted line-clamp-1 xl:hidden">{offer.description}</p>
      )}
    </Link>
  )
}
