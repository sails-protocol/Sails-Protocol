import { Link } from 'react-router'
import type { Offer } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { PaymentBadge } from '../ui/StatusBadges'
import { buttonVariants } from '../ui/button'
import { formatAmount } from '../../lib/format'
import { formatPrice } from '../../lib/currency'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { cn } from '../../lib/utils'
import { Check } from 'lucide-react'
import { sellerTrust } from './offerList'

const SELLER_FALLBACK = 'Anunciante'

/**
 * Desktop offer table: Anunciante | Preço | Limites | Pagamento | Ação.
 * Rows are split by one hairline, no boxes. The action is the row's one real link
 * (keyboard reachable); its ::after stretches over the row so the whole row is clickable.
 */
export function OfferTable({ offers }: { offers: Offer[] }) {
  return (
    <table className="w-full table-fixed text-left border-collapse">
      <caption className="sr-only">Ofertas</caption>
      {/* Fixed widths: price and the rest keep their size; only the seller column absorbs extra width. */}
      <colgroup>
        <col />
        <col className="w-[11rem]" />
        <col className="w-[12.5rem]" />
        <col className="w-[12rem]" />
        <col className="w-[8rem]" />
      </colgroup>
      <thead>
        <tr className="text-xs font-medium text-brand-text-muted">
          <th scope="col" className="font-medium py-2.5 pl-5 pr-4">Anunciante</th>
          <th scope="col" className="font-medium py-2.5 px-4">Preço</th>
          <th scope="col" className="font-medium py-2.5 px-4">Limites</th>
          <th scope="col" className="font-medium py-2.5 px-4">Pagamento</th>
          <th scope="col" className="py-2.5 pl-4 pr-5"><span className="sr-only">Ação</span></th>
        </tr>
      </thead>
      <tbody>
        {offers.map((offer) => <OfferTableRow key={offer.id} offer={offer} />)}
      </tbody>
    </table>
  )
}

function OfferTableRow({ offer }: { offer: Offer }) {
  const { name, parts } = sellerTrust(offer)
  const action = offer.side === 'SELL' ? 'Comprar' : 'Vender'
  const price = formatPrice(offer.priceFiat, offer.fiatCurrency)
  const limits = `${formatAmount(offer.minAmount)} – ${formatAmount(offer.maxAmount)} ${ASSET_SHORT_LABELS[offer.asset]}`
  const label = `${action} ${ASSET_LABELS[offer.asset]} por ${price}, ${name ?? SELLER_FALLBACK}, ${PAYMENT_METHOD_LABELS[offer.paymentMethod]}, limites ${limits}`

  return (
    <tr className="relative h-[4.25rem] border-t border-brand-border-subtle transition-colors hover:bg-brand-elevated/60">
      <td className="py-3 pl-5 pr-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <UserAvatar user={{ id: offer.user.id, displayName: name ?? SELLER_FALLBACK }} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-sm font-medium text-brand-text truncate">{name ?? SELLER_FALLBACK}</span>
              {offer.user.verified && <Check aria-label="Verificado" className="h-3.5 w-3.5 shrink-0 text-brand-orange-accent" />}
            </div>
            <div className="text-xs text-brand-text-muted tabular-nums truncate">{parts.join(' · ')}</div>
          </div>
        </div>
      </td>
      <td className="py-3 px-4">
        <div className="text-lg font-semibold text-brand-text tabular-nums leading-tight whitespace-nowrap">{price}</div>
        <div className="text-xs text-brand-text-muted whitespace-nowrap">por {ASSET_LABELS[offer.asset]}</div>
      </td>
      <td className="py-3 px-4 text-[13px] text-brand-text-secondary tabular-nums whitespace-nowrap">{limits}</td>
      <td className="py-3 px-4">
        <PaymentBadge method={offer.paymentMethod} />
      </td>
      <td className="py-3 pl-4 pr-5 text-right">
        <Link
          to={`/offer/${offer.id}`}
          aria-label={label}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-w-[5.5rem] after:absolute after:inset-0 after:content-[""]')}
        >
          {action}
        </Link>
      </td>
    </tr>
  )
}
