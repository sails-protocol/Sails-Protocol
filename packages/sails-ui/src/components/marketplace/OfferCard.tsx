import { Link } from 'react-router'
import type { Offer } from '../../types'
import { PaymentBadge } from '../ui/StatusBadges'
import { UserAvatar } from '../ui/UserAvatar'
import { formatAmount } from '../../lib/format'
import { formatPrice } from '../../lib/currency'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { sellerTrust } from './offerList'
import { TrustLine } from '../ui/TrustLine'
import { buttonVariants } from '../ui/button'
import { cn } from '../../lib/utils'
import { Check } from 'lucide-react'

const SELLER_FALLBACK = 'Anunciante'

/**
 * Compact offer row for widths below the desktop table (OfferTable.tsx): the same cells folded into
 * three lines, hairline separators, no boxes. Line 1 seller + trust line, line 2 price, line 3 limits and
 * payment; the action (or "Sua oferta" on the viewer's own offer) sits on the right. The whole row is
 * the link; the action is a visual affordance only (no nested interactive element).
 */
export function OfferCard({ offer, own = false }: { offer: Offer; own?: boolean }) {
  const action = own ? 'Sua oferta' : offer.side === 'SELL' ? 'Comprar' : 'Vender'
  const { name, items } = sellerTrust(offer)
  const price = formatPrice(offer.priceFiat, offer.fiatCurrency)
  const limits = `${formatAmount(offer.minAmount)} – ${formatAmount(offer.maxAmount)} ${ASSET_SHORT_LABELS[offer.asset]}`
  // One concise accessible name instead of every cell's text read in a row (same wording as the table).
  const label = `${action}: ${ASSET_LABELS[offer.asset]} por ${price}, ${name ?? SELLER_FALLBACK}, ${PAYMENT_METHOD_LABELS[offer.paymentMethod]}, limites ${limits}`

  return (
    <Link to={`/offer/${offer.id}`} aria-label={label} className="offer-row items-start">
      <UserAvatar user={{ id: offer.user.id, displayName: name ?? SELLER_FALLBACK }} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="flex items-center gap-1 min-w-0">
            <span data-seller-name className="text-sm font-medium text-brand-text">{name ?? SELLER_FALLBACK}</span>
            {offer.user.verified && <Check aria-label="Verificado" className="h-3.5 w-3.5 shrink-0 text-brand-orange-accent" />}
          </span>
          <TrustLine items={items} className="text-xs text-brand-text-muted" />
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
          <span data-price className="money-lg text-brand-text whitespace-nowrap">{price}</span>
          <span className="text-xs text-brand-text-muted">
            por {ASSET_LABELS[offer.asset]}
            {offer.fiatCurrency !== 'USD' && ` · ≈ $${offer.priceUsd} USD`}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-brand-text-secondary tabular-nums">
          <span className="whitespace-nowrap"><span className="sr-only">Limites: </span>{limits}</span>
          <PaymentBadge method={offer.paymentMethod} className="text-xs" />
        </div>
      </div>
      {own ? (
        <span className="shrink-0 self-center text-xs font-medium text-brand-text-secondary">{action}</span>
      ) : (
        <span aria-hidden="true" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0 self-center min-w-[5.5rem]')}>
          {action}
        </span>
      )}
    </Link>
  )
}
